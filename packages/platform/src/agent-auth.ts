import type { PrismaClient, Prisma } from '@prisma/client';
import type { AgentMessage } from '@apk/contracts';
import { agentIssues } from '@apk/contracts';
import { randomBytes } from 'node:crypto';
import { derivedToken, digest } from './security.js';
import { fault } from './errors.js';
import { lockNode } from './nodes.js';
import { expireNodeRun, reviewRun, ACTIVE_RUNS } from './runs.js';
export async function issueEnrollment(
  db: PrismaClient,
  deploymentId: string,
  workerId: string,
  fence: number,
) {
  const token = randomBytes(32).toString('base64url');
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Deployment" WHERE "id"=${deploymentId}::uuid FOR UPDATE`;
    const job = await tx.deployment.findUniqueOrThrow({ where: { id: deploymentId } });
    await lockNode(tx, job.nodeId);
    if (
      job.workerId !== workerId ||
      job.fence !== fence ||
      job.status !== 'CONFIGURING' ||
      job.stopRequested ||
      !job.leaseExpiresAt ||
      job.leaseExpiresAt.getTime() <= Date.now()
    )
      fault('STALE_FENCE', '部署执行权已失效');
    await tx.enrollment.create({
      data: {
        nodeId: job.nodeId,
        deploymentId,
        tokenHash: digest(token),
        expiresAt: new Date(Date.now() + 600000),
      },
    });
    await tx.agentCredential.updateMany({
      where: { nodeId: job.nodeId },
      data: { revokedAt: new Date() },
    });
    await tx.node.update({ where: { id: job.nodeId }, data: { lastSeenAt: null } });
  });
  return token;
}
export async function enrollAgent(db: PrismaClient, token: string, body: unknown) {
  if (agentIssues(body).length || (body as { kind?: unknown })?.kind !== 'enroll')
    fault('VALIDATION_FAILED', '注册消息无效', 422);
  const input = body as Extract<AgentMessage, { kind: 'enroll' }>;
  return db.$transaction(async (tx) => {
    await lockNode(tx, input.nodeId);
    const enrollment = await tx.enrollment.findUnique({
      where: { tokenHash: digest(token) },
      include: { deployment: { include: { release: true } } },
    });
    if (
      !enrollment ||
      enrollment.nodeId !== input.nodeId ||
      enrollment.expiresAt.getTime() <= Date.now()
    )
      fault('ENROLLMENT_EXPIRED', '注册令牌无效或已过期', 410);
    const job = enrollment.deployment;
    if (job.stopRequested || ['FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(job.status))
      fault('ENROLLMENT_EXPIRED', '部署已停止，不能注册', 410);
    const release = job.release?.manifest as {
      agentVersion?: string;
      protocolVersion?: string;
    } | null;
    if (
      job.releaseId !== input.releaseId ||
      release?.agentVersion !== input.agentVersion ||
      release?.protocolVersion !== input.protocolVersion
    )
      fault('NODE_NOT_READY', '节点发布版本不匹配');
    if (enrollment.consumedAt && enrollment.bootId !== input.bootId)
      fault('ENROLLMENT_USED', '注册令牌已使用', 410);
    if (!enrollment.consumedAt) {
      const slot = await tx.nodeSlot.findUnique({ where: { nodeId: input.nodeId } });
      if (
        slot?.operationId !== job.id ||
        job.stopRequested ||
        !['CONFIGURING', 'STARTING', 'VERIFYING'].includes(job.status) ||
        !job.leaseExpiresAt ||
        job.leaseExpiresAt.getTime() <= Date.now()
      )
        fault('ENROLLMENT_EXPIRED', '部署已停止，不能注册', 410);
      await tx.enrollment.update({
        where: { id: enrollment.id },
        data: { consumedAt: new Date(), bootId: input.bootId },
      });
    }
    const credential = derivedToken(token, input.nodeId, input.bootId);
    const existing = await tx.agentCredential.findUnique({ where: { nodeId: input.nodeId } });
    if (
      enrollment.consumedAt &&
      (!existing || existing.revokedAt || existing.tokenHash !== digest(credential))
    )
      fault('ENROLLMENT_USED', '该节点身份已被替换', 410);
    if (!enrollment.consumedAt)
      await tx.agentCredential.upsert({
        where: { nodeId: input.nodeId },
        create: {
          nodeId: input.nodeId,
          tokenHash: digest(credential),
          bootId: input.bootId,
          releaseId: input.releaseId,
        },
        update: {
          tokenHash: digest(credential),
          bootId: input.bootId,
          releaseId: input.releaseId,
          revokedAt: null,
          createdAt: new Date(),
        },
      });
    return {
      nodeId: input.nodeId,
      credential,
      protocolVersion: '1.0',
      heartbeatIntervalSeconds: 15,
    };
  });
}
export async function agentHeartbeat(db: PrismaClient, token: string, body: unknown) {
  if (agentIssues(body).length || (body as { kind?: unknown })?.kind !== 'heartbeat')
    fault('VALIDATION_FAILED', '心跳消息无效', 422);
  const input = body as Extract<AgentMessage, { kind: 'heartbeat' }>;
  return db.$transaction(async (tx) => {
    await lockNode(tx, input.nodeId);
    const auth = await tx.agentCredential.findUnique({ where: { nodeId: input.nodeId } });
    if (!auth || auth.revokedAt || auth.tokenHash !== digest(token))
      fault('UNAUTHENTICATED', '节点身份无效', 401);
    if (auth.releaseId !== input.releaseId) fault('NODE_NOT_READY', '节点版本不一致');
    const release = await tx.release.findUnique({ where: { id: input.releaseId } });
    const manifest = release?.manifest as { agentVersion?: string } | null;
    if (input.agentVersion !== manifest?.agentVersion)
      fault('NODE_NOT_READY', '节点程序版本不匹配');
    await expireNodeRun(tx, input.nodeId);
    const slot = await tx.nodeSlot.findUnique({ where: { nodeId: input.nodeId } });
    const active = slot?.runId
      ? await tx.run.findUnique({ where: { id: slot.runId }, include: { delivery: true } })
      : null;
    let desiredControl = 'CONTINUE',
      leaseExpiresAt: string | undefined,
      reconcileRequired = false;
    if (active?.delivery && ACTIVE_RUNS.includes(active.status as (typeof ACTIVE_RUNS)[number])) {
      const d = active.delivery,
        c = input.currentDelivery;
      if (auth.bootId !== input.bootId) {
        await reviewRun(tx, active, 'AGENT_RESTARTED');
        reconcileRequired = true;
        desiredControl = 'STOP';
      } else if (!c || c.deliveryId !== d.id || c.runId !== active.id || c.fence !== d.fence) {
        desiredControl = 'STOP';
        reconcileRequired = true;
      } else {
        const lease = new Date(Date.now() + 120000);
        await tx.delivery.update({ where: { id: d.id }, data: { leaseExpiresAt: lease } });
        leaseExpiresAt = lease.toISOString();
        desiredControl = active.stopRequested ? 'STOP' : 'CONTINUE';
      }
    } else if (input.currentDelivery || active?.status === 'NEEDS_REVIEW') {
      desiredControl = 'STOP';
      reconcileRequired = active?.status === 'NEEDS_REVIEW';
    }
    if (auth.bootId !== input.bootId)
      await tx.agentCredential.update({
        where: { nodeId: input.nodeId },
        data: { bootId: input.bootId },
      });
    const report = 'report' in input ? input.report : undefined;
    await tx.node.update({
      where: { id: input.nodeId },
      data: {
        lastSeenAt: new Date(),
        agentVersion: input.agentVersion,
        agentReleaseId: input.releaseId,
        currentDeliveryId: input.currentDelivery?.deliveryId ?? null,
        downloadProtocol: input.capabilities.downloadProtocol ?? null,
        health: (report ?? {
          ...input.capabilities,
          android: false,
          errors: ['ANDROID_NOT_READY'],
        }) as Prisma.InputJsonValue,
      },
    });
    return {
      serverTime: new Date().toISOString(),
      desiredControl,
      ...(leaseExpiresAt ? { leaseExpiresAt } : {}),
      reconcileRequired,
      heartbeatIntervalSeconds: 15,
    };
  });
}
