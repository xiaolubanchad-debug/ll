import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { runEvents, digest, runTimeline, runSummary } from '@apk/platform';
import { beijingDay } from '../packages/platform/dist/daily-plan.js';

test('database enforces grouped app order, allocated identity, uninstall scope and whole-device cleanup', async () => {
  const db = new PrismaClient(),
    nodeId = randomUUID(),
    releaseId = randomUUID(),
    configId = randomUUID(),
    versionId = randomUUID(),
    runId = randomUUID(),
    deliveryId = randomUUID(),
    bootId = randomUUID(),
    token = randomBytes(32).toString('base64url');
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
  );
  config.execution.appOpen.appsPerDevice = { min: 2, max: 2 };
  config.execution.appOpen.randomDeviceProfile = true;
  const day = beijingDay(new Date()),
    tasks = Array.from({ length: 4 }, () => randomUUID());
  const assets = [0, 1].map((i) => ({
    targetKey: digest('asset' + i),
    label: 'APP ' + i,
    sourceUrl: config.source.url,
    apk: {
      packageName: 'com.example.app' + i,
      versionName: '1',
      versionCode: 1,
      abis: [],
      minSdkVersion: 26,
      size: 10,
      apkSha256: digest('bytes' + i),
      cacheDay: day,
    },
  }));
  const sessions = [
    { id: randomUUID(), variantId: 'phone-01', assetIndexes: [1, 0] },
    { id: randomUUID(), variantId: 'phone-02', assetIndexes: [0, 1] },
  ];
  const plan = {
    purpose: 'REGISTER',
    cacheDay: day,
    successTarget: 4,
    attemptLimit: 4,
    assets,
    openPolicy: {
      concurrency: 2,
      dailyLimit: 800,
      admissionDeadline: new Date(Date.now() + 3600000).toISOString(),
      sessions,
    },
  };
  let seq = 1;
  async function send(index, type, payload) {
    const e = {
      eventId: randomUUID(),
      runId,
      ...(index === null ? {} : { taskId: tasks[index] }),
      sequence: seq,
      occurredAt: new Date().toISOString(),
      type,
      payload,
    };
    const result = await runEvents(db, token, {
      kind: 'events',
      protocolVersion: '1.0',
      nodeId,
      deliveryId,
      fence: 1,
      events: [e],
    });
    seq++;
    return result;
  }
  const start = (id) =>
    send(null, 'DEVICE_SESSION', {
      sessionId: id,
      phase: 'STARTED',
      elapsedMs: 0,
      cleanupComplete: false,
    });
  const close = (id) =>
    send(null, 'DEVICE_SESSION', {
      sessionId: id,
      phase: 'CLOSED',
      elapsedMs: 100000,
      cleanupComplete: true,
    });
  async function finish(index) {
    const group = sessions[Math.floor(index / 2)],
      appIndex = index % 2,
      asset = assets[group.assetIndexes[appIndex]];
    const observation = {
      profileId: config.execution.deviceProfiles[0].id,
      avdName: 'p3_' + digest(group.id).slice(0, 32),
      apiLevel: 31,
      model: group.variantId === 'phone-01' ? '21081111RG' : '2107113SG',
      locale: 'en-US',
      shellAndroidIdHash: digest(group.id),
      androidIdScope: 'SHELL_NOT_APP',
      proxyIpScope: 'NOT_CHECKED',
      appUserAgent: 'UNVERIFIED',
      identitySource: 'EMULATOR_NOT_REAL_DEVICE',
      variantId: group.variantId,
      systemImageSha256: digest('image'),
      deviceSessionId: group.id,
      appIndex,
    };
    for (const stage of ['DOWNLOADED', 'PREPARING', 'INSTALLING', 'LAUNCHING', 'HOLDING'])
      await send(index, 'TASK_STAGE', {
        stage,
        ...(stage === 'DOWNLOADED' ? { apk: asset.apk, cacheHit: true } : {}),
        ...(stage === 'INSTALLING' ? { observation } : {}),
      });
    const payload = {
      status: 'SUCCEEDED',
      proof: 'APP_OPEN',
      artifactIds: [],
      openObservation: {
        dwellMs: 10000,
        elapsedMs: 10005,
        samples: 11,
        scope: 'FOREGROUND_POLL_ONLY',
        cleanupComplete: true,
        cleanupScope: 'APP_UNINSTALLED',
        deviceSessionId: group.id,
        appIndex,
      },
    };
    const bad = structuredClone(payload);
    delete bad.openObservation.cleanupScope;
    await assert.rejects(send(index, 'TASK_FINISHED', bad));
    await send(index, 'TASK_FINISHED', payload);
  }
  try {
    await db.release.create({
      data: {
        id: releaseId,
        artifactName: 'agent-' + digest(releaseId) + '.tgz',
        sha256: digest(releaseId),
        manifest: {
          agentVersion: '0.13.0',
          features: [
            'DOWNLOAD_V1',
            'REGISTRATION_V1',
            'CONTENT_ISOLATION_V1',
            'APP_OPEN_V1',
            'APP_OPEN_PARALLEL_V1',
            'DEVICE_VARIANTS_V1',
            'DEVICE_SESSIONS_V1',
          ],
        },
      },
    });
    await db.node.create({
      data: {
        id: nodeId,
        name: 'Owned session fixture',
        host: '192.0.2.115',
        agentVersion: '0.13.0',
        agentReleaseId: releaseId,
        health: { versions: { identityModels: '30' } },
        slot: { create: { fence: 1 } },
      },
    });
    await db.agentCredential.create({
      data: { nodeId, tokenHash: digest(token), releaseId, bootId },
    });
    await db.configuration.create({
      data: { id: configId, name: 'Grouped APP fixture' },
    });
    await db.configVersion.create({
      data: {
        id: versionId,
        configId,
        version: 1,
        body: config,
        configHash: digest('config'),
        createdBy: randomUUID(),
      },
    });
    await db.run.create({
      data: {
        id: runId,
        nodeId,
        releaseId,
        configVersionId: versionId,
        configHash: digest('config'),
        cacheDay: day,
        status: 'RUNNING',
        discovered: true,
        purpose: 'REGISTER',
        successTarget: 4,
        attemptLimit: 4,
        executionPlan: plan,
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
    await db.task.createMany({
      data: tasks.map((id, position) => ({
        id,
        runId,
        position,
        targetKey: digest(id),
        label: 'APP ' + position,
        sourceUrl: config.source.url,
      })),
    });
    await assert.rejects(send(0, 'TASK_STAGE', { stage: 'DOWNLOADING' }));
    await start(sessions[0].id);
    await start(sessions[1].id);
    await assert.rejects(start(sessions[0].id));
    await send(0, 'TASK_STAGE', { stage: 'DOWNLOADING' });
    await assert.rejects(send(1, 'TASK_STAGE', { stage: 'DOWNLOADING' }));
    await send(2, 'TASK_STAGE', { stage: 'DOWNLOADING' });
    await assert.rejects(close(sessions[0].id));
    await finish(2);
    await finish(0);
    await send(1, 'TASK_STAGE', { stage: 'DOWNLOADING' });
    await finish(1);
    await close(sessions[0].id);
    await send(3, 'TASK_STAGE', { stage: 'DOWNLOADING' });
    await finish(3);
    await assert.rejects(send(null, 'RUN_FINISHED', { status: 'SUCCEEDED' }));
    await close(sessions[1].id);
    await send(null, 'RUN_FINISHED', { status: 'SUCCEEDED' });
    const run = await db.run.findUniqueOrThrow({ where: { id: runId } });
    assert.equal(run.successes, 4);
    assert.equal(run.attemptsStarted, 4);
    assert.equal(run.status, 'SUCCEEDED');
    const summary = await runSummary(db, runId);
    assert.deepEqual(summary.deviceSessions, { started: 2, closed: 2, failed: 0, active: 0 });
    const timeline = await runTimeline(db, runId, {});
    assert.ok(timeline.items.some((e) => e.deviceSessionId === sessions[1].id && e.appIndex === 1));
    assert.ok(
      timeline.items.some((e) => e.type === 'DEVICE_SESSION' && e.title.includes('整机清理')),
    );
  } finally {
    await db.runEvent.deleteMany({ where: { deliveryId } });
    await db.task.deleteMany({ where: { runId } });
    await db.delivery.deleteMany({ where: { runId } });
    await db.nodeSlot.deleteMany({ where: { nodeId } });
    await db.agentCredential.deleteMany({ where: { nodeId } });
    await db.run.deleteMany({ where: { nodeId } });
    await db.configVersion.deleteMany({ where: { configId } });
    await db.configuration.deleteMany({ where: { id: configId } });
    await db.node.deleteMany({ where: { id: nodeId } });
    await db.release.deleteMany({ where: { id: releaseId } });
    await db.$disconnect();
  }
});
