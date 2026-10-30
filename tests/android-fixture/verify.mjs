import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { parseFunctionalEvidence } from '@apk/contracts';
import {
  registerApk,
  openApk,
  inspectApk,
  NetworkPolicy,
  cacheDay,
  startAndroid,
  readRegistrationPage,
  obstructionRegions,
  closeIcon,
  screenshotPixels,
} from '@apk/automation';
import { openAgentStore } from '../../apps/agent/src/store.js';
process.umask(0o077);
process.env.HOME = '/var/lib/apk-platform/home';
const root = resolve(process.argv[2]),
  config = JSON.parse(await readFile('/var/lib/apk-platform/agent-config.json', 'utf8'));
const v111 = process.argv[3] === '--v111';
const v1112 = process.argv[3] === '--v1112';
const parallelOpen = process.argv[3] === '--parallel-open';
const appOpen = process.argv[3] === '--app-open' || parallelOpen;
const v192 = ['--v192', '--v110'].includes(process.argv[3]);
const automatic = process.argv[3] === '--auto' || v192 || v111 || v1112 || appOpen;
assert.match(
  root,
  automatic
    ? /^\/var\/lib\/apk-platform\/v16-verification-[a-f0-9-]{36}$/
    : /^\/var\/lib\/apk-platform\/p3-verification-/,
);
await mkdir(root, { recursive: true, mode: 0o700 });
let store = await openAgentStore(join(root, 'journal'));
let mode = 'SUCCESS',
  currentAccount,
  currentCase,
  requests = 0;
const reports = [],
  resources = [],
  sockets = new Set();
const abort = new AbortController();
process.on('SIGTERM', () => abort.abort());
process.on('SIGINT', () => abort.abort());
const stopTimer = setInterval(() => {
  void access(join(root, 'stop-requested'))
    .then(() => abort.abort())
    .catch(() => {});
}, 500);
let passed = false;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const track = (server) =>
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
async function listen(server) {
  track(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}
const backend = createServer((req, res) => {
  if (req.url === '/ip') {
    res.end(JSON.stringify({ ip: '93.184.216.34' }));
    return;
  }
  if (req.url !== '/register' || req.method !== 'POST') {
    res.writeHead(404).end();
    return;
  }
  let text = '';
  req.on('data', (b) => {
    text += b;
    if (text.length > 4096) req.destroy();
  });
  req.on('end', () => {
    requests++;
    const p = new URLSearchParams(text);
    const valid =
      p.get('username') === currentAccount?.username &&
      p.get('password') === currentAccount?.password;
    reports.push({
      case: currentCase,
      requestNumber: requests,
      validCredentials: valid,
      appAndroidIdHash: sha(p.get('device') ?? ''),
      model: p.get('model'),
      userAgent: req.headers['user-agent'],
    });
    if (mode === 'TIMEOUT') {
      res.on('close', () => {});
      return;
    }
    res.end(valid && mode === 'SUCCESS' ? 'OK' : 'REJECT');
  });
});
const backendPort = await listen(backend);
const credential = {
  host: '127.0.0.1',
  port: 0,
  username: 'owned-fixture',
  password: randomBytes(24).toString('base64url'),
};
const authorization =
  'Basic ' + Buffer.from(credential.username + ':' + credential.password).toString('base64');
let authenticated = 0;
const proxy = createServer((req, res) => {
  if (req.headers['proxy-authorization'] !== authorization) {
    res.writeHead(407).end();
    return;
  }
  let u;
  try {
    u = new URL(req.url);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (u.hostname !== '203.0.113.10' || u.port !== '18080') {
    res.writeHead(403).end();
    return;
  }
  authenticated++;
  const remote = request(
    {
      host: '127.0.0.1',
      port: backendPort,
      method: req.method,
      path: u.pathname,
      headers: {
        'content-type': req.headers['content-type'] ?? '',
        'user-agent': req.headers['user-agent'] ?? '',
        connection: 'close',
      },
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  remote.on('error', () => res.destroy());
  req.pipe(remote);
});
proxy.on('connect', (req, client, head) => {
  if (req.headers['proxy-authorization'] !== authorization || req.url !== '203.0.113.10:18080') {
    client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  authenticated++;
  const remote = connect(backendPort, '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) remote.write(head);
    client.pipe(remote);
    remote.pipe(client);
  });
  remote.on('error', () => client.destroy());
  client.on('error', () => remote.destroy());
  client.on('close', () => remote.destroy());
});
credential.port = await listen(proxy);
const policy = new NetworkPolicy(
  new Set([
    'http://127.0.0.1:' + credential.port,
    'http://203.0.113.10:18080',
    'https://203.0.113.10:18080',
  ]),
);
const outcomes = [];
const activeNative = new Set();
let peakConcurrentEmulators = 0;
try {
  const cases =
    v1112 || appOpen
      ? [['iota', 'SUCCESS', 'SUCCEEDED']]
      : v111
        ? [['theta', 'SUCCESS', 'SUCCEEDED']]
        : v192
          ? [
              ['epsilon', 'SUCCESS', 'SUCCEEDED'],
              ['zeta', 'GUEST', 'SKIPPED'],
              ['eta', 'DIRECTORY', 'SKIPPED'],
            ]
          : automatic
            ? [
                ['gamma', 'SUCCESS', 'SUCCEEDED'],
                ['gamma', 'SUCCESS', 'SUCCEEDED'],
                ['delta', 'SUCCESS', 'SUCCEEDED'],
                ['gamma', 'TIMEOUT', 'UNKNOWN'],
              ]
            : [
                ['alpha', 'SUCCESS', 'SUCCEEDED'],
                ['beta', 'SUCCESS', 'SUCCEEDED'],
                ['alpha', 'REJECT', 'FAILED'],
                ['alpha', 'TIMEOUT', 'UNKNOWN'],
                ['alpha', 'CHANGED', 'FAILED'],
              ];
  for (const [caseIndex, [variant, behavior, expected]] of cases.entries()) {
    if (abort.signal.aborted) throw Error('OWNED_VERIFICATION_STOPPED');
    if (automatic && caseIndex === 1) {
      store.close();
      store = await openAgentStore(join(root, 'journal'));
    }
    currentCase = variant + '-' + behavior + (automatic ? '-' + caseIndex : '');
    mode = behavior;
    let accountCalls = 0,
      intentCalls = 0;
    const startupNotes = [];
    const before = requests,
      taskId = randomUUID(),
      d = { deliveryId: randomUUID(), runId: randomUUID(), nodeId: config.nodeId, fence: 1 };
    store.add(d);
    const file = join(root, variant + '.apk'),
      metadata = await inspectApk(
        file,
        268435456,
        cacheDay(new Date()),
        new AbortController().signal,
      ),
      pkg = metadata.packageName;
    const step = (action, id, extra = {}) => ({
      action,
      locator: { by: 'id', value: pkg + ':id/' + id },
      timeoutMs: 10000,
      optional: false,
      ...extra,
    });
    const steps = [
      step('click', 'open_register'),
      step('input', behavior === 'CHANGED' ? 'missing_control' : 'username', {
        text: '{username}',
      }),
    ];
    if (variant === 'beta') steps.push(step('click', 'next'));
    steps.push(step('input', 'password', { text: '{password}' }), step('submit', 'submit'));
    if (behavior === 'CHANGED') steps[1].timeoutMs = 1000;
    const profile = {
      id: 'pixel6-api35',
      name: 'Owned fixture',
      avdDevice: 'pixel_6',
      systemImage: 'system-images;android-35;google_apis;x86_64',
      locale: 'en-US',
    };
    const testConfig = {
      schemaVersion: '1.0',
      name: 'Owned P3 fixture',
      source: { url: 'https://example.test', xpath: '//a', browserUserAgent: '' },
      download: {
        cacheTimezone: 'Asia/Shanghai',
        maxTargets: 1,
        maxLandingClicks: 1,
        timeoutMs: 10000,
        retries: 0,
        landingRules: [{ host: '*', by: 'css', selector: 'a' }],
      },
      execution: { mode: 'FULL', proxySecretVersionId: randomUUID(), deviceProfiles: [profile] },
      registrationFlows: [
        {
          packageName: pkg,
          activity: '.MainActivity',
          enabled: true,
          steps,
          success: {
            locator: { by: 'id', value: pkg + ':id/account_home' },
            timeoutMs: behavior === 'TIMEOUT' ? 3000 : 15000,
          },
          failure: { locator: { by: 'id', value: pkg + ':id/rejected' }, timeoutMs: 1000 },
        },
      ],
    };
    if (automatic) {
      testConfig.execution.autoRegistration = {
        enabled: true,
        screenshotFallback: true,
        maxNavigationSteps: 8,
        timeoutMs: 90000,
        successTimeoutMs: behavior === 'TIMEOUT' ? 3000 : 60000,
        ...(v111 ? { startup: { confirmationTimeoutMs: 5000 } } : {}),
      };
      testConfig.registrationFlows = [];
    }
    if (appOpen) {
      testConfig.execution.appOpen = { dwellMs: 10000 };
      testConfig.execution.contentIsolation = true;
      delete testConfig.execution.autoRegistration;
      testConfig.registrationFlows = [];
    }
    console.log(JSON.stringify({ case: currentCase, stage: 'STARTING' }));
    const ownedAction = async (targetId = taskId) =>
      await (appOpen ? openApk : registerApk)(
        testConfig,
        { taskId: targetId, ...(automatic ? { entryId: variant } : {}) },
        metadata,
        file,
        0,
        abort.signal,
        async (event) => {
          store.append(d, event);
          if (event.type === 'APP_OBSTRUCTION') startupNotes.push(event.payload);
          console.log(JSON.stringify({ case: currentCase, stage: event.payload.stage }));
        },
        {
          sdkRoot: config.sdkRoot,
          toolsRoot: config.toolsRoot,
          root: join(root, 'android'),
          proxy: credential,
          policy,
          proxyCheckUrl: 'http://203.0.113.10:18080/ip',
          beforeAction: () => {
            if (abort.signal.aborted) throw Error('OWNED_VERIFICATION_STOPPED');
          },
          ...(automatic && !appOpen
            ? {
                learning: {
                  load: async (key) => store.loadRegistrationTemplate(key),
                  save: async (key, value) => store.saveRegistrationTemplate(key, value),
                  drop: async (key) => store.dropRegistrationTemplate(key),
                },
                androidFactory: async (...args) => {
                  const session = await startAndroid(...args);
                  let inspectedIcon = false;
                  const inspectedNative = new Set();
                  return {
                    ...session,
                    rect: async (id) => {
                      const rect = await session.rect(id);
                      if (v111)
                        console.log(JSON.stringify({ case: currentCase, ownedActionRect: rect }));
                      return rect;
                    },
                    source: async (signal) => {
                      const source = await session.source(signal);
                      if (v111 && !inspectedIcon) {
                        const page = readRegistrationPage(source, pkg);
                        for (const kind of ['skip_ad', 'notice_ack']) {
                          const native = page.controls.find((c) =>
                            c.resourceId.endsWith(':id/' + kind),
                          );
                          if (native && !inspectedNative.has(kind)) {
                            inspectedNative.add(kind);
                            console.log(
                              JSON.stringify({
                                case: currentCase,
                                ownedSourceRect: { kind, rect: native.rect },
                              }),
                            );
                          }
                        }
                        const target = page.controls.find((c) =>
                          c.resourceId.endsWith(':id/graphic_target'),
                        );
                        if (target) {
                          inspectedIcon = true;
                          console.log(
                            JSON.stringify({
                              case: currentCase,
                              ownedIconProbe: {
                                className: target.className,
                                rect: target.rect,
                                clickable: target.clickable,
                                ownClickable: target.ownClickable,
                                enabled: target.enabled,
                                labelled: !!(target.text || target.description),
                                scopes: obstructionRegions(page),
                                validGlyph: closeIcon(
                                  screenshotPixels(await session.screenshot(signal)),
                                  target.rect,
                                ),
                              },
                            }),
                          );
                        }
                      }
                      return source;
                    },
                    submit: async (...values) => {
                      const started = Date.now();
                      try {
                        await session.submit(...values);
                        console.log(
                          JSON.stringify({
                            case: currentCase,
                            submitTransport: 'ACK',
                            elapsedMs: Date.now() - started,
                          }),
                        );
                      } catch (error) {
                        console.log(
                          JSON.stringify({
                            case: currentCase,
                            submitTransport: 'UNKNOWN',
                            elapsedMs: Date.now() - started,
                            code:
                              error instanceof Error && 'code' in error
                                ? error.code
                                : 'UNAVAILABLE',
                          }),
                        );
                        throw error;
                      }
                    },
                    close: async () => {
                      try {
                        const page = readRegistrationPage(
                          await session.source(AbortSignal.timeout(5000)),
                          pkg,
                        );
                        console.log(
                          JSON.stringify({
                            case: currentCase,
                            finalUi: {
                              fields: page.controls
                                .filter((e) => e.editable)
                                .map((e) => ({
                                  filled: !!e.text && e.text !== e.hint,
                                  password: e.password,
                                })),
                              submitEnabled: page.controls.find((e) =>
                                e.resourceId.endsWith(':id/submit'),
                              )?.enabled,
                              result: page.controls.some(
                                (e) => e.text === 'Registration successful',
                              )
                                ? 'SUCCESS'
                                : page.controls.some((e) => e.text === 'Pending result')
                                  ? 'PENDING'
                                  : 'OTHER',
                            },
                          }),
                        );
                      } catch {
                        console.log(JSON.stringify({ case: currentCase, finalUi: 'UNAVAILABLE' }));
                      }
                      return session.close();
                    },
                  };
                },
              }
            : {}),
          resources: async (record) => {
            if (parallelOpen) store.androidSlot(d.deliveryId, targetId, record);
            else store.android(d.deliveryId, record);
            if (record?.emulatorPid) activeNative.add(targetId);
            if (!record) activeNative.delete(targetId);
            peakConcurrentEmulators = Math.max(peakConcurrentEmulators, activeNative.size);
            if (record) resources.push({ ...record, slot: targetId });
          },
          account: async (id) => {
            accountCalls++;
            currentAccount = store.account(d, id);
            store.accountAck(currentAccount.accountRef);
            return currentAccount;
          },
          intent: async (id, ref) => {
            intentCalls++;
            return store.intent(d, id, ref);
          },
          evidence: async (id, bytes) => {
            assert.ok(parseFunctionalEvidence(bytes.toString()));
            assert.ok(!bytes.includes(Buffer.from('12345678')));
            const artifactId = store.evidence(d, id, bytes);
            await writeFile(join(root, artifactId + '.json'), bytes, { flag: 'wx', mode: 0o600 });
            return artifactId;
          },
        },
      );
    let result;
    if (parallelOpen) {
      const together = await Promise.allSettled([ownedAction(), ownedAction(randomUUID())]);
      assert.equal(together.filter((r) => r.status === 'fulfilled').length, 2);
      for (const r of together) {
        assert.equal(r.value.status, 'SUCCEEDED');
        assert.equal(r.value.proof, 'APP_OPEN');
        assert.equal(r.value.cleanupComplete, true);
      }
      assert.equal(peakConcurrentEmulators, 2);
      assert.equal(new Set(resources.map((r) => r.serial).filter(Boolean)).size, 2);
      result = together[0].value;
      outcomes.push({ case: currentCase + '-slot2', ...together[1].value, requests: 0 });
    } else result = await ownedAction();
    const resultRecord = { case: currentCase, ...result, requests: requests - before };
    outcomes.push(resultRecord);
    await writeFile(
      join(root, 'verification.json'),
      JSON.stringify(
        { outcomes, requests: reports, authenticatedProxyRequests: authenticated, resources },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(JSON.stringify(resultRecord));
    if (v111 || v1112) console.log(JSON.stringify({ case: currentCase, startupNotes }));
    assert.equal(result.cleanupComplete, true);
    assert.equal(result.status, expected);
    if (appOpen) {
      assert.equal(result.proof, 'APP_OPEN');
      assert.ok(result.openObservation.elapsedMs >= 10000);
      assert.equal(result.openObservation.scope, 'FOREGROUND_POLL_ONLY');
      assert.equal(accountCalls, 0);
      assert.equal(intentCalls, 0);
      assert.equal(requests - before, 0);
      assert.equal(startupNotes.length, 0);
      assert.equal(result.artifactIds.length, 0);
      assert.ok(resources.every((r) => !r.appiumPid && !r.systemPort));
      assert.equal((await readdir(join(root, 'android/jobs'))).length, 0);
      continue;
    }
    if (v1112) {
      assert.deepEqual(
        startupNotes.filter((n) => n.phase === 'ACTION_SENT').map((n) => [n.action, n.method]),
        [['CLOSE_POPUP', 'BACK']],
      );
      assert.equal(startupNotes.filter((n) => n.phase === 'CLEARED').length, 1);
    }
    if (v111) {
      assert.deepEqual(
        startupNotes.filter((n) => n.phase === 'ACTION_SENT').map((n) => n.action),
        ['RETRY_LOAD', 'SKIP_AD', 'ACK_NOTICE', 'CLOSE_POPUP'],
      );
      assert.equal(startupNotes.filter((n) => n.phase === 'CLEARED').length, 4);
      assert.ok(startupNotes.some((n) => n.method === 'ICON' && n.phase === 'CLEARED'));
      assert.ok(startupNotes.some((n) => n.action === 'WAIT_OVERLAY' && n.phase === 'WAITING'));
    }
    if (automatic) {
      assert.ok(result.recognition);
      assert.equal(result.recognition.learned, expected === 'SUCCEEDED');
      if (caseIndex === 1 && !v192) assert.equal(result.recognition.cache, 'HIT');
      if (variant === 'delta') assert.equal(result.recognition.source, 'OCR');
    }
    assert.equal(requests - before, ['CHANGED', 'GUEST', 'DIRECTORY'].includes(behavior) ? 0 : 1);
    if (expected === 'SKIPPED') {
      assert.equal(accountCalls, 0);
      assert.equal(intentCalls, 0);
      assert.equal(result.proof, 'NONE');
    }
    if (behavior === 'GUEST') {
      assert.equal(result.errorCode, 'APP_AUTO_IDENTITY');
      assert.equal(result.recognition.automaticIdentity.kind, 'GUEST');
      assert.equal(result.recognition.automaticIdentity.scope, 'APP_UI_ONLY');
      assert.ok(result.artifactIds.length);
      const evidence = parseFunctionalEvidence(
        await readFile(join(root, result.artifactIds[0] + '.json'), 'utf8'),
      );
      assert.equal(evidence.stage, 'DISCOVERY');
      assert.equal(evidence.outcome, 'UNVERIFIED');
    }
    if (behavior === 'DIRECTORY') assert.equal(result.errorCode, 'APP_NAVIGATION_ONLY');
    if (expected === 'SUCCEEDED') assert.equal(result.proof, 'APP_UI');
    if (behavior === 'REJECT') assert.equal(result.errorCode, 'REGISTRATION_REJECTED');
    if (!['CHANGED', 'GUEST', 'DIRECTORY'].includes(behavior)) {
      assert.equal(reports.at(-1).validCredentials, true);
      assert.equal(reports.at(-1).userAgent, 'OwnedFixture/1.0');
    }
    assert.equal((await readdir(join(root, 'android/jobs'))).length, 0);
  }
  assert.equal(new Set(reports.map((r) => r.appAndroidIdHash)).size, reports.length);
  assert.ok(
    !(await readdir(root)).some(
      (name) => /\.(png|xml)$/.test(name) || name === 'owned-ocr-lines.json',
    ),
  );
  for (const d of store.deliveries())
    for (const record of store.pendingEvidence(d.id))
      assert.ok(parseFunctionalEvidence(Buffer.from(record.data, 'base64').toString()));
  passed = true;
  console.log(
    JSON.stringify({
      verified: true,
      cases: outcomes.length,
      singleRequestPerSubmittedCase: !appOpen,
      appOpenOnly: appOpen,
      cleanupComplete: true,
      appIdentifiersObservedInOwnedFixtureOnly: true,
      syntheticProxyProbe: true,
    }),
  );
} finally {
  clearInterval(stopTimer);
  await writeFile(
    join(root, 'verification.json'),
    JSON.stringify(
      {
        finished: true,
        passed,
        peakConcurrentEmulators,
        cleanupComplete: store.deliveries().every((d) => d.clean),
        outcomes,
        requests: reports,
        authenticatedProxyRequests: authenticated,
        resources,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  store.close();
  for (const socket of sockets) socket.destroy();
  await new Promise((r) => proxy.close(r));
  await new Promise((r) => backend.close(r));
}
