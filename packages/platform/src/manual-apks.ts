import { Prisma } from '@prisma/client';
import type { PrismaClient, ManualApkUpload } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, rename, unlink, chmod, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { join, resolve } from 'node:path';
import { describeApkFile, apkFileName, verifyFileTransfer } from '@apk/automation/apk';
import { schemaIssues, apkMetadataOnlySupported, apkFileAssetsSupported } from '@apk/contracts';
import type { ManualApkView, TestConfiguration } from '@apk/contracts';
import { checked } from './secrets.js';
import { idempotent, stopJob } from './jobs.js';
import { lockLibrary } from './library-lock.js';
import { lockNode, idle } from './nodes.js';
import { fault, PlatformError } from './errors.js';

type Db = Prisma.TransactionClient;
export const MANUAL_FEATURE = 'MANUAL_APK_IMPORT_V1';
export const manualDay = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
const runEnd = ['SUCCEEDED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'];
const pending = ['UPLOADING', 'RECEIVING', 'QUEUED', 'IMPORTING', 'NEEDS_REVIEW'];
export function manualApkPath(sha: string) {
  if (!/^[a-f0-9]{64}$/.test(sha)) fault('APK_UPLOAD_INVALID', '补包文件标识无效', 422);
  return join(resolve(process.env.APK_UPLOAD_DIR ?? 'data/apk-uploads'), sha + '.apk');
}
export function manualApkView(row: ManualApkUpload): ManualApkView {
  const value = {
    id: row.id,
    status: row.status,
    apk: schemaIssues('ApkMetadata', row.apk).length ? null : row.apk,
    errorCode: row.errorCode,
    operationId: row.operationId,
    maxBytes: row.maxBytes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  return checked<ManualApkView>('ManualApkView', value);
}
export async function uploadEligibility(db: Db, taskId: string, now = new Date()) {
  const task = await db.task.findUnique({
    where: { id: taskId },
    include: { run: { include: { configVersion: true } } },
  });
  if (!task || task.run.purpose !== 'DOWNLOAD') return { task, reason: '只能为下载入口补包' };
  if (task.run.cacheDay !== manualDay(now))
    return { task, reason: '历史日期只保留记录，请为当天入口补包' };
  if (!['FAILED', 'CANCELLED'].includes(task.status))
    return {
      task,
      reason: task.status === 'SUCCEEDED' ? '已成功下载，无需补包' : '此入口尚未下载失败或停止',
    };
  if (!runEnd.includes(task.run.status)) return { task, reason: '请等待本次下载结束并完成清理' };
  if (!task.run.configVersion) return { task, reason: '来源配置已不可用' };
  const latest = await db.run.findFirst({
    where: {
      nodeId: task.run.nodeId,
      purpose: 'DOWNLOAD',
      cacheDay: task.run.cacheDay,
      configVersion: { configId: task.run.configVersion.configId },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  return {
    task,
    reason: latest?.id === task.runId ? null : '已有更新下载，请在最新下载记录中补包',
  };
}
export async function createManualApk(
  db: PrismaClient,
  taskId: string,
  body: unknown,
  actor: string,
  requestId: string,
  key: string,
) {
  checked('ManualApkCreateInput', body);
  const result = await idempotent(db, actor, 'manual-apk:' + taskId, key, {}, async (tx) => {
    await lockLibrary(tx);
    const { task, reason } = await uploadEligibility(tx, taskId);
    if (!task) fault('NOT_FOUND', '下载入口不存在', 404);
    await lockNode(tx, task.run.nodeId);
    if (reason) fault('APK_UPLOAD_UNAVAILABLE', reason, 409);
    const previous = await tx.manualApkUpload.findUnique({ where: { taskId } });
    if (previous && !['FAILED', 'CANCELLED', 'EXPIRED'].includes(previous.status))
      return { id: previous.id };
    const node = await tx.node.findUniqueOrThrow({ where: { id: task.run.nodeId } });
    const settings = task.run.configVersion!.body as unknown as TestConfiguration;
    const data = {
      nodeId: node.id,
      nodeVersion: node.version,
      cacheDay: task.run.cacheDay!,
      targetKey: task.targetKey,
      maxBytes: settings.download.maxApkBytes ?? 268435456,
      status: 'UPLOADING',
      errorCode: null,
      receiveOwner: null,
      receiveUntil: null,
      operationId: null,
      apk: Prisma.DbNull,
      storageSha: null,
    };
    const row = previous
      ? await tx.manualApkUpload.update({ where: { id: previous.id }, data })
      : await tx.manualApkUpload.create({ data: { ...data, taskId, createdBy: actor } });
    await tx.auditEvent.create({
      data: {
        adminId: actor,
        action: 'APK_UPLOAD_CREATED',
        requestId,
        details: { taskId, uploadId: row.id },
      },
    });
    return { id: row.id };
  });
  return manualApkView(await db.manualApkUpload.findUniqueOrThrow({ where: { id: result.id } }));
}
export async function receiveManualApk(
  db: PrismaClient,
  id: string,
  source: Readable,
  actor: string,
  requestId: string,
  fileName?: string,
) {
  const owner = randomUUID();
  const row = await db.$transaction(async (tx) => {
    await lockLibrary(tx);
    await tx.$queryRaw`SELECT "id" FROM "ManualApkUpload" WHERE "id"=${id}::uuid FOR UPDATE`;
    const r = await tx.manualApkUpload.findUnique({ where: { id } });
    if (!r) fault('NOT_FOUND', '上传会话不存在', 404);
    const { reason } = await uploadEligibility(tx, r.taskId);
    if (reason) fault('APK_UPLOAD_UNAVAILABLE', reason, 409);
    if (['QUEUED', 'IMPORTING', 'APPLIED'].includes(r.status)) return r;
    if (r.status === 'RECEIVING' && r.receiveUntil && r.receiveUntil > new Date())
      fault('APK_UPLOAD_BUSY', '该入口已有上传正在进行');
    if (!['UPLOADING', 'RECEIVING', 'FAILED', 'CANCELLED'].includes(r.status))
      fault('APK_UPLOAD_UNAVAILABLE', '请新建当天上传会话');
    return tx.manualApkUpload.update({
      where: { id },
      data: {
        status: 'RECEIVING',
        receiveOwner: owner,
        receiveUntil: new Date(Date.now() + 1800000),
        errorCode: null,
      },
    });
  });
  if (row.receiveOwner !== owner) {
    source.resume();
    return manualApkView(row);
  }
  const root = resolve(process.env.APK_UPLOAD_DIR ?? 'data/apk-uploads');
  const temp = join(root, id + '-' + owner + '.partial');
  let bytes = 0;
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await pipeline(
      source.iterator({ destroyOnReturn: false }),
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > row.maxBytes
              ? new PlatformError(413, 'APK_TOO_LARGE', 'APK 超过本任务大小限制')
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
    );
    const apk = await describeApkFile(
      temp,
      row.maxBytes,
      row.cacheDay,
      fileName ?? 'apk-' + row.targetKey.slice(0, 12) + '.apk',
      AbortSignal.timeout(120000),
    );
    const other = await db.task.findMany({
      where: { run: { nodeId: row.nodeId, cacheDay: row.cacheDay, purpose: 'DOWNLOAD' } },
      select: { targetKey: true, apk: true, manualApk: { select: { apk: true } } },
    });
    if (
      other.some(
        (t) =>
          t.targetKey !== row.targetKey &&
          [t.apk, t.manualApk?.apk].some((value) => {
            const m = value as { fileName?: string; apkSha256?: string } | null;
            return (
              m?.fileName?.toLowerCase() === apk.fileName!.toLowerCase() &&
              m?.apkSha256 !== apk.apkSha256
            );
          }),
      )
    )
      apk.fileName = apkFileName(
        apk.fileName!.slice(0, -4).slice(0, 180) + '-' + row.targetKey.slice(0, 12) + '.apk',
      );
    if (schemaIssues('ApkMetadata', apk).length) fault('APK_INVALID', 'APK 包信息不符合要求', 422);
    const target = manualApkPath(apk.apkSha256);
    const existing = await lstat(target).catch(() => null);
    if (existing) {
      if (!existing.isFile() || existing.isSymbolicLink() || existing.size !== apk.size)
        fault('APK_UPLOAD_INVALID', '补包存储校验失败', 422);
      await verifyFileTransfer(target, apk, row.maxBytes, AbortSignal.timeout(120000));
      await unlink(temp);
    } else {
      await rename(temp, target);
      await chmod(target, 0o600);
    }
    await db.$transaction(async (tx) => {
      await lockLibrary(tx);
      const { reason } = await uploadEligibility(tx, row.taskId);
      if (reason) fault('APK_UPLOAD_UNAVAILABLE', reason, 409);
      const saved = await tx.manualApkUpload.updateMany({
        where: { id, status: 'RECEIVING', receiveOwner: owner },
        data: {
          status: 'QUEUED',
          apk: apk as unknown as Prisma.InputJsonValue,
          storageSha: apk.apkSha256,
          receiveOwner: null,
          receiveUntil: null,
          errorCode: null,
        },
      });
      if (!saved.count) fault('APK_UPLOAD_BUSY', '上传会话状态已变化');
      await tx.auditEvent.create({
        data: {
          adminId: actor,
          action: 'APK_UPLOAD_VALIDATED',
          requestId,
          details: { uploadId: id, sha256: apk.apkSha256, size: apk.size },
        },
      });
    });
  } catch (error) {
    source.resume();
    await unlink(temp).catch(() => {});
    const code =
      error instanceof PlatformError
        ? error.code
        : ['APK_METADATA_UNREADABLE', 'FILE_TRANSFER_MISMATCH', 'APK_TOO_LARGE'].includes(
              (error as { code?: string }).code ?? '',
            )
          ? (error as { code: string }).code
          : 'APK_UPLOAD_INTERRUPTED';
    await db.manualApkUpload.updateMany({
      where: { id, status: 'RECEIVING', receiveOwner: owner },
      data: { status: 'FAILED', errorCode: code, receiveOwner: null, receiveUntil: null },
    });
    if (error instanceof PlatformError) throw error;
    fault(
      code,
      code === 'APK_METADATA_UNREADABLE'
        ? '文件已收到，但无法读取启动所需包信息'
        : code === 'FILE_TRANSFER_MISMATCH'
          ? '文件传输结果不一致，请重传'
          : '上传未完成，请重试',
      422,
    );
  }
  return manualApkView(await db.manualApkUpload.findUniqueOrThrow({ where: { id } }));
}
export async function retryManualApk(
  db: PrismaClient,
  id: string,
  body: unknown,
  actor: string,
  requestId: string,
  key: string,
) {
  checked('ManualApkCreateInput', body);
  await idempotent(db, actor, 'manual-apk-retry:' + id, key, {}, async (tx) => {
    await lockLibrary(tx);
    const r = await tx.manualApkUpload.findUnique({ where: { id } });
    if (!r) fault('NOT_FOUND', '补包不存在', 404);
    await lockNode(tx, r.nodeId);
    const { reason } = await uploadEligibility(tx, r.taskId);
    if (reason) fault('APK_UPLOAD_UNAVAILABLE', reason);
    if (r.status === 'NEEDS_REVIEW') {
      const slot = await tx.nodeSlot.findUnique({ where: { nodeId: r.nodeId } });
      const check = await tx.deployment.findFirst({
        where: {
          nodeId: r.nodeId,
          kind: 'CHECK',
          status: 'SUCCEEDED',
          finishedAt: { gt: r.updatedAt },
        },
        orderBy: { finishedAt: 'desc' },
      });
      if (slot?.quarantined || !check) fault('REVIEW_REQUIRED', '请先完成服务器环境检查及隔离核验');
    }
    if (
      !['FAILED', 'CANCELLED', 'APPLIED', 'NEEDS_REVIEW'].includes(r.status) ||
      !r.storageSha ||
      schemaIssues('ApkMetadata', r.apk).length
    )
      fault('APK_UPLOAD_UNAVAILABLE', '请先完成 APK 上传，未知结果须先核验');
    const jobs = await tx.deployment.count({
      where: {
        manualApkId: id,
        status: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'] },
      },
    });
    if (jobs) fault('NODE_BUSY', '补包仍在下发');
    await tx.manualApkUpload.update({
      where: { id },
      data: { status: 'QUEUED', operationId: null, errorCode: null },
    });
    await tx.auditEvent.create({
      data: { adminId: actor, action: 'APK_IMPORT_RETRY', requestId, details: { uploadId: id } },
    });
    return { id };
  });
  return manualApkView(await db.manualApkUpload.findUniqueOrThrow({ where: { id } }));
}
export async function cancelManualApk(
  db: PrismaClient,
  id: string,
  body: unknown,
  actor: string,
  requestId: string,
  key: string,
) {
  checked('ManualApkCreateInput', body);
  const row = await db.manualApkUpload.findUnique({ where: { id } });
  if (!row) fault('NOT_FOUND', '补包不存在', 404);
  if (row.operationId && row.status === 'IMPORTING')
    await stopJob(db, row.operationId, actor, requestId, key, { reason: '管理员取消补包' });
  await idempotent(db, actor, 'manual-apk-cancel:' + id, key, {}, async (tx) => {
    await lockLibrary(tx);
    await lockNode(tx, row.nodeId);
    await tx.manualApkUpload.updateMany({
      where: { id, status: { in: ['UPLOADING', 'RECEIVING', 'QUEUED'] } },
      data: {
        status: 'CANCELLED',
        receiveOwner: null,
        receiveUntil: null,
        errorCode: 'JOB_CANCELLED',
      },
    });
    await tx.auditEvent.create({
      data: {
        adminId: actor,
        action: 'APK_UPLOAD_CANCELLED',
        requestId,
        details: { uploadId: id },
      },
    });
    return { id };
  });
  return manualApkView(await db.manualApkUpload.findUniqueOrThrow({ where: { id } }));
}
export async function pruneManualApks(db: PrismaClient, now = new Date()) {
  const root = resolve(process.env.APK_UPLOAD_DIR ?? 'data/apk-uploads');
  for (const file of await readdir(root).catch(() => [])) {
    if (!/^(?:[a-f0-9]{64}\.apk|[a-f0-9-]{36}-[a-f0-9-]{36}\.partial)$/.test(file)) continue;
    const path = join(root, file),
      info = await lstat(path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || now.getTime() - info.mtimeMs < 7 * 86400000)
      continue;
    await db.$transaction(async (tx) => {
      await lockLibrary(tx);
      if (await tx.manualApkUpload.count({ where: { status: 'RECEIVING' } })) return;
      const active = file.endsWith('.apk')
        ? await tx.manualApkUpload.count({
            where: {
              storageSha: file.slice(0, -4),
              OR: [
                { cacheDay: { gte: manualDay(new Date(now.getTime() - 7 * 86400000)) } },
                { status: { in: pending } },
              ],
            },
          })
        : await tx.manualApkUpload.count({
            where: { id: file.slice(0, 36), status: 'RECEIVING', receiveUntil: { gt: now } },
          });
      if (!active) await unlink(path).catch(() => {});
    });
  }
}
export async function tickManualApks(db: PrismaClient, now = new Date()) {
  await db.$transaction(async (tx) => {
    await lockLibrary(tx);
    await tx.manualApkUpload.updateMany({
      where: { status: 'RECEIVING', receiveUntil: { lt: now } },
      data: {
        status: 'FAILED',
        errorCode: 'APK_UPLOAD_INTERRUPTED',
        receiveOwner: null,
        receiveUntil: null,
      },
    });
    await tx.manualApkUpload.updateMany({
      where: {
        cacheDay: { lt: manualDay(now) },
        status: { in: ['UPLOADING', 'QUEUED', 'APPLIED'] },
      },
      data: { status: 'EXPIRED', errorCode: 'DAY_CHANGED' },
    });
  });
  const rows = await db.manualApkUpload.findMany({
    where: { status: 'QUEUED' },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  for (const row of rows)
    await db
      .$transaction(async (tx) => {
        await lockLibrary(tx);
        const n = await lockNode(tx, row.nodeId);
        const current = await tx.manualApkUpload.findUniqueOrThrow({ where: { id: row.id } });
        if (current.status !== 'QUEUED') return;
        const { reason } = await uploadEligibility(tx, row.taskId);
        if (reason || n.archivedAt || n.version !== row.nodeVersion) {
          await tx.manualApkUpload.update({
            where: { id: row.id },
            data: { status: 'EXPIRED', errorCode: reason ? 'SOURCE_CHANGED' : 'NODE_CHANGED' },
          });
          return;
        }
        const slot = await tx.nodeSlot.findUnique({ where: { nodeId: n.id } });
        if (
          (current.apk as { validationPolicy?: string } | null)?.validationPolicy ===
            'ANDROID_INSTALL' ||
          (current.apk as { validationPolicy?: string } | null)?.validationPolicy === 'FILE_NAME'
        ) {
          const installed = n.agentReleaseId
            ? await tx.release.findUnique({ where: { id: n.agentReleaseId } })
            : null;
          if (
            !(
              (current.apk as { validationPolicy?: string }).validationPolicy === 'FILE_NAME'
                ? apkFileAssetsSupported
                : apkMetadataOnlySupported
            )((installed?.manifest as { features?: string[] } | null)?.features, n.agentVersion)
          ) {
            if (current.errorCode !== 'NODE_UPGRADE_REQUIRED')
              await tx.manualApkUpload.update({
                where: { id: row.id },
                data: { errorCode: 'NODE_UPGRADE_REQUIRED' },
              });
            return;
          }
        }
        if (
          slot?.runId ||
          slot?.operationId ||
          slot?.quarantined ||
          (await tx.managedTask.count({ where: { nodeId: n.id, enabled: true } })) ||
          (await tx.dailySchedule.count({ where: { nodeId: n.id, enabled: true } })) ||
          !n.expectedFingerprint ||
          !n.hostKey ||
          !n.credentialVersionId ||
          !n.lastSeenAt ||
          n.lastSeenAt.getTime() < now.getTime() - 45000
        ) {
          if (current.errorCode !== 'NODE_BUSY')
            await tx.manualApkUpload.update({
              where: { id: row.id },
              data: { errorCode: 'NODE_BUSY' },
            });
          return;
        }
        const releases = await tx.release.findMany({
          where: { archivedAt: null },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });
        const release = releases.find((r) => {
          const manifest = r.manifest as { features?: string[]; agentVersion?: string };
          return (
            manifest.features?.includes(MANUAL_FEATURE) &&
            ((current.apk as { validationPolicy?: string } | null)?.validationPolicy === 'FILE_NAME'
              ? apkFileAssetsSupported
              : apkMetadataOnlySupported)(manifest.features, manifest.agentVersion)
          );
        });
        if (!release) {
          if (current.errorCode !== 'IMPORT_TOOL_REQUIRED')
            await tx.manualApkUpload.update({
              where: { id: row.id },
              data: { errorCode: 'IMPORT_TOOL_REQUIRED' },
            });
          return;
        }
        await idle(tx, n.id);
        const job = await tx.deployment.create({
          data: {
            nodeId: n.id,
            nodeVersion: n.version,
            kind: 'APK_IMPORT',
            releaseId: release.id,
            manualApkId: row.id,
            createdBy: row.createdBy,
          },
        });
        await tx.nodeSlot.update({
          where: { nodeId: n.id },
          data: { operationId: job.id, fence: { increment: 1 } },
        });
        await tx.deploymentEvent.create({
          data: { deploymentId: job.id, sequence: 1, status: 'QUEUED', code: 'APK_IMPORT_QUEUED' },
        });
        await tx.manualApkUpload.update({
          where: { id: row.id },
          data: { status: 'IMPORTING', operationId: job.id, errorCode: null },
        });
      })
      .catch(() => {
        /* Next durable tick rechecks occupancy; no remote work occurs here. */
      });
}
export async function manualAssetsForRun(db: Db, runId: string) {
  return (
    await db.manualApkUpload.findMany({
      where: { status: 'APPLIED', task: { runId } },
      include: { node: { select: { version: true, archivedAt: true } } },
    })
  ).filter((m) => !m.node.archivedAt && m.node.version === m.nodeVersion);
}
export async function hasManualAssets(db: Db, runId: string) {
  return (await db.manualApkUpload.count({ where: { status: 'APPLIED', task: { runId } } })) > 0;
}
export async function assertNoPendingManualApks(db: Db, nodeId: string, configId: string) {
  if (
    await db.manualApkUpload.count({
      where: {
        nodeId,
        cacheDay: manualDay(),
        status: { in: pending },
        task: { run: { configVersion: { configId } } },
      },
    })
  )
    fault('APK_IMPORT_PENDING', '补包尚未确认就绪，请先停止任务并等待下发或核验');
}
