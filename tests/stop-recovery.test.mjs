import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import {
  stopRun,
  agentHeartbeat,
  reconcileAgent,
  runEvents,
  runSummary,
  controlTaskPlan,
  tickTaskPlans,
  digest,
} from '@apk/platform';
const db = new PrismaClient();
test.after(() => db.$disconnect());
async function fixture(t, options = {}) {
  const admin = await db.admin.findFirstOrThrow(),
    nodeId = randomUUID(),
    releaseId = randomUUID(),
    runId = randomUUID(),
    deliveryId = randomUUID(),
    bootId = randomUUID(),
    token = randomBytes(32).toString('base64url');
  await db.release.create({
    data: {
      id: releaseId,
      artifactName: 'agent-' + releaseId + '.tgz',
      sha256: digest(releaseId),
      manifest: { agentVersion: '0.16.0' },
    },
  });
  await db.node.create({
    data: {
      id: nodeId,
      name: 'Owned stop fixture',
      host: nodeId + '.example.test',
      deploymentStatus: 'INSTALLED',
      lastSeenAt: new Date(Date.now() - 20000),
      slot: { create: { runId, quarantined: true, fence: 7 } },
    },
  });
  await db.agentCredential.create({
    data: { nodeId, releaseId, bootId, tokenHash: digest(token) },
  });
  await db.run.create({
    data: {
      id: runId,
      nodeId,
      createdBy: admin.id,
      successTarget: 1,
      attemptLimit: 1,
      status: options.running ? 'RUNNING' : 'NEEDS_REVIEW',
      purpose: options.legacy ? 'LEGACY' : 'REGISTER',
      executionPlan: options.legacy ? undefined : { openPolicy: { concurrency: 1 } },
      cleanupConfirmedAt: options.dirty ? null : new Date(Date.now() - 10000),
      cleanupBootId: bootId,
      errorCode: 'AGENT_EXECUTION_INTERRUPTED',
      delivery: {
        create: {
          id: deliveryId,
          bootId,
          fence: 7,
          ackDeadline: new Date(Date.now() + 30000),
          leaseExpiresAt: new Date(Date.now() + 120000),
          acceptedAt: new Date(),
        },
      },
    },
  });
  if (options.unknown)
    await db.task.create({
      data: {
        id: randomUUID(),
        runId,
        targetKey: digest(runId),
        label: 'Owned unknown',
        sourceUrl: 'https://example.test/',
        position: 0,
        status: 'UNKNOWN',
      },
    });
  t.after(async () => {
    await db.auditEvent.deleteMany({ where: { details: { path: ['runId'], equals: runId } } });
    await db.idempotencyRecord.deleteMany({ where: { scope: 'POST:/runs/' + runId + '/stop' } });
    await db.runEvent.deleteMany({ where: { deliveryId } });
    await db.task.deleteMany({ where: { runId } });
    await db.delivery.delete({ where: { id: deliveryId } });
    await db.run.delete({ where: { id: runId } });
    await db.agentCredential.delete({ where: { nodeId } });
    await db.nodeSlot.delete({ where: { nodeId } });
    await db.node.delete({ where: { id: nodeId } });
    await db.release.delete({ where: { id: releaseId } });
  });
  const heartbeat = JSON.parse(await readFile('contracts/fixtures/agent.valid.json', 'utf8')).find(
    (m) => m.kind === 'heartbeat',
  );
  Object.assign(heartbeat, {
    nodeId,
    releaseId,
    bootId,
    agentVersion: '0.16.0',
    sentAt: new Date().toISOString(),
    currentDelivery: null,
  });
  const stop = () =>
    stopRun(db, runId, { reason: '用户停止自有测试' }, admin.id, 'fixture', randomUUID());
  return { nodeId, releaseId, runId, deliveryId, bootId, token, heartbeat, stop };
}
test('stop on reviewed APP run persists intent and fresh idle heartbeat automatically releases exactly that slot', async (t) => {
  const f = await fixture(t);
  await f.stop();
  assert.equal((await db.run.findUnique({ where: { id: f.runId } })).stopRequested, true);
  assert.equal((await db.nodeSlot.findUnique({ where: { nodeId: f.nodeId } })).quarantined, true);
  await agentHeartbeat(db, f.token, f.heartbeat);
  const run = await db.run.findUnique({ where: { id: f.runId } }),
    slot = await db.nodeSlot.findUnique({ where: { nodeId: f.nodeId } });
  assert.ok(run.reviewResolvedAt);
  assert.equal(run.status, 'NEEDS_REVIEW');
  assert.equal(run.successes, 0);
  assert.equal(slot.runId, null);
  assert.equal(slot.quarantined, false);
  const summary = await runSummary(db, f.runId);
  assert.equal(summary.cleanup, 'CONFIRMED');
  assert.equal(summary.run.stopConfirmed, true);
  assert.equal(summary.run.status, 'NEEDS_REVIEW');
  await f.stop();
  await agentHeartbeat(db, f.token, f.heartbeat);
  assert.equal(
    await db.auditEvent.count({
      where: { action: 'STOP_CLEANUP_CONFIRMED', details: { path: ['runId'], equals: f.runId } },
    }),
    1,
  );
});
for (const [label, options] of [
  ['dirty', { dirty: true }],
  ['unknown submission', { unknown: true }],
  ['historical registration', { legacy: true }],
])
  test(label + ' is never released by STOP and idle alone', async (t) => {
    const f = await fixture(t, options);
    await f.stop();
    await agentHeartbeat(db, f.token, f.heartbeat);
    assert.equal((await db.nodeSlot.findUnique({ where: { nodeId: f.nodeId } })).runId, f.runId);
    assert.equal((await db.run.findUnique({ where: { id: f.runId } })).reviewResolvedAt, null);
  });
test('old boot cleanup cannot release the current authenticated node', async (t) => {
  const f = await fixture(t);
  await f.stop();
  await db.agentCredential.update({ where: { nodeId: f.nodeId }, data: { bootId: randomUUID() } });
  f.heartbeat.bootId = (
    await db.agentCredential.findUnique({ where: { nodeId: f.nodeId } })
  ).bootId;
  await agentHeartbeat(db, f.token, f.heartbeat);
  assert.equal((await db.nodeSlot.findUnique({ where: { nodeId: f.nodeId } })).quarantined, true);
});
test('same-boot execution recovery is not reported as a process restart; cleanup then STOP can settle it', async (t) => {
  const f = await fixture(t, { running: true });
  await reconcileAgent(db, f.token, {
    protocolVersion: '1.0',
    nodeId: f.nodeId,
    bootId: f.bootId,
    reason: 'EXECUTION_ERROR',
    cleanupComplete: true,
    deliveries: [{ deliveryId: f.deliveryId, fence: 7, cleanupComplete: true, submissions: [] }],
  });
  assert.equal(
    (await db.run.findUnique({ where: { id: f.runId } })).errorCode,
    'AGENT_EXECUTION_INTERRUPTED',
  );
  await f.stop();
  await new Promise((r) => setTimeout(r, 5));
  await agentHeartbeat(db, f.token, f.heartbeat);
  assert.equal((await db.nodeSlot.findUnique({ where: { nodeId: f.nodeId } })).runId, null);
});
test('stale heartbeat cannot replace the authenticated boot or release a stopped slot', async (t) => {
  const f = await fixture(t);
  await f.stop();
  f.heartbeat.bootId = randomUUID();
  const r = await agentHeartbeat(db, f.token, f.heartbeat);
  assert.equal(r.reconcileRequired, true);
  assert.equal(
    (await db.agentCredential.findUnique({ where: { nodeId: f.nodeId } })).bootId,
    f.bootId,
  );
  assert.equal((await db.nodeSlot.findUnique({ where: { nodeId: f.nodeId } })).runId, f.runId);
});
test('late authenticated stop acknowledgement supplies cleanup proof but waits for a new idle heartbeat', async (t) => {
  const f = await fixture(t, { dirty: true });
  await f.stop();
  await runEvents(db, f.token, {
    kind: 'events',
    protocolVersion: '1.0',
    nodeId: f.nodeId,
    deliveryId: f.deliveryId,
    fence: 7,
    events: [
      {
        eventId: randomUUID(),
        runId: f.runId,
        sequence: 1,
        occurredAt: new Date().toISOString(),
        type: 'STOP_ACK',
        payload: { cleanupComplete: true },
      },
    ],
  });
  assert.ok((await db.run.findUnique({ where: { id: f.runId } })).cleanupConfirmedAt);
  assert.equal((await db.nodeSlot.findUnique({ where: { nodeId: f.nodeId } })).quarantined, true);
  await new Promise((r) => setTimeout(r, 5));
  await agentHeartbeat(db, f.token, f.heartbeat);
  assert.equal((await db.nodeSlot.findUnique({ where: { nodeId: f.nodeId } })).quarantined, false);
});

test('task-center STOP closes reviewed cycle after cleanup heartbeat without restarting work', async (t) => {
  let f, task, cycle, configId, version;
  t.after(async () => {
    if (!task) return;
    await db.run.update({ where: { id: f.runId }, data: { taskCycleId: null } });
    await db.managedCycle.delete({ where: { id: cycle.id } });
    await db.idempotencyRecord.deleteMany({
      where: { scope: 'POST:/task-plans/' + task.id + '/control' },
    });
    await db.managedTask.delete({ where: { id: task.id } });
    await db.configVersion.delete({ where: { id: version.id } });
    await db.configuration.delete({ where: { id: configId } });
  });
  f = await fixture(t);
  const admin = await db.admin.findFirstOrThrow();
  configId = randomUUID();
  await db.configuration.create({ data: { id: configId, name: 'Owned stop configuration' } });
  const body = JSON.parse(await readFile('contracts/fixtures/config.app-open.valid.json', 'utf8'));
  version = await db.configVersion.create({
    data: {
      configId,
      version: 1,
      body,
      configHash: digest(JSON.stringify(body)),
      createdBy: admin.id,
    },
  });
  task = await db.managedTask.create({
    data: {
      name: 'Owned reviewed task',
      nodeId: f.nodeId,
      configId,
      currentVersionId: version.id,
      enabled: true,
      successTarget: 1,
      attemptLimit: 1,
      createdBy: admin.id,
    },
  });
  cycle = await db.managedCycle.create({
    data: {
      taskId: task.id,
      nodeId: f.nodeId,
      configVersionId: version.id,
      releaseId: f.releaseId,
      day: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()),
      status: 'NEEDS_REVIEW',
      successTarget: 1,
      attemptLimit: 1,
    },
  });
  await db.run.update({ where: { id: f.runId }, data: { taskCycleId: cycle.id } });
  await controlTaskPlan(db, task.id, { action: 'STOP' }, 1, admin.id, 'fixture', randomUUID());
  assert.equal((await db.run.findUnique({ where: { id: f.runId } })).stopRequested, true);
  await agentHeartbeat(db, f.token, f.heartbeat);
  await tickTaskPlans(db);
  assert.equal((await db.managedCycle.findUnique({ where: { id: cycle.id } })).status, 'STOPPED');
  assert.equal((await db.managedTask.findUnique({ where: { id: task.id } })).enabled, false);
  assert.equal(await db.run.count({ where: { taskCycleId: cycle.id } }), 1);
});
