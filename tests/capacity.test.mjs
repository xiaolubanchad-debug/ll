import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { estimateOpenCapacity } from '@apk/platform';
import {
  configurationIssues,
  schemaIssues,
  devicePlanIssues,
  openPolicyIssues,
  executionCapacitySupported,
} from '@apk/contracts';
import { scheduleDeviceSessions } from '../packages/automation/dist/device-sessions.js';
import { createServer } from 'node:http';
import { callHub } from '../apps/agent/dist/main.js';
import { validManifest } from '@apk/platform';

test('0.14 signed capacity manifests require complete device toolchain', () => {
  const archive = (role) => ({
    role,
    url: 'https://dl.google.com/android/repository/' + role + '.zip',
    checksum: 'sha1:' + 'c'.repeat(40),
    revision: '1.0.0',
  });
  const m = {
    id: randomUUID(),
    gitCommit: 'a'.repeat(40),
    agentVersion: '0.14.0',
    protocolVersion: '1.0',
    artifactName: 'agent-' + 'b'.repeat(64) + '.tgz',
    sha256: 'b'.repeat(64),
    signature: Buffer.alloc(64).toString('base64'),
    playbookSha256: 'c'.repeat(64),
    features: [
      'EXECUTION_CAPACITY_V1',
      'DEVICE_SESSIONS_V1',
      'DEVICE_VARIANTS_V1',
      'APP_OPEN_V1',
      'APP_OPEN_PARALLEL_V1',
      'REGISTRATION_V1',
      'CONTENT_ISOLATION_V1',
      'APP_READINESS_V1',
    ],
    toolchain: {
      nodeVersion: '24.18.0',
      nodeUrl: 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz',
      nodeSha256: 'b'.repeat(64),
      playwrightVersion: '1.64.1',
      appiumVersion: '3.9.0',
      uiautomator2Version: '8.7.2',
      npmLockSha256: 'b'.repeat(64),
      systemImage: 'system-images;android-35;google_apis;x86_64',
      archives: ['cmdlineTools', 'emulator', 'platformTools', 'systemImage'].map(archive),
      extraSystemImages: [29, 31, 33, 34, 36].map((apiLevel) => ({
        ...archive('systemImage'),
        apiLevel,
      })),
    },
  };
  assert.equal(validManifest(m).agentVersion, '0.14.0');
  for (const patch of [
    { agentVersion: '0.13.3' },
    { features: m.features.filter((f) => f !== 'DEVICE_SESSIONS_V1') },
    { toolchain: { ...m.toolchain, extraSystemImages: [] } },
  ])
    assert.throws(() => validManifest({ ...m, ...patch }));
});
test('Agent streams bounded large configuration snapshots while preserving smaller response boundaries', async () => {
  let size = 1200000;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
      void _;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ padding: 'x'.repeat(size) }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port;
    const path = 'deliveries/' + randomUUID() + '/config';
    assert.equal((await callHub(url, path, 'fixture', {})).padding.length, size);
    await assert.rejects(callHub(url, 'claims', 'fixture', {}), /HUB_RESPONSE_INVALID/);
    await assert.rejects(callHub(url, 'heartbeats', 'fixture', {}), /HUB_RESPONSE_INVALID/);
    size = 8 * 1024 * 1024;
    await assert.rejects(callHub(url, path, 'fixture', {}), /HUB_RESPONSE_INVALID/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('capacity estimate amortizes real setup, reserves time and labels reference samples', () => {
  const samples = [
    { setupMs: 88222.5, appMs: 22146.5, apps: 20, owned: true },
    { setupMs: 57647.5, appMs: 19317, apps: 20, owned: true },
    { setupMs: 47111, appMs: 18705.45, apps: 20, owned: true },
  ];
  const eight = estimateOpenCapacity(samples, 8),
    ten = estimateOpenCapacity(samples, 10),
    many = estimateOpenCapacity(samples, 30);
  assert.equal(eight.recommendedLimit, 1900);
  assert.equal(ten.recommendedLimit, 2050);
  assert.ok(many.recommendedLimit > ten.recommendedLimit);
  assert.equal(eight.sampleApps, 60);
  assert.equal(eight.sampleScope, 'OWNED_TEST_ONLY');
  assert.equal(eight.reservePercent, 25);
  assert.equal(estimateOpenCapacity([], 8).sampleScope, 'CONSERVATIVE_REFERENCE');
  assert.equal(estimateOpenCapacity([{ setupMs: -1, appMs: 1, apps: 20 }], 8).sampleRuns, 0);
  assert.equal(executionCapacitySupported(['EXECUTION_CAPACITY_V1'], '0.13.3'), false);
  assert.equal(executionCapacitySupported(['EXECUTION_CAPACITY_V1'], '0.14.0'), true);
  assert.equal(executionCapacitySupported([], '0.14.0'), false);
});
test('extended config and schema support 37 distinct APPs and more than 1000 attempts, preserve old policy checks', async () => {
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
  );
  config.execution.appOpen.appsPerDevice = { min: 8, max: 37 };
  config.execution.appOpen.randomDeviceProfile = true;
  assert.deepEqual(configurationIssues(config), []);
  for (const value of [0, 1001, 1.1]) {
    const c = structuredClone(config);
    c.execution.appOpen.appsPerDevice.max = value;
    assert.ok(configurationIssues(c).length);
  }
  for (const dailyLimit of [0, 8641, 2.5, '2000'])
    assert.ok(schemaIssues('NodeCapacityInput', { dailyLimit }).length);
  for (const dailyLimit of [null, 1900, 8640])
    assert.deepEqual(schemaIssues('NodeCapacityInput', { dailyLimit }), []);
  assert.ok(schemaIssues('NodeCapacityInput', { dailyLimit: 1900, password: 'forbidden' }).length);
  const plan = {
    purpose: 'REGISTER',
    cacheDay: '2026-11-02',
    successTarget: 2000,
    attemptLimit: 2000,
    assets: Array.from({ length: 37 }, (_, i) => ({
      targetKey: String(i % 10).repeat(64),
      label: 'Owned fixture',
      sourceUrl: 'https://example.test/',
      apk: {
        packageName: 'com.example.fixture' + i,
        abis: [],
        minSdkVersion: 26,
        size: 10,
        apkSha256: 'a'.repeat(64),
        cacheDay: '2026-11-02',
        versionCode: 1,
        versionName: '1',
      },
    })),
    openPolicy: {
      capacityVersion: 1,
      concurrency: 1,
      dailyLimit: 2500,
      admissionDeadline: '2026-11-02T15:55:00.000Z',
      sessions: [],
    },
  };
  for (let left = 2000; left > 0; ) {
    const count = Math.min(left, 37);
    plan.openPolicy.sessions.push({
      id: randomUUID(),
      variantId: plan.openPolicy.sessions.length % 2 ? 'phone-01' : 'phone-02',
      assetIndexes: Array.from({ length: count }, (_, i) => i),
    });
    left -= count;
  }
  assert.deepEqual(schemaIssues('DailyExecutionPlan', plan), []);
  assert.deepEqual(devicePlanIssues(config, plan), []);
  assert.ok(
    openPolicyIssues({ ...plan, openPolicy: { ...plan.openPolicy, dailyLimit: 1999 } }).length,
  );
  assert.ok(
    schemaIssues('DailyExecutionPlan', {
      ...plan,
      openPolicy: { ...plan.openPolicy, capacityVersion: undefined, dailyLimit: 2500 },
    }).length,
  );
  let calls = 0,
    closed = 0,
    started = 0,
    active = 0,
    peak = 0;
  await scheduleDeviceSessions(
    plan,
    new AbortController().signal,
    () => {},
    async (e) => {
      if (e.payload.phase === 'STARTED') {
        started++;
        active++;
        peak = Math.max(peak, active);
      }
    },
    async () => {
      calls++;
      return { success: true, clean: true, missing: false };
    },
    async () => {
      closed++;
      active--;
      return true;
    },
    () => Date.parse('2026-11-02T04:00:00.000Z'),
  );
  assert.equal(calls, 2000);
  assert.equal(closed, plan.openPolicy.sessions.length);
  assert.equal(started, closed);
  assert.equal(peak, 1);
});
