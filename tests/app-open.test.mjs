import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import {
  openApk,
  inspectApk,
  isForegroundPackage,
  focusedAndroidWindow,
  androidForegroundSample,
  RegistrationError,
} from '@apk/automation';
import { appOpenSupported, agentIssues, APP_FOREGROUND_LOG } from '@apk/contracts';
import {
  androidLaunchMarker,
  addAndroidExitReasons,
  readAndroidProcessEvents,
} from '../packages/automation/dist/android-process.js';
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

test('focused window separates target, splash, system overlays, external apps and crash dialogs', () => {
  const sample = (title, focused = 'com.example.app') =>
    '  mCurrentFocus=Window{123ab u0 ' +
    title +
    '}\n  mFocusedApp=ActivityRecord{345ab u0 ' +
    focused +
    '/.Main t1}';
  for (const [title, state] of [
    ['com.example.app/.Main', 'TARGET'],
    ['Splash Screen com.example.app', 'SPLASH'],
    ['com.android.permissioncontroller/.Permission', 'SYSTEM'],
    ['com.android.chrome/.Browser', 'OTHER'],
    ['Application Error: com.example.app', 'CRASH'],
    ['Application Error: com.example.other', 'SYSTEM'],
  ])
    assert.equal(focusedAndroidWindow(sample(title), 'com.example.app'), state);
  assert.deepEqual(
    androidForegroundSample(sample('com.android.chrome/.Browser'), 'com.example.app'),
    {
      kind: 'BROWSER',
      packageName: 'com.android.chrome',
    },
  );
  assert.deepEqual(
    androidForegroundSample(sample('Browser https://private.invalid'), 'com.example.app'),
    { kind: 'UNKNOWN' },
  );
  assert.equal(
    focusedAndroidWindow(sample('com.example.app/.Main', 'com.other'), 'com.example.app'),
    'UNKNOWN',
  );
  assert.equal(
    focusedAndroidWindow(
      sample('com.example.app/.Main') + '\n mCurrentFocus=null',
      'com.example.app',
    ),
    'UNKNOWN',
  );
});

test('Android process evidence is bounded to the target launch and trusted system writer', () => {
  const marker = androidLaunchMarker('831\n1793700000.100782113 +0800\n');
  assert.deepEqual(marker, { systemPid: 831, startedAtMs: 1793700000100, utcOffset: '+0800' });
  assert.equal(androidLaunchMarker('831\n1793700000.N\n'), undefined);
  const output = [
    '1793700000.099 831  12 I am_crash: [0,512,com.example.app,0,old,old,old,1]',
    '1793700000.101 666  12 I am_crash: [0,512,com.example.app,0,spoof,spoof,spoof,1]',
    '1793700000.120 831  12 I am_proc_start: [0,512,10444,com.example.app,activity,com.example.app/.Home]',
    '1793700000.121 831  12 I am_proc_start: [0,789,10444,com.example.app2,activity,com.example.app2/.Home]',
    '1793700000.150 831  12 I am_proc_start: [0,513,10444,com.example.app:worker,service,worker]',
    '1793700000.870 831  12 I am_crash: [0,512,com.example.app,0,Native crash,PRIVATE DETAIL,file,3]',
    '1793700000.910 831  12 I am_proc_died: [0,512,com.example.app,0,5]',
    '1793700000.912 831  12 I am_kill: [0,513,com.example.app:worker,0,reason]',
  ].join('\n');
  const process = readAndroidProcessEvents(output, 'com.example.app', marker);
  for (const trigger of ['next-top-activity', 'pre-activity', 'pre-top-activity']) {
    assert.equal(
      readAndroidProcessEvents(
        output.replace(',activity,', ',' + trigger + ','),
        'com.example.app',
        marker,
      ).events[0].trigger,
      'ACTIVITY',
    );
  }
  assert.equal(
    readAndroidProcessEvents(output.replace(',activity,', ',restart,'), 'com.example.app', marker)
      .events[0].trigger,
    'OTHER',
  );
  assert.deepEqual(process, {
    availability: 'OBSERVED',
    truncated: false,
    events: [
      { kind: 'STARTED', process: 'MAIN', pid: 512, offsetMs: 20, trigger: 'ACTIVITY' },
      { kind: 'STARTED', process: 'CHILD', pid: 513, offsetMs: 50, trigger: 'SERVICE' },
      { kind: 'CRASH', process: 'MAIN', pid: 512, offsetMs: 770 },
      { kind: 'EXITED', process: 'MAIN', pid: 512, offsetMs: 810, exitReason: 'UNKNOWN' },
    ],
  });
  const local = (offset) =>
    new Date(marker.startedAtMs + offset + 8 * 3600000)
      .toISOString()
      .slice(0, -1)
      .replace('T', ' ');
  const exits =
    `ApplicationExitInfo #0:\n timestamp=${local(810)} pid=512\n process=com.example.app reason=1 (EXIT_SELF)\n description=private\n` +
    `ApplicationExitInfo #1:\n timestamp=${local(-100)} pid=512\n process=com.example.app reason=4 (CRASH)\n` +
    `ApplicationExitInfo #2:\n timestamp=${local(810)} pid=512\n process=com.other.app reason=4 (CRASH)\n`;
  assert.equal(
    addAndroidExitReasons(exits, 'com.example.app', marker, process).events.at(-1).exitReason,
    'EXIT_SELF',
  );
  assert.equal(
    readAndroidProcessEvents(Array(6).fill(output).join('\n'), 'com.example.app', marker).truncated,
    true,
  );
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
    if (variant.grouped) config.execution.appOpen.appsPerDevice = { min: 1, max: 1 };
    else delete config.execution.appOpen.appsPerDevice;
    if (variant.owned) config.execution.appOpen.ownedTestClient = true;
    else delete config.execution.appOpen.ownedTestClient;
    const logs = [],
      foregroundLogs = [],
      order = [];
    let now = 0,
      samples = 0,
      closed = false;
    const abort = new AbortController(),
      stages = [],
      notes = [];
    const result = await openApk(
      config,
      { taskId: randomUUID() },
      apk,
      file,
      0,
      abort.signal,
      async (e) => {
        if (e.type === 'LOG') {
          if (e.payload.message === APP_FOREGROUND_LOG) {
            assert.equal(closed, false);
            foregroundLogs.push(e.payload.appForeground);
            if (variant.diagnosticUnavailable) throw Error('diagnostic unavailable');
          } else logs.push(e.payload.message);
          return;
        }
        if (e.type === 'APP_OBSTRUCTION') {
          notes.push(e.payload);
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
        ...('receipt' in variant ||
        variant.receiptThrows ||
        variant.receiptHangs ||
        variant.stopInReceipt
          ? {
              testReceipt: async () => {
                assert.equal(closed, true, 'query only after APP cleanup');
                assert.equal(now, 10000, 'query cannot extend foreground dwell');
                order.push('receipt');
                if (variant.stopInReceipt) abort.abort();
                if (variant.receiptThrows) throw Error('private transport detail');
                if (variant.receiptHangs) return new Promise(() => {});
                return typeof variant.receipt === 'object'
                  ? variant.receipt
                  : { received: variant.receipt };
              },
            }
          : {}),
        androidFactory: async (_profile, _signal, options) => {
          assert.equal(options.controlMode, variant.grouped ? 'DEVICE_SESSION' : 'LAUNCH_ONLY');
          assert.equal(options.ownedTestClient, variant.owned === true);
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
            launch: async (pkg, activity, issued) => {
              order.push('launch');
              assert.equal(pkg, apk.packageName);
              assert.equal(activity, '@launcher');
              if (variant.captureDuringLaunch) {
                issued({ startedAtMs: 1793700000100, systemPid: 831 });
                await nextTurn();
              }
              if (variant.launchTimeout) {
                now += 10400;
                throw new RegistrationError('APP_LAUNCH_TIMEOUT');
              }
              if (variant.launchRejected) throw new RegistrationError('APP_LAUNCH_REJECTED');
            },
            foreground: async () => {
              samples++;
              if (variant.neverForeground || (variant.delayForeground && now < 1000)) return false;
              return !(variant.crash && now >= 4000);
            },
            ...(variant.grouped
              ? {
                  foregroundWindow: async () => {
                    const kind = variant.window?.(now) ?? 'TARGET';
                    return {
                      kind,
                      ...(kind === 'BROWSER' ? { packageName: 'com.android.chrome' } : {}),
                    };
                  },
                  ...(variant.captureDuringLaunch
                    ? {
                        processEvents: async (_pkg, marker) => {
                          assert.equal(closed, false);
                          assert.equal(marker.systemPid, 831);
                          return {
                            availability: 'OBSERVED',
                            truncated: false,
                            events: [
                              { kind: 'STARTED', process: 'MAIN', pid: 512, offsetMs: 80 },
                              ...(variant.processCrash
                                ? [
                                    {
                                      kind: 'EXITED',
                                      process: 'MAIN',
                                      pid: 512,
                                      offsetMs: 200,
                                      exitReason: 'NATIVE_CRASH',
                                    },
                                  ]
                                : []),
                            ],
                          };
                        },
                      }
                    : {}),
                  source: async () => {
                    const pkg = apk.packageName;
                    const text = variant.countdown?.(now)
                      ? '跳过 5 秒'
                      : variant.closable && !order.includes('close-ad')
                        ? '跳过广告'
                        : '正常页面';
                    const extra = variant.mixed
                      ? '<node package="com.other.app" class="android.widget.Button" text="outside" clickable="true" bounds="[5,5][60,40]" />'
                      : '';
                    return (
                      '<hierarchy><node package="' +
                      pkg +
                      '" class="android.widget.Button" text="' +
                      text +
                      '" enabled="true" clickable="true" bounds="[5,5][60,40]" />' +
                      extra +
                      '</hierarchy>'
                    );
                  },
                  find: async () => 'target',
                  rect: async () => ({ x: 5, y: 5, width: 55, height: 35 }),
                  click: async () => order.push('close-ad'),
                }
              : {}),
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
      variant.neverForeground ||
        (variant.grouped && result.status === 'FAILED' && !stages.includes('HOLDING'))
        ? ['PREPARING', 'INSTALLING', 'LAUNCHING']
        : ['PREPARING', 'INSTALLING', 'LAUNCHING', 'HOLDING'],
    );
    return { result, now, samples, logs, order, notes, foregroundLogs };
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
  assert.ok(delayed.now >= 11000 && delayed.now < 11400);
  assert.equal(delayed.result.openObservation.elapsedMs, 10000);
  const mixed = await run({ grouped: true, mixed: true, countdown: (ms) => ms < 4500 });
  assert.equal(mixed.result.status, 'SUCCEEDED');
  assert.ok(mixed.now >= 14500 && mixed.now < 16000);
  assert.deepEqual(
    mixed.notes.map((n) => n.action),
    ['WAIT_SPLASH'],
  );
  assert.ok(!mixed.order.includes('close-ad'));
  const closed = await run({ grouped: true, closable: true });
  assert.equal(closed.result.status, 'SUCCEEDED');
  assert.ok(closed.order.includes('close-ad'));
  assert.deepEqual(
    closed.notes.map((n) => n.phase),
    ['DETECTED', 'ACTION_SENT'],
  );
  const recovered = await run({
    grouped: true,
    window: (ms) => (ms >= 3500 && ms < 6200 ? 'BROWSER' : 'TARGET'),
  });
  assert.equal(recovered.result.status, 'SUCCEEDED');
  assert.ok(recovered.now >= 16200);
  assert.equal(recovered.result.openObservation.elapsedMs, 10000);
  const [log] = recovered.foregroundLogs;
  assert.equal(log.targetFocus, 'SEEN');
  assert.equal(log.switchCount, 2);
  assert.deepEqual(
    log.samples.map((s) => s.kind),
    ['TARGET', 'BROWSER', 'TARGET'],
  );
  assert.equal(log.samples[1].packageName, 'com.android.chrome');
  assert.ok(log.samples[1].offsetMs >= 3500 && log.samples[2].offsetMs >= 6200);
  assert.equal(log.last.kind, 'TARGET');
  const failedLaunch = await run({ grouped: true, launchTimeout: true, window: () => 'BROWSER' });
  assert.equal(failedLaunch.result.errorCode, 'APP_LAUNCH_TIMEOUT');
  assert.deepEqual(
    failedLaunch.foregroundLogs.map((l) => [l.scope, l.targetFocus, l.last.offsetMs, l.last.kind]),
    [['AFTER_LAUNCH_ERROR', 'NOT_SEEN', 10400, 'BROWSER']],
  );
  assert.equal((await run({ diagnosticUnavailable: true })).result.status, 'SUCCEEDED');
  const watched = await run({
    grouped: true,
    captureDuringLaunch: true,
    launchTimeout: true,
    window: (ms) => (ms < 1000 ? 'TARGET' : 'LAUNCHER'),
  });
  assert.equal(watched.result.errorCode, 'APP_LAUNCHER_TIMEOUT');
  assert.equal(watched.foregroundLogs[0].launchReceipt, 'TIMEOUT');
  assert.equal(watched.now, 20000);
  assert.equal(watched.foregroundLogs[0].scope, 'POLL');
  assert.equal(watched.foregroundLogs[0].targetFocus, 'SEEN');
  assert.deepEqual(
    watched.foregroundLogs[0].samples.map((s) => [s.kind, s.offsetMs]),
    [
      ['TARGET', 0],
      ['LAUNCHER', 10400],
    ],
  );
  assert.equal(watched.foregroundLogs[0].process.events[0].kind, 'STARTED');
  const late = await run({
    grouped: true,
    captureDuringLaunch: true,
    launchTimeout: true,
    window: (ms) => (ms < 12000 ? 'UNKNOWN' : 'TARGET'),
  });
  assert.equal(late.result.status, 'SUCCEEDED');
  assert.equal(late.result.openObservation.elapsedMs, 10000);
  assert.equal(late.foregroundLogs[0].launchReceipt, 'TIMEOUT');
  assert.equal(late.order.filter((item) => item === 'launch').length, 1);
  const withoutWindow = await run({
    grouped: true,
    captureDuringLaunch: true,
    launchTimeout: true,
    window: () => 'UNKNOWN',
  });
  assert.equal(withoutWindow.result.errorCode, 'APP_PROCESS_WITHOUT_WINDOW');
  assert.equal(withoutWindow.now, 20000);
  const rejected = await run({ grouped: true, captureDuringLaunch: true, launchRejected: true });
  assert.equal(rejected.result.errorCode, 'APP_LAUNCH_REJECTED');
  assert.equal(rejected.foregroundLogs[0].launchReceipt, 'REJECTED');
  assert.equal(rejected.now, 0);
  const crashed = await run({
    grouped: true,
    captureDuringLaunch: true,
    processCrash: true,
    window: () => 'UNKNOWN',
  });
  assert.equal(crashed.result.errorCode, 'APP_STARTUP_CRASH');
  for (const [variant, code] of [
    [{ window: () => 'SYSTEM' }, 'APP_SYSTEM_WINDOW_BLOCKED'],
    [{ window: () => 'OTHER' }, 'APP_EXTERNAL_WINDOW_TIMEOUT'],
    [{ countdown: () => true }, 'APP_SPLASH_TIMEOUT'],
    [{ window: () => 'CRASH' }, 'APP_STARTUP_CRASH'],
  ]) {
    const blocked = await run({ grouped: true, ...variant });
    assert.equal(blocked.result.errorCode, code);
    assert.equal(blocked.result.cleanupComplete, true);
    assert.equal(blocked.now, code === 'APP_STARTUP_CRASH' ? 0 : 20000);
  }
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
  const confirmed = await run({ owned: true, report: 'NETWORK_TIMEOUT', receipt: true });
  assert.deepEqual(confirmed.logs, [
    '自有测试 APK：网络响应尚未确认',
    '自有测试 APK：中台已确认收到（APP响应未确认）',
  ]);
  assert.deepEqual(confirmed.order, ['install', 'bootstrap', 'provision', 'launch', 'receipt']);
  assert.equal(confirmed.result.status, 'SUCCEEDED');
  for (const variant of [
    { receipt: false },
    { receipt: { received: true, password: 'forbidden' } },
    { receiptThrows: true },
  ]) {
    const pending = await run({ owned: true, report: 'NETWORK_TIMEOUT', ...variant });
    assert.deepEqual(pending.logs, ['自有测试 APK：网络响应尚未确认']);
    assert.equal(pending.result.proof, 'APP_OPEN');
  }
  for (const variant of [
    { report: 'HTTP_200' },
    { report: 'HTTP_403' },
    { report: 'NETWORK_TIMEOUT', dirty: true },
    { report: 'NETWORK_TIMEOUT', stopInCleanup: true },
  ]) {
    const skipped = await run({ owned: true, receipt: true, ...variant });
    assert.equal(skipped.order.includes('receipt'), false);
  }
  const began = Date.now();
  const timed = await run({ owned: true, report: 'NETWORK_TIMEOUT', receiptHangs: true });
  assert.equal(timed.now, 10000);
  assert.ok(Date.now() - began < 3500, 'unresponsive receipt query must be bounded');
  assert.deepEqual(timed.logs, ['自有测试 APK：网络响应尚未确认']);
  const stoppedReceipt = await run({
    owned: true,
    report: 'NETWORK_TIMEOUT',
    receipt: true,
    stopInReceipt: true,
  });
  assert.equal(stoppedReceipt.result.status, 'CANCELLED');
  assert.deepEqual(stoppedReceipt.logs, ['自有测试 APK：网络响应尚未确认']);
  assert.equal((await run({ receipt: true })).order.includes('receipt'), false);
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
