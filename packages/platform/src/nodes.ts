import { Prisma } from '@prisma/client';
import type { PrismaClient, Node } from '@prisma/client';
import type { NodeInput, HostKeyInput } from '@apk/contracts';
import { checked, readSecret } from './secrets.js';
import { fault } from './errors.js';
import { BUSY_RUNS } from './types.js';
export async function lockNode(tx: Prisma.TransactionClient, id: string) {
  const rows = await tx.$queryRaw<Node[]>`SELECT * FROM "Node" WHERE "id"=${id}::uuid FOR UPDATE`;
  if (!rows[0] || rows[0].archivedAt) fault('NOT_FOUND', '服务器不存在', 404);
  return rows[0];
}
export async function idle(tx: Prisma.TransactionClient, nodeId: string, allowQuarantine = false) {
  const slot = await tx.nodeSlot.findUnique({ where: { nodeId } });
  if (
    !slot ||
    slot.operationId ||
    (await tx.run.count({ where: { nodeId, status: { in: [...BUSY_RUNS] } } }))
  )
    fault('NODE_BUSY', '服务器正在执行其他操作');
  if (slot.quarantined && !allowQuarantine) fault('NODE_QUARANTINED', '服务器状态需核验后才能继续');
  return slot;
}
async function validateCredentials(tx: Prisma.TransactionClient, input: NodeInput) {
  await readSecret(tx, input.credentialVersionId, ['SSH_KEY', 'SSH_PASSWORD']);
  if (input.sudoCredentialVersionId)
    await readSecret(tx, input.sudoCredentialVersionId, ['SUDO_PASSWORD']);
}
export function ifMatch(value: string | undefined) {
  const n = Number(value?.replace(/^"|"$/g, ''));
  if (!Number.isSafeInteger(n) || n < 1) fault('STALE_VERSION', '请刷新服务器信息后重试');
  return n;
}
export async function nodeView(db: PrismaClient, id: string) {
  const node = await db.node.findUnique({ where: { id }, include: { slot: true } });
  if (!node || node.archivedAt) fault('NOT_FOUND', '服务器不存在', 404);
  return {
    id: node.id,
    name: node.name,
    host: node.host,
    port: node.port,
    username: node.username,
    version: node.version,
    credentialVersionId: node.credentialVersionId,
    sudoCredentialVersionId: node.sudoCredentialVersionId,
    expectedFingerprint: node.expectedFingerprint,
    deploymentStatus: node.deploymentStatus,
    connection:
      node.lastSeenAt && node.lastSeenAt.getTime() > Date.now() - 45000 ? 'ONLINE' : 'OFFLINE',
    occupancy: node.slot?.quarantined ? 'QUARANTINED' : node.slot?.operationId ? 'BUSY' : 'IDLE',
    lastSeenAt: node.lastSeenAt,
    agentVersion: node.agentVersion,
    agentReleaseId: node.agentReleaseId,
    health: node.health,
    createdAt: node.createdAt,
  };
}
export async function createNode(
  db: PrismaClient,
  body: unknown,
  adminId: string,
  requestId: string,
) {
  const input = checked<NodeInput>('NodeInput', body);
  input.host = input.host.toLowerCase().replace(/\.$/, '');
  let node;
  try {
    node = await db.$transaction(async (tx) => {
      await validateCredentials(tx, input);
      const n = await tx.node.create({ data: { ...input, slot: { create: {} } } });
      await tx.auditEvent.create({ data: { adminId, action: 'NODE_CREATED', requestId } });
      return n;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      fault('ENDPOINT_EXISTS', '该地址和端口已登记');
    throw error;
  }
  return nodeView(db, node.id);
}
export async function updateNode(
  db: PrismaClient,
  id: string,
  body: unknown,
  version: number,
  adminId: string,
  requestId: string,
) {
  const input = checked<NodeInput>('NodeInput', body);
  input.host = input.host.toLowerCase().replace(/\.$/, '');
  await db
    .$transaction(async (tx) => {
      const node = await lockNode(tx, id);
      await idle(tx, id);
      if (node.version !== version) fault('STALE_VERSION', '服务器资料已更新，请刷新');
      await validateCredentials(tx, input);
      const moved =
        node.host !== input.host || node.port !== input.port || node.username !== input.username;
      await tx.node.update({
        where: { id },
        data: {
          ...input,
          version: { increment: 1 },
          ...(moved
            ? {
                expectedFingerprint: null,
                hostKey: null,
                lastSeenAt: null,
                health: Prisma.JsonNull,
                deploymentStatus: 'NOT_INSTALLED',
                agentVersion: null,
                agentReleaseId: null,
              }
            : {}),
        },
      });
      if (moved)
        await tx.agentCredential.updateMany({
          where: { nodeId: id },
          data: { revokedAt: new Date() },
        });
      await tx.auditEvent.create({ data: { adminId, action: 'NODE_UPDATED', requestId } });
    })
    .catch((error: unknown) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        fault('ENDPOINT_EXISTS', '该地址和端口已登记');
      throw error;
    });
  return nodeView(db, id);
}
export async function trustNode(
  db: PrismaClient,
  id: string,
  body: unknown,
  version: number,
  adminId: string,
  requestId: string,
) {
  const input = checked<HostKeyInput>('HostKeyInput', body);
  await db.$transaction(async (tx) => {
    const node = await lockNode(tx, id);
    await idle(tx, id);
    if (node.version !== version) fault('STALE_VERSION', '服务器资料已更新，请刷新');
    const probe = await tx.deployment.findFirst({
      where: {
        id: input.probeId,
        nodeId: id,
        nodeVersion: version,
        kind: 'PROBE',
        status: 'SUCCEEDED',
      },
    });
    const result = probe?.result as { fingerprint?: string; hostKey?: string } | null;
    if (!result?.hostKey || result.fingerprint !== input.expectedFingerprint)
      fault('HOST_KEY_MISMATCH', '填写的指纹与本次探测不一致，请核对可信来源');
    await tx.node.update({
      where: { id },
      data: {
        hostKey: result.hostKey,
        expectedFingerprint: input.expectedFingerprint,
        version: { increment: 1 },
      },
    });
    await tx.auditEvent.create({ data: { adminId, action: 'HOST_KEY_CONFIRMED', requestId } });
  });
  return nodeView(db, id);
}
export async function archiveNode(
  db: PrismaClient,
  id: string,
  version: number,
  adminId: string,
  requestId: string,
) {
  await db.$transaction(async (tx) => {
    const n = await lockNode(tx, id);
    await idle(tx, id);
    if (n.version !== version) fault('STALE_VERSION', '服务器资料已更新');
    if (n.lastSeenAt && n.lastSeenAt.getTime() > Date.now() - 45000)
      fault('NODE_BUSY', '请先在服务器停止 Agent 服务，再归档');
    await tx.node.update({
      where: { id },
      data: { archivedAt: new Date(), version: { increment: 1 } },
    });
    await tx.agentCredential.updateMany({ where: { nodeId: id }, data: { revokedAt: new Date() } });
    await tx.auditEvent.create({ data: { adminId, action: 'NODE_ARCHIVED', requestId } });
  });
}
