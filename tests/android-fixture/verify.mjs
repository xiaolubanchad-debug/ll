import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { URLSearchParams } from 'node:url';
import { registerApk, inspectApk, NetworkPolicy, cacheDay } from '@apk/automation';
import { openAgentStore } from '../../apps/agent/src/store.js';
process.umask(0o077);
const root = resolve(process.argv[2]),
  config = JSON.parse(await readFile('/var/lib/apk-platform/agent-config.json', 'utf8'));
assert.ok(root.startsWith('/var/lib/apk-platform/p3-verification-'));
await mkdir(root, { recursive: true, mode: 0o700 });
const store = await openAgentStore(join(root, 'journal'));
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
try {
  for (const [variant, behavior, expected] of [
    ['alpha', 'SUCCESS', 'SUCCEEDED'],
    ['beta', 'SUCCESS', 'SUCCEEDED'],
    ['alpha', 'REJECT', 'FAILED'],
    ['alpha', 'TIMEOUT', 'UNKNOWN'],
    ['alpha', 'CHANGED', 'FAILED'],
  ]) {
    if (abort.signal.aborted) throw Error('OWNED_VERIFICATION_STOPPED');
    currentCase = variant + '-' + behavior;
    mode = behavior;
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
    console.log(JSON.stringify({ case: currentCase, stage: 'STARTING' }));
    const result = await registerApk(
      testConfig,
      { taskId },
      metadata,
      file,
      0,
      abort.signal,
      async (event) => {
        store.append(d, event);
        console.log(JSON.stringify({ case: currentCase, stage: event.payload.stage }));
      },
      {
        sdkRoot: config.sdkRoot,
        toolsRoot: config.toolsRoot,
        root: join(root, 'android'),
        proxy: credential,
        policy,
        proxyCheckUrl: 'http://203.0.113.10:18080/ip',
        beforeAction: () => {},
        resources: async (record) => {
          store.android(d.deliveryId, record);
          if (record) resources.push({ ...record });
        },
        account: async (id) => {
          currentAccount = store.account(d, id);
          store.accountAck(currentAccount.accountRef);
          return currentAccount;
        },
        intent: async (id, ref) => store.intent(d, id, ref),
        evidence: async (id, bytes) => {
          const artifactId = randomUUID();
          await writeFile(join(root, artifactId + '.png'), bytes, { flag: 'wx', mode: 0o600 });
          return artifactId;
        },
      },
    );
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
    assert.equal(result.cleanupComplete, true);
    assert.equal(result.status, expected);
    assert.equal(requests - before, behavior === 'CHANGED' ? 0 : 1);
    if (expected === 'SUCCEEDED') assert.equal(result.proof, 'APP_UI');
    if (behavior === 'REJECT') assert.equal(result.errorCode, 'REGISTRATION_REJECTED');
    if (behavior !== 'CHANGED') {
      assert.equal(reports.at(-1).validCredentials, true);
      assert.equal(reports.at(-1).userAgent, 'OwnedFixture/1.0');
    }
    assert.equal((await readdir(join(root, 'android/jobs'))).length, 0);
  }
  assert.equal(new Set(reports.map((r) => r.appAndroidIdHash)).size, reports.length);
  passed = true;
  console.log(
    JSON.stringify({
      verified: true,
      cases: outcomes.length,
      singleRequestPerSubmittedCase: true,
      cleanupComplete: true,
      appIdentifiersObservedInOwnedFixtureOnly: true,
      syntheticProxyProbe: true,
    }),
  );
} finally {
  await writeFile(
    join(root, 'verification.json'),
    JSON.stringify(
      {
        finished: true,
        passed,
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
