import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openApk, inspectApk, isForegroundPackage } from '@apk/automation';
import { appOpenSupported, agentIssues } from '@apk/contracts';
import { fixtureApk } from './p2-fixtures.mjs';

test('foreground uses resumed package only and rejects missing, ambiguous or foreign activity', () => {
  assert.equal(
    isForegroundPackage(
      '  topResumedActivity=ActivityRecord{abc u0 com.example.app/.Main t1}',
      'com.example.app',
    ),
    true,
  );
  assert.equal(
    isForegroundPackage(
      '  mResumedActivity: ActivityRecord{abc u0 com.example.app/.Main t1}',
      'com.example.app',
    ),
    true,
  );
  for (const text of [
    '',
    'ActivityRecord{abc u0 com.example.app/.Main t1}',
    'topResumedActivity=ActivityRecord{abc u0 com.example.other/.Main t1}',
    'topResumedActivity=null\nmResumedActivity: ActivityRecord{abc u0 com.example.app/.Main t1}',
    'topResumedActivity=ActivityRecord{abc u0 com.example.app/.Main t1}\ntopResumedActivity=ActivityRecord{abc u0 com.other/.Main t2}',
  ])
    assert.equal(isForegroundPackage(text, 'com.example.app'), false);
  assert.equal(appOpenSupported(['APP_OPEN_V1'], '0.9.2'), false);
  assert.equal(appOpenSupported([], '0.10.0'), false);
  assert.equal(appOpenSupported(['APP_OPEN_V1'], '0.10.0'), true);
  assert.equal(appOpenSupported(['APP_OPEN_V1'], '0.11.1'), true);
});

test('open-only completion follows measured foreground dwell and cleanup, without any UI/account calls', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'apk-open-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.app-open.valid.json', 'utf8'),
  );
  const file = join(dir, 'owned.apk');
  await writeFile(file, fixtureApk());
  const clientFile = join(dir, 'client.apk');
  await writeFile(clientFile, fixtureApk('com.apkplatform.testclient'));
  async function run(variant = {}) {
    const file = variant.owned ? clientFile : join(dir, 'owned.apk');
    const apk = await inspectApk(file, 268435456, '2026-10-30', new AbortController().signal);
    if (variant.owned) config.execution.appOpen.ownedTestClient = true;
    else delete config.execution.appOpen.ownedTestClient;
    const logs = [],
      order = [];
    let now = 0,
      samples = 0,
      closed = false;
    const abort = new AbortController(),
      stages = [];
    const result = await openApk(
      config,
      { taskId: randomUUID() },
      apk,
      file,
      0,
      abort.signal,
      async (e) => {
        if (e.type === 'LOG') {
          logs.push(e.payload.message);
          return;
        }
        assert.equal(e.type, 'TASK_STAGE');
        stages.push(e.payload.stage);
        assert.equal(closed, false);
      },
      {
        root: dir,
        sdkRoot: dir,
        toolsRoot: dir,
        proxy: { host: 'example.test', port: 10000, username: 'fixture', password: 'fixture' },
        beforeAction() {},
        resources: async () => {},
        clock: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
            if (variant.stop && now >= 3000) abort.abort();
          },
        },
        testBootstrap: async () => {
          order.push('bootstrap');
          return { token: 'x'.repeat(43) };
        },
        androidFactory: async (_profile, _signal, options) => {
          assert.equal(options.controlMode, 'LAUNCH_ONLY');
          const session = {
            supportedAbis: apk.abis,
            observation: { profileId: 'owned-fixture' },
            install: async (path) => {
              order.push('install');
              assert.equal(path, file);
            },
            ...(variant.owned
              ? {
                  provisionTestClient: async () => {
                    order.push('provision');
                  },
                  testClientStatus: async () => variant.report,
                }
              : {}),
            launch: async (pkg, activity) => {
              order.push('launch');
              assert.equal(pkg, apk.packageName);
              assert.equal(activity, '@launcher');
            },
            foreground: async () => {
              samples++;
              if (variant.neverForeground || (variant.delayForeground && now < 1000)) return false;
              return !(variant.crash && now >= 4000);
            },
            close: async () => {
              closed = true;
              if (variant.stopInCleanup) abort.abort();
              return !variant.dirty;
            },
          };
          return new Proxy(session, {
            get: (obj, key) => {
              if (key === 'then') return undefined;
              if (!(key in obj)) assert.fail('forbidden UI/account method ' + String(key));
              return obj[key];
            },
          });
        },
      },
    );
    assert.equal(closed, true);
    assert.deepEqual(
      stages,
      variant.neverForeground
        ? ['PREPARING', 'INSTALLING', 'LAUNCHING']
        : ['PREPARING', 'INSTALLING', 'LAUNCHING', 'HOLDING'],
    );
    return { result, now, samples, logs, order };
  }
  const { result, now, samples } = await run();
  assert.equal(now, 10000);
  assert.equal(samples, 11);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.proof, 'APP_OPEN');
  assert.equal(result.openObservation.elapsedMs, 10000);
  assert.equal(result.cleanupComplete, true);
  const delayed = await run({ delayForeground: true });
  assert.equal(delayed.result.status, 'SUCCEEDED');
  assert.equal(delayed.now, 11000);
  assert.equal(delayed.result.openObservation.elapsedMs, 10000);
  for (const [variant, code] of [
    [{ crash: true }, 'APP_NOT_FOREGROUND'],
    [{ stop: true }, 'CANCELLED'],
    [{ stopInCleanup: true }, 'CANCELLED'],
    [{ dirty: true }, 'CLEANUP_INCOMPLETE'],
    [{ neverForeground: true }, 'APP_NOT_FOREGROUND'],
  ]) {
    const { result: failed } = await run(variant);
    assert.notEqual(failed.status, 'SUCCEEDED');
    assert.equal(failed.proof, 'NONE');
    assert.equal(failed.errorCode, code);
    assert.equal(failed.openObservation, undefined);
    assert.equal(failed.cleanupComplete, !variant.dirty);
  }
  for (const [report, message] of [
    ['HTTP_200', '自有测试 APK：账户已上报'],
    ['NETWORK_TIMEOUT', '自有测试 APK：网络响应尚未确认'],
    ['HTTP_422', '自有测试 APK：请求未获接受'],
    ['secret-token-raw', '自有测试 APK：上报结果尚未确认'],
  ]) {
    const owned = await run({ owned: true, report });
    assert.equal(owned.now, 10000);
    assert.equal(owned.result.proof, 'APP_OPEN');
    assert.deepEqual(owned.order, ['install', 'bootstrap', 'provision', 'launch']);
    assert.deepEqual(owned.logs, [message]);
  }
  const { cleanupComplete, ...payload } = result;
  assert.equal(cleanupComplete, true);
  const envelope = {
    kind: 'events',
    protocolVersion: '1.0',
    nodeId: randomUUID(),
    deliveryId: randomUUID(),
    fence: 1,
    events: [
      {
        eventId: randomUUID(),
        runId: randomUUID(),
        taskId: randomUUID(),
        sequence: 1,
        occurredAt: new Date().toISOString(),
        type: 'TASK_FINISHED',
        payload,
      },
    ],
  };
  assert.deepEqual(agentIssues(envelope), []);
  for (const mutate of [
    (p) => {
      p.openObservation.elapsedMs = 9999;
    },
    (p) => {
      p.openObservation.cleanupComplete = false;
    },
    (p) => {
      p.openObservation.samples = 1;
    },
    (p) => {
      p.accountRef = randomUUID();
    },
    (p) => {
      p.proof = 'APP_UI';
    },
    (p) => {
      delete p.openObservation;
    },
    (p) => {
      p.artifactIds = [randomUUID()];
    },
    (p) => {
      p.openTimings.steps.push(p.openTimings.steps[0]);
    },
    (p) => {
      p.openTimings.steps[0].elapsedMs = p.openTimings.totalMs + 1;
    },
  ]) {
    const e = structuredClone(envelope);
    mutate(e.events[0].payload);
    assert.ok(agentIssues(e).length);
  }
});
