import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import {
  registerApk,
  inspectApk,
  RegistrationError,
  ApkCache,
  runCachedRegistrations,
} from '@apk/automation';
import { fixtureApk } from './p2-fixtures.mjs';
test('1.5 one entry template follows changing APK packages and expands locator prefixes without mutating its snapshot', async (t) => {
  const parent = resolve('.tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'entry-template-'));
  t.after(async () => {
    assert.ok(root.startsWith(parent + sep));
    await rm(root, { recursive: true, force: true });
  });
  const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
  config.registrationFlows = [
    {
      packageName: '*',
      activity: '@launcher',
      entryId: '2692',
      enabled: true,
      steps: [
        {
          action: 'input',
          locator: { by: 'id', value: '{packageName}:id/username' },
          text: '{username}',
          timeoutMs: 1000,
          optional: false,
        },
        {
          action: 'input',
          locator: { by: 'id', value: '{packageName}:id/password' },
          text: '{password}',
          timeoutMs: 1000,
          optional: false,
        },
        {
          action: 'submit',
          locator: { by: 'id', value: '{packageName}:id/submit' },
          timeoutMs: 1000,
          optional: false,
        },
      ],
      success: { locator: { by: 'id', value: '{packageName}:id/success' }, timeoutMs: 1000 },
    },
  ];
  const unchanged = JSON.stringify(config),
    image = new PNG({ width: 20, height: 20 });
  image.data.fill(255);
  const png = PNG.sync.write(image);
  let starts = 0,
    closes = 0,
    intents = 0,
    submissions = 0,
    lastFile,
    lastApk;
  for (const pkg of ['com.example.today', 'com.example.tomorrow']) {
    const file = join(root, pkg + '.apk');
    await writeFile(file, fixtureApk(pkg));
    const apk = await inspectApk(file, 1000000, '2026-10-28', new AbortController().signal);
    assert.equal(apk.packageName, pkg);
    let submitted = false;
    const target = {
      taskId: randomUUID(),
      entryId: '2692',
      targetKey: 'a'.repeat(64),
      label: 'owned',
      sourceUrl: 'https://example.test',
      pid: '2692',
      href: '',
      position: 0,
    };
    const hooks = {
      sdkRoot: '/fixture',
      toolsRoot: '/fixture',
      root,
      proxy: { host: 'proxy.example.test', port: 8080, username: 'fixture', password: 'fixture' },
      beforeAction: () => {},
      resources: async () => {},
      account: async () => ({
        accountRef: randomUUID(),
        username: 'linyuchen',
        password: 'Test1234',
      }),
      intent: async () => {
        intents++;
      },
      evidence: async () => randomUUID(),
      androidFactory: async () => {
        starts++;
        return {
          supportedAbis: ['x86_64'],
          observation: {
            profileId: 'pixel6-api35',
            avdName: 'p3_' + randomUUID().replaceAll('-', ''),
            apiLevel: 35,
            model: 'fixture',
            locale: 'en-US',
            shellAndroidIdHash: 'a'.repeat(64),
            androidIdScope: 'SHELL_NOT_APP',
            proxyObservedIp: '203.0.113.1',
            proxyObservedAt: new Date().toISOString(),
            proxyIpScope: 'PROBE_ONLY',
            appUserAgent: 'UNVERIFIED',
            identitySource: 'EMULATOR_NOT_REAL_DEVICE',
          },
          install: async (path) => assert.equal(path, file),
          launch: async (p, a) => {
            assert.equal(p, pkg);
            assert.equal(a, '@launcher');
          },
          find: async (locator) => {
            assert.ok(locator.value.startsWith(pkg + ':id/'));
            if (locator.value.endsWith('/success') && !submitted)
              throw new RegistrationError('FLOW_STEP_FAILED');
            return locator.value;
          },
          rect: async () => ({ x: 1, y: 1, width: 5, height: 5 }),
          input: async () => {},
          click: async () => {},
          submit: async () => {
            submissions++;
            submitted = true;
          },
          back: async () => {},
          source: async () => '<hierarchy/>',
          screenshot: async () => png,
          close: async () => {
            closes++;
            return true;
          },
        };
      },
    };
    const result = await registerApk(
      config,
      target,
      apk,
      file,
      0,
      new AbortController().signal,
      async () => {},
      hooks,
    );
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.cleanupComplete, true);
    assert.equal(JSON.stringify(config), unchanged);
    lastFile = file;
    lastApk = apk;
  }
  assert.equal(starts, 2);
  assert.equal(closes, 2);
  assert.equal(intents, 2);
  assert.equal(submissions, 2);
  const node = randomUUID(),
    key = createHash('sha256').update('entry').digest('hex'),
    loop = join(root, 'loop'),
    cache = await ApkCache.open(join(loop, 'cache'));
  await cache.put(node, '2026-10-28', key, lastFile, lastApk);
  cache.releasePins();
  cache.close();
  const events = [];
  let attempts = 0;
  await runCachedRegistrations(
    config,
    {
      purpose: 'REGISTER',
      cacheDay: '2026-10-28',
      successTarget: 3,
      attemptLimit: 6,
      assets: [
        {
          targetKey: key,
          entryId: '2692',
          label: 'owned',
          sourceUrl: 'https://example.test',
          apk: lastApk,
        },
      ],
    },
    node,
    loop,
    new AbortController().signal,
    async (e) => events.push(e),
    () => {},
    async () => {
      attempts++;
      return {
        status: 'FAILED',
        proof: 'NONE',
        artifactIds: [],
        errorCode: 'FLOW_STEP_FAILED',
        cleanupComplete: true,
      };
    },
  );
  assert.equal(attempts, 1);
  assert.equal(events.at(-1).payload.errorCode, 'FLOW_LAYOUT_CHANGED');
});
