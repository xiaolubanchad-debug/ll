import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { consoleOverview, nodeView, digest } from '@apk/platform';
import { schemaIssues } from '@apk/contracts';

test('server console uses actual slot control and separates daily open counts from owned reports and old accounts', async () => {
  const db = new PrismaClient(),
    ids = [randomUUID(), randomUUID()],
    day = '2026-10-20',
    runIds = [];
  try {
    for (const id of ids)
      await db.node.create({
        data: {
          id,
          name: 'Server console fixture',
          host: id + '.example.test',
          slot: { create: {} },
        },
      });
    async function run(nodeId, cacheDay, plan) {
      const r = await db.run.create({
        data: {
          nodeId,
          cacheDay,
          purpose: 'REGISTER',
          successTarget: 10,
          attemptLimit: 20,
          executionPlan: plan,
        },
      });
      runIds.push(r.id);
      return r;
    }
    const a = await run(ids[0], day, { openPolicy: { concurrency: 1 } }),
      b = await run(ids[1], day, { openPolicy: { concurrency: 1 } }),
      old = await run(ids[0], day, {}),
      yesterday = await run(ids[0], '2026-10-19', { openPolicy: { concurrency: 1 } });
    async function task(runId, position, status, proof = 'NONE', attemptStarted = true) {
      return db.task.create({
        data: {
          id: randomUUID(),
          runId,
          position,
          label: 'Owned fixture',
          sourceUrl: 'https://example.test/',
          targetKey: digest(randomUUID()),
          status,
          proof,
          attemptStarted,
        },
      });
    }
    const reported = await task(a.id, 0, 'SUCCEEDED', 'APP_OPEN');
    await task(a.id, 1, 'FAILED');
    await task(a.id, 2, 'HOLDING');
    await task(a.id, 3, 'CANCELLED');
    await task(a.id, 4, 'UNKNOWN');
    await task(a.id, 5, 'QUEUED', 'NONE', false);
    await task(b.id, 0, 'SUCCEEDED', 'APP_OPEN');
    await task(old.id, 0, 'SUCCEEDED', 'APP_UI');
    await task(yesterday.id, 0, 'SUCCEEDED', 'APP_OPEN');
    const en = await db.testEnrollment.create({
      data: {
        taskId: reported.id,
        nodeId: ids[0],
        deliveryId: randomUUID(),
        fence: 1,
        tokenHash: digest(randomUUID()),
        expectedUa: 'Owned fixture',
        model: 'Owned model',
        profileId: 'fixture',
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    await db.testRecord.create({
      data: {
        enrollmentId: en.id,
        installationId: randomUUID(),
        requestKey: randomUUID(),
        requestHash: digest(randomUUID()),
        username: 'qa' + randomUUID().replaceAll('-', '').slice(0, 8),
        sourceIp: '192.0.2.1',
        androidIdHash: digest(randomUUID()),
        model: 'Owned model',
        manufacturer: 'Owned fixture',
        apiLevel: 33,
        userAgent: 'Owned fixture',
        defaultWebViewUa: 'Owned fixture',
        uaMatched: true,
        modelMatched: true,
        encrypted: {},
      },
    });
    const result = await consoleOverview(db, { day, nodeId: ids[0] });
    assert.deepEqual(result.appOpens, {
      completed: 1,
      failed: 1,
      attempts: 5,
      pending: 1,
      stopped: 1,
      needsReview: 1,
      testReports: 1,
    });
    assert.equal(result.registrations.SUCCESS, 0);
    assert.deepEqual(schemaIssues('OverviewView', result), []);
    assert.equal((await consoleOverview(db, { day, nodeId: ids[1] })).appOpens.testReports, 0);
    assert.equal((await consoleOverview(db, { day, nodeId: ids[1] })).appOpens.completed, 1);
    await db.nodeSlot.update({ where: { nodeId: ids[0] }, data: { runId: a.id } });
    let node = await nodeView(db, ids[0]);
    assert.equal(node.activeRunId, a.id);
    assert.equal(node.activeOperationId, null);
    assert.equal(node.activeStopRequested, false);
    await db.run.update({
      where: { id: a.id },
      data: { stopRequested: true, status: 'STOP_REQUESTED' },
    });
    node = await nodeView(db, ids[0]);
    assert.equal(node.activeStopRequested, true);
    assert.equal(node.occupancy, 'BUSY');
    const op = await db.deployment.create({
      data: {
        nodeId: ids[0],
        nodeVersion: 1,
        kind: 'CHECK',
        createdBy: randomUUID(),
        stopRequested: true,
      },
    });
    await db.nodeSlot.update({
      where: { nodeId: ids[0] },
      data: { operationId: op.id, runId: null },
    });
    node = await nodeView(db, ids[0]);
    assert.equal(node.activeOperationId, op.id);
    assert.equal(node.activeRunId, null);
    assert.equal(node.activeStopRequested, true);
    await db.nodeSlot.update({ where: { nodeId: ids[0] }, data: { operationId: null } });
    node = await nodeView(db, ids[0]);
    assert.equal(node.occupancy, 'IDLE');
    assert.equal(node.activeStopRequested, false);
  } finally {
    await db.testRecord.deleteMany({ where: { enrollment: { nodeId: { in: ids } } } });
    await db.testEnrollment.deleteMany({ where: { nodeId: { in: ids } } });
    await db.nodeSlot.deleteMany({ where: { nodeId: { in: ids } } });
    await db.task.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.deployment.deleteMany({ where: { nodeId: { in: ids } } });
    await db.node.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  }
});
