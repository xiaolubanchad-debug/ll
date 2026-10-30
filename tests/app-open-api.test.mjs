import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  runEvents,
  runTimeline,
  runSummary,
  registrationRecords,
  storeAccount,
  digest,
  acceptRun,
} from '@apk/platform';

test('open completion cannot create account success or accept registration/legacy proofs', async () => {
  const db = new PrismaClient(),
    nodeId = randomUUID(),
    releaseId = randomUUID(),
    configId = randomUUID(),
    versionId = randomUUID(),
    runId = randomUUID(),
    taskId = randomUUID(),
    deliveryId = randomUUID(),
    bootId = randomUUID(),
    token = randomBytes(32).toString('base64url');
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.app-open.valid.json', 'utf8'),
  );
  const apk = {
    packageName: 'com.example.owned',
    versionName: '1',
    versionCode: 1,
    abis: [],
    size: 10,
    apkSha256: 'a'.repeat(64),
    cacheDay: '2026-10-30',
  };
  const observation = {
    profileId: config.execution.deviceProfiles[0].id,
    avdName: 'owned_fixture',
    apiLevel: 35,
    model: 'Owned fixture',
    locale: 'en-US',
    shellAndroidIdHash: 'b'.repeat(64),
    androidIdScope: 'SHELL_NOT_APP',
    proxyObservedIp: '93.184.216.34',
    proxyObservedAt: new Date().toISOString(),
    proxyIpScope: 'PROBE_ONLY',
    appUserAgent: 'UNVERIFIED',
    identitySource: 'EMULATOR_NOT_REAL_DEVICE',
  };
  try {
    await db.release.create({
      data: {
        id: releaseId,
        artifactName: 'agent-' + digest(releaseId) + '.tgz',
        sha256: digest(releaseId),
        manifest: { agentVersion: '0.10.0', features: ['CONTENT_ISOLATION_V1', 'APP_OPEN_V1'] },
      },
    });
    await db.node.create({
      data: {
        id: nodeId,
        name: 'Owned app-open fixture',
        host: '192.0.2.112',
        agentVersion: '0.10.0',
        agentReleaseId: releaseId,
        slot: { create: { fence: 1 } },
      },
    });
    await db.agentCredential.create({
      data: { nodeId, tokenHash: digest(token), releaseId, bootId },
    });
    await db.configuration.create({ data: { id: configId, name: 'Owned app-open fixture' } });
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
        attemptsStarted: 1,
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
        label: 'Owned APK',
        sourceUrl: 'https://example.test/',
        targetKey: digest(taskId),
        status: 'LAUNCHING',
        apk,
        observation,
        attemptStarted: true,
      },
    });
    let sequence = 1;
    const send = (type, payload) =>
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
            type,
            payload,
          },
        ],
      });
    const success = {
      status: 'SUCCEEDED',
      proof: 'APP_OPEN',
      artifactIds: [],
      openTimings: JSON.parse(await readFile('contracts/fixtures/open-timings.valid.json', 'utf8')),
      openObservation: {
        dwellMs: 10000,
        elapsedMs: 10021,
        samples: 11,
        scope: 'FOREGROUND_POLL_ONLY',
        cleanupComplete: true,
      },
    };
    await assert.rejects(send('TASK_FINISHED', success), (e) => e.code === 'EVENT_CONFLICT');
    await assert.rejects(
      send('TASK_STAGE', { stage: 'REGISTERING' }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    await assert.rejects(
      send('APP_OBSTRUCTION', { action: 'CLOSE_POPUP', method: 'CONTROLS', index: 1 }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    await assert.rejects(
      storeAccount(db, token, taskId, {
        kind: 'account',
        protocolVersion: '1.0',
        nodeId,
        deliveryId,
        fence: 1,
        taskId,
        accountRef: randomUUID(),
        username: 'owneduser',
        password: 'Owned1234',
      }),
      (e) => e.code === 'FEATURE_UNAVAILABLE',
    );
    await send('TASK_STAGE', { stage: 'HOLDING' });
    sequence++;
    await assert.rejects(
      send('TASK_FINISHED', { status: 'SUCCEEDED', proof: 'FILE_VALIDATION', artifactIds: [] }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    await db.node.update({ where: { id: nodeId }, data: { agentVersion: '0.9.2' } });
    await assert.rejects(
      acceptRun(db, token, deliveryId, {
        kind: 'accept',
        protocolVersion: '1.0',
        nodeId,
        bootId,
        deliveryId,
        fence: 1,
      }),
      (e) => e.code === 'NODE_UPGRADE_REQUIRED',
    );
    await db.run.update({ where: { id: runId }, data: { purpose: 'DOWNLOAD' } });
    await assert.rejects(
      acceptRun(db, token, deliveryId, {
        kind: 'accept',
        protocolVersion: '1.0',
        nodeId,
        bootId,
        deliveryId,
        fence: 1,
      }),
      (e) => e.code === 'NODE_UPGRADE_REQUIRED',
    );
    await db.run.update({ where: { id: runId }, data: { purpose: 'REGISTER' } });
    await db.node.update({ where: { id: nodeId }, data: { agentVersion: '0.10.0' } });
    // Legacy versions cannot be changed into successful registrations using APP_OPEN evidence.
    const legacy = structuredClone(config);
    delete legacy.execution.appOpen;
    await db.configVersion.update({ where: { id: versionId }, data: { body: legacy } });
    await assert.rejects(send('TASK_FINISHED', success), (e) => e.code === 'EVENT_CONFLICT');
    await db.configVersion.update({ where: { id: versionId }, data: { body: config } });
    const invalidTiming = structuredClone(success);
    invalidTiming.openTimings.steps.push(invalidTiming.openTimings.steps[0]);
    await assert.rejects(send('TASK_FINISHED', invalidTiming));
    await send('TASK_FINISHED', success);
    sequence++;
    assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).successes, 1);
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } });
    assert.equal(task.registrationStartedAt, null);
    assert.equal(task.accountRef, null);
    assert.equal(task.submissionId, null);
    assert.equal(await db.accountResult.count({ where: { taskId } }), 0);
    assert.equal((await registrationRecords(db, { runId })).items.length, 0);
    assert.equal((await runSummary(db, runId)).executionKind, 'APP_OPEN');
    assert.ok(
      (await runTimeline(db, runId, {})).items.some(
        (e) => e.title === 'APP 启动停留 10 秒并清理完成',
      ),
    );
    assert.deepEqual(
      (await runTimeline(db, runId, {})).items.find((e) => e.type === 'TASK_FINISHED').openTimings,
      success.openTimings,
    );
    await send('RUN_FINISHED', { status: 'SUCCEEDED' });
    assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).status, 'SUCCEEDED');
  } finally {
    await db.runEvent.deleteMany({ where: { deliveryId } });
    await db.accountResult.deleteMany({ where: { deliveryId } });
    await db.task.deleteMany({ where: { runId } });
    await db.delivery.deleteMany({ where: { id: deliveryId } });
    await db.run.deleteMany({ where: { id: runId } });
    await db.nodeSlot.deleteMany({ where: { nodeId } });
    await db.agentCredential.deleteMany({ where: { nodeId } });
    await db.node.deleteMany({ where: { id: nodeId } });
    await db.configVersion.deleteMany({ where: { configId } });
    await db.configuration.deleteMany({ where: { id: configId } });
    await db.release.deleteMany({ where: { id: releaseId } });
    await db.$disconnect();
  }
});
