import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import {
  nodeCapacity,
  capacityState,
  updateNodeCapacity,
  dailyOpenUsage,
  capacitySamples,
  digest,
  createSecret,
} from '@apk/platform';
import { prepareDailyPlan, beijingDay } from '../packages/platform/dist/daily-plan.js';
import { DEVICE_CATALOG, devicePlanIssues, deviceVariant, schemaIssues } from '@apk/contracts';
import { createApp } from '../apps/control-api/dist/app.js';
import { passwordHash } from '../apps/control-api/dist/auth.js';

test('capacity uses applied serial receipts, freezes shared daily usage and protects manual changes and extended plans', async () => {
  const db = new PrismaClient(),
    nodeId = randomUUID(),
    releaseId = randomUUID(),
    configId = randomUUID(),
    versionId = randomUUID(),
    day = beijingDay(new Date()),
    admission = new Date(day + 'T12:00:00+08:00');
  let app, base, secretId;
  const runs = [];
  try {
    const admin = await db.admin.findFirstOrThrow();
    await db.admin.update({
      where: { id: admin.id },
      data: { passwordHash: await passwordHash(process.env.P0_TEST_PASSWORD) },
    });
    const features = [
      'DOWNLOAD_V1',
      'REGISTRATION_V1',
      'DAILY_V1',
      'CONTENT_ISOLATION_V1',
      'APP_OPEN_V1',
      'APP_OPEN_PARALLEL_V1',
      'DEVICE_VARIANTS_V1',
      'DEVICE_SESSIONS_V1',
      'EXECUTION_CAPACITY_V1',
    ];
    await db.release.create({
      data: {
        id: releaseId,
        sha256: digest(releaseId),
        artifactName: 'agent-' + digest(releaseId) + '.tgz',
        manifest: { agentVersion: '0.14.0', features },
      },
    });
    await db.node.create({
      data: {
        id: nodeId,
        name: 'Capacity owned fixture',
        host: '192.0.2.117',
        agentVersion: '0.14.0',
        agentReleaseId: releaseId,
        lastSeenAt: new Date(),
        deploymentStatus: 'INSTALLED',
        downloadProtocol: '1.0',
        registrationProtocol: '1.0',
        slot: { create: {} },
        health: {
          android: true,
          kvm: true,
          download: true,
          versions: {
            identityModels: '30',
            identityCatalog: JSON.stringify([
              'phone-01',
              'phone-08',
              'phone-25',
              ...DEVICE_CATALOG.map((x) => x.id),
            ]),
            identityAbis: JSON.stringify(
              Object.fromEntries(DEVICE_CATALOG.map((x) => [x.id, ['x86_64']])),
            ),
          },
        },
      },
    });
    secretId = (
      await createSecret(
        db,
        {
          type: 'HTTP_PROXY',
          secretValue: {
            host: 'proxy.example.test',
            port: 10000,
            username: 'OwnedFixture',
            password: 'FixtureOnlyPassword123',
          },
        },
        admin.id,
        'capacity-fixture',
      )
    ).id;
    const config = JSON.parse(
      await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
    );
    config.execution.proxySecretVersionId = secretId;
    config.execution.appOpen = {
      dwellMs: 10000,
      concurrency: 1,
      randomDeviceProfile: true,
      appsPerDevice: { min: 8, max: 100 },
    };
    await db.configuration.create({
      data: {
        id: configId,
        name: 'Capacity fixture',
        versions: {
          create: {
            id: versionId,
            version: 1,
            body: config,
            configHash: digest(JSON.stringify(config)),
            createdBy: admin.id,
          },
        },
      },
    });
    async function createRun(data) {
      const r = await db.run.create({
        data: { nodeId, releaseId, configVersionId: versionId, cacheDay: day, ...data },
      });
      runs.push(r.id);
      return r;
    }
    const source = await createRun({ purpose: 'DOWNLOAD', status: 'SUCCEEDED' });
    for (let i = 0; i < 37; i++)
      await db.task.create({
        data: {
          id: randomUUID(),
          runId: source.id,
          position: i,
          targetKey: digest('capacity-' + i),
          label: 'Owned fixture ' + i,
          sourceUrl: config.source.url,
          status: 'SUCCEEDED',
          proof: 'FILE_VALIDATION',
          apk: {
            packageName: 'com.example.cap' + i,
            versionName: '1',
            versionCode: 1,
            abis: [],
            minSdkVersion: 26,
            size: 10,
            apkSha256: digest('bytes' + i),
            cacheDay: day,
          },
        },
      });
    const sessions = [{ id: randomUUID() }, { id: randomUUID() }];
    const perf = await createRun({
      purpose: 'REGISTER',
      status: 'SUCCEEDED',
      createdAt: new Date(Date.now() - 700000),
      finishedAt: new Date(Date.now() - 100000),
      successTarget: 20,
      attemptLimit: 20,
      attemptsStarted: 20,
      successes: 20,
      executionPlan: { openPolicy: { concurrency: 1, sessions } },
    });
    const delivery = await db.delivery.create({
      data: {
        runId: perf.id,
        bootId: randomUUID(),
        fence: 1,
        ackDeadline: new Date(),
        leaseExpiresAt: new Date(),
        appliedThroughSequence: 24,
      },
    });
    for (let i = 1; i <= 24; i++) {
      const group = Math.floor((i - 1) / 12),
        pos = (i - 1) % 12;
      await db.runEvent.create({
        data: {
          id: randomUUID(),
          deliveryId: delivery.id,
          sequence: i,
          contentHash: digest('cap-event' + i),
          body:
            pos === 0 || pos === 11
              ? {
                  type: 'DEVICE_SESSION',
                  payload: {
                    sessionId: sessions[group].id,
                    phase: pos === 0 ? 'STARTED' : 'CLOSED',
                    cleanupComplete: pos === 11,
                  },
                }
              : {
                  type: 'TASK_FINISHED',
                  payload: {
                    status: 'SUCCEEDED',
                    proof: 'APP_OPEN',
                    openTimings: {
                      version: 1,
                      totalMs: 50000,
                      steps: [
                        {
                          name: pos === 1 ? 'EMULATOR_BOOT' : 'FOREGROUND_DWELL',
                          startedMs: 0,
                          elapsedMs: pos === 1 ? 35000 : 10000,
                          outcome: 'SUCCEEDED',
                        },
                      ],
                    },
                  },
                },
        },
      });
    }
    assert.equal((await capacitySamples(db, nodeId)).length, 1);
    const closeA = await db.runEvent.findUniqueOrThrow({
        where: { deliveryId_sequence: { deliveryId: delivery.id, sequence: 12 } },
      }),
      startB = await db.runEvent.findUniqueOrThrow({
        where: { deliveryId_sequence: { deliveryId: delivery.id, sequence: 13 } },
      });
    await db.runEvent.update({ where: { id: closeA.id }, data: { body: startB.body } });
    await db.runEvent.update({ where: { id: startB.id }, data: { body: closeA.body } });
    assert.equal(
      (await capacitySamples(db, nodeId)).length,
      0,
      'overlapping device receipts never become capacity samples',
    );
    await db.runEvent.update({ where: { id: closeA.id }, data: { body: closeA.body } });
    await db.runEvent.update({ where: { id: startB.id }, data: { body: startB.body } });
    const auto = await nodeCapacity(db, nodeId, { appsPerDeviceMin: '8' });
    assert.equal(auto.supported, true);
    assert.equal(auto.sampleRuns, 1);
    assert.ok(auto.recommendedLimit > 800);
    assert.deepEqual(schemaIssues('NodeCapacityView', auto), []);
    await db.delivery.update({ where: { id: delivery.id }, data: { appliedThroughSequence: 22 } });
    assert.equal((await capacitySamples(db, nodeId)).length, 0);
    await db.delivery.update({ where: { id: delivery.id }, data: { appliedThroughSequence: 24 } });
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    assert.equal(
      (await fetch(base + '/api/v1/nodes/' + nodeId + '/execution-capacity')).status,
      401,
    );
    const login = await fetch(base + '/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: process.env.APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: admin.username, password: process.env.P0_TEST_PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0],
      csrf = (await login.json()).csrfToken;
    const call = (body, version = 1, key = randomUUID(), csrfValue = csrf) =>
      fetch(base + '/api/v1/nodes/' + nodeId + '/execution-capacity', {
        method: 'PUT',
        headers: {
          cookie,
          origin: process.env.APP_ORIGIN,
          'content-type': 'application/json',
          'x-csrf-token': csrfValue,
          'if-match': String(version),
          'idempotency-key': key,
        },
        body: JSON.stringify(body),
      });
    assert.equal((await call({ dailyLimit: 2500 }, 1, randomUUID(), 'bad')).status, 403);
    assert.equal((await call({ dailyLimit: 8641 })).status, 422);
    const key = randomUUID(),
      first = await call({ dailyLimit: 2500 }, 1, key);
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    const saved = await first.json();
    assert.equal(saved.manualLimit, 2500);
    assert.equal((await call({ dailyLimit: 2500 }, 1, key)).status, 200);
    assert.equal((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).version, 2);
    assert.equal((await call({ dailyLimit: 2600 }, 1)).status, 409);
    await db.nodeSlot.update({ where: { nodeId }, data: { runId: source.id } });
    assert.equal((await call({ dailyLimit: 2600 }, 2)).status, 409);
    await db.nodeSlot.update({ where: { nodeId }, data: { runId: null } });
    const version = await db.configVersion.findUniqueOrThrow({ where: { id: versionId } }),
      input = {
        nodeId,
        purpose: 'REGISTER',
        sourceDownloadId: source.id,
        successTarget: 2000,
        attemptLimit: 2000,
      };
    const plan = await db.$transaction((tx) => prepareDailyPlan(tx, input, version, admission));
    assert.equal(plan.openPolicy.capacityVersion, 1);
    assert.equal(plan.openPolicy.dailyLimit, 2500);
    assert.deepEqual(devicePlanIssues(config, plan), []);
    assert.deepEqual(
      [...new Set(plan.openPolicy.sessions.map((s) => deviceVariant(s.variantId).apiLevel))].sort(),
      [34, 35, 36],
    );
    assert.ok(
      plan.openPolicy.sessions.every(
        (s) =>
          s.assetIndexes.length <= 37 && new Set(s.assetIndexes).size === s.assetIndexes.length,
      ),
    );
    assert.equal(plan.openPolicy.sessions.flatMap((s) => s.assetIndexes).length, 2000);
    const spent = await createRun({
      purpose: 'REGISTER',
      status: 'FAILED',
      successTarget: 2000,
      attemptLimit: 2000,
      attemptsStarted: 300,
      executionPlan: plan,
    });
    assert.ok(spent.id);
    await updateNodeCapacity(
      db,
      nodeId,
      { dailyLimit: null },
      2,
      admin.id,
      'capacity-auto',
      randomUUID(),
    );
    const frozen = await nodeCapacity(db, nodeId, { appsPerDeviceMin: '8' });
    assert.equal(frozen.mode, 'AUTO');
    assert.equal(frozen.limit, 2500);
    assert.equal(frozen.used, 320);
    assert.equal(frozen.remaining, 2180);
    assert.equal(frozen.frozen, true);
    const next = beijingDay(new Date(admission.getTime() + 86400000));
    assert.equal((await capacityState(db, nodeId, next, 8)).used, 0);
    assert.equal((await dailyOpenUsage(db, nodeId, day, config)).used, 320);
    const smaller = structuredClone(config);
    smaller.execution.appOpen.appsPerDevice.min = 38;
    const badVersion = { ...version, body: smaller };
    await assert.rejects(
      db.$transaction((tx) =>
        prepareDailyPlan(
          tx,
          { ...input, successTarget: 20, attemptLimit: 20 },
          badVersion,
          admission,
        ),
      ),
      (e) => e.code === 'APK_POOL_INSUFFICIENT',
    );
    await db.node.update({ where: { id: nodeId }, data: { agentVersion: '0.13.3' } });
    await assert.rejects(
      db.$transaction((tx) => prepareDailyPlan(tx, input, version, admission)),
      (e) => e.code === 'NODE_UPGRADE_REQUIRED',
    );
    for (const executionPlan of [
      undefined,
      { openPolicy: { capacityVersion: 1, concurrency: 1, dailyLimit: 1000 } },
    ])
      await assert.rejects(
        db.run.create({
          data: {
            nodeId,
            purpose: 'REGISTER',
            successTarget: 2000,
            attemptLimit: 2000,
            ...(executionPlan ? { executionPlan } : {}),
          },
        }),
      );
    await db.node.update({ where: { id: nodeId }, data: { archivedAt: new Date() } });
    assert.equal(
      (await dailyOpenUsage(db, nodeId, day, config)).used,
      320,
      'archiving retains historical usage',
    );
  } finally {
    await app?.close();
    await db.runEvent.deleteMany({ where: { delivery: { runId: { in: runs } } } });
    await db.delivery.deleteMany({ where: { runId: { in: runs } } });
    await db.task.deleteMany({ where: { runId: { in: runs } } });
    await db.nodeSlot.deleteMany({ where: { nodeId } });
    await db.run.deleteMany({ where: { id: { in: runs } } });
    await db.configVersion.deleteMany({ where: { configId } });
    await db.configuration.deleteMany({ where: { id: configId } });
    await db.node.deleteMany({ where: { id: nodeId } });
    await db.release.deleteMany({ where: { id: releaseId } });
    if (secretId) await db.secretVersion.deleteMany({ where: { id: secretId } });
    await db.$disconnect();
  }
});
