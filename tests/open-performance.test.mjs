import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate as immediate } from 'node:timers/promises';
import {
  prepareAndroidInParallel,
  deviceProperties,
  hasAndroidDefaultNetwork,
  waitForAndroidNetwork,
  openTimer,
  inspectApk,
  verifyApkIntegrity,
  RegistrationError,
} from '@apk/automation';
import { appOpenTimingsIssues, parallelAppOpenSupported } from '@apk/contracts';
import { fixtureApk } from './p2-fixtures.mjs';
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test('Android readiness requires a unique current default network, not Wi-Fi or historical logs', () => {
  assert.equal(hasAndroidDefaultNetwork('Active default network: 100\nNetwork diagnostics'), true);
  assert.equal(hasAndroidDefaultNetwork('  Active default network: 103\r\n'), true);
  for (const text of [
    '',
    'Active default network: none',
    'Active default network: 0',
    'Wi-Fi enabled\nlog: Active default network: 100',
    'Active default network: 100\nActive default network: none',
    'Active default network: 100 trailing text',
  ])
    assert.equal(hasAndroidDefaultNetwork(text), false);
});

test('boot waits for the default route, honors cancellation and bounds unavailable network reads', async () => {
  let now = 0,
    reads = 0,
    checks = 0;
  const clock = {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
  await waitForAndroidNetwork(
    new AbortController().signal,
    async () => {
      reads++;
      return reads < 3 ? 'Active default network: none' : 'Active default network: 100';
    },
    () => {
      checks++;
    },
    clock,
  );
  assert.equal(reads, 3);
  assert.equal(now, 1000);
  assert.equal(checks, 6);
  now = 0;
  await assert.rejects(
    waitForAndroidNetwork(
      new AbortController().signal,
      async () => {
        throw Error('private system output');
      },
      () => {},
      clock,
    ),
    (e) => e.code === 'ANDROID_NOT_READY',
  );
  assert.equal(now, 30000);
  const cancelled = new AbortController();
  await assert.rejects(
    waitForAndroidNetwork(
      cancelled.signal,
      async () => {
        cancelled.abort();
        return 'Active default network: 100';
      },
      () => {},
      clock,
    ),
    (e) => e.code === 'CANCELLED',
  );
  await assert.rejects(
    waitForAndroidNetwork(
      new AbortController().signal,
      async () => '',
      () => {
        throw new RegistrationError('CANCELLED');
      },
      clock,
    ),
    (e) => e.code === 'CANCELLED',
  );
});

test('preparation overlaps proxy and boot but returns only after both finish', async () => {
  const proxy = deferred(),
    boot = deferred(),
    started = [],
    signal = new AbortController().signal;
  let finished = false;
  const job = prepareAndroidInParallel(
    signal,
    async () => {
      started.push('proxy');
      await proxy.promise;
      return 'observed';
    },
    async () => {
      started.push('boot');
      await boot.promise;
    },
  ).then((v) => {
    finished = true;
    return v;
  });
  assert.deepEqual(started, ['proxy', 'boot']);
  proxy.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(finished, false);
  boot.resolve();
  assert.equal(await job, 'observed');
});

for (const failure of ['proxy', 'boot', 'stop'])
  test('preparation drains both branches before cleanup on ' + failure, async () => {
    const abort = new AbortController(),
      trigger = deferred(),
      drained = deferred();
    let peerAborted = false,
      finished = false;
    const task = prepareAndroidInParallel(
      abort.signal,
      async (s) => {
        await trigger.promise;
        if (failure === 'proxy') throw new RegistrationError('PROXY_CHECK_FAILED');
        {
          await new Promise((r) =>
            s.aborted ? r() : s.addEventListener('abort', r, { once: true }),
          );
          peerAborted = true;
          await drained.promise;
        }
        return 'ok';
      },
      async (s) => {
        await trigger.promise;
        if (failure === 'boot') throw new RegistrationError('ANDROID_NOT_READY');
        await new Promise((r) =>
          s.aborted ? r() : s.addEventListener('abort', r, { once: true }),
        );
        peerAborted = true;
        await drained.promise;
      },
    );
    const result = task.catch((e) => {
      finished = true;
      return e;
    });
    trigger.resolve();
    if (failure === 'stop') abort.abort();
    await immediate();
    assert.equal(peerAborted, true);
    assert.equal(finished, false);
    drained.resolve();
    assert.equal(
      (await result).code,
      failure === 'proxy'
        ? 'PROXY_CHECK_FAILED'
        : failure === 'boot'
          ? 'ANDROID_NOT_READY'
          : 'CANCELLED',
    );
  });

test('device property reader keeps only required values, rejects duplicate properties and missing SDK', () => {
  const p = deviceProperties(
    '[ro.build.version.sdk]: [30]\n[ro.product.model]: [Pixel 4]\n[persist.sys.locale]: []\n[ro.product.locale]: [zh-CN]\n[ro.product.cpu.abilist]: [x86_64,arm64-v8a]\n[secret.password]: [never retained]',
  );
  assert.deepEqual(p, {
    api: 30,
    model: 'Pixel 4',
    locale: 'zh-CN',
    supportedAbis: ['x86_64', 'arm64-v8a'],
  });
  assert.ok(Number.isNaN(deviceProperties('').api));
  assert.throws(
    () => deviceProperties('[ro.product.model]: [one]\n[ro.product.model]: [two]'),
    (e) => e.code === 'DEVICE_PROFILE_UNSUPPORTED',
  );
});

test('timings use relative monotonic intervals and permit overlapping preparation, including failure', async () => {
  let now = 500;
  const timer = openTimer(() => now),
    gate = deferred();
  const proxy = timer.measure('PROXY_CHECK', async () => {
    await gate.promise;
    now = 1500;
  });
  now = 700;
  await timer.measure('AVD_CREATE', async () => {
    now = 1000;
  });
  gate.resolve();
  await proxy;
  now = 1700;
  await timer.measure('CLEANUP', async () => false);
  const t = timer.finish();
  assert.equal(t.totalMs, 1200);
  assert.deepEqual(appOpenTimingsIssues(t), []);
  assert.equal(t.steps.find((s) => s.name === 'PROXY_CHECK').elapsedMs, 1000);
  assert.equal(t.steps.find((s) => s.name === 'CLEANUP').outcome, 'FAILED');
  assert.equal(parallelAppOpenSupported(['APP_OPEN_PARALLEL_V1'], '0.11.1'), true);
  for (const mutate of [
    (t) => t.steps.push(t.steps[0]),
    (t) => (t.steps[0].elapsedMs = t.totalMs + 1),
    (t) => (t.steps[0].startedMs = -1),
    (t) => (t.steps[0].name = 'SHELL'),
    (t) => (t.steps[0].password = 'forbidden'),
  ]) {
    const bad = structuredClone(t);
    mutate(bad);
    assert.ok(appOpenTimingsIssues(bad).length);
  }
});

test('installation integrity verifies bytes and rejects same-size tampering, directories, symlinks and cancellation', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'apk-integrity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'owned.apk'),
    signal = new AbortController().signal;
  await writeFile(file, fixtureApk());
  const apk = await inspectApk(file, 268435456, '2026-10-30', signal);
  await verifyApkIntegrity(file, apk, 268435456, signal);
  const bytes = await readFile(file);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(file, bytes);
  await assert.rejects(
    verifyApkIntegrity(file, apk, 268435456, signal),
    (e) => e.code === 'APK_INVALID',
  );
  await assert.rejects(
    verifyApkIntegrity(dir, apk, 268435456, signal),
    (e) => e.code === 'APK_INVALID',
  );
  await writeFile(file, fixtureApk());
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    verifyApkIntegrity(file, apk, 268435456, abort.signal),
    (e) => e.code === 'CANCELLED',
  );
  const link = join(dir, 'link.apk');
  try {
    await symlink(file, link);
  } catch (e) {
    if (['EPERM', 'EACCES'].includes(e.code)) return;
    throw e;
  }
  await assert.rejects(
    verifyApkIntegrity(link, apk, 268435456, signal),
    (e) => e.code === 'APK_INVALID',
  );
});
