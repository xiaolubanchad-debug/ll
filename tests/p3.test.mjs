import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PNG } from 'pngjs';
import { parseFunctionalEvidence, functionalEvidenceText } from '@apk/contracts';
import { chromium } from '@playwright/test';
import { createApp } from '../apps/control-api/dist/app.js';
import { passwordHash } from '../apps/control-api/dist/auth.js';
import { startAgent, loadIdentity, saveIdentity } from '../apps/agent/dist/main.js';
import { openAgentStore } from '../apps/agent/dist/store.js';
import { TaskEngine } from '../apps/agent/dist/tasks.js';
import {
  AppiumClient,
  NetworkPolicy,
  redactScreenshot,
  startProxyBridge,
  proxyObservation,
  registerApk,
  inspectApk,
  RegistrationError,
} from '@apk/automation';
import { digest, tickSchedules } from '@apk/platform';
import { fixtureSite, fixtureApk } from './p2-fixtures.mjs';
const db = new PrismaClient(),
  root = process.env.P1_TEST_DIR;
const image = new PNG({ width: 120, height: 120 });
image.data.fill(255);
const white = PNG.sync.write(image);
const functionalBytes = (outcome = 'UNVERIFIED') =>
  Buffer.from(
    functionalEvidenceText({
      schemaVersion: '1.0',
      kind: 'FUNCTIONAL_EVIDENCE',
      stage: outcome === 'UNVERIFIED' ? 'DISCOVERY' : 'RESULT',
      outcome,
      verification: outcome === 'UNVERIFIED' ? 'NO_SUBMISSION' : 'CONFIGURED_LOCATOR',
      sourceDigest: 'b'.repeat(64),
      controls: [],
    }),
  );
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const r = await fn();
    if (r) return r;
    await pause(100);
  }
  throw Error('P3 condition timed out');
}
async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
}
const observation = () => ({
  profileId: 'pixel6-api35',
  avdName: 'p3_' + randomUUID().replaceAll('-', ''),
  apiLevel: 35,
  model: 'Owned fixture emulator',
  locale: 'en-US',
  shellAndroidIdHash: randomBytes(32).toString('hex'),
  androidIdScope: 'SHELL_NOT_APP',
  proxyObservedIp: '93.184.216.34',
  proxyObservedAt: new Date().toISOString(),
  proxyIpScope: 'PROBE_ONLY',
  appUserAgent: 'UNVERIFIED',
  identitySource: 'EMULATOR_NOT_REAL_DEVICE',
});
test('P3 proxy authentication, pinned forwarding, CONNECT and redaction', async (t) => {
  const auth = 'Basic ' + Buffer.from('fixture-user:fixture-pass').toString('base64');
  let http = 0,
    tunnels = 0,
    leaked = false;
  const target = createServer((req, res) => {
    leaked ||= !!req.headers['proxy-authorization'];
    res.end(JSON.stringify({ ip: '93.184.216.34' }));
  });
  const targetPort = await listen(target);
  const proxy = createServer((req, res) => {
    assert.equal(req.headers['proxy-authorization'], auth);
    http++;
    const u = new URL(req.url);
    const out = request(
      { host: '127.0.0.1', port: targetPort, path: u.pathname, headers: { host: u.host } },
      (r) => r.pipe(res),
    );
    out.on('error', () => res.destroy());
    req.pipe(out);
  });
  proxy.on('connect', (req, client, head) => {
    assert.equal(req.headers['proxy-authorization'], auth);
    tunnels++;
    const out = connect(targetPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 OK\r\n\r\n');
      if (head.length) out.write(head);
      client.pipe(out);
      out.pipe(client);
    });
    out.on('error', () => client.destroy());
    client.on('error', () => out.destroy());
    client.on('close', () => out.destroy());
  });
  const port = await listen(proxy),
    policy = new NetworkPolicy(new Set(['http://127.0.0.1:' + port]));
  let bridge;
  try {
    bridge = await startProxyBridge(
      { host: '127.0.0.1', port, username: 'fixture-user', password: 'fixture-pass' },
      policy,
    );
    assert.equal(new URL(bridge.url).password, '');
    assert.equal(
      (await proxyObservation(bridge.port, new AbortController().signal, 'http://93.184.216.34/ip'))
        .ip,
      '93.184.216.34',
    );
    await new Promise((ok, no) => {
      const req = request(
        { host: '127.0.0.1', port: bridge.port, method: 'CONNECT', path: '93.184.216.34:443' },
        (res) => {
          res.resume();
          no(Error('missing tunnel'));
        },
      );
      req.on('connect', (res, s) => {
        assert.equal(res.statusCode, 200);
        let text = '';
        s.on('data', (b) => {
          text += b;
          if (text.includes('93.184.216.34')) {
            s.destroy();
            ok();
          }
        });
        s.on('error', no);
        s.write('GET / HTTP/1.1\r\nHost: fixture\r\nConnection: close\r\n\r\n');
      });
      req.on('error', no);
      req.end();
    });
    assert.equal(http, 1);
    assert.equal(tunnels, 1);
    assert.equal(leaked, false);
    await assert.rejects(
      proxyObservation(bridge.port, new AbortController().signal, 'http://169.254.169.254/latest'),
      /PROXY_CHECK_FAILED/,
    );
    await bridge.close();
    bridge = null;
    await assert.rejects(
      startProxyBridge({ host: '127.0.0.1', port, username: 'x', password: 'x' }),
      /NETWORK_BLOCKED/,
    );
    await t.test('input and echoed credentials are blacked out; unsafe tree is withheld', () => {
      const account = { accountRef: randomUUID(), username: 'SecretUser', password: 'Fixture123' },
        xml = '<hierarchy><node text="Hello SecretUser" bounds="[50,50][90,70]" /></hierarchy>';
      const safe = PNG.sync.read(
        redactScreenshot(white, xml, account, [{ x: 10, y: 10, width: 20, height: 10 }]),
      );
      assert.equal(safe.data[(15 * 120 + 15) * 4], 0);
      assert.equal(safe.data[(55 * 120 + 55) * 4], 0);
      assert.equal(safe.data[(110 * 120 + 110) * 4], 255);
      assert.throws(
        () => redactScreenshot(white, '<node text="SecretUser"/>', account, []),
        /EVIDENCE_UNSAFE/,
      );
      assert.throws(
        () => redactScreenshot(white, '<!DOCTYPE node><node/>', account, []),
        /EVIDENCE_UNSAFE/,
      );
    });
  } finally {
    await bridge?.close();
    await close(proxy);
    await close(target);
  }
});

test('P3 complete runs with PostgreSQL, SQLite, real Chromium and a fault-injected Appium HTTP boundary', async (t) => {
  let app,
    site,
    agentRun,
    abort,
    mode = 'success',
    submitted = 0,
    installed = 0,
    launched = 0,
    body,
    release,
    node,
    base,
    cookie,
    csrf,
    engineBoot,
    activeRunId;
  const sessions = new Map();
  let activeSessions = 0,
    openedSessions = 0,
    closedSessions = 0;
  const configurationIds = [];
  const appium = createServer((req, res) => {
    let raw = '';
    req.on('data', (b) => (raw += b));
    req.on('end', async () => {
      const b = raw ? JSON.parse(raw) : {},
        parts = req.url.split('/'),
        sid = parts[2],
        s = sessions.get(sid);
      let value = null;
      if (req.url === '/session') {
        const id = randomUUID();
        sessions.set(id, { submitted: false, username: '', password: '', next: false });
        value = { sessionId: id, capabilities: {} };
      } else if (req.url.endsWith('/elements')) {
        let visible = true;
        const key = mode.startsWith('auto-') ? b.value.split(':id/').at(-1) : b.value;
        if (key === 'success')
          visible = !!s?.submitted && ['success', 'lost-success', 'cleanup'].includes(mode);
        if (key === 'rejected') visible = !!s?.submitted && mode === 'reject';
        if (key === 'changed') visible = false;
        if (key === 'username' && mode === 'stop-before') {
          await apiStop();
          await pause(6000);
        }
        if (
          key === 'password' &&
          body.registrationFlows[0]?.steps.some((x) => x.locator?.value === 'next')
        )
          visible = s.next;
        value = visible ? [{ 'element-6066-11e4-a52e-4f735466cecf': key }] : [];
      } else if (req.url.endsWith('/click')) {
        const id = parts[4];
        if (mode.startsWith('auto-') && id === 'open-register') s.autoForm = true;
        if (mode === 'auto-success' && id === 'ad-close') s.adClosed = true;
        if (id === 'next') s.next = true;
        if (id === 'submit') {
          submitted++;
          s.submitted = true;
          if (mode === 'unknown') await apiStop();
          if (mode === 'lost-success' || mode === 'unknown') {
            req.socket.destroy();
            return;
          }
        }
      } else if (req.url.endsWith('/value')) {
        s[parts[4]] = b.text;
      } else if (req.url.endsWith('/rect')) value = { x: 10, y: 10, width: 20, height: 10 };
      else if (req.url.endsWith('/screenshot')) value = white.toString('base64');
      else if (req.url.endsWith('/appium/device/is_keyboard_shown')) value = false;
      else if (req.url.endsWith('/source')) {
        if (mode.startsWith('auto-')) {
          const pkg = s.packageName ?? 'com.example.p2';
          const control = (id, text, kind, y, password = false) =>
            `<node package="${pkg}" class="android.widget.${kind}" resource-id="${pkg}:id/${id}" text="${text}" enabled="true" clickable="${kind === 'Button'}" password="${password}" bounds="[10,${y}][110,${y + 15}]"/>`;
          const content =
            mode === 'auto-guest'
              ? control('profile', '个人中心', 'TextView', 10) +
                control('guest', '游客', 'TextView', 30) +
                control('uid', 'UID：12345678', 'TextView', 50)
              : mode === 'auto-directory'
                ? control('popular', '热门推荐', 'TextView', 0) +
                  control('directory', '站长精选', 'TextView', 12) +
                  Array.from({ length: 8 }, (_, i) =>
                    control('app' + i, 'Owned app ' + i, 'Button', 24 + i * 10),
                  ).join('')
                : mode === 'auto-success' && !s.adClosed
                  ? control('ad-close', '关闭广告', 'Button', 10)
                  : s.submitted
                    ? control('result', 'Registration successful', 'TextView', 10)
                    : s.autoForm || mode === 'auto-unsupported'
                      ? control(
                          mode === 'auto-unsupported' ? 'phone' : 'username',
                          mode === 'auto-unsupported' ? 'Phone number' : s.username || 'Username',
                          'EditText',
                          20,
                        ) +
                        control('password', s.password || 'Password', 'EditText', 40, true) +
                        control('submit', 'Register', 'Button', 60)
                      : control('open-register', 'Register', 'Button', 10);
          value = `<hierarchy><node package="${pkg}" class="android.widget.FrameLayout" text="" clickable="false" bounds="[0,0][120,120]">${content}</node></hierarchy>`;
        } else
          value =
            '<hierarchy><node text="' + s.username + '" bounds="[50,50][90,70]" /></hierarchy>';
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ value }));
    });
  });
  const appiumPort = await listen(appium);
  const factory = async (_profile, signal, options) => {
    assert.equal(activeSessions, 0, 'previous emulator must be closed before a new one opens');
    activeSessions++;
    openedSessions++;
    const c = new AppiumClient(appiumPort, signal);
    await c.start({ platformName: 'Android' });
    if (mode === 'cleanup')
      await options.resources({
        workspace: join(options.root, 'jobs/android-fixture'),
        avdName: observation().avdName,
        appiumTmp: join(options.root, 'jobs/android-fixture/appium-tmp'),
      });
    return {
      observation: observation(),
      supportedAbis: ['x86_64'],
      install: async () => {
        installed++;
      },
      launch: async (pkg) => {
        launched++;
        sessions.get(c.session).packageName = pkg;
      },
      find: (...a) => c.find(...a),
      click: (...a) => c.click(...a),
      submit: (...a) => c.submit(...a),
      input: (...a) => c.input(...a),
      hideKeyboard: () => c.hideKeyboard(),
      back: () => c.back(),
      rect: (id) => c.rect(id),
      screenshot: () => c.screenshot(),
      source: () => c.source(),
      close: async () => {
        await c.close();
        activeSessions--;
        closedSessions++;
        if (mode === 'cleanup') return false;
        await options.resources(null);
        return true;
      },
    };
  };
  const req = async (path, method = 'GET', data, extra = {}) => {
    const r = await fetch(base + '/api/v1' + path, {
      method,
      headers: {
        cookie,
        ...(method === 'GET'
          ? {}
          : {
              origin: process.env.APP_ORIGIN,
              'content-type': 'application/json',
              'x-csrf-token': csrf,
            }),
        ...extra,
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: r.status, data: r.status === 204 ? null : await r.json(), headers: r.headers };
  };
  const idem = () => ({ 'Idempotency-Key': randomUUID() });
  async function apiStop() {
    const r = await req(
      '/runs/' + activeRunId + '/stop',
      'POST',
      { reason: '自有测试注入停止竞争' },
      idem(),
    );
    assert.equal(r.status, 202);
  }
  async function save() {
    const c = await req('/configs', 'POST', { name: 'P3 ' + mode }, idem());
    assert.equal(c.status, 201);
    configurationIds.push(c.data.id);
    const v = await req('/configs/' + c.data.id + '/versions', 'POST', body, {
      ...idem(),
      'If-Match': '1',
    });
    assert.equal(v.status, 201, JSON.stringify(v.data));
    return v.data;
  }
  async function run(cycle = false) {
    const v = await save();
    let sourceDownloadId;
    if (cycle) {
      const download = await req(
        '/runs',
        'POST',
        { nodeId: node.id, configVersionId: v.id, releaseId: release.id, purpose: 'DOWNLOAD' },
        idem(),
      );
      assert.equal(download.status, 202);
      await wait(async () => {
        const r = await db.run.findUnique({ where: { id: download.data.resourceId } });
        return r.status === 'SUCCEEDED';
      });
      sourceDownloadId = download.data.resourceId;
    }
    const r = await req(
      '/runs',
      'POST',
      {
        nodeId: node.id,
        configVersionId: v.id,
        releaseId: release.id,
        ...(cycle
          ? { purpose: 'REGISTER', sourceDownloadId, successTarget: 3, attemptLimit: 5 }
          : {}),
      },
      idem(),
    );
    assert.equal(r.status, 202, JSON.stringify(r.data));
    activeRunId = r.data.resourceId;
    return wait(async () => {
      const run = (await req('/runs/' + r.data.resourceId)).data;
      return ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(run.status)
        ? run
        : false;
    });
  }
  async function start() {
    const after = new Date();
    abort = new AbortController();
    agentRun = startAgent(
      {
        nodeId: node.id,
        releaseId: release.id,
        agentVersion: '0.8.0',
        apiUrl: base,
        sdkRoot: '/fixture',
        toolsRoot: resolve('.'),
        dataRoot: join(root, 'p3-execution'),
      },
      join(root, 'p3-identity'),
      abort.signal,
      async () => report,
      { chromium, policy: new NetworkPolicy(new Set([site.url])), androidFactory: factory },
    );
    agentRun.catch(() => {});
    await wait(async () => {
      const n = await db.node.findUnique({ where: { id: node.id } });
      engineBoot = (await db.agentCredential.findUnique({ where: { nodeId: node.id } })).bootId;
      return n.registrationProtocol === '1.0' && n.lastSeenAt > after;
    });
  }
  const report = {
    ubuntu: 'ubuntu:26.04',
    arch: 'x86_64',
    memoryKiB: 16000000,
    freeDiskBytes: 50 * 1024 ** 3,
    kvm: true,
    sudo: false,
    markerPresent: false,
    android: true,
    download: true,
    versions: { node: '24.18.0' },
    errors: [],
  };
  try {
    site = await fixtureSite();
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const admin = await db.admin.findFirst();
    await db.admin.update({
      where: { id: admin.id },
      data: { passwordHash: await passwordHash(process.env.P0_TEST_PASSWORD) },
    });
    await db.loginBucket.deleteMany();
    const login = await fetch(base + '/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: process.env.APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'p0admin', password: process.env.P0_TEST_PASSWORD }),
    });
    cookie = login.headers.get('set-cookie').split(';')[0];
    csrf = (await login.json()).csrfToken;
    body = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
    body.source = {
      url: site.url + '/source',
      xpath: "//div[@aria-label='1 / 5']//a[@pid='1']",
      browserUserAgent: '',
    };
    body.download.timeoutMs = 10000;
    body.download.retries = 0;
    const proxy = await req('/secrets/versions', 'POST', {
      type: 'HTTP_PROXY',
      secretValue: {
        host: 'proxy.example.test',
        port: 8080,
        username: 'fixture-user',
        password: 'fixture-pass',
      },
    });
    assert.equal(proxy.status, 201);
    body.execution.proxySecretVersionId = proxy.data.id;
    const flow = {
      packageName: 'com.example.p2',
      activity: '.MainActivity',
      enabled: true,
      steps: [
        {
          action: 'input',
          locator: { by: 'id', value: 'username' },
          text: '{username}',
          timeoutMs: 1000,
          optional: false,
        },
        {
          action: 'input',
          locator: { by: 'id', value: 'password' },
          text: '{password}',
          timeoutMs: 1000,
          optional: false,
        },
        {
          action: 'submit',
          locator: { by: 'id', value: 'submit' },
          timeoutMs: 1000,
          optional: false,
        },
      ],
      success: { locator: { by: 'id', value: 'success' }, timeoutMs: 1500 },
      failure: { locator: { by: 'id', value: 'rejected' }, timeoutMs: 1000 },
    };
    body.registrationFlows = [flow];
    release = await db.release.create({
      data: {
        id: randomUUID(),
        artifactName: 'agent-' + randomBytes(32).toString('hex') + '.tgz',
        sha256: randomBytes(32).toString('hex'),
        manifest: {
          agentVersion: '0.8.0',
          features: [
            'DOWNLOAD_V1',
            'REGISTRATION_V1',
            'DAILY_V1',
            'AUTO_REGISTRATION_V1',
            'CONTENT_ISOLATION_V1',
          ],
          toolchain: { systemImage: body.execution.deviceProfiles[0].systemImage },
        },
      },
    });
    node = await db.node.create({
      data: {
        name: 'P3 fixture',
        host: 'p3.example.test',
        deploymentStatus: 'INSTALLED',
        agentReleaseId: release.id,
        agentVersion: '0.8.0',
        downloadProtocol: '1.0',
        health: report,
        lastSeenAt: new Date(),
        slot: { create: {} },
      },
    });
    const token = randomBytes(32).toString('base64url');
    await db.agentCredential.create({
      data: {
        nodeId: node.id,
        tokenHash: digest(token),
        bootId: randomUUID(),
        releaseId: release.id,
      },
    });
    await loadIdentity(join(root, 'p3-identity'));
    await saveIdentity(join(root, 'p3-identity'), {
      enrollmentBootId: randomUUID(),
      credential: token,
    });
    await t.test('old registration capability is refused before claiming', async () => {
      const v = await save(),
        r = await req(
          '/runs',
          'POST',
          { nodeId: node.id, configVersionId: v.id, releaseId: release.id },
          idem(),
        );
      assert.equal(r.data.error.code, 'NODE_UPGRADE_REQUIRED');
    });
    await start();
    await t.test('registration refuses a signed release without content isolation', async () => {
      const original = release.manifest;
      await db.release.update({
        where: { id: release.id },
        data: {
          manifest: {
            ...original,
            features: ['DOWNLOAD_V1', 'REGISTRATION_V1', 'DAILY_V1', 'AUTO_REGISTRATION_V1'],
          },
        },
      });
      try {
        const v = await save(),
          r = await req(
            '/runs',
            'POST',
            { nodeId: node.id, configVersionId: v.id, releaseId: release.id },
            idem(),
          );
        assert.equal(r.status, 409);
        assert.equal(r.data.error.code, 'NODE_UPGRADE_REQUIRED');
      } finally {
        await db.release.update({ where: { id: release.id }, data: { manifest: original } });
      }
    });
    await t.test(
      'first flow really registers once and stores only functional evidence and encrypted accounts',
      async () => {
        const before = submitted,
          r = await run();
        assert.equal(r.status, 'SUCCEEDED', JSON.stringify(r));
        assert.equal(submitted - before, 1);
        const [task] = await db.task.findMany({ where: { runId: r.id } });
        assert.equal(task.proof, 'APP_UI');
        assert.ok(task.submissionId);
        assert.ok(task.observation);
        assert.equal(installed, 1);
        assert.equal(launched, 1);
        const account = await db.accountResult.findUnique({ where: { taskId: task.id } }),
          row = await req('/tasks/' + task.id + '/account-view', 'POST', {
            reason: '核对自有测试账户',
          });
        assert.equal(row.status, 200);
        assert.match(row.data.username, /^[a-zA-Z]{6,10}$/);
        assert.match(row.data.password, /^(?=.*[a-zA-Z])(?=.*[0-9])[a-zA-Z0-9]{8,12}$/);
        assert.equal(row.headers.get('cache-control'), 'no-store');
        assert.ok(!JSON.stringify(account).includes(row.data.password));
        const local = await openAgentStore(join(root, 'p3-inspect-account'));
        local.close(); // Independent key permissions are tested below.
        const audit = await db.auditEvent.findFirst({
          where: { action: 'ACCOUNT_VIEWED' },
          orderBy: { createdAt: 'desc' },
        });
        assert.equal(audit.details.taskId, task.id);
        assert.equal(audit.details.reason, '核对自有测试账户');
        assert.equal((await req('/tasks/' + task.id + '/account-view', 'POST', {})).status, 422);
        const list = await req('/tasks/' + task.id + '/artifacts');
        assert.equal(list.data.items.length, 1);
        assert.ok(!JSON.stringify(list.data).includes('storageKey'));
        const art = list.data.items[0];
        const content = await fetch(base + '/api/v1/artifacts/' + art.id + '/content', {
          headers: { cookie },
        });
        assert.equal(content.status, 200);
        assert.match(content.headers.get('content-type'), /^application\/json/);
        const bytes = Buffer.from(await content.arrayBuffer()),
          evidence = parseFunctionalEvidence(bytes.toString());
        assert.equal(evidence.stage, 'RESULT');
        assert.equal(evidence.outcome, 'SUCCEEDED');
        assert.equal(evidence.verification, 'CONFIGURED_LOCATOR');
        assert.ok(!bytes.includes(Buffer.from(row.data.username)));
        assert.ok(!bytes.includes(Buffer.from(row.data.password)));
        const delivery = await db.delivery.findUnique({ where: { runId: r.id } });
        const nodeCall = async (path, data, method = 'POST') => {
          const result = await fetch(base + '/api/v1/agent/' + path, {
            method,
            headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
            body: JSON.stringify(data),
          });
          return { status: result.status, data: await result.json() };
        };
        const accountMessage = {
          kind: 'account',
          protocolVersion: '1.0',
          nodeId: node.id,
          deliveryId: delivery.id,
          fence: delivery.fence,
          taskId: task.id,
          ...row.data,
        };
        assert.equal(
          (await nodeCall('tasks/' + task.id + '/account', accountMessage, 'PUT')).status,
          200,
        );
        assert.equal(
          (
            await nodeCall(
              'tasks/' + task.id + '/account',
              { ...accountMessage, password: 'Different123' },
              'PUT',
            )
          ).status,
          409,
        );
        const artifactMessage = {
          protocolVersion: '1.0',
          nodeId: node.id,
          bootId: engineBoot,
          deliveryId: delivery.id,
          fence: delivery.fence,
          taskId: task.id,
          artifactId: art.id,
          kind: 'functional-evidence',
          sha256: digest(bytes),
          dataBase64: bytes.toString('base64'),
          redaction: 'CONTENT_ISOLATED',
        };
        assert.equal((await nodeCall('artifacts', artifactMessage)).status, 200);
        assert.equal(
          (
            await nodeCall('artifacts', {
              ...artifactMessage,
              dataBase64: functionalBytes().toString('base64'),
              sha256: digest(functionalBytes()),
            })
          ).status,
          409,
        );
        assert.equal(
          (
            await nodeCall('artifacts', {
              ...artifactMessage,
              artifactId: randomUUID(),
              taskId: randomUUID(),
            })
          ).status,
          404,
        );
        const otherNode = await db.node.create({
          data: { name: 'P3 other owner', host: 'other.example.test' },
        });
        try {
          assert.equal(
            (await nodeCall('artifacts', { ...artifactMessage, nodeId: otherNode.id })).status,
            401,
          );
        } finally {
          await db.node.delete({ where: { id: otherNode.id } });
        }
        assert.equal(
          (await nodeCall('artifacts', { ...artifactMessage, fence: delivery.fence + 1 })).status,
          409,
        );
        assert.equal(
          (await nodeCall('artifacts', { ...artifactMessage, sha256: 'a'.repeat(64) })).status,
          422,
        );
        const artifactPath = join(process.env.ARTIFACT_DIR, art.id + '.json');
        await writeFile(artifactPath, white);
        assert.equal(
          (await fetch(base + '/api/v1/artifacts/' + art.id + '/content', { headers: { cookie } }))
            .status,
          410,
        );
        await writeFile(artifactPath, bytes);
        assert.equal((await fetch(base + '/api/v1/artifacts/' + art.id + '/content')).status, 401);
        for (const raw of [white, Buffer.from('{"body":"OWNED_CONTENT_MUST_NOT_EXPORT"}')]) {
          assert.equal(
            (
              await nodeCall('artifacts', {
                ...artifactMessage,
                artifactId: randomUUID(),
                dataBase64: raw.toString('base64'),
                sha256: digest(raw),
              })
            ).status,
            422,
          );
        }
        const legacyId = randomUUID();
        await db.artifact.create({
          data: {
            id: legacyId,
            taskId: task.id,
            deliveryId: delivery.id,
            fence: delivery.fence,
            kind: 'screenshot',
            sha256: digest(white),
            bytes: white.length,
            storageKey: legacyId + '.png',
          },
        });
        // Deliberately no legacy file: the read must be refused before touching storage.
        const hidden = await req('/artifacts/' + legacyId + '/content');
        assert.equal(hidden.status, 410);
        assert.equal(hidden.data.error.code, 'CONTENT_ISOLATION_REQUIRED');
        assert.ok(
          !(await req('/tasks/' + task.id + '/artifacts')).data.items.some(
            (a) => a.id === legacyId,
          ),
        );
        const eventText = JSON.stringify(
          await db.runEvent.findMany({
            where: { deliveryId: (await db.delivery.findUnique({ where: { runId: r.id } })).id },
          }),
        );
        assert.ok(!eventText.includes(row.data.username));
        assert.ok(!eventText.includes(row.data.password));
        if (process.platform !== 'win32')
          assert.equal(
            (await lstat(join(process.env.ARTIFACT_DIR, art.id + '.png'))).mode & 0o777,
            0o600,
          );
      },
    );
    await t.test(
      '1.5 daily download, cached global quotas, lifecycle, proxy check and durable schedule',
      async (t) => {
        const original = structuredClone(body.source);
        body.source.xpath = '//a[@class="jgg-item"]';
        mode = 'success';
        const version = await save();
        body.source = original;
        const apkRequests = () =>
          ['/direct.apk', '/second.apk', '/third.apk'].reduce(
            (n, p) => n + (site.counts.get(p) ?? 0),
            0,
          );
        const purpose = async (extra, waitEnd = true) => {
          const r = await req(
            '/runs',
            'POST',
            { nodeId: node.id, configVersionId: version.id, releaseId: release.id, ...extra },
            idem(),
          );
          assert.equal(r.status, 202, JSON.stringify(r.data));
          activeRunId = r.data.resourceId;
          return waitEnd
            ? wait(async () => {
                const run = await db.run.findUnique({ where: { id: r.data.resourceId } });
                return [
                  'SUCCEEDED',
                  'PARTIAL_FAILED',
                  'FAILED',
                  'CANCELLED',
                  'NEEDS_REVIEW',
                ].includes(run.status)
                  ? run
                  : false;
              })
            : r.data;
        };
        let downloaded, entryVersion;
        await t.test(
          'daily download never installs and duplicate start does not revisit source',
          async () => {
            const before = installed;
            downloaded = await purpose({ purpose: 'DOWNLOAD' });
            assert.equal(downloaded.status, 'SUCCEEDED');
            assert.equal(installed, before);
            const requests = apkRequests();
            const again = await purpose({ purpose: 'DOWNLOAD' });
            assert.equal(again.id, downloaded.id);
            assert.equal(apkRequests(), requests);
            assert.equal(await db.task.count({ where: { runId: downloaded.id } }), 3);
          },
        );
        await t.test(
          'entry-bound templates select the daily assets without fixed package names',
          async () => {
            const stored = await db.configVersion.findUniqueOrThrow({ where: { id: version.id } });
            const entryBody = structuredClone(stored.body);
            entryBody.registrationFlows = ['1', '2', '3'].map((entryId) => ({
              ...structuredClone(entryBody.registrationFlows[0]),
              entryId,
              packageName: '*',
              activity: '@launcher',
            }));
            const container = (await req('/configs/' + version.configId)).data;
            const saved = await req(
              '/configs/' + version.configId + '/versions',
              'POST',
              entryBody,
              { ...idem(), 'If-Match': String(container.version) },
            );
            assert.equal(saved.status, 201, JSON.stringify(saved.data));
            entryVersion = saved.data;
            const r = await purpose({
              purpose: 'REGISTER',
              configVersionId: entryVersion.id,
              sourceDownloadId: downloaded.id,
              successTarget: 3,
              attemptLimit: 3,
            });
            assert.equal(r.status, 'SUCCEEDED', JSON.stringify(r));
            assert.equal(r.successes, 3);
            assert.deepEqual(
              r.executionPlan.assets.map((a) => a.entryId),
              ['1', '2', '3'],
            );
          },
        );
        const registration = {
          purpose: 'REGISTER',
          sourceDownloadId: downloaded.id,
          successTarget: 3,
          attemptLimit: 5,
        };
        await t.test(
          '1.6 automatic flows include unadapted assets, persist receipts and learn across Agent restart',
          async () => {
            const stored = await db.configVersion.findUniqueOrThrow({ where: { id: version.id } }),
              automatic = structuredClone(stored.body);
            automatic.registrationFlows = [];
            automatic.execution.autoRegistration = {
              enabled: true,
              screenshotFallback: false,
              maxNavigationSteps: 8,
              timeoutMs: 15000,
              successTimeoutMs: 1500,
            };
            const container = (await req('/configs/' + version.configId)).data;
            const saved = await req(
              '/configs/' + version.configId + '/versions',
              'POST',
              automatic,
              { ...idem(), 'If-Match': String(container.version) },
            );
            assert.equal(saved.status, 201);
            const input = {
              purpose: 'REGISTER',
              configVersionId: saved.data.id,
              sourceDownloadId: downloaded.id,
              successTarget: 3,
              attemptLimit: 3,
            };
            const manifest = structuredClone(release.manifest);
            await db.release.update({
              where: { id: release.id },
              data: {
                manifest: { ...manifest, features: ['DOWNLOAD_V1', 'REGISTRATION_V1', 'DAILY_V1'] },
              },
            });
            try {
              const old = await req(
                '/runs',
                'POST',
                { nodeId: node.id, releaseId: release.id, ...input },
                idem(),
              );
              assert.equal(old.status, 409);
              assert.equal(old.data.error.code, 'NODE_UPGRADE_REQUIRED');
            } finally {
              await db.release.update({ where: { id: release.id }, data: { manifest } });
            }
            mode = 'auto-success';
            const before = submitted;
            const first = await purpose(input);
            assert.equal(first.status, 'SUCCEEDED', JSON.stringify(first));
            assert.equal(first.executionPlan.assets.length, 3);
            assert.equal(first.successes, 3);
            assert.equal(submitted - before, 3);
            const firstTasks = await db.task.findMany({ where: { runId: first.id } });
            assert.ok(
              firstTasks.every(
                (task) => task.recognition.learned && task.recognition.source === 'CONTROLS',
              ),
            );
            const stages = await db.runEvent.findMany({ where: { delivery: { runId: first.id } } });
            assert.ok(stages.some((e) => e.body.payload.stage === 'DISCOVERING'));
            assert.ok(
              stages.some(
                (e) => e.body.type === 'APP_OBSTRUCTION' && e.body.payload.action === 'CLOSE_AD',
              ),
            );
            const timeline = await req('/runs/' + first.id + '/timeline?limit=100');
            assert.equal(timeline.status, 200);
            assert.ok(timeline.data.items.some((e) => e.title === '已关闭广告'));
            abort.abort();
            await agentRun;
            await start();
            const second = await purpose(input);
            assert.equal(second.status, 'SUCCEEDED', JSON.stringify(second));
            const tasks = await db.task.findMany({ where: { runId: second.id } });
            assert.ok(
              tasks.every(
                (task) => task.recognition.cache === 'HIT' && task.recognition.source === 'LEARNED',
              ),
            );
            assert.equal(activeSessions, 0);
            for (const scenario of ['auto-guest', 'auto-directory']) {
              mode = scenario;
              const beforeIdentitySubmit = submitted;
              const skipped = await purpose({ ...input, successTarget: 2, attemptLimit: 5 });
              assert.equal(skipped.status, 'FAILED');
              assert.equal(skipped.errorCode, 'NO_REGISTERABLE_APK');
              assert.equal(skipped.successes, 0);
              assert.equal(skipped.attemptsStarted, 1);
              const observedTask = await db.task.findFirstOrThrow({
                where: { runId: skipped.id, attemptStarted: true },
              });
              assert.equal(observedTask.status, 'SKIPPED');
              assert.equal(
                observedTask.errorCode,
                scenario === 'auto-guest' ? 'APP_AUTO_IDENTITY' : 'APP_NAVIGATION_ONLY',
              );
              assert.equal(observedTask.submissionId, null);
              assert.equal(submitted, beforeIdentitySubmit);
              assert.equal(
                await db.accountResult.count({ where: { delivery: { runId: skipped.id } } }),
                0,
              );
              const observedSummary = await req('/runs/' + skipped.id + '/summary');
              assert.equal(observedSummary.status, 200);
              assert.equal(
                observedSummary.data.automaticIdentityCount,
                scenario === 'auto-guest' ? 1 : 0,
              );
              assert.equal(observedSummary.data.counts.SUCCESS, 0);
              assert.equal(activeSessions, 0);
            }
            mode = 'auto-unsupported';
            const rejected = await purpose({ ...input, successTarget: 2, attemptLimit: 5 });
            assert.equal(rejected.status, 'FAILED');
            assert.equal(rejected.errorCode, 'AUTO_ADAPTATION_REQUIRED');
            assert.equal(rejected.attemptsStarted, 1);
            assert.equal(
              await db.task.count({
                where: { runId: rejected.id, attemptStarted: false, status: 'SKIPPED' },
              }),
              4,
            );
            const badTask = await db.task.findFirstOrThrow({
              where: { runId: rejected.id, attemptStarted: true },
            });
            assert.equal(badTask.recognition.needsAdaptation, true);
            assert.equal(badTask.submissionId, null);
            mode = 'success';
          },
        );
        await t.test(
          'all APKs share target; each attempt has a closed previous session; unused slots do not count',
          async () => {
            const requests = apkRequests(),
              before = submitted,
              opened = openedSessions;
            const r = await purpose(registration);
            assert.equal(r.status, 'SUCCEEDED', JSON.stringify(r));
            assert.equal(r.successes, 3);
            assert.equal(r.attemptsStarted, 3);
            assert.equal(submitted - before, 3);
            assert.equal(openedSessions - opened, 3);
            assert.equal(activeSessions, 0);
            assert.equal(openedSessions, closedSessions);
            assert.equal(apkRequests(), requests, 'registration must never download again');
            const tasks = await db.task.findMany({
              where: { runId: r.id },
              orderBy: { position: 'asc' },
            });
            assert.equal(tasks.filter((t) => t.errorCode === 'QUOTA_NOT_USED').length, 2);
            assert.ok(tasks.slice(0, 3).every((t) => t.cacheHit && t.attemptStarted));
            const delivery = await db.delivery.findUnique({ where: { runId: r.id } });
            const event = await db.runEvent.findFirst({
              where: { deliveryId: delivery.id, body: { path: ['type'], equals: 'TASK_FINISHED' } },
              orderBy: { sequence: 'desc' },
            });
            const replay = await fetch(base + '/api/v1/agent/events', {
              method: 'POST',
              headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
              body: JSON.stringify({
                kind: 'events',
                protocolVersion: '1.0',
                nodeId: node.id,
                deliveryId: delivery.id,
                fence: delivery.fence,
                events: [event.body],
              }),
            });
            assert.equal(replay.status, 200);
            assert.equal((await db.run.findUnique({ where: { id: r.id } })).successes, 3);
          },
        );
        await t.test(
          'explicit rejection consumes bounded attempts and invalid budget cannot start',
          async () => {
            mode = 'reject';
            const before = submitted;
            const r = await purpose({ ...registration, successTarget: 2, attemptLimit: 3 });
            assert.equal(r.status, 'FAILED');
            assert.equal(r.errorCode, 'ATTEMPT_LIMIT');
            assert.equal(r.attemptsStarted, 3);
            assert.equal(submitted - before, 3);
            const bad = await req(
              '/runs',
              'POST',
              {
                nodeId: node.id,
                configVersionId: version.id,
                releaseId: release.id,
                ...registration,
                successTarget: 5,
                attemptLimit: 2,
              },
              idem(),
            );
            assert.equal(bad.status, 422);
            mode = 'success';
          },
        );
        await t.test('proxy-only failure never starts an emulator or opens a product', async () => {
          const before = installed,
            opened = openedSessions;
          const r = await purpose({
            purpose: 'PROXY_CHECK',
            proxySecretVersionId: body.execution.proxySecretVersionId,
          });
          assert.equal(r.status, 'FAILED');
          assert.equal(r.errorCode, 'PROXY_CHECK_FAILED');
          assert.equal(r.proxyObservation.status, 'FAILED');
          assert.equal(installed, before);
          assert.equal(openedSessions, opened);
        });
        await t.test(
          'concurrent daily ticks create one persistent occurrence and one registration; disable is versioned',
          async () => {
            const input = {
              nodeId: node.id,
              configVersionId: version.id,
              releaseId: release.id,
              time: '00:00',
              timezone: 'Asia/Shanghai',
              successTarget: 2,
              attemptLimit: 4,
              enabled: true,
              autoRegister: true,
            };
            const saved = await req('/schedules', 'POST', input, idem());
            assert.equal(saved.status, 201, JSON.stringify(saved.data));
            await Promise.all([tickSchedules(db), tickSchedules(db)]);
            const rows = await db.dailyOccurrence.findMany({
              where: { scheduleId: saved.data.id },
            });
            assert.equal(rows.length, 1);
            assert.equal(rows[0].downloadRunId, downloaded.id);
            assert.ok(rows[0].registerRunId);
            const r = await wait(async () => {
              const r = await db.run.findUnique({ where: { id: rows[0].registerRunId } });
              return r.status === 'SUCCEEDED' ? r : false;
            });
            assert.equal(r.successes, 2);
            await tickSchedules(db);
            assert.equal(
              (await db.dailyOccurrence.findUnique({ where: { id: rows[0].id } })).status,
              'FINISHED',
            );
            const disabled = await req(
              '/schedules/' + saved.data.id,
              'PUT',
              { ...input, enabled: false },
              { ...idem(), 'If-Match': '1' },
            );
            assert.equal(disabled.status, 200);
            assert.equal(
              (
                await req('/schedules/' + saved.data.id, 'PUT', input, {
                  ...idem(),
                  'If-Match': '1',
                })
              ).status,
              409,
            );
            await tickSchedules(db, new Date(Date.now() + 86400000));
            assert.equal(
              await db.dailyOccurrence.count({ where: { scheduleId: saved.data.id } }),
              1,
            );
          },
        );
        await t.test(
          'cross-day stops the previous queued daily batch; disabled plan stays stopped after restart',
          async () => {
            const schedule = await db.dailySchedule.findUniqueOrThrow({
              where: { nodeId: node.id },
            });
            const enabled = await req(
              '/schedules/' + schedule.id,
              'PUT',
              { ...schedule.body, enabled: true },
              { ...idem(), 'If-Match': String(schedule.version) },
            );
            assert.equal(enabled.status, 200);
            abort.abort();
            await agentRun;
            const tomorrow = new Date(Date.now() + 86400000),
              after = new Date(Date.now() + 2 * 86400000);
            await tickSchedules(db, tomorrow);
            const one = await db.dailyOccurrence.findFirst({
              where: { scheduleId: schedule.id, day: { gt: downloaded.cacheDay } },
              orderBy: { day: 'asc' },
            });
            assert.equal(
              (await db.run.findUnique({ where: { id: one.downloadRunId } })).status,
              'QUEUED',
            );
            await tickSchedules(db, after);
            assert.equal(
              (await db.run.findUnique({ where: { id: one.downloadRunId } })).status,
              'CANCELLED',
            );
            assert.equal(
              (await db.dailyOccurrence.findUnique({ where: { id: one.id } })).status,
              'STOPPED',
            );
            const disabled = await req(
              '/schedules/' + schedule.id,
              'PUT',
              { ...schedule.body, enabled: false },
              { ...idem(), 'If-Match': String(enabled.data.version) },
            );
            assert.equal(disabled.status, 200);
            await tickSchedules(db, after);
            assert.equal(
              (await db.nodeSlot.findUnique({ where: { nodeId: node.id } })).runId,
              null,
            );
            const count = await db.dailyOccurrence.count({ where: { scheduleId: schedule.id } });
            await tickSchedules(db, new Date(Date.now() + 3 * 86400000));
            assert.equal(
              await db.dailyOccurrence.count({ where: { scheduleId: schedule.id } }),
              count,
            );
            await start();
          },
        );
        await t.test(
          'changed entry layout stops before submission without burning the remaining budget',
          async () => {
            const entryBody = structuredClone(
              (await db.configVersion.findUniqueOrThrow({ where: { id: entryVersion.id } })).body,
            );
            for (const f of entryBody.registrationFlows) f.steps[0].locator.value = 'changed';
            const container = (await req('/configs/' + version.configId)).data;
            const saved = await req(
              '/configs/' + version.configId + '/versions',
              'POST',
              entryBody,
              { ...idem(), 'If-Match': String(container.version) },
            );
            assert.equal(saved.status, 201);
            const before = submitted;
            const r = await purpose({ ...registration, configVersionId: saved.data.id });
            assert.equal(r.status, 'FAILED');
            assert.equal(r.errorCode, 'FLOW_LAYOUT_CHANGED');
            assert.equal(r.attemptsStarted, 1);
            assert.equal(submitted, before);
          },
        );
        await t.test('missing cached APK ends early and never downloads as a repair', async () => {
          const source = await db.task.findFirst({
            where: { runId: downloaded.id },
            orderBy: { position: 'asc' },
          });
          const key = digest(JSON.stringify([node.id, downloaded.cacheDay, source.targetKey]));
          await writeFile(
            join(root, 'p3-execution/downloads/cache/files', key + '.apk'),
            'corrupted fixture',
          );
          const requests = apkRequests(),
            before = installed;
          const r = await purpose(registration);
          assert.equal(r.status, 'FAILED');
          assert.equal(r.errorCode, 'CACHE_MISSING');
          assert.equal(r.attemptsStarted, 1);
          assert.equal(installed, before);
          assert.equal(apkRequests(), requests);
        });
      },
    );
    await t.test(
      'second page flow and lost submit response still submit exactly once',
      async () => {
        mode = 'lost-success';
        flow.steps.splice(1, 0, {
          action: 'click',
          locator: { by: 'id', value: 'next' },
          timeoutMs: 1000,
          optional: false,
        });
        const before = submitted,
          r = await run();
        assert.equal(r.status, 'SUCCEEDED');
        assert.equal(submitted - before, 1);
        flow.steps.splice(1, 1);
      },
    );
    await t.test('explicit rejection is a proved failure without retry', async () => {
      mode = 'reject';
      const before = submitted,
        r = await run();
      assert.equal(r.status, 'FAILED');
      const task = await db.task.findFirst({ where: { runId: r.id } });
      assert.equal(task.errorCode, 'REGISTRATION_REJECTED');
      assert.equal(task.proof, 'APP_UI');
      assert.equal(submitted - before, 1);
    });
    await t.test(
      'changed selector fails before submission; unadapted package is skipped',
      async () => {
        mode = 'success';
        flow.steps[0].locator.value = 'changed';
        const before = submitted,
          r = await run();
        assert.equal(r.status, 'FAILED');
        assert.equal(submitted, before);
        assert.equal((await db.task.findFirst({ where: { runId: r.id } })).submissionId, null);
        flow.steps[0].locator.value = 'username';
        flow.enabled = false;
        const skipped = await run();
        assert.equal((await db.task.findFirst({ where: { runId: skipped.id } })).status, 'SKIPPED');
        assert.equal(submitted, before);
        flow.enabled = true;
      },
    );
    await t.test('stop before intent confirms cleanup and sends no submission', async () => {
      mode = 'stop-before';
      const before = submitted,
        r = await run(true);
      assert.equal(r.status, 'CANCELLED', JSON.stringify(r));
      assert.equal(submitted, before);
      assert.equal((await db.task.findFirst({ where: { runId: r.id } })).submissionId, null);
    });
    await t.test(
      '1.5 unknown stops the loop across stop and restart and requires explicit task decision',
      async () => {
        mode = 'unknown';
        const before = submitted,
          r = await run(true);
        assert.equal(r.status, 'NEEDS_REVIEW');
        assert.equal(submitted - before, 1);
        const task = await db.task.findFirst({
          where: { runId: r.id, submissionId: { not: null } },
        });
        assert.equal(task.status, 'UNKNOWN');
        assert.equal(await db.task.count({ where: { runId: r.id, attemptStarted: true } }), 1);
        assert.ok(await db.accountResult.findUnique({ where: { taskId: task.id } }));
        abort.abort();
        await agentRun;
        await start();
        await pause(1200);
        assert.equal(submitted - before, 1);
        assert.equal(
          (
            await req(
              '/runs/' + r.id + '/reconciliations',
              'POST',
              { reason: '已确认节点清理并核验后台' },
              idem(),
            )
          ).status,
          409,
        );
        const key = idem(),
          review = {
            outcome: 'FAILED',
            reason: '自有测试后台确认本次提交未创建账户',
            evidenceIds: [],
          };
        const saved = await req('/tasks/' + task.id + '/reconciliations', 'POST', review, key);
        assert.equal(saved.status, 200);
        assert.equal(
          (await req('/tasks/' + task.id + '/reconciliations', 'POST', review, key)).data.id,
          saved.data.id,
        );
        assert.equal((await db.task.findUnique({ where: { id: task.id } })).status, 'UNKNOWN');
        await wait(async () => {
          const n = await db.node.findUnique({ where: { id: node.id } }),
            rr = await db.run.findUnique({ where: { id: r.id } });
          return (
            !n.currentDeliveryId &&
            n.lastSeenAt > rr.cleanupConfirmedAt &&
            rr.cleanupBootId === engineBoot
          );
        });
        const unlocked = await req(
          '/runs/' + r.id + '/reconciliations',
          'POST',
          { reason: '已确认节点清理并核验后台' },
          idem(),
        );
        assert.equal(unlocked.status, 200, JSON.stringify(unlocked.data));
        const late = await fetch(base + '/api/v1/agent/artifacts', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
          body: JSON.stringify({
            protocolVersion: '1.0',
            nodeId: node.id,
            bootId: engineBoot,
            deliveryId: (await db.delivery.findUnique({ where: { runId: r.id } })).id,
            fence: (await db.delivery.findUnique({ where: { runId: r.id } })).fence,
            taskId: task.id,
            artifactId: randomUUID(),
            kind: 'functional-evidence',
            sha256: digest(functionalBytes()),
            dataBase64: functionalBytes().toString('base64'),
            redaction: 'CONTENT_ISOLATED',
          }),
        });
        assert.equal(late.status, 200);
        assert.equal((await late.json()).recordedForReview, true);
        assert.equal(
          (
            await fetch(base + '/api/v1/agent/artifacts', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: '[' + 'x'.repeat(300000) + ']',
            })
          ).status,
          401,
        );
      },
    );
    await t.test(
      'unproved Android cleanup quarantines the node even after a proved registration',
      async () => {
        mode = 'cleanup';
        const r = await run();
        assert.equal(r.status, 'NEEDS_REVIEW');
        assert.equal(r.errorCode, 'CLEANUP_INCOMPLETE');
        assert.equal(
          (await db.nodeSlot.findUnique({ where: { nodeId: node.id } })).quarantined,
          true,
        );
      },
    );
  } finally {
    abort?.abort();
    await agentRun;
    await app?.close();
    await site?.close();
    await close(appium);
    if (node) {
      await db.dailyOccurrence.deleteMany({ where: { schedule: { nodeId: node.id } } });
      await db.dailySchedule.deleteMany({ where: { nodeId: node.id } });
      const taskWhere = { task: { run: { nodeId: node.id } } };
      await db.artifact.deleteMany({ where: taskWhere });
      await db.taskReview.deleteMany({ where: taskWhere });
      await db.accountResult.deleteMany({ where: taskWhere });
      await db.runEvent.deleteMany({ where: { delivery: { run: { nodeId: node.id } } } });
      await db.task.deleteMany({ where: { run: { nodeId: node.id } } });
      await db.delivery.deleteMany({ where: { run: { nodeId: node.id } } });
      await db.run.deleteMany({ where: { nodeId: node.id } });
      await db.agentCredential.deleteMany({ where: { nodeId: node.id } });
      await db.nodeSlot.deleteMany({ where: { nodeId: node.id } });
      await db.node.delete({ where: { id: node.id } });
    }
    await db.configVersion.deleteMany({ where: { configId: { in: configurationIds } } });
    await db.configuration.deleteMany({ where: { id: { in: configurationIds } } });
    if (release) await db.release.delete({ where: { id: release.id } });
    await db.$disconnect();
  }
});

test('P3 proof confirmation has a shared deadline and never replays submission', async () => {
  const file = join(root, 'p3-deadline.apk');
  await writeFile(file, fixtureApk());
  const apk = await inspectApk(file, 1048576, '2026-10-28', new AbortController().signal),
    config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
  const flow = config.registrationFlows[0];
  flow.packageName = apk.packageName;
  flow.enabled = true;
  flow.success.timeoutMs = 1000;
  flow.steps.unshift({
    action: 'click',
    locator: { by: 'id', value: 'optional-missing' },
    timeoutMs: 1000,
    optional: true,
  });
  let submissions = 0,
    closed = false;
  const session = {
    observation: observation(),
    supportedAbis: ['x86_64'],
    install: async () => {},
    launch: async () => {},
    find: async (locator) => {
      if (locator.value === 'optional-missing') throw new RegistrationError('FLOW_STEP_FAILED');
      return 'field';
    },
    input: async () => {},
    click: async () => {},
    submit: async () => {
      submissions++;
    },
    back: async () => {},
    rect: async () => ({ x: 10, y: 10, width: 20, height: 10 }),
    source: async () => '<hierarchy/>',
    screenshot: async () => white,
    close: async () => {
      closed = true;
      return true;
    },
  };
  const started = Date.now(),
    result = await registerApk(
      config,
      { taskId: randomUUID() },
      apk,
      file,
      0,
      new AbortController().signal,
      async () => {},
      {
        sdkRoot: '/fixture',
        toolsRoot: '/fixture',
        root,
        proxy: { host: 'fixture.example.test', port: 8080, username: 'x', password: 'x' },
        beforeAction: () => {},
        resources: async () => {},
        androidFactory: async () => session,
        account: async () => ({
          accountRef: randomUUID(),
          username: 'FixtureUser',
          password: 'Fixture123',
        }),
        intent: async () => {},
        evidence: async (_id, _bytes, signal) =>
          new Promise((_ok, no) => {
            const keepAlive = setTimeout(() => no(Error('deadline was not delivered')), 3000);
            const abort = () => {
              clearTimeout(keepAlive);
              no(Error('confirmation timed out'));
            };
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          }),
      },
    );
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.errorCode, 'REGISTRATION_UNKNOWN');
  assert.equal(submissions, 1);
  assert.equal(closed, true);
  assert.ok(Date.now() - started < 2500);
});

test('P3 SQLite intent is atomic, immutable and restart never dispatches another submission', async () => {
  const dir = join(root, 'p3-journal');
  await mkdir(dir, { recursive: true });
  let store = await openAgentStore(dir);
  const d = JSON.parse(
    await readFile('contracts/fixtures/agent.delivery.json', 'utf8').catch(() => '{}'),
  );
  Object.assign(d, {
    kind: 'delivery',
    protocolVersion: '1.0',
    nodeId: randomUUID(),
    deliveryId: randomUUID(),
    runId: randomUUID(),
    fence: 1,
    configVersionId: randomUUID(),
    configHash: randomBytes(32).toString('hex'),
    releaseId: randomUUID(),
    issuedAt: new Date().toISOString(),
    ackDeadline: new Date(Date.now() + 30000).toISOString(),
    leaseExpiresAt: new Date(Date.now() + 120000).toISOString(),
  });
  store.add(d);
  const task = randomUUID(),
    account = store.account(d, task);
  assert.deepEqual(store.account(d, task), account);
  assert.throws(() => store.intent(d, task, account.accountRef));
  store.accountAck(account.accountRef);
  store.intent(d, task, account.accountRef);
  assert.throws(() => store.intent(d, task, account.accountRef));
  assert.equal(store.pending(d.deliveryId).filter((e) => e.type === 'SUBMISSION_INTENT').length, 1);
  store.append(d, {
    type: 'TASK_FINISHED',
    taskId: task,
    payload: {
      status: 'SUCCEEDED',
      proof: 'APP_UI',
      artifactIds: [randomUUID()],
      accountRef: account.accountRef,
    },
  });
  assert.equal(store.submissions(d.deliveryId).length, 1);
  assert.ok(
    !Buffer.from(store.db.prepare('SELECT sealed FROM accounts').get().sealed).includes(
      Buffer.from(account.password),
    ),
  );
  store.close();
  let claims = 0,
    reconciled;
  const engine = await TaskEngine.open(
    dir,
    d.nodeId,
    randomUUID(),
    resolve('.'),
    async (path, body) => {
      if (path === 'reconcile') {
        reconciled = body;
        return {};
      }
      if (path === 'events') return { ackedEventIds: body.events.map((e) => e.eventId) };
      if (path === 'claims') {
        claims++;
        return {};
      }
      throw Error('unexpected mutation');
    },
  );
  assert.equal(reconciled.deliveries[0].submissions[0].accountRef, account.accountRef);
  assert.equal(claims, 0);
  await engine.close();
});
