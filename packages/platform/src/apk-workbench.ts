import type { ConfigVersion, Prisma, PrismaClient, Run, Task } from '@prisma/client';
import { knownAgentAtLeast, schemaIssues } from '@apk/contracts';
import type {
  ApkWorkbenchQuery,
  ApkWorkbenchView,
  DailyExecutionPlan,
  TestConfiguration,
} from '@apk/contracts';
import { checked } from './secrets.js';
import { canonical, digest } from './security.js';
import { fault } from './errors.js';

type Db = PrismaClient | Prisma.TransactionClient;
type Asset = DailyExecutionPlan['assets'][number];

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

export async function workbenchAssets(db: Db, nodeId: string, version: ConfigVersion) {
  const entries = await db.apkWorkbenchEntry.findMany({
    where: { ...workbenchScope(nodeId, version), present: true, downloadedAt: { not: null } },
    orderBy: [{ label: 'asc' }, { targetKey: 'asc' }],
  });
  return entries.flatMap((entry) => {
    const asset = readyAsset(entry.readyAsset);
    return asset ? [{ ...asset, label: entry.label }] : [];
  });
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
          url,
          receivedBytes,
          totalBytes,
          download: view(byId.get(latestRunId ?? '')),
          fileName: apk?.fileName ?? null,
          size: apk?.size ?? null,
          downloadedAt: downloadedAt?.toISOString() ?? null,
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
