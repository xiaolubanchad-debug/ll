import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  devicePlanIssues,
  configurationIssues,
  DEVICE_CATALOG,
  deviceAssignments,
} from '@apk/contracts';
import { scheduleDeviceSessions } from '../packages/automation/dist/device-sessions.js';

async function fixture(n = 6) {
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
  );
  config.execution.appOpen.appsPerDevice = { min: 3, max: 3 };
  config.execution.appOpen.randomDeviceProfile = true;
  const plan = {
    purpose: 'REGISTER',
    cacheDay: '2026-10-31',
    successTarget: n,
    attemptLimit: 6,
    assets: Array.from({ length: 3 }, (_, i) => ({
      targetKey: String(i).repeat(64),
      label: 'APP ' + i,
      sourceUrl: 'https://example.com/',
      apk: { packageName: 'com.example.app' + i, abis: [], minSdkVersion: 26 },
    })),
    openPolicy: {
      concurrency: 2,
      dailyLimit: 800,
      admissionDeadline: new Date(Date.now() + 60000).toISOString(),
      sessions: [
        { id: randomUUID(), variantId: 'phone-01', assetIndexes: [2, 0, 1] },
        { id: randomUUID(), variantId: 'phone-02', assetIndexes: [1, 2, 0] },
      ],
    },
  };
  return { config, plan };
}

test('thirty distinct real model codes and six actual Android API targets; malformed ranges and duplicate packages refused', async () => {
  assert.equal(DEVICE_CATALOG.length, 30);
  assert.equal(new Set(DEVICE_CATALOG.map((d) => d.model)).size, 30);
  assert.deepEqual(
    [...new Set(DEVICE_CATALOG.map((d) => d.apiLevel))].sort(),
    [29, 31, 33, 34, 35, 36],
  );
  const { config, plan } = await fixture();
  assert.deepEqual(configurationIssues(config), []);
  assert.deepEqual(devicePlanIssues(config, plan), []);
  for (const [min, max] of [
    [0, 3],
    [4, 3],
    [1, 11],
    [1.5, 3],
  ]) {
    const c = structuredClone(config);
    c.execution.appOpen.appsPerDevice = { min, max };
    assert.ok(configurationIssues(c).length);
  }
  const bad = structuredClone(plan);
  bad.assets[1].apk.packageName = bad.assets[0].apk.packageName;
  assert.ok(devicePlanIssues(config, bad).length);
  bad.assets[1].apk.packageName = 'com.example.distinct';
  bad.assets[1].apk.minSdkVersion = 99;
  assert.ok(devicePlanIssues(config, bad).length);
});

test('two successive devices each run three apps sequentially and close once, with exact global reservations', async () => {
  const { plan } = await fixture();
  const assignments = deviceAssignments(plan),
    events = [],
    busy = new Set(),
    closed = [],
    seen = new Map(),
    devices = new Set();
  let peak = 0;
  const result = await scheduleDeviceSessions(
    plan,
    new AbortController().signal,
    () => {},
    async (e) => {
      if (e.payload.phase === 'STARTED') {
        assert.equal(devices.size, 0, 'the previous whole device must close first');
        devices.add(e.payload.sessionId);
      } else if (e.payload.phase === 'CLOSED') devices.delete(e.payload.sessionId);
      events.push(e);
    },
    async (position) => {
      const a = assignments[position];
      assert.ok(!busy.has(a.sessionId));
      busy.add(a.sessionId);
      peak = Math.max(peak, busy.size);
      const apps = seen.get(a.sessionId) ?? [];
      assert.ok(!apps.includes(a.assetIndex));
      apps.push(a.assetIndex);
      seen.set(a.sessionId, apps);
      await delay(a.appIndex === 0 ? 12 : 3);
      busy.delete(a.sessionId);
      return { success: true, clean: true, missing: false };
    },
    async (id) => {
      assert.ok(!busy.has(id));
      closed.push(id);
      return true;
    },
  );
  assert.equal(peak, 1);
  assert.equal(result.successes, 6);
  assert.equal(closed.length, 2);
  assert.equal(events.filter((e) => e.payload.phase === 'STARTED').length, 2);
  assert.deepEqual(
    [...seen.values()].map((v) => v.length),
    [3, 3],
  );
});

test('failure uses next different app, final quota prevents extra launches, all sessions close on stop', async () => {
  const { plan } = await fixture(3);
  const seen = [],
    closed = [];
  const r = await scheduleDeviceSessions(
    plan,
    new AbortController().signal,
    () => {},
    async () => {},
    async (i) => {
      seen.push(i);
      await delay(1);
      return { success: i !== 0, clean: true, missing: false };
    },
    async (id) => {
      closed.push(id);
      return true;
    },
  );
  assert.equal(r.successes, 3);
  assert.equal(seen.length, 4);
  assert.equal(new Set(seen).size, 4);
  assert.equal(closed.length, 2);
  const abort = new AbortController(),
    cleanup = [];
  await assert.rejects(
    scheduleDeviceSessions(
      plan,
      abort.signal,
      () => {},
      async () => {},
      async () => {
        abort.abort();
        await delay(1);
        return { success: false, clean: true, missing: false };
      },
      async (id) => {
        cleanup.push(id);
        return true;
      },
    ),
  );
  assert.equal(cleanup.length, 1);
});

test('more than two sessions progress; cleanup failure stops all new admission', async () => {
  const { plan } = await fixture();
  plan.openPolicy.sessions.push({
    id: randomUUID(),
    variantId: 'phone-03',
    assetIndexes: [0, 1, 2],
  });
  plan.attemptLimit = 9;
  plan.successTarget = 9;
  let count = 0;
  const r = await scheduleDeviceSessions(
    plan,
    new AbortController().signal,
    () => {},
    async () => {},
    async () => {
      count++;
      await delay(1);
      return { success: true, clean: true, missing: false };
    },
    async () => true,
  );
  assert.equal(count, 9);
  assert.equal(r.successes, 9);
  count = 0;
  const dirty = await scheduleDeviceSessions(
    plan,
    new AbortController().signal,
    () => {},
    async () => {},
    async () => {
      count++;
      await delay(1);
      return { success: true, clean: true, missing: false };
    },
    async () => false,
  );
  assert.equal(dirty.dirty, true);
  assert.equal(count, 3);
});
