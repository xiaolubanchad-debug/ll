import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  describeApkFile,
  apkFileName,
  ApkCache,
  openApk,
  runDownload,
  NetworkPolicy,
} from '@apk/automation';
import { chromium } from '@playwright/test';
import { fixtureSite } from './p2-fixtures.mjs';
import { schemaIssues, devicePlanIssues } from '@apk/contracts';
import {
  checkConfiguredSourceElements,
  describeSourceElements,
  locateSourceElement,
} from '../packages/automation/dist/source-elements.js';

test('manual checks support attributes, tags and XPath without extra taps, and retain missing/read-error distinctions', async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<i name="download">Owned icon</i><button>Owned button</button>');
  const value = `both'and"quotes`;
  await page.locator('i').evaluate((e, value) => e.setAttribute('data-key', value), value);
  const rules = [
    { id: randomUUID(), label: 'name', kind: 'ATTRIBUTE', attribute: 'name', value: 'download' },
    { id: randomUUID(), label: 'i', kind: 'TAG', tag: 'i' },
    { id: randomUUID(), label: 'quotes', kind: 'ATTRIBUTE', attribute: 'data-key', value },
    { id: randomUUID(), label: 'missing pid', kind: 'ATTRIBUTE', attribute: 'pid', value: '1230' },
    { id: randomUUID(), label: 'invalid expression', kind: 'XPATH', xpath: '//*[' },
  ];
  const events = [];
  await checkConfiguredSourceElements(
    page,
    rules,
    AbortSignal.timeout(10000),
    async (e) => events.push(e),
    () => {},
  );
  assert.deepEqual(
    events.map((e) => e.payload.status),
    ['FOUND', 'FOUND', 'FOUND', 'NOT_FOUND', 'READ_FAILED'],
  );
  assert.deepEqual(
    events.map((e) => e.payload.matchedCount),
    [1, 1, 1, 0, 0],
  );
  const described = describeSourceElements([
    {
      position: 0,
      tag: 'i',
      label: 'Owned icon',
      attributes: [{ name: 'name', value: 'download' }],
    },
  ])[0];
  assert.equal(await (await locateSourceElement(page, '//i', described)).count(), 1);
  await page.locator('i').evaluate((e) => e.remove());
  await assert.rejects(
    locateSourceElement(page, '//i', described),
    (e) => e.code === 'TARGET_MISSING',
  );
  assert.ok(events.every((e) => schemaIssues('SourceElementObservation', e.payload).length === 0));
});

test('download receipt accepts arbitrary file bytes without manifest parsing and retains a safe filename', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'file-assets-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'bytes');
  await writeFile(file, 'not a ZIP; Android must decide');
  const apk = await describeApkFile(
    file,
    1000,
    '2026-11-03',
    'C:\\uploads\\1.APK',
    AbortSignal.timeout(1000),
  );
  assert.equal(apk.fileName, '1.apk');
  assert.equal(apk.packageName, undefined);
  assert.equal(apk.minSdkVersion, undefined);
  assert.deepEqual(schemaIssues('ApkMetadata', apk), []);
  assert.ok(schemaIssues('ApkMetadata', { ...apk, fileName: '../../1.apk' }).length);
  assert.ok(schemaIssues('ApkMetadata', { ...apk, fileName: undefined }).length);
  assert.equal(apkFileName('../目录/2.apk'), '2.apk');
  await assert.rejects(
    describeApkFile(file, 2, '2026-11-03', '1.apk', AbortSignal.timeout(1000)),
    (e) => e.code === 'APK_TOO_LARGE',
  );
});

test('real mobile browser download saves the file without requiring package metadata', async (t) => {
  const site = await fixtureSite();
  t.after(() => site.close());
  const dir = await mkdtemp(resolve('.tmp/file-download-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
  config.source.url = site.url + '/invalid';
  config.source.xpath = '//a[@pid="4"]';
  config.execution.mode = 'DOWNLOAD_ONLY';
  config.download.timeoutMs = 10000;
  config.download.retries = 0;
  const events = [];
  await runDownload(
    config,
    randomUUID(),
    dir,
    resolve('.'),
    AbortSignal.timeout(20000),
    async (e) => events.push(e),
    { chromium, policy: new NetworkPolicy(new Set([site.url])), dailyDownload: true },
  );
  const saved = events.find((e) => e.type === 'TASK_STAGE' && e.payload.stage === 'DOWNLOADED');
  assert.ok(saved, JSON.stringify(events));
  assert.equal(saved.payload.apk.packageName, undefined);
  assert.equal(saved.payload.apk.validationPolicy, 'FILE_NAME');
  assert.match(saved.payload.apk.fileName, /\.apk$/);
  assert.equal(events.at(-1).payload.status, 'SUCCEEDED');
});

test('cache reuses the named file across source keys; filename conflicts preserve both byte streams', async (t) => {
  const dir = await mkdtemp(resolve('.tmp/file-cache-'));
  const cache = await ApkCache.open(join(dir, 'cache'));
  t.after(async () => {
    cache.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const file = join(dir, '1.apk');
  await writeFile(file, 'first file');
  const m = await describeApkFile(file, 1000, '2026-11-03', '1.apk', AbortSignal.timeout(1000));
  await cache.put('node', '2026-11-03', 'a'.repeat(64), file, m);
  assert.equal(
    cache.availableName('node', '2026-11-03', 'b'.repeat(64), '1.apk', m.apkSha256),
    '1.apk',
  );
  assert.notEqual(
    cache.availableName('node', '2026-11-03', 'b'.repeat(64), '1.apk', 'c'.repeat(64)),
    '1.apk',
  );
  const found = await cache.asset(
    'node',
    '2026-11-03',
    'b'.repeat(64),
    m,
    1000,
    AbortSignal.timeout(1000),
  );
  assert.ok(found);
  assert.equal(await readFile(found.file, 'utf8'), 'first file');
  await writeFile(file, 'first file');
  await cache.put('node', '2026-11-03', 'b'.repeat(64), file, m);
  await unlink(found.file);
  const fallback = await cache.asset(
    'node',
    '2026-11-03',
    'a'.repeat(64),
    m,
    1000,
    AbortSignal.timeout(1000),
  );
  assert.equal(fallback?.file, cache.path(cache.key('node', '2026-11-03', 'b'.repeat(64))));
  assert.equal(
    await cache.asset('node', '2026-11-04', 'a'.repeat(64), m, 1000, AbortSignal.timeout(1000)),
    null,
  );
});

test('two filenames may resolve to the same installed package; opening waits for Android identity', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'file-open-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.app-open.valid.json', 'utf8'),
  );
  const seen = [];
  for (const filename of ['1.apk', '2.apk']) {
    const file = join(dir, filename);
    await writeFile(file, 'installer fixture');
    const apk = await describeApkFile(
      file,
      1000,
      '2026-11-03',
      filename,
      AbortSignal.timeout(1000),
    );
    let now = 0;
    const result = await openApk(
      config,
      { taskId: randomUUID() },
      apk,
      file,
      0,
      new AbortController().signal,
      async (e) => {
        if (e.payload.installedPackageName) seen.push(e.payload.installedPackageName);
      },
      {
        sdkRoot: dir,
        toolsRoot: dir,
        root: dir,
        proxy: {},
        beforeAction() {},
        resources: async () => {},
        clock: {
          now: () => now,
          sleep: async (ms) => {
            now += ms;
          },
        },
        androidFactory: async () => ({
          observation: {},
          supportedAbis: [],
          install: async (_file, resolve) => {
            assert.equal(resolve, true);
            return 'com.example.same';
          },
          launch: async (pkg) => assert.equal(pkg, 'com.example.same'),
          foreground: async () => true,
          close: async () => true,
        }),
      },
    );
    assert.equal(result.status, 'SUCCEEDED');
  }
  assert.deepEqual(seen, ['com.example.same', 'com.example.same']);
});

test('file plan deduplicates filenames, accepts identical package names and leaves compatibility to installer', async () => {
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
  );
  config.execution.appOpen.appsPerDevice = { min: 2, max: 2 };
  const assets = [0, 1].map((i) => ({
    targetKey: String(i).repeat(64),
    apk: { fileName: i + 1 + '.apk', packageName: 'com.example.same', abis: [] },
  }));
  const plan = {
    purpose: 'REGISTER',
    attemptLimit: 2,
    successTarget: 2,
    assets,
    openPolicy: {
      concurrency: 1,
      dailyLimit: 100,
      capacityVersion: 1,
      admissionDeadline: new Date(Date.now() + 60000).toISOString(),
      fileAssets: true,
      sessions: [{ id: randomUUID(), assetIndexes: [0, 1] }],
    },
  };
  assert.deepEqual(devicePlanIssues(config, plan), []);
  assets[1].apk.fileName = '1.apk';
  assert.ok(devicePlanIssues(config, plan).length);
});
