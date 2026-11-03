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
import {
  androidCommand,
  androidInstallFailure,
  isAndroidInstallRejection,
} from '../packages/automation/dist/android.js';

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

test('only a completed Android install rejection can confirm that the package inventory should be checked', async () => {
  let rejected = false;
  await assert.rejects(
    androidCommand(
      process.execPath,
      [
        '-e',
        "console.error('adb: failed to install sample.apk: Failure [INSTALL_FAILED_OLDER_SDK: fixture]'); process.exitCode=1;",
      ],
      process.env,
      undefined,
      5000,
      'APK_INSTALL_FAILED',
      undefined,
      16384,
      undefined,
      (output) => {
        rejected = isAndroidInstallRejection(output);
        return androidInstallFailure(output);
      },
    ),
    { code: 'APK_INSTALL_ANDROID_VERSION' },
  );
  assert.equal(rejected, true);
  assert.equal(isAndroidInstallRejection('adb: device offline'), false);
  assert.equal(
    isAndroidInstallRejection('adb: failed to install sample.apk: Failure [unexpected]'),
    false,
  );
  assert.equal(isAndroidInstallRejection('Failure [INSTALL_FAILED_OLDER_SDK'), false);
  assert.equal(androidInstallFailure('adb: device offline'), 'APK_INSTALL_DEVICE_UNAVAILABLE');
  assert.equal(
    androidInstallFailure('Failure [INSTALL_FAILED_NO_MATCHING_ABIS: private fixture]'),
    'APK_INSTALL_ABI_MISMATCH',
  );
  assert.equal(
    androidInstallFailure('Failure [INSTALL_FAILED_MISSING_SPLIT]'),
    'APK_INSTALL_SPLIT_REQUIRED',
  );
  assert.equal(
    androidInstallFailure('Failure [INSTALL_PARSE_FAILED_BAD_MANIFEST]'),
    'APK_INSTALL_INVALID',
  );
  assert.equal(
    androidInstallFailure('Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]'),
    'APK_INSTALL_SIGNATURE_CONFLICT',
  );
  assert.equal(
    androidInstallFailure('Failure [INSTALL_FAILED_UNKNOWN_FIXTURE]'),
    'APK_INSTALL_REJECTED',
  );
  assert.equal(androidInstallFailure('adb: fixture /private/file.apk'), 'APK_INSTALL_UNCONFIRMED');
  let received = false;
  await assert.rejects(
    androidCommand(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      process.env,
      undefined,
      100,
      'APK_INSTALL_UNCONFIRMED',
      undefined,
      16384,
      undefined,
      () => {
        received = true;
      },
      'APK_INSTALL_TIMEOUT',
    ),
    { code: 'APK_INSTALL_TIMEOUT' },
  );
  assert.equal(received, false);
});

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
    [1, 1001],
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
      return { success: true, failed: false, missing: false };
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

test('failure retires its device before continuing, and all sessions close on stop', async () => {
  const { plan } = await fixture(3);
  const seen = [],
    closed = [],
    events = [];
  const r = await scheduleDeviceSessions(
    plan,
    new AbortController().signal,
    () => {},
    async (event) => {
      if (event.payload.phase === 'STARTED' && events.length)
        assert.equal(events.at(-1).payload.phase, 'CLOSED');
      events.push(event);
    },
    async (i) => {
      seen.push(i);
      await delay(1);
      return { success: i !== 0, failed: i === 0, missing: false };
    },
    async (id) => {
      closed.push(id);
      return true;
    },
  );
  assert.equal(r.successes, 3);
  assert.deepEqual(seen, [0, 3, 4, 5]);
  assert.equal(r.skipped, 2);
  assert.equal(events[1].payload.skipRemaining, true);
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
        return { success: false, failed: false, missing: false };
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
      return { success: true, failed: false, missing: false };
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
      return { success: false, failed: true, missing: false };
    },
    async () => false,
  );
  assert.equal(dirty.dirty, true);
  assert.equal(dirty.skipped, 0);
  assert.equal(count, 1);
});

test('preserved queue skips only the failed app, replaces a dirty device, and retries preparation once', async () => {
  const { plan } = await fixture();
  plan.openPolicy.preserveQueue = true;
  plan.openPolicy.concurrency = 1;
  const run = async (attempt, clean = true) => {
    const events = [],
      positions = [];
    const result = await scheduleDeviceSessions(
      plan,
      new AbortController().signal,
      () => {},
      async (event) => {
        events.push(event.payload);
      },
      async (position, epoch) => {
        positions.push([position, epoch]);
        return { success: true, failed: false, missing: false, ...attempt(position, epoch) };
      },
      async () => clean,
    );
    return { events, positions, result };
  };
  const same = await run((i) => (i === 0 ? { success: false, failed: true } : {}));
  assert.deepEqual(same.positions, [
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
    [4, 1],
    [5, 1],
  ]);
  const replacement = await run((i) =>
    i === 0 ? { success: false, failed: true, replaceDevice: true } : {},
  );
  assert.deepEqual(replacement.positions, [
    [0, 1],
    [1, 2],
    [2, 2],
    [3, 1],
    [4, 1],
    [5, 1],
  ]);
  assert.equal(replacement.events[1].replacementReason, 'APP_CLEANUP_UNCONFIRMED');
  assert.equal(replacement.events[2].sessionId, replacement.events[0].sessionId);
  assert.equal(replacement.events[2].deviceEpoch, 2);
  assert.equal(
    replacement.events.some((e) => e.skipRemaining),
    false,
  );
  const preparation = await run((i, epoch) =>
    i === 0 && epoch === 1 ? { success: false, preparationFailed: true, appiumFailed: true } : {},
  );
  assert.deepEqual(preparation.positions.slice(0, 3), [
    [0, 1],
    [0, 2],
    [1, 2],
  ]);
  assert.equal(preparation.events[1].replacementReason, 'APPIUM_FAILED');
  const paused = await run(() => ({ success: false, preparationFailed: true }));
  assert.deepEqual(paused.positions, [
    [0, 1],
    [0, 2],
  ]);
  assert.equal(paused.result.preparationFailed, true);
  const dirty = await run(() => ({ success: false, failed: true, replaceDevice: true }), false);
  assert.deepEqual(dirty.positions, [[0, 1]]);
  assert.equal(dirty.result.dirty, true);
});
