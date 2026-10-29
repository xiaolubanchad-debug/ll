import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { initializeAdmin } from '../apps/control-api/dist/admin.js';
import {
  createRun,
  digest,
  saveTaskPlan,
  taskPlanDetail,
  controlTaskPlan,
  tickTaskPlans,
} from '@apk/platform';

test('1.8.1 explicit download retry preserves history, receipts and daily reuse', async () => {
  const db = new PrismaClient(),
    now = new Date(),
    key = () => randomUUID();
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  let node, other, release;
  try {
    if (!(await db.admin.findFirst()))
      await initializeAdmin(db, 'p0admin', process.env.P0_TEST_PASSWORD);
    const admin = await db.admin.findFirstOrThrow();
    release = await db.release.create({
      data: {
        id: key(),
        sha256: digest(key()),
        artifactName: 'agent-' + digest(key()) + '.tgz',
        manifest: { agentVersion: '0.6.0', features: ['DOWNLOAD_V1', 'DAILY_V1'] },
      },
    });
    node = await db.node.create({
      data: {
        name: '1.8.1 owned retry',
        host: '192.0.2.182',
        lastSeenAt: now,
        agentVersion: '0.6.1',
        agentReleaseId: release.id,
        deploymentStatus: 'INSTALLED',
        downloadProtocol: '1.0',
        health: { download: true },
        slot: { create: {} },
      },
    });
    const input = JSON.parse(await readFile('contracts/fixtures/v18.valid.json', 'utf8')).task;
    input.nodeId = node.id;
    input.name = '1.8.1 retry';
    input.configuration.execution.mode = 'DOWNLOAD_ONLY';
    delete input.configuration.execution.autoRegistration;
    delete input.configuration.execution.proxySecretVersionId;
    const task = await saveTaskPlan(db, input, admin.id, 'v181', key());
    const runInput = {
      nodeId: node.id,
      configVersionId: task.currentVersionId,
      releaseId: release.id,
      purpose: 'DOWNLOAD',
    };
    const create = (extra = {}) =>
      createRun(db, { ...runInput, ...extra }, admin.id, 'v181', key(), now);
    const control = async (action) =>
      controlTaskPlan(
        db,
        task.id,
        { action },
        (await taskPlanDetail(db, task.id)).task.version,
        admin.id,
        'v181',
        key(),
        now,
      );
    const finish = async (id, status) => {
      await db.run.update({ where: { id }, data: { status, finishedAt: now } });
      await db.nodeSlot.update({ where: { nodeId: node.id }, data: { runId: null } });
    };
    const original = (await create()).resourceId;
    await assert.rejects(
      create({ supersedesRunId: original }),
      (e) => e.code === 'DOWNLOAD_RETRY_INVALID',
    );
    await finish(original, 'SUCCEEDED');
    await assert.rejects(
      create({ supersedesRunId: original }),
      (e) => e.code === 'DOWNLOAD_RETRY_INVALID',
    );
    await finish(original, 'CANCELLED');
    const delivery = await db.delivery.create({
      data: {
        runId: original,
        bootId: key(),
        fence: 1,
        ackDeadline: now,
        leaseExpiresAt: now,
        acceptedAt: now,
      },
    });
    await assert.rejects(
      create({ supersedesRunId: original }),
      (e) => e.code === 'DOWNLOAD_RETRY_NOT_READY',
    );
    const event = await db.runEvent.create({
      data: {
        id: key(),
        deliveryId: delivery.id,
        sequence: 1,
        contentHash: digest(key()),
        body: { type: 'STOP_ACK', payload: { cleanupComplete: true } },
        recordedForReview: true,
      },
    });
    await db.delivery.update({ where: { id: delivery.id }, data: { appliedThroughSequence: 1 } });
    await assert.rejects(
      create({ supersedesRunId: original }),
      (e) => e.code === 'DOWNLOAD_RETRY_NOT_READY',
    );
    await db.runEvent.update({ where: { id: event.id }, data: { recordedForReview: false } });
    assert.equal(
      (await create()).resourceId,
      original,
      'ordinary start still reuses cancelled daily source',
    );
    const source = await db.run.findUniqueOrThrow({ where: { id: original } });
    await db.run.update({ where: { id: original }, data: { cacheDay: '2000-01-01' } });
    await assert.rejects(
      create({ supersedesRunId: original }),
      (e) => e.code === 'DOWNLOAD_RETRY_INVALID',
    );
    await db.run.update({ where: { id: original }, data: { cacheDay: day } });
    other = await db.node.create({
      data: { name: 'other', host: '192.0.2.183', slot: { create: {} } },
    });
    await assert.rejects(
      createRun(
        db,
        { ...runInput, nodeId: other.id, supersedesRunId: original },
        admin.id,
        'v181',
        key(),
        now,
      ),
      (e) => e.code === 'DOWNLOAD_RETRY_INVALID',
    );
    const otherTask = await saveTaskPlan(
      db,
      { ...input, name: 'other config' },
      admin.id,
      'v181',
      key(),
    );
    await assert.rejects(
      create({ configVersionId: otherTask.currentVersionId, supersedesRunId: original }),
      (e) => e.code === 'DOWNLOAD_RETRY_INVALID',
    );
    await control('RETRY_DOWNLOAD');
    let detail = await taskPlanDetail(db, task.id);
    assert.equal(detail.task.latestCycle.downloadRetryOf, original);
    await Promise.all([tickTaskPlans(db, now), tickTaskPlans(db, now)]);
    detail = await taskPlanDetail(db, task.id);
    const retried = detail.task.latestCycle.downloadRunId;
    assert.ok(retried && retried !== original);
    assert.equal(
      (await db.run.findUniqueOrThrow({ where: { id: retried } })).supersedesRunId,
      original,
    );
    assert.equal(
      (await db.run.findUniqueOrThrow({ where: { id: original } })).status,
      source.status,
    );
    await control('STOP');
    await tickTaskPlans(db, now);
    assert.equal((await taskPlanDetail(db, task.id)).task.latestCycle.status, 'STOPPED');
    assert.equal(
      (await create({ supersedesRunId: original })).resourceId,
      retried,
      'same parent is idempotent even with another HTTP key',
    );
    assert.equal((await create()).resourceId, retried, 'ordinary daily reuse selects latest retry');
    assert.equal(await db.run.count({ where: { nodeId: node.id, purpose: 'DOWNLOAD' } }), 2);
    await finish(retried, 'CANCELLED');
    await control('NEW_ROUND');
    await tickTaskPlans(db, now);
    await tickTaskPlans(db, now);
    detail = await taskPlanDetail(db, task.id);
    assert.equal(detail.task.latestCycle.errorCode, 'DOWNLOAD_STOPPED');
    assert.equal(detail.task.latestCycle.status, 'STOPPED');
  } finally {
    const nodeIds = [node?.id, other?.id].filter(Boolean);
    const tasks = await db.managedTask.findMany({ where: { nodeId: { in: nodeIds } } });
    const configIds = tasks.map((t) => t.configId);
    await db.runEvent.deleteMany({ where: { delivery: { run: { nodeId: { in: nodeIds } } } } });
    await db.delivery.deleteMany({ where: { run: { nodeId: { in: nodeIds } } } });
    await db.nodeSlot.deleteMany({ where: { nodeId: { in: nodeIds } } });
    await db.run.deleteMany({ where: { nodeId: { in: nodeIds } } });
    await db.managedCycle.deleteMany({ where: { taskId: { in: tasks.map((t) => t.id) } } });
    await db.managedTask.deleteMany({ where: { id: { in: tasks.map((t) => t.id) } } });
    await db.configVersion.deleteMany({ where: { configId: { in: configIds } } });
    await db.configuration.deleteMany({ where: { id: { in: configIds } } });
    await db.node.deleteMany({ where: { id: { in: nodeIds } } });
    if (release) await db.release.delete({ where: { id: release.id } });
    await db.$disconnect();
  }
});
