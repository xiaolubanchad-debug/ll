import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { runEvents, runTimeline, claimRun, acceptRun, digest } from '@apk/platform';

test('startup phases require their matching action, remain separate from registration, and settings reject old nodes', async () => {
  const db = new PrismaClient(),
    nodeId = randomUUID(),
    releaseId = randomUUID(),
    configId = randomUUID(),
    versionId = randomUUID(),
    runId = randomUUID(),
    deliveryId = randomUUID(),
    taskId = randomUUID(),
    bootId = randomUUID(),
    token = randomBytes(32).toString('base64url');
  const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
  config.execution.autoRegistration = {
    enabled: true,
    screenshotFallback: true,
    maxNavigationSteps: 8,
    timeoutMs: 60000,
    successTimeoutMs: 60000,
    startup: { confirmationTimeoutMs: 3000 },
  };
  try {
    await db.release.create({
      data: {
        id: releaseId,
        artifactName: 'agent-' + digest(releaseId) + '.tgz',
        sha256: digest(releaseId),
        manifest: {
          agentVersion: '0.9.0',
          features: ['DOWNLOAD_V1', 'REGISTRATION_V1', 'CONTENT_ISOLATION_V1', 'APP_READINESS_V1'],
        },
      },
    });
    await db.node.create({
      data: {
        id: nodeId,
        name: 'Owned startup policy',
        host: '192.0.2.111',
        agentVersion: '0.9.0',
        agentReleaseId: releaseId,
        downloadProtocol: '1.0',
        slot: { create: { fence: 1 } },
      },
    });
    await db.agentCredential.create({
      data: { nodeId, tokenHash: digest(token), releaseId, bootId },
    });
    await db.configuration.create({ data: { id: configId, name: 'Owned startup fixture' } });
    await db.configVersion.create({
      data: {
        id: versionId,
        configId,
        version: 1,
        body: config,
        configHash: digest(JSON.stringify(config)),
        createdBy: randomUUID(),
      },
    });
    await db.run.create({
      data: {
        id: runId,
        nodeId,
        releaseId,
        configVersionId: versionId,
        status: 'RUNNING',
        discovered: true,
        purpose: 'REGISTER',
        successTarget: 1,
        attemptLimit: 1,
      },
    });
    await db.nodeSlot.update({ where: { nodeId }, data: { runId } });
    await db.delivery.create({
      data: {
        id: deliveryId,
        runId,
        bootId,
        fence: 1,
        acceptedAt: new Date(),
        ackDeadline: new Date(Date.now() + 30000),
        leaseExpiresAt: new Date(Date.now() + 120000),
      },
    });
    await db.task.create({
      data: {
        id: taskId,
        runId,
        position: 0,
        label: 'Owned popup',
        sourceUrl: 'https://example.test/',
        targetKey: digest(taskId),
        status: 'LAUNCHING',
      },
    });
    let sequence = 1;
    const send = (payload) =>
      runEvents(db, token, {
        kind: 'events',
        protocolVersion: '1.0',
        nodeId,
        deliveryId,
        fence: 1,
        events: [
          {
            eventId: randomUUID(),
            runId,
            taskId,
            sequence,
            occurredAt: new Date().toISOString(),
            type: 'APP_OBSTRUCTION',
            payload,
          },
        ],
      });
    const base = { action: 'CLOSE_POPUP', method: 'ICON', index: 1 };
    await assert.rejects(send({ ...base, phase: 'CLEARED' }), (e) => e.code === 'EVENT_CONFLICT');
    assert.equal(await db.runEvent.count({ where: { deliveryId } }), 0);
    for (const phase of ['DETECTED', 'ACTION_SENT', 'WAITING', 'CLEARED']) {
      await send({ ...base, phase });
      sequence++;
    }
    await assert.rejects(
      send({ ...base, phase: 'ACTION_SENT' }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    await assert.rejects(send({ ...base, phase: 'CLEARED' }), (e) => e.code === 'EVENT_CONFLICT');
    await send({ action: 'CLOSE_AD', method: 'CONTROLS', index: 2 });
    sequence++;
    await send({ action: 'WAIT_OVERLAY', method: 'CONTROLS', index: 3, phase: 'WAITING' });
    sequence++;
    const load = { action: 'RETRY_LOAD', method: 'CONTROLS', index: 4 };
    for (const phase of ['DETECTED', 'ACTION_SENT', 'WAITING', 'CLEARED']) {
      await send({ ...load, phase });
      sequence++;
    }
    await send({ ...load, index: 5, phase: 'DETECTED' });
    sequence++;
    await assert.rejects(
      send({ ...load, index: 5, phase: 'ACTION_SENT' }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    await db.task.update({ where: { id: taskId }, data: { status: 'REGISTERING' } });
    await assert.rejects(
      send({ ...load, index: 6, phase: 'DETECTED' }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    await db.task.update({ where: { id: taskId }, data: { status: 'LAUNCHING' } });
    await db.accountResult.create({
      data: {
        accountRef: randomUUID(),
        taskId,
        deliveryId,
        fence: 1,
        contentHash: digest('owned-startup-account'),
        encrypted: { fixture: true },
      },
    });
    await assert.rejects(
      send({ ...load, index: 6, phase: 'DETECTED' }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    await db.accountResult.deleteMany({ where: { taskId } });
    const timeline = await runTimeline(db, runId, {});
    assert.ok(timeline.items.some((e) => e.title === '已执行关闭弹窗，正在核对'));
    assert.ok(timeline.items.some((e) => e.title === '已确认遮挡消失：关闭弹窗'));
    assert.ok(timeline.items.some((e) => e.title === '已执行关闭广告，关闭结果未核对'));
    assert.ok(timeline.items.some((e) => e.title === '等待弹窗加载和稳定'));
    assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).successes, 0);
    await db.task.update({
      where: { id: taskId },
      data: { status: 'VERIFYING', submittedAt: new Date() },
    });
    await assert.rejects(
      send({ action: 'CLOSE_AD', method: 'CONTROLS', index: 3, phase: 'DETECTED' }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    await db.run.update({ where: { id: runId }, data: { status: 'CANCELLED' } });
    await db.nodeSlot.update({ where: { nodeId }, data: { runId: null } });
    const queued = await db.run.create({
      data: {
        nodeId,
        releaseId,
        configVersionId: versionId,
        status: 'QUEUED',
        purpose: 'REGISTER',
        successTarget: 1,
        attemptLimit: 1,
      },
    });
    await db.nodeSlot.update({ where: { nodeId }, data: { runId: queued.id } });
    await db.node.update({ where: { id: nodeId }, data: { agentVersion: '0.8.1' } });
    await assert.rejects(
      claimRun(db, token, { kind: 'claim', protocolVersion: '1.0', nodeId, bootId }),
      (e) => e.code === 'NODE_UPGRADE_REQUIRED',
    );
    await db.node.update({ where: { id: nodeId }, data: { agentVersion: '0.9.0' } });
    const assigned = await claimRun(db, token, {
      kind: 'claim',
      protocolVersion: '1.0',
      nodeId,
      bootId,
    });
    await db.node.update({ where: { id: nodeId }, data: { agentVersion: '0.8.1' } });
    await assert.rejects(
      acceptRun(db, token, assigned.deliveryId, {
        kind: 'accept',
        protocolVersion: '1.0',
        nodeId,
        bootId,
        deliveryId: assigned.deliveryId,
        fence: assigned.fence,
      }),
      (e) => e.code === 'NODE_UPGRADE_REQUIRED',
    );
  } finally {
    const runs = (await db.run.findMany({ where: { nodeId }, select: { id: true } })).map(
        (r) => r.id,
      ),
      ds = (
        await db.delivery.findMany({ where: { runId: { in: runs } }, select: { id: true } })
      ).map((d) => d.id);
    await db.runEvent.deleteMany({ where: { deliveryId: { in: ds } } });
    await db.accountResult.deleteMany({ where: { deliveryId: { in: ds } } });
    await db.task.deleteMany({ where: { runId: { in: runs } } });
    await db.delivery.deleteMany({ where: { id: { in: ds } } });
    await db.run.deleteMany({ where: { id: { in: runs } } });
    await db.nodeSlot.deleteMany({ where: { nodeId } });
    await db.agentCredential.deleteMany({ where: { nodeId } });
    await db.node.deleteMany({ where: { id: nodeId } });
    await db.configVersion.deleteMany({ where: { configId } });
    await db.configuration.deleteMany({ where: { id: configId } });
    await db.release.deleteMany({ where: { id: releaseId } });
    await db.$disconnect();
  }
});
