import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  issueTestBootstrap,
  enrollTestClient,
  testDataPage,
  viewTestCredentials,
  digest,
  runEvents,
  runTimeline,
  openAdmissionDeadline,
} from '@apk/platform';
import { readFile } from 'node:fs/promises';
import { beijingDay } from '../packages/platform/dist/daily-plan.js';

test('owned APP accounts bind one installation, retain first request IP and remain separate from APP_OPEN proofs', async () => {
  const db = new PrismaClient(),
    nodeId = randomUUID(),
    runId = randomUUID(),
    taskId = randomUUID(),
    secondTask = randomUUID(),
    deliveryId = randomUUID(),
    configId = randomUUID(),
    versionId = randomUUID(),
    releaseId = randomUUID(),
    bootId = randomUUID(),
    auditRequest = randomUUID(),
    token = randomBytes(32).toString('base64url');
  const oldRoot = process.env.TEST_CLIENT_ROOT,
    root = await mkdtemp(resolve('.tmp/test-client-'));
  process.env.TEST_CLIENT_ROOT = root;
  const bytes = randomBytes(256),
    sha = digest(bytes);
  await writeFile(join(root, sha + '.apk'), bytes);
  await writeFile(join(root, 'current.json'), JSON.stringify({ sha256: sha, version: '1.0.0' }));
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.app-open.valid.json', 'utf8'),
  );
  config.execution.appOpen = { dwellMs: 10000, concurrency: 2, ownedTestClient: true };
  const apk = {
    packageName: 'com.apkplatform.testclient',
    apkSha256: sha,
    size: bytes.length,
    versionName: '1.0.0',
    versionCode: 1,
    abis: [],
    cacheDay: '2026-10-30',
  };
  let app;
  const adminId = (await db.admin.findFirstOrThrow()).id;
  try {
    await db.release.create({
      data: {
        id: releaseId,
        artifactName: 'agent-' + digest(releaseId) + '.tgz',
        sha256: digest(releaseId),
        manifest: {
          agentVersion: '0.12.0',
          features: [
            'OWNED_TEST_CLIENT_V1',
            'CONTENT_ISOLATION_V1',
            'APP_OPEN_V1',
            'APP_OPEN_PARALLEL_V1',
          ],
        },
      },
    });
    await db.node.create({
      data: {
        id: nodeId,
        name: 'Owned test data node',
        host: '192.0.2.114',
        agentVersion: '0.12.0',
        agentReleaseId: releaseId,
        slot: { create: { fence: 1 } },
      },
    });
    await db.agentCredential.create({
      data: { nodeId, tokenHash: digest(token), releaseId, bootId },
    });
    await db.configuration.create({ data: { id: configId, name: 'Owned observation' } });
    await db.configVersion.create({
      data: {
        id: versionId,
        configId,
        version: 1,
        body: config,
        configHash: digest(JSON.stringify(config)),
        createdBy: adminId,
      },
    });
    await db.run.create({
      data: {
        id: runId,
        nodeId,
        releaseId,
        configVersionId: versionId,
        status: 'RUNNING',
        purpose: 'REGISTER',
        cacheDay: beijingDay(new Date()),
        executionPlan: {
          purpose: 'REGISTER',
          cacheDay: beijingDay(new Date()),
          successTarget: 2,
          attemptLimit: 2,
          assets: [],
          openPolicy: {
            concurrency: 2,
            dailyLimit: 800,
            admissionDeadline: openAdmissionDeadline(beijingDay(new Date())),
          },
        },
        discovered: true,
        successTarget: 2,
        attemptLimit: 2,
        attemptsStarted: 2,
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
    for (const [position, id] of [taskId, secondTask].entries())
      await db.task.create({
        data: {
          id,
          runId,
          position,
          label: 'Owned client',
          sourceUrl: 'https://example.test/test-client',
          targetKey: digest(id),
          status: 'INSTALLING',
          apk,
          attemptStarted: true,
          observation: {
            model: 'QA-Mobile-0001',
            profileId: 'pixel6-api35',
            variantId: 'qa-model-01',
          },
        },
      });
    const input = { protocolVersion: '1.0', nodeId, deliveryId, fence: 1 };
    const boot = await issueTestBootstrap(db, token, taskId, input),
      again = await issueTestBootstrap(db, token, taskId, input);
    assert.deepEqual(again, boot);
    const log = (message) =>
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
            sequence: 1,
            occurredAt: new Date().toISOString(),
            type: 'LOG',
            payload: { level: 'INFO', message },
          },
        ],
      });
    await assert.rejects(log('自有测试 APK：账户已上报'), (e) => e.code === 'EVENT_CONFLICT');
    await db.task.update({ where: { id: taskId }, data: { status: 'HOLDING' } });
    await assert.rejects(log('自有测试 APK：账户已上报'), (e) => e.code === 'EVENT_CONFLICT');
    const body = {
      installationId: randomUUID(),
      requestKey: randomUUID(),
      androidId: '1234abcdeffedcba',
      model: 'QA-Mobile-0001',
      manufacturer: 'QATest',
      apiLevel: 35,
      locale: 'en-US',
      declaredUserAgent: boot.userAgent,
      appliedWebViewUa: 'NOT_COLLECTED',
      defaultWebViewUa: 'NOT_COLLECTED',
      appVersion: '1.1.1',
      packageName: 'com.apkplatform.testclient',
    };
    await assert.rejects(
      enrollTestClient(
        db,
        boot.token,
        { ...body, sourceIp: '198.51.100.99' },
        '198.51.100.10',
        boot.userAgent,
      ),
      (e) => e.code === 'VALIDATION_FAILED',
    );
    await db.task.update({ where: { id: taskId }, data: { status: 'LAUNCHING' } });
    const { createApp } = await import('../apps/control-api/dist/app.js');
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    const base = 'http://127.0.0.1:' + app.getHttpServer().address().port + '/api/v1';
    assert.equal((await fetch(base + '/test-data')).status, 401);
    const native = await fetch(base + '/test-data/enroll', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + boot.token,
        'Content-Type': 'application/json',
        'User-Agent': boot.userAgent,
        'X-Forwarded-For': '198.51.100.99',
      },
      body: JSON.stringify(body),
    });
    const source = await fetch(base + '/test-client?sha256=' + sha);
    assert.equal(source.status, 200);
    assert.ok((await source.text()).includes('/test-client/apk?sha256=' + sha));
    const versioned = await fetch(base + '/test-client/apk?sha256=' + sha);
    assert.equal(versioned.status, 200);
    assert.deepEqual(Buffer.from(await versioned.arrayBuffer()), bytes);
    assert.equal((await fetch(base + '/test-client/apk?sha256=../../secret')).status, 422);
    assert.equal(native.status, 200);
    const created = await native.json();
    assert.equal(created.sourceIp, '127.0.0.1');
    const [one, two] = await Promise.all([
      enrollTestClient(db, boot.token, body, '198.51.100.10', boot.userAgent),
      enrollTestClient(db, boot.token, body, '198.51.100.11', boot.userAgent),
    ]);
    assert.deepEqual(one, two);
    assert.deepEqual(one, created);
    await db.task.update({ where: { id: taskId }, data: { status: 'HOLDING' } });
    await log('自有测试 APK：账户已上报');
    assert.equal(
      (await runTimeline(db, runId, { limit: '100' })).items[0].title,
      '自有测试 APK：账户已上报',
    );
    await assert.rejects(
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
            sequence: 2,
            occurredAt: new Date().toISOString(),
            type: 'LOG',
            payload: { level: 'INFO', message: '下载入口：已操作配置控件' },
          },
        ],
      }),
      (e) => e.code === 'EVENT_CONFLICT',
    );
    assert.match(one.username, /^[a-z]{6,10}$/);
    assert.match(one.password, /^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{8,12}$/);
    assert.equal(await db.testRecord.count({ where: { enrollment: { nodeId } } }), 1);
    const page = await testDataPage(db, { nodeId });
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].uaMatched, true);
    assert.equal(page.items[0].modelMatched, true);
    assert.equal(JSON.stringify(page).includes(one.password), false);
    assert.equal(JSON.stringify(page).includes(body.androidId), false);
    const stored = await db.testRecord.findUniqueOrThrow({ where: { id: one.id } });
    assert.equal(JSON.stringify(stored.encrypted).includes(one.password), false);
    const revealed = await viewTestCredentials(
      db,
      one.id,
      { reason: '核对自有测试账户' },
      adminId,
      auditRequest,
    );
    assert.equal(revealed.password, one.password);
    assert.equal(revealed.androidId, body.androidId);
    assert.equal(
      await db.auditEvent.count({ where: { adminId, action: 'TEST_CREDENTIALS_VIEWED' } }),
      1,
    );
    await assert.rejects(
      enrollTestClient(
        db,
        boot.token,
        { ...body, installationId: randomUUID() },
        '198.51.100.12',
        boot.userAgent,
      ),
      (e) => e.code === 'TEST_IDEMPOTENCY_CONFLICT',
    );
    await assert.rejects(
      enrollTestClient(
        db,
        randomBytes(32).toString('base64url'),
        body,
        '198.51.100.12',
        boot.userAgent,
      ),
      (e) => e.code === 'TEST_TOKEN_INVALID',
    );
    await assert.rejects(
      issueTestBootstrap(db, token, randomUUID(), input),
      (e) => e.code === 'TEST_CLIENT_SCOPE',
    );
    const second = await issueTestBootstrap(db, token, secondTask, input);
    await db.task.update({ where: { id: secondTask }, data: { status: 'LAUNCHING' } });
    await db.run.update({
      where: { id: runId },
      data: { stopRequested: true, status: 'STOP_REQUESTED' },
    });
    assert.deepEqual(
      await enrollTestClient(db, boot.token, body, '198.51.100.13', boot.userAgent),
      one,
    );
    await assert.rejects(
      enrollTestClient(
        db,
        second.token,
        {
          ...body,
          installationId: randomUUID(),
          requestKey: randomUUID(),
          declaredUserAgent: second.userAgent,
          appliedWebViewUa: second.userAgent,
        },
        '198.51.100.14',
        second.userAgent,
      ),
      (e) => e.code === 'TEST_RUN_STOPPED',
    );
    assert.equal(await db.accountResult.count({ where: { taskId } }), 0);
    assert.equal((await db.run.findUniqueOrThrow({ where: { id: runId } })).successes, 0);
    await db.testEnrollment.update({ where: { taskId }, data: { expiresAt: new Date(0) } });
    await assert.rejects(
      enrollTestClient(db, boot.token, body, '198.51.100.15', boot.userAgent),
      (e) => e.code === 'TEST_TOKEN_EXPIRED',
    );
  } finally {
    await app?.close();
    await db.testRecord.deleteMany({ where: { enrollment: { nodeId } } });
    await db.testEnrollment.deleteMany({ where: { nodeId } });
    await db.runEvent.deleteMany({ where: { deliveryId } });
    await db.task.deleteMany({ where: { runId } });
    await db.delivery.deleteMany({ where: { id: deliveryId } });
    await db.run.deleteMany({ where: { id: runId } });
    await db.nodeSlot.deleteMany({ where: { nodeId } });
    await db.agentCredential.deleteMany({ where: { nodeId } });
    await db.node.deleteMany({ where: { id: nodeId } });
    await db.configVersion.deleteMany({ where: { id: versionId } });
    await db.configuration.deleteMany({ where: { id: configId } });
    await db.release.deleteMany({ where: { id: releaseId } });
    await db.auditEvent.deleteMany({ where: { requestId: auditRequest } });
    await db.$disconnect();
    if (oldRoot === undefined) delete process.env.TEST_CLIENT_ROOT;
    else process.env.TEST_CLIENT_ROOT = oldRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('identity models allocate without replacement and fail closed on pool shortage', async () => {
  const { allocateIdentityModels, identityCapacity, assertIdentityReady } = await import(
    '@apk/platform'
  );
  assert.equal(new Set(allocateIdentityModels(3, 3)).size, 3);
  assert.throws(
    () => allocateIdentityModels(4, 3),
    (e) => e.code === 'IDENTITY_POOL_EXHAUSTED',
  );
  assert.equal(identityCapacity({ versions: { identityModels: '3' } }), 3);
  assert.equal(identityCapacity({ versions: { identityModels: 'arbitrary' } }), 0);
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
  );
  config.execution.appOpen.randomDeviceProfile = true;
  assert.throws(
    () =>
      assertIdentityReady(
        config,
        ['DEVICE_VARIANTS_V1'],
        '0.11.1',
        { versions: { identityModels: '3' } },
        2,
      ),
    (e) => e.code === 'NODE_UPGRADE_REQUIRED',
  );
  assert.throws(
    () =>
      assertIdentityReady(
        config,
        ['DEVICE_VARIANTS_V1'],
        '0.12.0',
        { versions: { identityModels: '2' } },
        3,
      ),
    (e) => e.code === 'IDENTITY_POOL_EXHAUSTED',
  );
  assertIdentityReady(
    config,
    ['DEVICE_VARIANTS_V1'],
    '0.12.0',
    { versions: { identityModels: '3' } },
    3,
  );
  const { propertyPatch } = await import('../apps/agent/dist/identity-builder.js');
  const input =
    'ro.product.product.model=sdk_gphone64_x86_64\nro.product.cpu.abilist=x86_64,arm64-v8a\nro.build.version.sdk=35\n';
  const patch = propertyPatch(input, 'QA-Mobile-0001');
  assert.equal(patch.changed, 1);
  assert.equal(Buffer.byteLength(input), Buffer.byteLength(patch.text));
  assert.ok(patch.text.includes('QA-Mobile-0001'));
  assert.ok(patch.text.includes('ro.product.cpu.abilist=x86_64,arm64-v8a'));
  assert.ok(patch.text.includes('ro.build.version.sdk=35'));
});
