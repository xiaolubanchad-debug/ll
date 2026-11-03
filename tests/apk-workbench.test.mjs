import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { ApkCache, NetworkPolicy, runCachedRegistrations, runDirectApk } from '@apk/automation';
import {
  acceptRun,
  apkWorkbench,
  claimRun,
  controlTaskPlan,
  createRun,
  createSecret,
  deliveryConfig,
  digest,
  migrateWorkbenchUrls,
  reconcileAgent,
  runEvents,
  saveTaskPlan,
  taskPlanDetail,
  tickTaskPlans,
} from '@apk/platform';
import { TaskEngine } from '../apps/agent/dist/tasks.js';
import { beijingDay } from '../packages/platform/dist/daily-plan.js';

test(
  'manual XPath discovery and a signed direct URL feed a later day without replacing usable bytes on failure',
  { timeout: 90000 },
  async (t) => {
    const db = new PrismaClient();
    const root = await mkdtemp(join(resolve('.tmp'), 'workbench-'));
    const signedPath = '/payload.apk?t=1793692019095&auth_key=fixture%2Btoken&extra=x+y';
    const body = Buffer.alloc(2048, 0x61);
    const requests = [];
    let sourceMode = 'normal';
    const server = createServer((req, res) => {
      requests.push({ path: req.url, proxy: req.headers['proxy-authorization'] });
      if (req.url === '/') {
        res.setHeader('content-type', 'text/html');
        if (sourceMode === 'failed') res.statusCode = 502;
        res.end(
          '<meta name="viewport" content="width=device-width, initial-scale=1">' +
            (sourceMode === 'normal' ? '<a name="demo" href="/never-click">Demo App</a>' : ''),
        );
      } else if (req.url === signedPath) {
        res
          .writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': body.length,
          })
          .end(body);
      } else if (req.url === '/html.apk') {
        res
          .writeHead(200, { 'content-type': 'application/octet-stream' })
          .end('<!doctype html><title>Not an APK</title>');
      } else if (req.url === '/private') {
        res
          .writeHead(302, { location: 'http://127.0.0.2:' + server.address().port + '/hidden' })
          .end();
      } else if (req.url === '/expired') {
        res.writeHead(403).end();
      } else if (req.url === '/expired-json.apk' || req.url === '/expired-xml.apk') {
        res
          .writeHead(200, {
            'content-type': req.url.includes('json')
              ? 'application/problem+json'
              : 'application/octet-stream',
            'content-disposition': 'attachment; filename="expired.apk"',
          })
          .end(
            req.url.includes('json')
              ? '{"error":"Signature expired"}'
              : '<Error><Code>ExpiredToken</Code></Error>',
          );
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const origin = 'http://127.0.0.1:' + server.address().port;
    let engine;
    t.after(async () => {
      await engine?.close();
      await new Promise((ok) => server.close(ok));
      await db.$disconnect();
      await rm(root, { recursive: true, force: true });
    });
    const now = new Date();
    const day = beijingDay(now);
    const yesterday = new Date(now.getTime() - 86400000);
    const noon = new Date(day + 'T12:00:00+08:00');
    const admin = await db.admin.findFirstOrThrow();
    const releaseId = randomUUID();
    const agentVersion = '0.17.10';
    await db.release.create({
      data: {
        id: releaseId,
        sha256: digest(releaseId),
        artifactName: 'agent-' + digest(releaseId) + '.tgz',
        manifest: {
          agentVersion,
          features: [
            'DOWNLOAD_V1',
            'DAILY_V1',
            'REGISTRATION_V1',
            'CONTENT_ISOLATION_V1',
            'APP_OPEN_V1',
            'APP_OPEN_PARALLEL_V1',
            'APK_METADATA_ONLY_V1',
            'APK_FILE_ASSETS_V1',
          ],
          toolchain: { systemImage: 'system-images;android-35;google_apis;x86_64' },
        },
      },
    });
    const token = 'fixture-token-' + randomUUID(),
      bootId = randomUUID();
    const node = await db.node.create({
      data: {
        name: 'APK workbench fixture',
        host: '192.0.2.188',
        lastSeenAt: now,
        agentVersion,
        agentReleaseId: releaseId,
        deploymentStatus: 'INSTALLED',
        downloadProtocol: '1.0',
        registrationProtocol: '1.0',
        health: { download: true, android: true, kvm: true },
        slot: { create: {} },
        agentCredential: { create: { tokenHash: digest(token), bootId, releaseId } },
      },
    });
    const config = JSON.parse(
      await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
    );
    config.source = { url: origin + '/', xpath: '//a[@name="demo"]', browserUserAgent: '' };
    config.execution.appOpen.concurrency = 1;
    config.execution.proxySecretVersionId = (
      await createSecret(
        db,
        {
          type: 'HTTP_PROXY',
          secretValue: {
            host: 'proxy.invalid',
            port: 8080,
            username: 'owned',
            password: 'UnusedForDownload',
          },
        },
        admin.id,
        'fixture',
      )
    ).id;
    const task = await saveTaskPlan(
      db,
      {
        name: 'APK workbench fixture',
        nodeId: node.id,
        configuration: config,
        automatic: false,
        time: '00:05',
        successTarget: 1,
        attemptLimit: 1,
      },
      admin.id,
      'fixture',
      randomUUID(),
    );
    const input = {
      nodeId: node.id,
      configVersionId: task.currentVersionId,
      releaseId,
      purpose: 'DOWNLOAD',
    };
    const view = () =>
      apkWorkbench(db, { nodeId: node.id, configVersionId: task.currentVersionId });
    const create = (body, at = yesterday, key = randomUUID()) =>
      createRun(db, { ...input, ...body }, admin.id, 'fixture', key, at);
    const start = async () =>
      controlTaskPlan(
        db,
        task.id,
        { action: 'START' },
        (await taskPlanDetail(db, task.id)).task.version,
        admin.id,
        'fixture',
        randomUUID(),
        noon,
      );
    await assert.rejects(start, (error) => error.code === 'APK_WORKBENCH_EMPTY');
    await assert.rejects(create({}), (error) => error.code === 'APK_WORKBENCH_REQUIRED');

    engine = await TaskEngine.open(
      root,
      node.id,
      bootId,
      resolve('.'),
      async (path, message) => {
        if (path === 'claims') return (await claimRun(db, token, message)) ?? {};
        if (path === 'events') return runEvents(db, token, message);
        if (path === 'reconcile') return reconcileAgent(db, token, message);
        const [, id, verb] = path.split('/');
        if (verb === 'accept') return acceptRun(db, token, id, message);
        if (verb === 'config') {
          const snapshot = await deliveryConfig(db, token, id, message);
          if (snapshot.executionPlan.purpose === 'DOWNLOAD')
            assert.deepEqual(snapshot.secretVersions, []);
          return snapshot;
        }
        throw Error('UNEXPECTED_ROUTE');
      },
      { policy: new NetworkPolicy(new Set([origin])), sdkRoot: root },
    );
    const drain = async () => {
      await engine.tick();
      for (let count = 0; engine.current && count < 240; count++) await delay(100);
      assert.equal(engine.current, null);
    };
    const execute = async (resourceAction) => {
      const key = randomUUID();
      const run = await create({ resourceAction }, yesterday, key);
      assert.equal((await create({ resourceAction }, yesterday, key)).resourceId, run.resourceId);
      await drain();
      return db.run.findUniqueOrThrow({ where: { id: run.resourceId } });
    };
    const scan = { kind: 'SCAN' };
    assert.equal((await execute(scan)).status, 'SUCCEEDED');
    const first = (await view()).items[0];
    assert.equal(first.sourceLocator, 'name=demo');
    assert.equal(
      requests.some((r) => r.path === '/never-click'),
      false,
    );
    const fetch = (url) =>
      execute({ kind: 'FETCH', targetKey: first.targetKey, url: origin + url });
    const initial = await fetch(signedPath);
    assert.equal(initial.status, 'SUCCEEDED');
    assert.ok(initial.resourceUrlEncrypted?.data);
    assert.equal(initial.executionPlan.resourceAction.url, undefined);
    const storedEntry = await db.apkWorkbenchEntry.findFirstOrThrow({ where: { nodeId: node.id } });
    assert.equal(storedEntry.url, null);
    assert.ok(storedEntry.urlEncrypted?.data);
    const repeated = await fetch(signedPath);
    assert.equal(repeated.status, 'SUCCEEDED');
    const newest = await fetch(signedPath);
    assert.equal(newest.status, 'SUCCEEDED');
    const cache = await ApkCache.open(join(root, 'downloads', 'resources'));
    const dayOfFile = newest.cacheDay;
    const pathOf = (run) =>
      cache.path(cache.key(node.id, dayOfFile, run.executionPlan.resourceAction.cacheKey));
    try {
      const kept = await lstat(pathOf(repeated));
      assert.equal(kept.ino, (await lstat(pathOf(newest))).ino);
      assert.ok(kept.nlink >= 2);
      await assert.rejects(lstat(pathOf(initial)), { code: 'ENOENT' });
      const key = newest.executionPlan.resourceAction.cacheKey;
      const signal = new AbortController().signal;
      assert.equal(await cache.get(node.id, dayOfFile, key, 1024, signal), null);
      assert.deepEqual(await readFile(pathOf(newest)), body);
      assert.equal((await cache.get(node.id, dayOfFile, key, 4096, signal)).size, body.length);
    } finally {
      cache.close();
    }
    const ready = (await view()).items[0];
    assert.equal(ready.fileName, 'payload.apk');
    assert.equal(ready.receivedBytes, body.length);
    assert.equal(ready.url, origin + signedPath);
    assert.ok(requests.some((r) => r.path === signedPath));
    assert.ok(requests.every((r) => r.proxy === undefined));
    assert.equal((await fetch('/html.apk')).errorCode, 'APK_RESPONSE_HTML');
    assert.equal((await fetch('/expired')).errorCode, 'APK_LINK_REJECTED');
    assert.equal((await fetch('/expired-json.apk')).errorCode, 'APK_RESPONSE_NOT_FILE');
    assert.equal((await fetch('/expired-xml.apk')).errorCode, 'APK_RESPONSE_NOT_FILE');
    assert.equal((await fetch('/private')).errorCode, 'NETWORK_BLOCKED');
    assert.equal((await view()).items[0].fileName, 'payload.apk');
    assert.equal((await view()).items[0].downloadedAt, ready.downloadedAt);
    const version = await db.configVersion.findUniqueOrThrow({
      where: { id: task.currentVersionId },
    });
    await db.configVersion.update({
      where: { id: version.id },
      data: { body: { ...config, download: { ...config.download, maxApkBytes: 1024 } } },
    });
    assert.equal((await view()).items[0].overLimit, true);
    await assert.rejects(start, { code: 'APK_CACHE_LIMIT' });
    await db.configVersion.update({ where: { id: version.id }, data: { body: version.body } });
    assert.equal((await view()).items[0].overLimit, undefined);

    sourceMode = 'failed';
    assert.equal((await execute(scan)).status, 'FAILED');
    assert.equal((await view()).items[0].present, true);
    sourceMode = 'empty';
    assert.equal((await execute(scan)).status, 'SUCCEEDED');
    assert.equal((await view()).items[0].present, false);
    sourceMode = 'normal';
    assert.equal((await execute(scan)).status, 'SUCCEEDED');
    assert.equal((await view()).items[0].targetKey, first.targetKey);
    assert.equal((await view()).items[0].url, origin + '/private');
    const entryKey = {
      nodeId: storedEntry.nodeId,
      configId: storedEntry.configId,
      sourceKey: storedEntry.sourceKey,
      targetKey: storedEntry.targetKey,
    };
    await db.apkWorkbenchEntry.update({
      where: { nodeId_configId_sourceKey_targetKey: entryKey },
      data: { url: origin + signedPath },
    });
    await db.run.update({
      where: { id: initial.id },
      data: {
        executionPlan: {
          ...initial.executionPlan,
          resourceAction: { ...initial.executionPlan.resourceAction, url: origin + signedPath },
        },
      },
    });
    await migrateWorkbenchUrls(db);
    assert.equal((await view()).items[0].url, origin + signedPath);
    assert.equal((await db.apkWorkbenchEntry.findFirstOrThrow({ where: entryKey })).url, null);
    assert.equal(
      (await db.run.findUniqueOrThrow({ where: { id: initial.id } })).executionPlan.resourceAction
        .url,
      undefined,
    );

    await start();
    await tickTaskPlans(db, noon);
    const run = await db.run.findFirstOrThrow({ where: { nodeId: node.id, purpose: 'REGISTER' } });
    const plan = run.executionPlan;
    assert.equal(plan.resourceAssets, true);
    assert.equal(run.sourceDownloadId, null);
    assert.equal(plan.cacheDay, day);
    assert.equal(plan.assets[0].apk.cacheDay, beijingDay(yesterday));
    const events = [];
    let opened = 0;
    await runCachedRegistrations(
      config,
      plan,
      node.id,
      join(root, 'downloads'),
      new AbortController().signal,
      async (event) => events.push(event),
      () => {},
      async (_target, _apk, file) => {
        assert.deepEqual(await readFile(file), body);
        opened++;
        return { status: 'SUCCEEDED', proof: 'APP_OPEN', artifactIds: [], cleanupComplete: true };
      },
    );
    assert.equal(opened, 1);
    assert.equal(events.at(-1).payload.status, 'SUCCEEDED');
    await rm(pathOf(repeated));
    await rm(pathOf(newest));
    await drain();
    assert.equal(
      (await db.task.findFirstOrThrow({ where: { runId: run.id } })).errorCode,
      'CACHE_MISSING',
    );
    const missing = (await view()).items[0];
    assert.equal(missing.fileName, null);
    assert.equal(missing.cacheMissing, true);
    assert.equal(missing.downloadedAt, ready.downloadedAt);
  },
);

test('the APK transfer deadline also bounds a stalled DNS lookup', async (t) => {
  const root = await mkdtemp(join(resolve('.tmp'), 'workbench-dns-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  const url = 'http://dns-fixture.invalid/payload.apk';
  let startedLookup = false;
  const slowLookup = async () => {
    startedLookup = true;
    await delay(1500);
    throw Error('fixture lookup failed');
  };
  const start = performance.now();
  await runDirectApk(
    { source: { url }, download: { timeoutMs: 100 } },
    {
      cacheDay: '2026-11-04',
      resourceAction: { kind: 'FETCH', cacheKey: 'a'.repeat(64), label: 'DNS', url },
    },
    randomUUID(),
    root,
    new AbortController().signal,
    async (event) => events.push(event),
    { policy: new NetworkPolicy(new Set(), slowLookup) },
  );
  assert.equal(startedLookup, true);
  assert.ok(performance.now() - start < 1000);
  assert.equal(events.at(-1).payload.errorCode, 'APK_DOWNLOAD_TIMEOUT');
});
