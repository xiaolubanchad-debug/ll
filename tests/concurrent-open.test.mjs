import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ApkCache, inspectApk, runCachedAppOpens } from '@apk/automation';
import { schemaIssues, configurationIssues, parallelAppOpenSupported } from '@apk/contracts';
import { openAgentStore } from '../apps/agent/dist/store.js';
import { TaskEngine } from '../apps/agent/dist/tasks.js';
import { fixtureApk } from './p2-fixtures.mjs';

const good = () => ({
  status: 'SUCCEEDED',
  proof: 'APP_OPEN',
  artifactIds: [],
  cleanupComplete: true,
  openObservation: {
    dwellMs: 10000,
    elapsedMs: 10000,
    samples: 11,
    scope: 'FOREGROUND_POLL_ONLY',
    cleanupComplete: true,
  },
});
const failed = (code = 'APP_OPEN_FAILED') => ({
  status: 'FAILED',
  proof: 'NONE',
  artifactIds: [],
  cleanupComplete: true,
  errorCode: code,
});
test('parallel configuration is bounded, quota cannot exceed 800, and capability refuses old nodes', async () => {
  const c = JSON.parse(
    await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
  );
  assert.deepEqual(configurationIssues(c), []);
  for (const value of [0, 3, '2']) {
    const bad = structuredClone(c);
    bad.execution.appOpen.concurrency = value;
    assert.ok(configurationIssues(bad).length);
  }
  const fixture = JSON.parse(await readFile('contracts/fixtures/v18.valid.json', 'utf8')).task;
  assert.deepEqual(
    schemaIssues('TaskPlanInput', {
      ...fixture,
      configuration: c,
      successTarget: 600,
      attemptLimit: 800,
    }),
    [],
  );
  assert.ok(
    schemaIssues('TaskPlanInput', {
      ...fixture,
      configuration: c,
      successTarget: 801,
      attemptLimit: 801,
    }).length,
  );
  assert.equal(parallelAppOpenSupported(['APP_OPEN_PARALLEL_V1'], '0.10.0'), false);
  assert.equal(parallelAppOpenSupported([], '0.11.0'), false);
  assert.equal(parallelAppOpenSupported(['APP_OPEN_PARALLEL_V1'], '0.11.0'), true);
});

test('legacy two-worker snapshots execute serially with exact quotas, cache pin and cutoff', async (t) => {
  const root = await mkdtemp(join(resolve('.tmp'), 'concurrent-open-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
  );
  const nodeId = randomUUID(),
    targetKey = 'a'.repeat(64),
    file = join(root, 'owned.apk'),
    day = '2026-10-30';
  await writeFile(file, fixtureApk());
  const apk = await inspectApk(file, 268435456, day, new AbortController().signal);
  const cache = await ApkCache.open(join(root, 'cache'));
  await cache.put(nodeId, day, targetKey, file, apk);
  cache.releasePins();
  cache.close();
  async function run({
    n = 3,
    m = 5,
    fail = false,
    stop = false,
    dirty = false,
    cutoff = false,
  } = {}) {
    const abort = new AbortController(),
      events = [],
      launched = [],
      closed = [];
    let active = 0,
      peak = 0,
      now = 0;
    const plan = {
      purpose: 'REGISTER',
      cacheDay: day,
      successTarget: n,
      attemptLimit: m,
      assets: [{ targetKey, label: 'Owned', sourceUrl: config.source.url, apk }],
      openPolicy: {
        concurrency: 2,
        dailyLimit: 800,
        admissionDeadline: new Date(1000).toISOString(),
      },
    };
    const promise = runCachedAppOpens(
      config,
      plan,
      nodeId,
      root,
      abort.signal,
      async (e) => {
        events.push(e);
      },
      () => {
        abort.signal.throwIfAborted();
      },
      async (_target, _apk, path, index, signal) => {
        launched.push(index);
        active++;
        peak = Math.max(peak, active);
        assert.equal(path, cache.path(cache.key(nodeId, day, targetKey)));
        try {
          if (stop && index === 0) abort.abort();
          if (dirty && index === 1) {
            while (!signal.aborted) await delay(1);
          } else await delay(index === 0 ? 20 : 3);
          if (cutoff) now = 1000;
          if (dirty && index === 0)
            return { ...failed('CLEANUP_INCOMPLETE'), cleanupComplete: false };
          if (signal.aborted) return { ...failed('CANCELLED'), status: 'CANCELLED' };
          return fail ? failed() : good();
        } finally {
          active--;
          closed.push(index);
        }
      },
      () => now,
    );
    if (stop) await assert.rejects(promise);
    else await promise;
    assert.equal(active, 0);
    assert.equal(closed.length, launched.length);
    assert.equal(peak, 1);
    const check = await ApkCache.open(join(root, 'cache'));
    assert.equal(check.db.prepare('SELECT active FROM cache').get().active, 0);
    assert.ok(await check.get(nodeId, day, targetKey, 268435456, new AbortController().signal));
    check.close();
    return { launched, events, final: events.at(-1)?.payload };
  }
  const normal = await run();
  assert.deepEqual(
    [...normal.launched].sort((a, b) => a - b),
    [0, 1, 2],
  );
  assert.deepEqual(normal.final, { status: 'SUCCEEDED' });
  assert.equal(
    normal.events.filter((e) => e.type === 'TASK_FINISHED' && e.payload.status === 'SUCCEEDED')
      .length,
    3,
  );
  const failures = await run({ fail: true });
  assert.equal(failures.launched.length, 5);
  assert.equal(failures.final.errorCode, 'ATTEMPT_LIMIT');
  const stopped = await run({ stop: true });
  assert.equal(stopped.launched.length, 1);
  const unclean = await run({ dirty: true });
  assert.equal(unclean.launched.length, 1);
  assert.equal(unclean.final.errorCode, 'CLEANUP_INCOMPLETE');
  assert.equal(unclean.final.status, 'NEEDS_REVIEW');
  const ended = await run({ cutoff: true });
  assert.equal(ended.launched.length, 1);
  assert.equal(ended.final.errorCode, 'DAY_CUTOFF');
});

test('durable resource slots survive restart and one cleanup cannot clear another slot', async (t) => {
  const root = await mkdtemp(join(resolve('.tmp'), 'open-slots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let store = await openAgentStore(root);
  const delivery = { deliveryId: randomUUID(), runId: randomUUID(), fence: 1 },
    slots = [randomUUID(), randomUUID()];
  const record = (slot) => ({
    workspace: join(root, slot),
    avdName: 'p3_' + slot.replaceAll('-', ''),
    appiumTmp: join(root, slot, 'appium-tmp'),
  });
  store.add(delivery);
  for (const slot of slots) store.androidSlot(delivery.deliveryId, slot, record(slot));
  store.close();
  store = await openAgentStore(root);
  assert.equal(store.androidSlots(delivery.deliveryId).length, 2);
  store.androidSlot(delivery.deliveryId, slots[0], null);
  store.browser(delivery.deliveryId, null);
  store.android(delivery.deliveryId, null);
  store.status(delivery.deliveryId, 'DONE', true);
  assert.equal(store.deliveries()[0].clean, false);
  assert.equal(store.androidSlots(delivery.deliveryId)[0].slot, slots[1]);
  store.androidSlot(delivery.deliveryId, slots[1], null);
  assert.equal(store.deliveries()[0].clean, true);
  store.close();
});

test('concurrent outbox flushes are serialized and preserve durable event sequence', async (t) => {
  const root = await mkdtemp(join(resolve('.tmp'), 'open-outbox-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let active = 0,
    peak = 0;
  const sequences = [];
  const engine = await TaskEngine.open(
    root,
    randomUUID(),
    randomUUID(),
    root,
    async (path, body) => {
      if (path === 'reconcile') return { reconciled: true };
      assert.equal(path, 'events');
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      sequences.push(...body.events.map((e) => e.sequence));
      active--;
      return {
        ackedEventIds: body.events.map((e) => e.eventId),
        appliedThroughSequence: body.events.at(-1).sequence,
      };
    },
  );
  try {
    const d = { deliveryId: randomUUID(), runId: randomUUID(), fence: 1 };
    engine.store.add(d);
    engine.store.append(d, { type: 'RUN_STARTED', payload: {} });
    const a = engine.flush(d);
    await delay(1);
    engine.store.append(d, { type: 'TARGETS_DISCOVERED', payload: {} });
    const b = engine.flush(d);
    await Promise.all([a, b]);
    assert.equal(peak, 1);
    assert.deepEqual(sequences, [1, 2]);
    assert.equal(engine.store.pending(d.deliveryId).length, 0);
  } finally {
    await engine.close();
  }
});

test('restart reports every unclean slot and never claims more work', async (t) => {
  const root = await mkdtemp(join(resolve('.tmp'), 'open-recover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = await openAgentStore(root),
    delivery = { deliveryId: randomUUID(), runId: randomUUID(), fence: 1 };
  store.add(delivery);
  for (const slot of [randomUUID(), randomUUID()])
    store.androidSlot(delivery.deliveryId, slot, {
      workspace: '/invalid-owned-fixture',
      avdName: 'invalid',
      appiumTmp: '/invalid-owned-fixture/appium-tmp',
    });
  store.close();
  const receipts = [];
  const engine = await TaskEngine.open(
    root,
    randomUUID(),
    randomUUID(),
    root,
    async (path, body) => {
      assert.equal(path, 'reconcile');
      receipts.push(body);
      return { reconciled: true, mayClaim: false };
    },
  );
  try {
    await engine.tick();
    assert.equal(receipts[0].cleanupComplete, false);
    assert.equal(engine.store.androidSlots(delivery.deliveryId).length, 2);
    assert.equal(engine.store.deliveries()[0].clean, false);
  } finally {
    await engine.close();
  }
});
