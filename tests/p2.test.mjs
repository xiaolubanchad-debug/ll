import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { chromium } from '@playwright/test';
import { createApp } from '../apps/control-api/dist/app.js';
import { passwordHash } from '../apps/control-api/dist/auth.js';
import { startAgent, loadIdentity, saveIdentity } from '../apps/agent/dist/main.js';
import { openAgentStore } from '../apps/agent/dist/store.js';
import {
  NetworkPolicy,
  inspectApk,
  ApkCache,
  cacheDay,
  runDownload,
  cleanupBrowser,
} from '@apk/automation';
import { digest } from '@apk/platform';
import { fixtureSite, fixtureApk, zip } from './p2-fixtures.mjs';
const db = new PrismaClient(),
  root = process.env.P1_TEST_DIR;
let app,
  base,
  cookie,
  csrf,
  site,
  release,
  node,
  token,
  agentAbort,
  agentRun,
  config,
  version,
  clock = new Date('2026-10-27T12:00:00Z');
const idem = () => ({ 'Idempotency-Key': randomUUID() });
const report = {
  ubuntu: 'ubuntu:24.04',
  arch: 'x86_64',
  memoryKiB: 32768000,
  freeDiskBytes: 50 * 1024 ** 3,
  kvm: false,
  sudo: false,
  markerPresent: false,
  android: false,
  download: true,
  versions: { node: '24.18.0' },
  errors: ['NO_KVM', 'ANDROID_NOT_READY'],
};
async function req(path, method = 'GET', body, headers = {}) {
  const r = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      cookie,
      ...(method === 'GET'
        ? {}
        : {
            origin: process.env.APP_ORIGIN,
            'content-type': 'application/json',
            'x-csrf-token': csrf,
          }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, data: r.status === 204 ? null : await r.json() };
}
async function agent(path, body, bearer = token) {
  const r = await fetch(base + '/api/v1/agent/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: r.status === 204 ? null : await r.json() };
}
async function waitFor(fn, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('P2 fixture condition timed out');
}
async function body(path = '/source') {
  const c = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
  c.source = {
    url: site.url + path,
    xpath: "//a[@class='jgg-item']",
    browserUserAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/149.0.0.0 Mobile Safari/537.36',
  };
  c.execution.mode = 'DOWNLOAD_ONLY';
  delete c.execution.proxySecretVersionId;
  c.registrationFlows = [];
  c.download.landingRules = [{ host: '127.0.0.1', by: 'css', selector: 'a.download' }];
  c.download.timeoutMs = 10000;
  c.download.retries = 0;
  return c;
}
async function save(c) {
  const current = (await req('/configs/' + config.id)).data;
  const response = await req('/configs/' + config.id + '/versions', 'POST', c, {
    'If-Match': String(current.version),
    ...idem(),
  });
  assert.equal(response.status, 201, JSON.stringify(response.data));
  version = response.data;
  return version;
}
async function begin(v = version, key = idem()) {
  const r = await req(
    '/runs',
    'POST',
    { nodeId: node.id, configVersionId: v.id, releaseId: release.id },
    key,
  );
  assert.equal(r.status, 202, JSON.stringify(r.data));
  return r.data.resourceId;
}
async function endRun(id) {
  return waitFor(async () => {
    const r = (await req('/runs/' + id)).data;
    return ['SUCCEEDED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(r.status)
      ? r
      : false;
  });
}
async function start() {
  const dir = join(root, 'p2-identity');
  await loadIdentity(dir);
  await saveIdentity(dir, { enrollmentBootId: randomUUID(), credential: token });
  agentAbort = new AbortController();
  agentRun = startAgent(
    {
      nodeId: node.id,
      releaseId: release.id,
      agentVersion: '0.3.4',
      apiUrl: base,
      sdkRoot: '/fixture',
      toolsRoot: resolve('.'),
      dataRoot: join(root, 'p2-execution'),
    },
    dir,
    agentAbort.signal,
    async () => report,
    { chromium, policy: new NetworkPolicy(new Set([site.url])), now: () => clock },
  );
  agentRun.catch(() => {});
  await waitFor(async () => {
    const n = await db.node.findUnique({ where: { id: node.id } });
    return n.downloadProtocol === '1.0' && n.lastSeenAt > new Date(Date.now() - 5000);
  });
}
async function stopAgent() {
  agentAbort?.abort();
  await agentRun;
  agentRun = null;
}
test('P2 acceptance with real PostgreSQL, SQLite, Chromium and owned fixture site', async (t) => {
  await mkdir(join(root, 'p2-fixtures'), { recursive: true });
  site = await fixtureSite();
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  const admin = await db.admin.findFirst();
  await db.admin.update({
    where: { id: admin.id },
    data: { passwordHash: await passwordHash(process.env.P0_TEST_PASSWORD) },
  });
  await db.loginBucket.deleteMany();
  const login = await fetch(base + '/api/v1/auth/login', {
    method: 'POST',
    headers: { origin: process.env.APP_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'p0admin', password: process.env.P0_TEST_PASSWORD }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = (await login.json()).csrfToken;
  try {
    await t.test(
      'immutable versions validate input, bind hashes and retry keys, and reject stale editors',
      async () => {
        const key = idem();
        const first = await req('/configs', 'POST', { name: 'P2 fixture' }, key);
        assert.equal(first.status, 201);
        config = first.data;
        assert.equal(
          (await req('/configs', 'POST', { name: 'P2 fixture' }, key)).data.id,
          config.id,
        );
        assert.equal((await req('/configs', 'POST', { name: 'different' }, key)).status, 409);
        const c = await body(),
          headers = { ...idem(), 'If-Match': '1' };
        const v = await req('/configs/' + config.id + '/versions', 'POST', c, headers);
        assert.equal(v.status, 201);
        version = v.data;
        assert.equal(
          (await req('/configs/' + config.id + '/versions', 'POST', c, headers)).data.id,
          version.id,
        );
        assert.equal(
          (
            await req('/configs/' + config.id + '/versions', 'POST', c, {
              ...idem(),
              'If-Match': '1',
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await req(
              '/configs/' + config.id + '/versions',
              'POST',
              { ...c, secret: 'nope' },
              { ...idem(), 'If-Match': '2' },
            )
          ).status,
          422,
        );
        const old = version;
        await save({ ...c, name: 'Changed draft' });
        assert.deepEqual((await req('/configs/' + config.id + '/versions/' + old.id)).data.body, c);
        assert.equal(old.configHash, digest((await import('@apk/automation')).canonical(c)));
      },
    );
    release = await db.release.create({
      data: {
        id: randomUUID(),
        artifactName: 'agent-' + randomBytes(32).toString('hex') + '.tgz',
        sha256: randomBytes(32).toString('hex'),
        manifest: { agentVersion: '0.3.4', protocolVersion: '1.0', features: ['DOWNLOAD_V1'] },
      },
    });
    token = randomBytes(32).toString('base64url');
    node = await db.node.create({
      data: {
        name: 'P2 fixture node',
        host: 'p2.example.test',
        deploymentStatus: 'INSTALLED',
        agentReleaseId: release.id,
        agentVersion: '0.3.4',
        health: report,
        lastSeenAt: new Date(),
        slot: { create: {} },
      },
    });
    await db.agentCredential.create({
      data: {
        nodeId: node.id,
        tokenHash: digest(token),
        bootId: randomUUID(),
        releaseId: release.id,
      },
    });
    await t.test('P1 nodes are refused until download protocol is advertised', async () => {
      assert.equal(
        (
          await req(
            '/runs',
            'POST',
            { nodeId: node.id, configVersionId: version.id, releaseId: release.id },
            idem(),
          )
        ).data.error.code,
        'NODE_UPGRADE_REQUIRED',
      );
      await start();
    });
    await t.test(
      'direct, popup and same-page downloads validate APK metadata and merge carousel clones',
      async () => {
        await save(await body());
        const key = idem(),
          id = await begin(version, key);
        assert.equal(await begin(version, key), id);
        assert.equal(
          (
            await req(
              '/runs',
              'POST',
              { nodeId: node.id, configVersionId: version.id, releaseId: release.id },
              idem(),
            )
          ).data.error.code,
          'NODE_BUSY',
        );
        const result = await endRun(id);
        assert.equal(result.status, 'SUCCEEDED', JSON.stringify(result));
        const tasks = (await req('/runs/' + id + '/tasks')).data.items;
        assert.equal(tasks.length, 3);
        assert.ok(
          tasks.every(
            (x) =>
              x.apk.packageName === 'com.example.p2' &&
              x.apk.versionCode === 12 &&
              x.apk.abis.includes('x86_64') &&
              x.proof === 'FILE_VALIDATION' &&
              !x.cacheHit,
          ),
        );
        assert.ok(site.agents.includes('Mozilla/5.0 (Linux; Android 13) Chrome/149.0.0.0 Mobile Safari/537.36'));
        assert.equal(site.counts.get('/direct.apk'), 1);
        assert.equal(site.counts.get('/second.apk'), 1);
        assert.equal(site.counts.get('/third.apk'), 1);
      },
    );
    await t.test(
      'same-day cache validates again, corrupted file redownloads, next day refreshes',
      async () => {
        let id = await begin();
        assert.equal((await endRun(id)).status, 'SUCCEEDED');
        let tasks = (await req('/runs/' + id + '/tasks')).data.items;
        assert.ok(tasks.every((x) => x.cacheHit));
        assert.equal(site.counts.get('/direct.apk'), 1);
        const cache = await ApkCache.open(join(root, 'p2-execution/downloads/cache'));
        const target = tasks.find((x) => x.label === '直接 APK');
        await writeFile(
          cache.path(cache.key(node.id, cacheDay(clock), target.targetKey)),
          'corrupt cache',
        );
        cache.close();
        id = await begin();
        assert.equal((await endRun(id)).status, 'SUCCEEDED');
        tasks = (await req('/runs/' + id + '/tasks')).data.items;
        assert.equal(tasks.filter((x) => x.cacheHit).length, 2);
        assert.equal(site.counts.get('/direct.apk'), 2);
        clock = new Date('2026-10-28T12:00:00Z');
        id = await begin();
        assert.equal((await endRun(id)).status, 'SUCCEEDED');
        tasks = (await req('/runs/' + id + '/tasks')).data.items;
        assert.ok(tasks.every((x) => !x.cacheHit && x.apk.cacheDay === '2026-10-28'));
      },
    );
    await t.test(
      'invalid APKs and target overflow fail explicitly; FULL cannot run in P2',
      async () => {
        await save(await body('/invalid'));
        let id = await begin();
        assert.equal((await endRun(id)).status, 'FAILED');
        assert.equal((await req('/runs/' + id + '/tasks')).data.items[0].errorCode, 'APK_INVALID');
        const c = await body();
        c.download.maxTargets = 1;
        await save(c);
        id = await begin();
        assert.equal((await endRun(id)).errorCode, 'TARGET_LIMIT');
        const proxy = (
          await req('/secrets/versions', 'POST', {
            type: 'HTTP_PROXY',
            secretValue: {
              host: 'proxy.example.test',
              port: 8080,
              username: 'fixture',
              password: 'FixtureOnlyProxy',
            },
          })
        ).data;
        const full = await body();
        full.execution.mode = 'FULL';
        full.execution.proxySecretVersionId = proxy.id;
        await save(full);
        assert.equal(
          (
            await req(
              '/runs',
              'POST',
              { nodeId: node.id, configVersionId: version.id, releaseId: release.id },
              idem(),
            )
          ).data.error.code,
          'NODE_UPGRADE_REQUIRED',
        );
        assert.ok(
          !JSON.stringify(
            (await req('/configs/' + config.id + '/versions/' + version.id)).data,
          ).includes('FixtureOnlyProxy'),
        );
      },
    );
    await t.test(
      'stopping a partial download waits for cleanup acknowledgement and removes temporary files',
      async () => {
        await save(await body('/hang'));
        const id = await begin();
        await waitFor(
          async () => await db.task.findFirst({ where: { runId: id, status: 'DOWNLOADING' } }),
        );
        const r = await req('/runs/' + id + '/stop', 'POST', { reason: 'fixture stop' }, idem());
        assert.equal(r.data.status, 'STOP_REQUESTED');
        assert.equal((await endRun(id)).status, 'CANCELLED');
        assert.equal((await db.nodeSlot.findUnique({ where: { nodeId: node.id } })).runId, null);
        assert.deepEqual(await readdir(join(root, 'p2-execution/downloads/jobs')), []);
      },
    );
    await t.test(
      'expired delivery is quarantined and late events cannot release a new slot',
      async () => {
        await save(await body('/hang'));
        const id = await begin();
        const delivery = await waitFor(async () => {
          const d = await db.delivery.findUnique({ where: { runId: id } });
          return d?.acceptedAt ? d : false;
        });
        await db.delivery.update({
          where: { id: delivery.id },
          data: { leaseExpiresAt: new Date(0) },
        });
        assert.equal((await endRun(id)).status, 'NEEDS_REVIEW');
        assert.equal(
          (
            await req(
              '/runs',
              'POST',
              { nodeId: node.id, configVersionId: version.id, releaseId: release.id },
              idem(),
            )
          ).data.error.code,
          'NODE_QUARANTINED',
        );
        await waitFor(async () => {
          const r = await db.run.findUnique({ where: { id } }),
            n = await db.node.findUnique({ where: { id: node.id } });
          return (
            r.cleanupConfirmedAt && n.lastSeenAt > r.cleanupConfirmedAt && !n.currentDeliveryId
          );
        });
        assert.equal(
          (
            await req(
              '/runs/' + id + '/reconciliations',
              'POST',
              { reason: 'fixture verified cleanup' },
              idem(),
            )
          ).status,
          200,
        );
        await stopAgent();
        const next = await begin();
        const event = {
          eventId: randomUUID(),
          runId: id,
          sequence: 999,
          occurredAt: new Date().toISOString(),
          type: 'STOP_ACK',
          payload: { cleanupComplete: true },
        };
        const late = await agent('events', {
          kind: 'events',
          protocolVersion: '1.0',
          nodeId: node.id,
          deliveryId: delivery.id,
          fence: delivery.fence,
          events: [event],
        });
        assert.equal(late.data.recordedForReview, true);
        assert.equal((await db.nodeSlot.findUnique({ where: { nodeId: node.id } })).runId, next);
        await req('/runs/' + next + '/stop', 'POST', { reason: 'cleanup queued fixture' }, idem());
      },
    );
    await t.test(
      'repeated claims and accepts are stable; unordered events wait for gaps and conflicts reject',
      async () => {
        await save(await body('/empty'));
        const id = await begin();
        const auth = await db.agentCredential.findUnique({ where: { nodeId: node.id } });
        const claim = {
          kind: 'claim',
          protocolVersion: '1.0',
          nodeId: node.id,
          bootId: auth.bootId,
        };
        const a = await agent('claims', claim),
          b = await agent('claims', claim);
        assert.equal(a.data.deliveryId, b.data.deliveryId);
        const d = a.data;
        const accept = { ...claim, kind: 'accept', deliveryId: d.deliveryId, fence: d.fence };
        assert.equal((await agent('deliveries/' + d.deliveryId + '/accept', accept)).status, 200);
        assert.equal((await agent('deliveries/' + d.deliveryId + '/accept', accept)).status, 200);
        const event = (sequence, type, payload) => ({
          eventId: randomUUID(),
          runId: id,
          sequence,
          occurredAt: new Date().toISOString(),
          type,
          payload,
        });
        const first = event(1, 'RUN_STARTED', { configHash: d.configHash, releaseId: d.releaseId }),
          second = event(2, 'TARGETS_DISCOVERED', { targets: [] });
        const send = (events) =>
          agent('events', {
            kind: 'events',
            protocolVersion: '1.0',
            nodeId: node.id,
            deliveryId: d.deliveryId,
            fence: d.fence,
            events,
          });
        assert.equal((await send([second])).data.appliedThroughSequence, 0);
        assert.equal((await send([first])).data.appliedThroughSequence, 2);
        assert.equal((await send([second])).status, 200);
        assert.equal(
          (await send([{ ...second, payload: { targets: [], complete: false } }])).status,
          409,
        );
        assert.equal((await send([event(3, 'RUN_FINISHED', { status: 'SUCCEEDED' })])).status, 409);
        assert.equal(
          (await send([event(3, 'RUN_FINISHED', { status: 'FAILED', errorCode: 'NO_TARGETS' })]))
            .status,
          200,
        );
        assert.equal((await endRun(id)).status, 'FAILED');
        const peerToken = randomBytes(32).toString('base64url');
        const peer = await db.node.create({
          data: { name: 'peer', host: 'peer.example.test', slot: { create: {} } },
        });
        await db.agentCredential.create({
          data: {
            nodeId: peer.id,
            tokenHash: digest(peerToken),
            releaseId: release.id,
            bootId: randomUUID(),
          },
        });
        const other = await db.agentCredential.findUnique({ where: { nodeId: peer.id } });
        assert.equal(
          (
            await agent(
              'deliveries/' + d.deliveryId + '/accept',
              { ...accept, nodeId: peer.id, bootId: other.bootId },
              peerToken,
            )
          ).status,
          409,
        );
      },
    );
    await t.test(
      'restart reconciles durable received work without replaying downloads',
      async () => {
        await save(await body());
        const id = await begin();
        const auth = await db.agentCredential.findUnique({ where: { nodeId: node.id } });
        const d = (
          await agent('claims', {
            kind: 'claim',
            protocolVersion: '1.0',
            nodeId: node.id,
            bootId: auth.bootId,
          })
        ).data;
        const store = await openAgentStore(join(root, 'p2-execution'));
        store.add(d);
        store.status(d.deliveryId, 'RUNNING', true);
        store.close();
        const before = site.counts.get('/direct.apk');
        await start();
        assert.equal((await endRun(id)).status, 'NEEDS_REVIEW');
        await new Promise((r) => setTimeout(r, 1200));
        assert.equal(site.counts.get('/direct.apk'), before);
        await stopAgent();
      },
    );
    await t.test(
      'network policy blocks private, mapped and mixed DNS; real redirect cannot access private target',
      async () => {
        const policy = new NetworkPolicy();
        for (const url of [
          'http://127.1/',
          'http://169.254.169.254/',
          'http://[::1]/',
          'http://[::ffff:127.0.0.1]/',
          'http://10.0.0.1/',
        ])
          await assert.rejects(policy.endpoint(url));
        const mixed = new NetworkPolicy(new Set(), async () => [
          { address: '8.8.8.8', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]);
        await assert.rejects(mixed.endpoint('http://mixed.example.test/'));
        const events = [];
        await runDownload(
          await body('/blocked'),
          node.id,
          join(root, 'redirect-fixture'),
          resolve('.'),
          new AbortController().signal,
          async (event) => {
            events.push(event);
          },
          { chromium, policy: new NetworkPolicy(new Set([site.url])) },
        );
        assert.equal(
          events.find((e) => e.type === 'TASK_FINISHED').payload.errorCode,
          'NETWORK_BLOCKED',
        );
        assert.equal(site.forbiddenRequests(), 0);
      },
    );
    await t.test(
      'Linux cleanup targets only the exact owned browser profile',
      { skip: process.platform !== 'linux' },
      async () => {
        const profiles = await mkdtemp(join(root, 'profiles-'));
        const one = await chromium.launchPersistentContext(join(profiles, 'one'), {
            headless: true,
          }),
          two = await chromium.launchPersistentContext(join(profiles, 'two'), { headless: true });
        try {
          assert.equal(await cleanupBrowser(profiles, join(profiles, 'one')), true);
          assert.equal(two.browser().isConnected(), true);
          assert.equal(await cleanupBrowser(profiles, resolve('outside-owned-root')), false);
        } finally {
          await one.close().catch(() => {});
          await two.close();
        }
      },
    );
    await t.test(
      'APK structure, CRC, size and Shanghai boundary are checked independently',
      async () => {
        const dir = await mkdtemp(join(root, 'p2-fixtures/apk-')),
          file = join(dir, 'fixture.apk');
        await writeFile(file, fixtureApk());
        const m = await inspectApk(file, 1024 * 1024, '2026-10-27', new AbortController().signal);
        assert.equal(m.packageName, 'com.example.p2');
        assert.equal(m.versionName, '1.2.3');
        await assert.rejects(inspectApk(file, 32, '2026-10-27', new AbortController().signal));
        await writeFile(file, zip([['../bad', Buffer.from('x')]]));
        await assert.rejects(
          inspectApk(file, 1024 * 1024, '2026-10-27', new AbortController().signal),
        );
        const bad = fixtureApk();
        bad[50] ^= 1;
        await writeFile(file, bad);
        await assert.rejects(
          inspectApk(file, 1024 * 1024, '2026-10-27', new AbortController().signal),
        );
        assert.equal(cacheDay(new Date('2026-10-27T15:59:59Z')), '2026-10-27');
        assert.equal(cacheDay(new Date('2026-10-27T16:00:00Z')), '2026-10-28');
      },
    );
  } finally {
    await stopAgent();
    await site.close();
    await app.close();
    await db.runEvent.deleteMany();
    await db.task.deleteMany();
    await db.delivery.deleteMany();
    await db.run.deleteMany();
    await db.configVersion.deleteMany();
    await db.configuration.deleteMany();
    await db.agentCredential.deleteMany();
    await db.nodeSlot.deleteMany();
    await db.node.deleteMany();
    if (release) await db.release.delete({ where: { id: release.id } });
    await db.$disconnect();
  }
});
