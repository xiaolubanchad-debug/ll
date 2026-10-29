import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { canonical, digest } from './security.js';
import { lockNode, idle } from './nodes.js';
import { readSecret } from './secrets.js';
import { fault } from './errors.js';
import { TERMINAL } from './types.js';
import { lockLibrary } from './library-lock.js';
export function keyRequired(key: string | undefined) {
  if (!key || !/^[A-Za-z0-9._:-]{8,128}$/.test(key))
    fault('VALIDATION_FAILED', '缺少有效的请求幂等编号', 422);
  return key;
}
export async function idempotent<T>(
  db: PrismaClient,
  actorId: string,
  scope: string,
  key: string,
  body: unknown,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return db.$transaction(
    async (tx) => {
      const lock = actorId + ':' + scope + ':' + key;
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${lock},0))`;
      const where = { actorId_scope_key: { actorId, scope, key } };
      const existing = await tx.idempotencyRecord.findUnique({ where });
      const hash = digest(canonical(body));
      if (existing) {
        if (existing.requestHash !== hash)
          fault('IDEMPOTENCY_CONFLICT', '同一请求编号的内容不一致');
        return existing.response as T;
      }
      const response = await work(tx);
      await tx.idempotencyRecord.create({
        data: {
          actorId,
          scope,
          key,
          requestHash: hash,
          response: JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue,
        },
      });
      return response;
    },
    { timeout: 15000 },
  );
}
export async function enqueue(
  db: PrismaClient,
  nodeId: string,
  kind: 'PROBE' | 'CHECK' | 'DEPLOY',
  releaseId: string | null,
  actorId: string,
  requestId: string,
  key: string,
) {
  return idempotent(
    db,
    actorId,
    `node:${nodeId}:${kind}`,
    key,
    { nodeId, kind, releaseId },
    async (tx) => {
      await lockLibrary(tx);
      const node = await lockNode(tx, nodeId);
      if (await tx.managedTask.count({ where: { nodeId, enabled: true } }))
        fault('NODE_BUSY', '请先停止任务中心中绑定此服务器的任务');
      await idle(tx, nodeId, kind !== 'DEPLOY');
      if (kind !== 'PROBE') {
        if (!node.expectedFingerprint || !node.hostKey)
          fault('HOST_KEY_REQUIRED', '请先核验服务器主机指纹');
        if (!node.credentialVersionId) fault('CREDENTIAL_REQUIRED', '请先配置 SSH 凭据');
        await readSecret(tx, node.credentialVersionId, ['SSH_KEY', 'SSH_PASSWORD']);
      }
      if (kind === 'DEPLOY') {
        if (!releaseId || !(await tx.release.findUnique({ where: { id: releaseId } })))
          fault('RELEASE_INVALID', '发布版本不存在', 422);
        if ((await tx.release.findUniqueOrThrow({ where: { id: releaseId } })).archivedAt)
          fault('VERSION_ARCHIVED', '发布已归档，请恢复后部署');
        await tx.node.update({ where: { id: nodeId }, data: { deploymentStatus: 'INSTALLING' } });
      }
      const job = await tx.deployment.create({
        data: {
          nodeId,
          kind,
          releaseId,
          nodeVersion: node.version,
          createdBy: actorId,
          ...(kind === 'DEPLOY' ? { licenseAcceptedAt: new Date() } : {}),
        },
      });
      await tx.nodeSlot.update({
        where: { nodeId },
        data: { operationId: job.id, fence: { increment: 1 } },
      });
      await tx.deploymentEvent.create({
        data: { deploymentId: job.id, sequence: 1, status: 'QUEUED', code: 'QUEUED' },
      });
      await tx.auditEvent.create({
        data: { adminId: actorId, action: 'NODE_' + kind + '_REQUESTED', requestId },
      });
      return { operationId: job.id, resourceId: job.id, status: 'QUEUED' };
    },
  );
}
export async function claimJob(db: PrismaClient, workerId: string) {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT "id" FROM "Deployment" WHERE "status"='QUEUED' ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!rows.length) return null;
    const job = await tx.deployment.findUniqueOrThrow({ where: { id: rows[0].id } });
    const updated = await tx.deployment.update({
      where: { id: job.id },
      data: {
        workerId,
        fence: { increment: 1 },
        status: 'CONNECTING',
        leaseExpiresAt: new Date(Date.now() + 60000),
      },
    });
    await tx.deploymentEvent.create({
      data: { deploymentId: job.id, sequence: 2, status: 'CONNECTING', code: 'CONNECTING' },
    });
    return updated;
  });
}
export async function jobPhase(
  db: PrismaClient,
  id: string,
  workerId: string,
  fence: number,
  status: string,
  code = status,
) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Deployment" WHERE "id"=${id}::uuid FOR UPDATE`;
    const job = await tx.deployment.findUniqueOrThrow({ where: { id } });
    if (
      job.workerId !== workerId ||
      job.fence !== fence ||
      TERMINAL.includes(job.status) ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt.getTime() <= Date.now()
    )
      fault('STALE_FENCE', '部署执行权已失效');
    if (job.stopRequested) fault('JOB_CANCELLED', '操作已停止');
    const last = await tx.deploymentEvent.aggregate({
      where: { deploymentId: id },
      _max: { sequence: true },
    });
    await tx.deployment.update({ where: { id }, data: { status } });
    await tx.deploymentEvent.create({
      data: { deploymentId: id, sequence: (last._max.sequence ?? 0) + 1, status, code },
    });
  });
}
export async function finishJob(
  db: PrismaClient,
  id: string,
  workerId: string,
  fence: number,
  status: string,
  code: string,
  result: unknown = null,
  uncertain = false,
  expiredOnly = false,
) {
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Deployment" WHERE "id"=${id}::uuid FOR UPDATE`;
    const job = await tx.deployment.findUniqueOrThrow({ where: { id } });
    if (job.workerId !== workerId || job.fence !== fence || TERMINAL.includes(job.status))
      fault('STALE_FENCE', '部署执行权已失效');
    if (expiredOnly && job.leaseExpiresAt && job.leaseExpiresAt.getTime() > Date.now()) return;
    uncertain = uncertain || !job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= Date.now();
    const final = uncertain ? 'NEEDS_REVIEW' : job.stopRequested ? 'CANCELLED' : status;
    const last = await tx.deploymentEvent.aggregate({
      where: { deploymentId: id },
      _max: { sequence: true },
    });
    await tx.deployment.update({
      where: { id },
      data: {
        status: final,
        errorCode: code === 'OK' ? null : code,
        result: result === null ? Prisma.JsonNull : JSON.parse(JSON.stringify(result)),
        finishedAt: new Date(),
        leaseExpiresAt: null,
      },
    });
    await tx.deploymentEvent.create({
      data: { deploymentId: id, sequence: (last._max.sequence ?? 0) + 1, status: final, code },
    });
    await tx.nodeSlot.updateMany({
      where: { nodeId: job.nodeId, operationId: id },
      data: { operationId: null, ...(uncertain ? { quarantined: true } : {}) },
    });
    if (job.kind === 'DEPLOY')
      await tx.node.update({
        where: { id: job.nodeId },
        data: { deploymentStatus: final === 'SUCCEEDED' ? 'INSTALLED' : final },
      });
  });
}
export async function expireJobs(db: PrismaClient) {
  const jobs = await db.deployment.findMany({
    where: { status: { notIn: TERMINAL }, leaseExpiresAt: { lt: new Date() } },
  });
  for (const j of jobs)
    if (j.workerId)
      await finishJob(
        db,
        j.id,
        j.workerId,
        j.fence,
        'NEEDS_REVIEW',
        'WORKER_LOST',
        null,
        true,
        true,
      ).catch(() => {});
}
export async function stopJob(
  db: PrismaClient,
  id: string,
  actorId: string,
  requestId: string,
  key: string,
  reason: unknown,
) {
  return idempotent(db, actorId, 'stop:' + id, key, reason, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Deployment" WHERE "id"=${id}::uuid FOR UPDATE`;
    const job = await tx.deployment.findUnique({ where: { id } });
    if (!job) fault('NOT_FOUND', '操作不存在', 404);
    if (!TERMINAL.includes(job.status)) {
      const queued = job.status === 'QUEUED';
      await tx.deployment.update({
        where: { id },
        data: {
          stopRequested: true,
          ...(queued ? { status: 'CANCELLED', finishedAt: new Date() } : {}),
        },
      });
      if (queued)
        await tx.nodeSlot.updateMany({
          where: { nodeId: job.nodeId, operationId: id },
          data: { operationId: null },
        });
      if (queued) {
        await tx.deploymentEvent.create({
          data: { deploymentId: id, sequence: 2, status: 'CANCELLED', code: 'JOB_CANCELLED' },
        });
        if (job.kind === 'DEPLOY')
          await tx.node.update({
            where: { id: job.nodeId },
            data: { deploymentStatus: 'CANCELLED' },
          });
      }
    }
    await tx.auditEvent.create({
      data: { adminId: actorId, action: 'DEPLOYMENT_STOP_REQUESTED', requestId },
    });
    return {
      operationId: id,
      resourceId: id,
      status: TERMINAL.includes(job.status)
        ? job.status
        : job.status === 'QUEUED'
          ? 'CANCELLED'
          : 'CANCEL_REQUESTED',
    };
  });
}
export const workerId = () => randomUUID();
