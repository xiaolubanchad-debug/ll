import type { ConfigVersion, Prisma, PrismaClient, Run, Task } from '@prisma/client';
import { knownAgentAtLeast, schemaIssues } from '@apk/contracts';
import type {
  ApkWorkbenchQuery,
  ApkWorkbenchView,
  DailyExecutionPlan,
  TestConfiguration,
} from '@apk/contracts';
import { checked } from './secrets.js';
import { canonical, decrypt, digest, encrypt } from './security.js';
import { fault } from './errors.js';

type Db = PrismaClient | Prisma.TransactionClient;
type Asset = DailyExecutionPlan['assets'][number];
type EntryKey = { nodeId: string; configId: string; sourceKey: string; targetKey: string };
const entryUrlAad = ({ nodeId, configId, sourceKey, targetKey }: EntryKey) =>
  canonical(['apk-workbench-entry-v1', nodeId, configId, sourceKey, targetKey]);
const runUrlAad = (id: string) => 'apk-workbench-run-v1:' + id;
const encryptUrl = (url: string, aad: string) =>
  encrypt(url, aad) as unknown as Prisma.InputJsonValue;
export const encryptWorkbenchEntryUrl = (url: string, key: EntryKey) =>
  encryptUrl(url, entryUrlAad(key));
export const encryptWorkbenchRunUrl = (url: string, id: string) => encryptUrl(url, runUrlAad(id));
function decryptUrl(value: unknown, aad: string) {
  const url = decrypt(value, aad);
  if (typeof url !== 'string') fault('CREDENTIAL_UNAVAILABLE', 'APK 下载链接不可用', 503);
  return url;
}
export const decryptWorkbenchRunUrl = (value: unknown, id: string) =>
  decryptUrl(value, runUrlAad(id));

export async function migrateWorkbenchUrls(db: PrismaClient) {
  let count: number;
  do {
    count = await db.$transaction(
      async (tx) => {
        const entries = await tx.$queryRaw<(EntryKey & { url: string })[]>`
        SELECT "nodeId", "configId", "sourceKey", "targetKey", url
        FROM "ApkWorkbenchEntry" WHERE url IS NOT NULL LIMIT 100 FOR UPDATE`;
        for (const { url, ...key } of entries)
          await tx.apkWorkbenchEntry.update({
            where: { nodeId_configId_sourceKey_targetKey: key },
            data: { url: null, urlEncrypted: encryptWorkbenchEntryUrl(url, key) },
          });
        const runs = await tx.$queryRaw<{ id: string; executionPlan: DailyExecutionPlan }[]>`
        SELECT id, "executionPlan" FROM "Run"
        WHERE "executionPlan"#>>'{resourceAction,kind}' = 'FETCH'
          AND jsonb_typeof("executionPlan"#>'{resourceAction,url}') = 'string'
        LIMIT 100 FOR UPDATE`;
        for (const { id, executionPlan } of runs) {
          if (executionPlan.resourceAction?.kind !== 'FETCH') continue;
          const { url, ...action } = executionPlan.resourceAction;
          await tx.run.update({
            where: { id },
            data: {
              resourceUrlEncrypted: encryptWorkbenchRunUrl(url, id),
              executionPlan: {
                ...executionPlan,
                resourceAction: action,
              } as unknown as Prisma.InputJsonValue,
            },
          });
        }
        return entries.length + runs.length;
      },
      { timeout: 30000 },
    );
  } while (count);
}

export const workbenchSupported = (version?: string | null) => knownAgentAtLeast(version, '0.17.9');

export function workbenchScope(nodeId: string, version: ConfigVersion) {
  const { source } = version.body as unknown as TestConfiguration;
  const url = new URL(source.url);
  url.hash = '';
  return {
    nodeId,
    configId: version.configId,
    sourceKey: digest(canonical([url.href, source.xpath])),
  };
}

function readyAsset(value: unknown): Asset | null {
  const asset = value as Asset | null;
  return asset && schemaIssues('ApkMetadata', asset.apk).length === 0 ? asset : null;
}

function maxWorkbenchBytes(version: ConfigVersion) {
  return (version.body as unknown as TestConfiguration).download.maxApkBytes ?? 268435456;
}

export async function workbenchAssets(db: Db, nodeId: string, version: ConfigVersion) {
  const entries = await db.apkWorkbenchEntry.findMany({
    where: { ...workbenchScope(nodeId, version), present: true, downloadedAt: { not: null } },
    orderBy: [{ label: 'asc' }, { targetKey: 'asc' }],
  });
  const assets: Asset[] = [];
  let oversized = false;
  for (const entry of entries) {
    const asset = readyAsset(entry.readyAsset);
    if (!asset) continue;
    if (asset.apk.size > maxWorkbenchBytes(version)) oversized = true;
    else assets.push({ ...asset, label: entry.label });
  }
  return { assets, oversized };
}

export const workbenchAssetIssue = (oversized: boolean) =>
  oversized
    ? { code: 'APK_CACHE_LIMIT', message: '已下载的 APK 超过当前大小上限，请调整配置' }
    : { code: 'APK_WORKBENCH_EMPTY', message: '请先在 APK 资源下载至少一个可用文件' };

export async function workbenchCacheKeep(tx: Db, nodeId: string) {
  const [entries, runs] = await Promise.all([
    tx.apkWorkbenchEntry.findMany({
      where: { nodeId, downloadedAt: { not: null } },
      select: { readyAsset: true },
    }),
    tx.run.findMany({
      where: {
        nodeId,
        purpose: 'REGISTER',
        OR: [
          { status: { in: ['QUEUED', 'ASSIGNED', 'RUNNING', 'STOP_REQUESTED'] } },
          {
            status: 'NEEDS_REVIEW',
            OR: [
              { reviewResolvedAt: null },
              {
                tasks: {
                  some: {
                    status: 'QUEUED',
                    attemptStarted: false,
                    errorCode: 'DEVICE_QUEUE_PENDING',
                  },
                },
              },
            ],
          },
        ],
        executionPlan: { path: ['resourceAssets'], equals: true },
      },
      select: { executionPlan: true },
    }),
  ]);
  const keys = new Set<string>();
  const keep = (key: unknown) => {
    if (typeof key === 'string' && /^[a-f0-9]{64}$/.test(key)) keys.add(key);
  };
  for (const entry of entries) keep(readyAsset(entry.readyAsset)?.targetKey);
  for (const run of runs)
    for (const asset of (run.executionPlan as unknown as DailyExecutionPlan).assets)
      keep(asset.targetKey);
  return keys.size <= 20000 ? [...keys] : undefined;
}

export async function apkWorkbench(db: Db, query: unknown): Promise<ApkWorkbenchView> {
  const input = checked<ApkWorkbenchQuery>('ApkWorkbenchQuery', query);
  const [node, version] = await Promise.all([
    db.node.findUnique({ where: { id: input.nodeId } }),
    db.configVersion.findUnique({
      where: { id: input.configVersionId },
      include: { config: true },
    }),
  ]);
  if (!node || node.archivedAt || !version || version.archivedAt || version.config.archivedAt)
    fault('NOT_FOUND', '服务器或配置不可用', 404);
  const scope = workbenchScope(node.id, version);
  const [scan, entries] = await Promise.all([
    db.run.findFirst({
      where: {
        nodeId: node.id,
        configVersion: { configId: version.configId },
        AND: [
          { executionPlan: { path: ['resourceAction', 'kind'], equals: 'SCAN' } },
          { executionPlan: { path: ['resourceScope'], equals: scope.sourceKey } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, status: true, errorCode: true, createdAt: true },
    }),
    db.apkWorkbenchEntry.findMany({
      where: scope,
      orderBy: [{ present: 'desc' }, { label: 'asc' }, { targetKey: 'asc' }],
    }),
  ]);
  const runs = await db.run.findMany({
    where: { id: { in: entries.flatMap(({ latestRunId }) => (latestRunId ? [latestRunId] : [])) } },
    select: { id: true, status: true, errorCode: true, createdAt: true },
  });
  const view = (run?: (typeof runs)[number] | null) =>
    run ? { ...run, createdAt: run.createdAt.toISOString() } : null;
  const byId = new Map(runs.map((run) => [run.id, run]));
  return {
    releaseId: node.agentReleaseId,
    supported: node.deploymentStatus === 'INSTALLED' && workbenchSupported(node.agentVersion),
    scan: view(scan),
    items: entries.map(
      ({
        targetKey,
        label,
        sourceLocator,
        present,
        url,
        urlEncrypted,
        latestRunId,
        downloadedAt,
        receivedBytes,
        totalBytes,
        readyAsset: stored,
      }) => {
        const apk = readyAsset(stored)?.apk;
        return {
          targetKey,
          label,
          sourceLocator,
          present,
          url: urlEncrypted ? decryptUrl(urlEncrypted, entryUrlAad({ ...scope, targetKey })) : url,
          receivedBytes,
          totalBytes,
          download: view(byId.get(latestRunId ?? '')),
          fileName: apk?.fileName ?? null,
          size: apk?.size ?? null,
          downloadedAt: downloadedAt?.toISOString() ?? null,
          ...(downloadedAt && !apk ? { cacheMissing: true } : {}),
          ...(apk && apk.size > maxWorkbenchBytes(version) ? { overLimit: true } : {}),
        };
      },
    ),
  };
}

export async function publishWorkbenchScan(
  tx: Prisma.TransactionClient,
  run: Run,
  sourceKey: string,
  tasks: Task[],
) {
  const version = await tx.configVersion.findUniqueOrThrow({ where: { id: run.configVersionId! } });
  const scope = { nodeId: run.nodeId, configId: version.configId, sourceKey };
  await tx.apkWorkbenchEntry.updateMany({ where: scope, data: { present: false } });
  for (const task of tasks) {
    const key = { ...scope, targetKey: task.targetKey };
    const details = { label: task.label, sourceLocator: task.sourceLocator!, present: true };
    await tx.apkWorkbenchEntry.upsert({
      where: { nodeId_configId_sourceKey_targetKey: key },
      create: { ...key, ...details },
      update: details,
    });
  }
}
