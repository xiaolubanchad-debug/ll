import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  runEvents,
  runSummary,
  dailyOpenUsage,
  openAdmissionDeadline,
  acceptRun,
  reconcileAgent,
  digest,
} from '@apk/platform';
import { prepareDailyPlan, beijingDay } from '../packages/platform/dist/daily-plan.js';

test('parallel receipts enforce shared N/M, daily total, cutoff and fixed policy', async () => {
  const db = new PrismaClient(),
    nodeId = randomUUID(),
    releaseId = randomUUID(),
    configId = randomUUID(),
    versionId = randomUUID(),
    bootId = randomUUID(),
    token = randomBytes(32).toString('base64url');
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
  );
  const day = beijingDay(new Date()),
    deadline = openAdmissionDeadline(day);
  // These tests need a normal admission window independently of the host clock.
  const admission = new Date(day + 'T12:00:00+08:00');
  const apk = {
    packageName: 'com.example.parallel',
    versionName: '1',
    versionCode: 1,
    abis: [],
    size: 10,
    apkSha256: 'a'.repeat(64),
    cacheDay: day,
  };
  const observation = {
    profileId: config.execution.deviceProfiles[0].id,
    avdName: 'p3_' + randomUUID().replaceAll('-', ''),
    apiLevel: 35,
    model: 'Owned parallel fixture',
    locale: 'en-US',
    shellAndroidIdHash: 'b'.repeat(64),
    androidIdScope: 'SHELL_NOT_APP',
    proxyIpScope: 'NOT_CHECKED',
    appUserAgent: 'UNVERIFIED',
    identitySource: 'EMULATOR_NOT_REAL_DEVICE',
  };
  let batch;
  async function make(n, m) {
    const runId = randomUUID(),
      deliveryId = randomUUID(),
      tasks = Array.from({ length: m }, () => randomUUID());
    const plan = {
      purpose: 'REGISTER',
      cacheDay: day,
      successTarget: n,
      attemptLimit: m,
      assets: [{ targetKey: 'c'.repeat(64), label: 'Owned', sourceUrl: config.source.url, apk }],
      openPolicy: { concurrency: 2, dailyLimit: 800, admissionDeadline: deadline },
    };
    await db.run.create({
      data: {
        id: runId,
        nodeId,
        releaseId,
        configVersionId: versionId,
        configHash: digest('fixture'),
        cacheDay: day,
        status: 'RUNNING',
        discovered: true,
        purpose: 'REGISTER',
        successTarget: n,
        attemptLimit: m,
        executionPlan: plan,
      },
    });
    await db.nodeSlot.update({ where: { nodeId }, data: { runId, quarantined: false } });
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
        label: 'Owned',
        sourceUrl: config.source.url,
      })),
    });
    let seq = 1;
    const event = (index, type, payload) => ({
      eventId: randomUUID(),
      runId,
      taskId: tasks[index],
      sequence: seq++,
      occurredAt: new Date().toISOString(),
      type,
      payload,
    });
    const deliver = (e) =>
      runEvents(db, token, {
        kind: 'events',
        protocolVersion: '1.0',
        nodeId,
        deliveryId,
        fence: 1,
        events: [e],
      });
    const send = async (index, type, payload) => {
      const e = event(index, type, payload);
      try {
        return await deliver(e);
      } catch (error) {
        seq--;
        throw error;
      }
    };
    return { runId, deliveryId, tasks, plan, event, deliver, send };
  }
  const success = {
    status: 'SUCCEEDED',
    proof: 'APP_OPEN',
    artifactIds: [],
    openObservation: {
      dwellMs: 10000,
      elapsedMs: 10011,
      samples: 11,
      scope: 'FOREGROUND_POLL_ONLY',
      cleanupComplete: true,
    },
  };
  const finish = async (i) => {
    for (const stage of ['DOWNLOADED', 'PREPARING', 'INSTALLING', 'LAUNCHING', 'HOLDING'])
      await batch.send(i, 'TASK_STAGE', {
        stage,
        ...(stage === 'DOWNLOADED' ? { cacheHit: true, apk } : {}),
        ...(stage === 'INSTALLING' ? { observation } : {}),
      });
    await batch.send(i, 'TASK_FINISHED', success);
  };
  try {
    await db.release.create({
      data: {
        id: releaseId,
        artifactName: 'agent-' + digest(releaseId) + '.tgz',
        sha256: digest(releaseId),
        manifest: {
          agentVersion: '0.11.0',
          features: ['CONTENT_ISOLATION_V1', 'APP_OPEN_V1', 'APP_OPEN_PARALLEL_V1'],
        },
      },
    });
    await db.node.create({
      data: {
        id: nodeId,
        name: 'Owned parallel node',
        host: '192.0.2.113',
        agentVersion: '0.11.0',
        agentReleaseId: releaseId,
        slot: { create: { fence: 1 } },
      },
    });
    await db.agentCredential.create({
      data: { nodeId, tokenHash: digest(token), releaseId, bootId },
    });
    await db.configuration.create({ data: { id: configId, name: 'Owned parallel configuration' } });
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
    batch = await make(3, 5);
    // Receipt-time cutoff is tested below; normal stages use a future boundary in the fixture.
    if (Date.now() >= Date.parse(deadline)) {
      batch.plan.openPolicy.admissionDeadline = new Date(Date.now() + 3600000).toISOString();
      await db.run.update({ where: { id: batch.runId }, data: { executionPlan: batch.plan } });
    }
    await Promise.all([
      batch.deliver(batch.event(0, 'TASK_STAGE', { stage: 'DOWNLOADING' })),
      batch.deliver(batch.event(1, 'TASK_STAGE', { stage: 'DOWNLOADING' })),
    ]);
    await assert.rejects(
      batch.send(2, 'TASK_STAGE', { stage: 'DOWNLOADING' }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    const view = await runSummary(db, batch.runId);
    assert.equal(view.concurrency, 2);
    assert.equal(view.activeTasks.length, 2);
    await finish(0);
    await batch.send(2, 'TASK_STAGE', { stage: 'DOWNLOADING' });
    await finish(2);
    await assert.rejects(
      batch.send(3, 'TASK_STAGE', { stage: 'DOWNLOADING' }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    await finish(1);
    await batch.send(0, 'RUN_FINISHED', { status: 'SUCCEEDED' });
    const r = await db.run.findUniqueOrThrow({ where: { id: batch.runId } });
    assert.equal(r.successes, 3);
    assert.equal(r.attemptsStarted, 3);
    assert.equal((await dailyOpenUsage(db, nodeId, day)).used, 3);
    assert.equal(await db.accountResult.count({ where: { taskId: { in: batch.tasks } } }), 0);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: batch.tasks[3] } })).errorCode,
      'QUOTA_NOT_USED',
    );

    batch = await make(1, 1);
    await db.node.update({ where: { id: nodeId }, data: { agentVersion: '0.10.0' } });
    await assert.rejects(
      acceptRun(db, token, batch.deliveryId, {
        kind: 'accept',
        protocolVersion: '1.0',
        nodeId,
        bootId,
        deliveryId: batch.deliveryId,
        fence: 1,
      }),
      (e) => e.code === 'NODE_UPGRADE_REQUIRED',
    );
    await db.node.update({ where: { id: nodeId }, data: { agentVersion: '0.11.0' } });
    const wrong = structuredClone(batch.plan);
    wrong.openPolicy.concurrency = 3;
    await db.run.update({ where: { id: batch.runId }, data: { executionPlan: wrong } });
    await assert.rejects(
      acceptRun(db, token, batch.deliveryId, {
        kind: 'accept',
        protocolVersion: '1.0',
        nodeId,
        bootId,
        deliveryId: batch.deliveryId,
        fence: 1,
      }),
      (e) => e.code === 'OPEN_POLICY_INVALID',
    );
    const expired = structuredClone(batch.plan);
    expired.openPolicy.admissionDeadline = new Date(Date.now() - 1000).toISOString();
    await db.run.update({ where: { id: batch.runId }, data: { executionPlan: expired } });
    await assert.rejects(
      batch.send(0, 'TASK_STAGE', { stage: 'DOWNLOADING' }),
      (e) => e.code === 'DAY_CUTOFF',
    );
    await batch.send(0, 'RUN_FINISHED', { status: 'FAILED', errorCode: 'DAY_CUTOFF' });
    assert.equal((await dailyOpenUsage(db, nodeId, day)).used, 3);

    const source = await db.run.create({
      data: {
        nodeId,
        releaseId,
        configVersionId: versionId,
        cacheDay: day,
        purpose: 'DOWNLOAD',
        status: 'SUCCEEDED',
        tasks: {
          create: {
            id: randomUUID(),
            label: 'Owned',
            position: 0,
            targetKey: digest('download'),
            sourceUrl: config.source.url,
            status: 'SUCCEEDED',
            proof: 'FILE_VALIDATION',
            apk,
          },
        },
      },
    });
    const version = await db.configVersion.findUniqueOrThrow({ where: { id: versionId } });
    const input = {
      nodeId,
      releaseId,
      configVersionId: versionId,
      purpose: 'REGISTER',
      sourceDownloadId: source.id,
      successTarget: 3,
      attemptLimit: 5,
    };
    const plan = await db.$transaction((tx) => prepareDailyPlan(tx, input, version, admission));
    assert.equal(plan.openPolicy.concurrency, 1);
    assert.equal(plan.openPolicy.admissionDeadline, deadline);
    const variantConfig = structuredClone(config);
    variantConfig.execution.appOpen.randomDeviceProfile = true;
    await db.node.update({
      where: { id: nodeId },
      data: { agentVersion: '0.12.0', health: { versions: { identityModels: '3' } } },
    });
    const release = await db.release.findUniqueOrThrow({ where: { id: releaseId } });
    await db.release.update({
      where: { id: releaseId },
      data: {
        manifest: {
          ...release.manifest,
          features: [...release.manifest.features, 'DEVICE_VARIANTS_V1'],
        },
      },
    });
    const variantVersion = { ...version, body: variantConfig };
    const variants = await db.$transaction((tx) =>
      prepareDailyPlan(tx, { ...input, attemptLimit: 3 }, variantVersion, admission),
    );
    assert.equal(new Set(variants.openPolicy.variantIds).size, 3);
    await assert.rejects(
      db.$transaction((tx) =>
        prepareDailyPlan(tx, { ...input, attemptLimit: 4 }, variantVersion, admission),
      ),
      (e) => e.code === 'IDENTITY_POOL_EXHAUSTED',
    );
    await db.run.create({
      data: {
        nodeId,
        releaseId,
        configVersionId: versionId,
        cacheDay: day,
        purpose: 'REGISTER',
        status: 'FAILED',
        successTarget: 1,
        attemptLimit: 797,
        attemptsStarted: 797,
      },
    });
    const budget = await dailyOpenUsage(db, nodeId, day);
    assert.equal(budget.used, 800);
    assert.equal(budget.remaining, 0);
    await assert.rejects(
      db.$transaction((tx) => prepareDailyPlan(tx, input, version, admission)),
      (e) => e.code === 'DAILY_OPEN_LIMIT',
    );
    const next = new Date(admission.getTime() + 86400000);
    assert.equal((await dailyOpenUsage(db, nodeId, beijingDay(next))).used, 0);
    // Archiving does not remove the server's consumed allowance.
    await db.configuration.update({ where: { id: configId }, data: { archivedAt: new Date() } });
    assert.equal((await dailyOpenUsage(db, nodeId, day)).used, 800);
    await reconcileAgent(db, token, {
      protocolVersion: '1.0',
      nodeId,
      bootId,
      deliveries: [],
      cleanupComplete: false,
    });
    assert.equal((await db.nodeSlot.findUniqueOrThrow({ where: { nodeId } })).quarantined, true);
  } finally {
    const runs = (await db.run.findMany({ where: { nodeId }, select: { id: true } })).map(
      (r) => r.id,
    );
    await db.runEvent.deleteMany({ where: { delivery: { runId: { in: runs } } } });
    await db.accountResult.deleteMany({ where: { delivery: { runId: { in: runs } } } });
    await db.task.deleteMany({ where: { runId: { in: runs } } });
    await db.delivery.deleteMany({ where: { runId: { in: runs } } });
    await db.run.deleteMany({ where: { nodeId } });
    await db.nodeSlot.deleteMany({ where: { nodeId } });
    await db.agentCredential.deleteMany({ where: { nodeId } });
    await db.node.deleteMany({ where: { id: nodeId } });
    await db.configVersion.deleteMany({ where: { configId } });
    await db.configuration.deleteMany({ where: { id: configId } });
    await db.release.deleteMany({ where: { id: releaseId } });
    await db.$disconnect();
  }
});
