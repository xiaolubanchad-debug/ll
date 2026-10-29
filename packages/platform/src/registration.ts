import type { PrismaClient, Prisma } from '@prisma/client';
import type { AgentMessage, ArtifactInput, TaskReconcileInput } from '@apk/contracts';
import { agentIssues } from '@apk/contracts';
import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  artifactRoot,
  readFunctionalArtifact,
  validateFunctionalBytes,
} from './functional-artifacts.js';
import { checked } from './secrets.js';
import { boundDelivery, ACTIVE_RUNS, nodeAuth } from './runs.js';
import { encrypt, decrypt, digest, canonical } from './security.js';
import { fault } from './errors.js';
import { idempotent } from './jobs.js';
import { lockNode } from './nodes.js';

async function fullTask(tx: Prisma.TransactionClient, runId: string, taskId: string) {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    include: { run: { include: { configVersion: true } } },
  });
  if (!task || task.runId !== runId) fault('NOT_FOUND', '任务不存在', 404);
  if (
    (task.run.configVersion?.body as { execution?: { mode?: string } })?.execution?.mode !== 'FULL'
  )
    fault('FEATURE_UNAVAILABLE', '下载模式不接收注册数据', 422);
  return task;
}
export async function storeAccount(db: PrismaClient, token: string, taskId: string, body: unknown) {
  if (agentIssues(body).length || (body as { kind?: unknown })?.kind !== 'account')
    fault('VALIDATION_FAILED', '账户消息无效', 422);
  const input = body as Extract<AgentMessage, { kind: 'account' }>;
  if (input.taskId !== taskId) fault('STALE_FENCE', '账户任务不一致');
  return db.$transaction(async (tx) => {
    const d = await boundDelivery(tx, token, input.nodeId, input.deliveryId, input.fence);
    await fullTask(tx, d.runId, taskId);
    const hash = digest(canonical({ username: input.username, password: input.password }));
    const old = await tx.accountResult.findFirst({
      where: { OR: [{ accountRef: input.accountRef }, { taskId }] },
    });
    if (
      old &&
      (old.accountRef !== input.accountRef ||
        old.taskId !== taskId ||
        old.deliveryId !== d.id ||
        old.fence !== d.fence ||
        old.contentHash !== hash)
    )
      fault('EVENT_CONFLICT', '账户记录不可替换');
    if (!old)
      await tx.accountResult.create({
        data: {
          accountRef: input.accountRef,
          taskId,
          deliveryId: d.id,
          fence: d.fence,
          contentHash: hash,
          encrypted: encrypt(
            { username: input.username, password: input.password },
            'account:' + input.accountRef,
          ) as unknown as Prisma.InputJsonValue,
        },
      });
    return {
      accountRef: input.accountRef,
      recordedForReview:
        !ACTIVE_RUNS.includes(d.run.status as (typeof ACTIVE_RUNS)[number]) ||
        d.leaseExpiresAt.getTime() <= Date.now(),
    };
  });
}
export async function uploadArtifact(db: PrismaClient, token: string, body: unknown) {
  const input = checked<ArtifactInput>('ArtifactInput', body);
  const bytes = Buffer.from(input.dataBase64, 'base64');
  if (bytes.toString('base64') !== input.dataBase64 || digest(bytes) !== input.sha256)
    fault('ARTIFACT_INVALID', '功能证据摘要不匹配', 422);
  validateFunctionalBytes(bytes);
  return db.$transaction(
    async (tx) => {
      const d = await boundDelivery(tx, token, input.nodeId, input.deliveryId, input.fence);
      await nodeAuth(tx, token, input.nodeId, input.bootId);
      await fullTask(tx, d.runId, input.taskId);
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${'artifact:' + input.artifactId},0))`;
      const old = await tx.artifact.findUnique({ where: { id: input.artifactId } });
      if (old) {
        if (
          old.taskId !== input.taskId ||
          old.deliveryId !== d.id ||
          old.fence !== d.fence ||
          old.sha256 !== input.sha256 ||
          old.kind !== 'functional-evidence'
        )
          fault('EVENT_CONFLICT', '证据编号冲突');
        return { artifactId: old.id, recordedForReview: old.recordedForReview };
      }
      if ((await tx.artifact.count({ where: { taskId: input.taskId } })) >= 20)
        fault('ARTIFACT_LIMIT', '任务证据数量超限', 422);
      await mkdir(artifactRoot(), { recursive: true, mode: 0o700 });
      const storageKey = input.artifactId + '.json',
        file = join(artifactRoot(), storageKey);
      try {
        await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = await lstat(file);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size !== bytes.length ||
          digest(await readFile(file)) !== input.sha256
        )
          fault('ARTIFACT_INVALID', '证据存储冲突', 422);
      }
      const late =
        !ACTIVE_RUNS.includes(d.run.status as (typeof ACTIVE_RUNS)[number]) ||
        d.leaseExpiresAt.getTime() <= Date.now();
      await tx.artifact.create({
        data: {
          id: input.artifactId,
          taskId: input.taskId,
          deliveryId: d.id,
          fence: d.fence,
          kind: 'functional-evidence',
          sha256: input.sha256,
          bytes: bytes.length,
          storageKey,
          recordedForReview: late,
        },
      });
      return { artifactId: input.artifactId, recordedForReview: late };
    },
    { timeout: 15000 },
  );
}
export async function artifactContent(db: PrismaClient, id: string) {
  const artifact = await db.artifact.findUnique({ where: { id } });
  if (!artifact) fault('NOT_FOUND', '证据不存在', 404);
  return (await readFunctionalArtifact(artifact)).bytes;
}
export async function viewAccount(
  db: PrismaClient,
  taskId: string,
  body: unknown,
  actor: string,
  requestId: string,
) {
  checked('AccountViewInput', body);
  return db.$transaction(async (tx) => {
    const account = await tx.accountResult.findUnique({
      where: { taskId },
      include: { task: true },
    });
    if (!account) fault('NOT_FOUND', '尚无已保存账户', 404);
    if (
      account.task.status !== 'UNKNOWN' &&
      account.createdAt.getTime() < Date.now() - 30 * 86400000
    )
      fault('ACCOUNT_EXPIRED', '账户查看期限已过', 410);
    await tx.auditEvent.create({
      data: {
        adminId: actor,
        action: 'ACCOUNT_VIEWED',
        requestId,
        details: {
          taskId,
          accountRef: account.accountRef,
          reason: (body as { reason: string }).reason,
        },
      },
    });
    return {
      accountRef: account.accountRef,
      ...(decrypt(account.encrypted, 'account:' + account.accountRef) as {
        username: string;
        password: string;
      }),
    };
  });
}
export async function reconcileTask(
  db: PrismaClient,
  taskId: string,
  body: unknown,
  actor: string,
  requestId: string,
  key: string,
) {
  const input = checked<TaskReconcileInput>('TaskReconcileInput', body);
  return idempotent(
    db,
    actor,
    'POST:/tasks/' + taskId + '/reconciliations',
    key,
    input,
    async (tx) => {
      const task = await tx.task.findUnique({ where: { id: taskId }, include: { run: true } });
      if (!task) fault('NOT_FOUND', '任务不存在', 404);
      await lockNode(tx, task.run.nodeId);
      if (task.status !== 'UNKNOWN' || task.run.status !== 'NEEDS_REVIEW')
        fault('EVENT_CONFLICT', '只有未知注册任务需要人工决议');
      if (
        (await tx.artifact.count({ where: { id: { in: input.evidenceIds }, taskId } })) !==
        input.evidenceIds.length
      )
        fault('VALIDATION_FAILED', '证据不属于本任务', 422);
      const review = await tx.taskReview.create({ data: { taskId, ...input, createdBy: actor } });
      await tx.auditEvent.create({
        data: { adminId: actor, action: 'TASK_RECONCILED', requestId },
      });
      return { id: review.id, taskId, outcome: review.outcome, originalStatus: task.status };
    },
  );
}
