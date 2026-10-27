import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, stat, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { create as tarCreate } from 'tar';
import { createApp } from '../apps/control-api/dist/app.js';
import { passwordHash } from '../apps/control-api/dist/auth.js';
import { Worker, sshTransport, parseInspection } from '../apps/deploy-worker/dist/worker.js';
import { startAgent, callHub, loadIdentity } from '../apps/agent/dist/main.js';
import { canonical, digest, playbookDigest, claimJob, expireJobs, finishJob } from '@apk/platform';
import { provisionWorkerRole } from '../scripts/setup-worker-db.mjs';
import { sdkArchive } from '../scripts/release-agent.mjs';

const db = new PrismaClient(),
  dir = process.env.P1_TEST_DIR;
const pair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const parsedKey = utils.parseKey(pair.privateKey);
const password = 'ssh-test-' + randomBytes(10).toString('hex') + '{{ 2 + 2 }}';
const machine = { kvm: true, disk: 50 * 1024 ** 3, sudo: true, marker: false };
const sockets = new Set();
let authAttempts = 0,
  publicAuth = 0;
const ssh = new Server({ hostKeys: [pair.privateKey] }, (client) => {
  sockets.add(client);
  client.on('close', () => sockets.delete(client));
  client.on('error', () => {});
  client.on('authentication', (ctx) => {
    authAttempts++;
    if (ctx.method === 'password' && ctx.password === password) ctx.accept();
    else if (
      ctx.method === 'publickey' &&
      ctx.key.data.equals(parsedKey.getPublicSSH()) &&
      (!ctx.signature || parsedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)
    ) {
      publicAuth++;
      ctx.accept();
    } else ctx.reject();
  });
  client.on('ready', () =>
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (accept, reject, info) => {
        if (info.command !== 'sh -s') {
          reject();
          return;
        }
        const stream = accept();
        let input = '';
        stream.on('data', (b) => {
          input += b.toString();
        });
        stream.on('end', () => {
          assert.ok(input.includes('KVM'));
          assert.ok(!input.includes(password));
          stream.write(
            `UBUNTU=ubuntu:24.04\nARCH=x86_64\nMEMORY=32768000\nDISK=${machine.disk}\nKVM=${machine.kvm ? 1 : 0}\nSUDO=${machine.sudo ? 1 : 0}\nMARKER=${machine.marker ? 1 : 0}\n`,
          );
          stream.exit(0);
          stream.end();
        });
      });
    }),
  );
});
ssh.on('error', () => {});
let base,
  cookie,
  csrf,
  app,
  node,
  secretId,
  manifest,
  bootstrap,
  enrollmentBoot,
  agentAbort,
  agentRun,
  installCount = 0;
const report = {
  ubuntu: 'ubuntu:24.04',
  arch: 'x86_64',
  memoryKiB: 32768000,
  freeDiskBytes: 50 * 1024 ** 3,
  kvm: true,
  sudo: false,
  markerPresent: false,
  android: true,
  download: true,
  versions: { node: '24.18.0', appium: '3.9.0' },
  errors: [],
};
async function request(path, method = 'GET', body, headers = {}) {
  const response = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      cookie,
      ...(method !== 'GET'
        ? {
            origin: process.env.APP_ORIGIN,
            'content-type': 'application/json',
            'x-csrf-token': csrf,
          }
        : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: response.status === 204 ? null : await response.json() };
}
const idem = () => ({ 'Idempotency-Key': randomUUID() });
async function nodeRefresh() {
  node = (await request('/nodes/' + node.id)).data;
  return node;
}
async function job(kind, key = idem()) {
  const r = await request('/nodes/' + node.id + '/' + kind, 'POST', {}, key);
  assert.equal(r.status, 202);
  return r.data.operationId;
}
async function jobResult(id) {
  return (await request('/deployments/' + id)).data;
}
async function credential(type, secretValue) {
  const r = await request('/secrets/versions', 'POST', { type, secretValue });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.id;
}
async function replaceCredential(id) {
  await nodeRefresh();
  const input = {
    name: node.name,
    host: node.host,
    port: node.port,
    username: node.username,
    credentialVersionId: id,
    sudoCredentialVersionId: null,
  };
  const r = await request('/nodes/' + node.id, 'PATCH', input, {
    'If-Match': String(node.version),
  });
  assert.equal(r.status, 200);
  node = r.data;
}
async function makeRelease() {
  const packageDir = await mkdtemp(join(dir, 'artifact-'));
  await mkdir(join(packageDir, 'npm'));
  await writeFile(
    join(packageDir, 'agent.js'),
    '// fixture bytes; never installed by the simulated runner\n',
  );
  await writeFile(join(packageDir, 'boot-check.js'), '// fixture boot check\n');
  await writeFile(join(packageDir, 'npm/package.json'), '{}');
  await writeFile(join(packageDir, 'npm/package-lock.json'), '{}');
  const file = join(packageDir, 'archive.tgz');
  await tarCreate({ gzip: true, portable: true, cwd: packageDir, file }, [
    'agent.js',
    'boot-check.js',
    'npm/package.json',
    'npm/package-lock.json',
  ]);
  const bytes = await readFile(file),
    sha256 = digest(bytes),
    artifactName = 'agent-' + sha256 + '.tgz';
  await writeFile(join(process.env.RELEASE_DIR, artifactName), bytes);
  const body = {
    id: randomUUID(),
    gitCommit: 'a'.repeat(40),
    agentVersion: '0.2.0',
    protocolVersion: '1.0',
    artifactName,
    sha256,
    playbookSha256: await playbookDigest(resolve('deploy/ansible')),
    toolchain: {
      nodeVersion: '24.18.0',
      nodeUrl: 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz',
      nodeSha256: 'b'.repeat(64),
      playwrightVersion: '1.56.1',
      appiumVersion: '3.9.0',
      uiautomator2Version: '8.7.2',
      npmLockSha256: digest('{}'),
      systemImage: 'system-images;android-35;google_apis;x86_64',
      archives: ['cmdlineTools', 'emulator', 'platformTools', 'systemImage'].map((role) => ({
        role,
        url: `https://dl.google.com/android/repository/${role}.zip`,
        checksum: 'sha1:' + 'c'.repeat(40),
        revision: '1.0.0',
      })),
    },
  };
  return {
    ...body,
    signature: sign(
      null,
      Buffer.from(canonical(body)),
      await readFile(join(dir, 'release-private.key')),
    ).toString('base64'),
  };
}
const runner = {
  async install() {
    installCount++;
    machine.marker = true;
  },
  async activate(context, token) {
    bootstrap = token;
    machine.marker = false;
    agentAbort = new AbortController();
    agentRun = startAgent(
      {
        nodeId: node.id,
        releaseId: context.manifest.id,
        agentVersion: context.manifest.agentVersion,
        apiUrl: base,
        sdkRoot: '/fixture/sdk',
        toolsRoot: '/fixture/tools',
        bootstrapToken: token,
      },
      join(dir, 'agent-identity'),
      agentAbort.signal,
      async () => report,
    ).catch((e) => {
      if (!agentAbort.signal.aborted) throw e;
    });
    for (let i = 0; i < 60; i++) {
      const e = await db.enrollment.findUnique({ where: { deploymentId: context.deploymentId } });
      if (e?.consumedAt) {
        enrollmentBoot = e.bootId;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  },
};
test('P1 acceptance: real SSH transport and database; simulated remote OS and installer', async (t) => {
  await new Promise((r) => ssh.listen(0, '127.0.0.1', r));
  const admin = await db.admin.findFirst();
  await db.admin.update({
    where: { id: admin.id },
    data: { passwordHash: await passwordHash(process.env.P0_TEST_PASSWORD) },
  });
  await db.loginBucket.deleteMany();
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  process.env.CONTROL_PLANE_URL = base;
  const login = await fetch(base + '/api/v1/auth/login', {
    method: 'POST',
    headers: { origin: process.env.APP_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'p0admin', password: process.env.P0_TEST_PASSWORD }),
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
  csrf = (await login.json()).csrfToken;
  try {
    await t.test(
      'credentials are encrypted, never returned, and invalid key input is rejected',
      async () => {
        secretId = await credential('SSH_PASSWORD', { password });
        const stored = await db.secretVersion.findUnique({ where: { id: secretId } });
        assert.ok(!JSON.stringify(stored).includes(password));
        assert.ok(!JSON.stringify((await request('/secrets')).data).includes('encrypted'));
        assert.equal(
          (
            await request('/secrets/versions', 'POST', {
              type: 'SSH_KEY',
              secretValue: { privateKey: 'bad'.repeat(20) },
            })
          ).status,
          422,
        );
      },
    );
    await t.test(
      'node creation validates inputs, protects updates and requires explicit host trust',
      async () => {
        const input = {
          name: 'SSH fixture',
          host: '127.0.0.1',
          port: ssh.address().port,
          username: 'ubuntu',
          credentialVersionId: secretId,
        };
        assert.equal(
          (await request('/nodes', 'POST', { ...input, host: 'host;touch /tmp/no' })).status,
          422,
        );
        const created = await request('/nodes', 'POST', input);
        assert.equal(created.status, 201);
        node = created.data;
        assert.equal((await request('/nodes', 'POST', input)).status, 409);
        assert.equal(
          (await request('/nodes/' + node.id + '/checks', 'POST', {}, idem())).data.error.code,
          'HOST_KEY_REQUIRED',
        );
        assert.equal(
          (await request('/nodes/' + node.id, 'PATCH', input, { 'If-Match': '999' })).status,
          409,
        );
      },
    );
    await t.test(
      'fingerprint probe does not send credentials; trust must match fresh probe',
      async () => {
        const key = idem(),
          id = await job('fingerprint-probes', key);
        assert.equal(await job('fingerprint-probes', key), id);
        const worker = new Worker(db, runner);
        await worker.once();
        const result = await jobResult(id);
        assert.equal(result.status, 'SUCCEEDED');
        assert.equal(authAttempts, 0);
        assert.equal(
          (
            await request(
              '/nodes/' + node.id + '/host-key',
              'PUT',
              { probeId: id, expectedFingerprint: 'SHA256:' + 'a'.repeat(43) },
              { 'If-Match': String(node.version) },
            )
          ).status,
          409,
        );
        const trusted = await request(
          '/nodes/' + node.id + '/host-key',
          'PUT',
          { probeId: id, expectedFingerprint: result.result.fingerprint },
          { 'If-Match': String(node.version) },
        );
        assert.equal(trusted.status, 200);
        node = trusted.data;
      },
    );
    await t.test(
      'SSH checks distinguish wrong password, changed key, KVM and disk errors',
      async () => {
        const worker = new Worker(db, runner);
        let id = await job('checks');
        await worker.once();
        assert.equal((await jobResult(id)).status, 'SUCCEEDED');
        assert.ok(authAttempts > 0);
        const bad = await credential('SSH_PASSWORD', { password: 'incorrect' });
        await replaceCredential(bad);
        id = await job('checks');
        await worker.once();
        assert.equal((await jobResult(id)).errorCode, 'SSH_AUTH_FAILED');
        const keyId = await credential('SSH_KEY', { privateKey: pair.privateKey });
        await replaceCredential(keyId);
        id = await job('checks');
        await worker.once();
        assert.equal((await jobResult(id)).status, 'SUCCEEDED');
        assert.ok(publicAuth > 0);
        const saved = node.expectedFingerprint;
        await db.node.update({
          where: { id: node.id },
          data: { expectedFingerprint: 'SHA256:' + 'x'.repeat(43) },
        });
        id = await job('checks');
        await worker.once();
        assert.equal((await jobResult(id)).errorCode, 'HOST_KEY_MISMATCH');
        await db.node.update({ where: { id: node.id }, data: { expectedFingerprint: saved } });
        machine.kvm = false;
        id = await job('checks');
        await worker.once();
        assert.equal((await jobResult(id)).errorCode, 'NO_KVM');
        machine.kvm = true;
        machine.disk = 1;
        id = await job('checks');
        await worker.once();
        assert.equal((await jobResult(id)).errorCode, 'DISK_LOW');
        machine.disk = 50 * 1024 ** 3;
      },
    );
    await t.test('release registry verifies signature, artifact, lock and path', async () => {
      manifest = await makeRelease();
      assert.equal(
        (await request('/releases', 'POST', { ...manifest, signature: 'a'.repeat(86) + '==' }))
          .status,
        422,
      );
      assert.equal(
        (await request('/releases', 'POST', { ...manifest, artifactName: '../../agent.tgz' }))
          .status,
        422,
      );
      assert.equal((await request('/releases', 'POST', manifest)).status, 201);
      assert.equal((await request('/releases', 'POST', manifest)).status, 409);
    });
    await t.test(
      'deployment is idempotent and exclusive; Agent registers and heartbeats after simulated install',
      async () => {
        const input = { nodeId: node.id, releaseId: manifest.id, licenseAccepted: true },
          key = idem();
        const results = await Promise.all([
          request('/deployments', 'POST', input, key),
          request('/deployments', 'POST', input, key),
        ]);
        assert.equal(results[0].status, 202);
        assert.equal(results[0].data.operationId, results[1].data.operationId);
        assert.equal(
          (await request('/deployments', 'POST', input, idem())).data.error.code,
          'NODE_BUSY',
        );
        assert.equal(
          (await request('/deployments', 'POST', { ...input, releaseId: randomUUID() }, key)).data
            .error.code,
          'IDEMPOTENCY_CONFLICT',
        );
        assert.equal(
          (
            await request(
              '/nodes/' + node.id,
              'PATCH',
              {
                name: node.name,
                host: node.host,
                port: node.port,
                username: node.username,
                credentialVersionId: secretId,
              },
              { 'If-Match': String(node.version) },
            )
          ).data.error.code,
          'NODE_BUSY',
        );
        const worker = new Worker(db, runner),
          other = new Worker(db, runner);
        await Promise.all([worker.once(), other.once()]);
        const result = await jobResult(results[0].data.operationId);
        assert.equal(result.status, 'SUCCEEDED');
        assert.equal(installCount, 1);
        await nodeRefresh();
        assert.equal(node.connection, 'ONLINE');
        assert.equal(node.health.android, true);
        assert.equal(node.deploymentStatus, 'INSTALLED');
        const bytes = await readFile(join(dir, 'agent-identity/identity.enc'));
        const identity = await loadIdentity(join(dir, 'agent-identity'));
        assert.ok(!bytes.includes(Buffer.from(identity.credential)));
        assert.ok((await stat(join(dir, 'agent-identity/identity.key'))).size === 32);
      },
    );
    await t.test(
      'bootstrap retries recover same identity but other boots, nodes and roles are rejected',
      async () => {
        const body = {
          kind: 'enroll',
          protocolVersion: '1.0',
          nodeId: node.id,
          bootId: enrollmentBoot,
          agentVersion: manifest.agentVersion,
          releaseId: manifest.id,
        };
        const retry = await callHub(base, 'enroll', bootstrap, body);
        const identity = await loadIdentity(join(dir, 'agent-identity'));
        assert.equal(retry.credential, identity.credential);
        await assert.rejects(callHub(base, 'enroll', bootstrap, { ...body, bootId: randomUUID() }));
        const peer = (
          await request('/nodes', 'POST', {
            name: 'other',
            host: '127.0.0.2',
            port: 22,
            username: 'ubuntu',
            credentialVersionId: secretId,
          })
        ).data;
        const heartbeat = {
          kind: 'heartbeat',
          protocolVersion: '1.0',
          nodeId: peer.id,
          bootId: randomUUID(),
          releaseId: manifest.id,
          agentVersion: manifest.agentVersion,
          sentAt: new Date().toISOString(),
          capabilities: { download: true, android: true, kvm: true, freeDiskBytes: 100 },
          currentDelivery: null,
        };
        await assert.rejects(callHub(base, 'heartbeats', identity.credential, heartbeat));
        assert.equal((await request('/agent/heartbeats', 'POST', heartbeat)).status, 401);
        const cookieOnly = await fetch(base + '/api/v1/nodes', {
          headers: { authorization: 'Bearer ' + identity.credential },
        });
        assert.equal(cookieOnly.status, 401);
      },
    );
    await t.test(
      'healthy repeat deployment waits for a new heartbeat and preserves identity',
      async () => {
        const before = await db.agentCredential.findUnique({ where: { nodeId: node.id } });
        const created = await request(
          '/deployments',
          'POST',
          { nodeId: node.id, releaseId: manifest.id, licenseAccepted: true },
          idem(),
        );
        assert.equal(created.status, 202);
        await new Worker(db, runner).once();
        assert.equal((await jobResult(created.data.operationId)).status, 'SUCCEEDED');
        assert.equal(installCount, 1);
        assert.equal(
          (await db.agentCredential.findUnique({ where: { nodeId: node.id } })).tokenHash,
          before.tokenHash,
        );
      },
    );
    await t.test(
      'expired bootstrap cannot be replayed and revoked credentials cannot heartbeat',
      async () => {
        agentAbort.abort();
        await agentRun;
        await db.enrollment.updateMany({
          where: { nodeId: node.id },
          data: { expiresAt: new Date(0) },
        });
        await assert.rejects(
          callHub(base, 'enroll', bootstrap, {
            kind: 'enroll',
            protocolVersion: '1.0',
            nodeId: node.id,
            bootId: enrollmentBoot,
            agentVersion: manifest.agentVersion,
            releaseId: manifest.id,
          }),
        );
        const identity = await loadIdentity(join(dir, 'agent-identity'));
        await db.agentCredential.update({
          where: { nodeId: node.id },
          data: { revokedAt: new Date() },
        });
        await assert.rejects(
          callHub(base, 'heartbeats', identity.credential, {
            kind: 'heartbeat',
            protocolVersion: '1.0',
            nodeId: node.id,
            bootId: randomUUID(),
            agentVersion: manifest.agentVersion,
            releaseId: manifest.id,
            sentAt: new Date().toISOString(),
            capabilities: { download: false, android: false, kvm: false, freeDiskBytes: 0 },
            currentDelivery: null,
          }),
        );
        await db.node.update({ where: { id: node.id }, data: { lastSeenAt: new Date(0) } });
        assert.equal((await nodeRefresh()).connection, 'OFFLINE');
      },
    );
    await t.test(
      'running stop waits for acknowledgement and keeps uncertain installation quarantined',
      async () => {
        let started;
        const entered = new Promise((resolve) => {
          started = resolve;
        });
        const abort = new AbortController();
        const blocking = {
          install: async (_context, signal) => {
            machine.marker = true;
            started();
            await new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => reject(Error('stopped')), { once: true });
            });
          },
          activate: async () => assert.fail('cancelled install must not activate'),
        };
        const created = await request(
          '/deployments',
          'POST',
          { nodeId: node.id, releaseId: manifest.id, licenseAccepted: true },
          idem(),
        );
        assert.equal(created.status, 202);
        const running = new Worker(db, blocking).once(abort.signal);
        try {
          await Promise.race([
            entered,
            new Promise((_, reject) =>
              setTimeout(() => reject(Error('install did not start')), 5000),
            ),
          ]);
          const stopped = await request(
            '/deployments/' + created.data.operationId + '/stop',
            'POST',
            { reason: 'cancel fixture install' },
            idem(),
          );
          assert.equal(stopped.data.status, 'CANCEL_REQUESTED');
          assert.equal((await nodeRefresh()).occupancy, 'BUSY');
          await running;
          assert.equal((await jobResult(created.data.operationId)).status, 'NEEDS_REVIEW');
          assert.equal((await nodeRefresh()).occupancy, 'QUARANTINED');
        } finally {
          abort.abort();
          await running;
          machine.marker = false;
        }
        const check = await job('checks');
        await new Worker(db, runner).once();
        assert.equal(
          (
            await request(
              '/nodes/' + node.id + '/reconciliations',
              'POST',
              { checkId: check, reason: 'fixture install ended and marker removed' },
              idem(),
            )
          ).status,
          200,
        );
      },
    );
    await t.test(
      'queued stop releases slot, stale worker quarantines and old fence cannot overwrite',
      async () => {
        let id = await job('checks');
        assert.equal(
          (await request('/deployments/' + id + '/stop', 'POST', { reason: 'test stop' }, idem()))
            .status,
          202,
        );
        assert.equal((await jobResult(id)).status, 'CANCELLED');
        id = await job('checks');
        const claimed = await claimJob(db, randomUUID());
        assert.equal(claimed.id, id);
        await db.deployment.update({ where: { id }, data: { leaseExpiresAt: new Date(0) } });
        await expireJobs(db);
        assert.equal((await jobResult(id)).status, 'NEEDS_REVIEW');
        assert.equal((await nodeRefresh()).occupancy, 'QUARANTINED');
        await assert.rejects(finishJob(db, id, claimed.workerId, claimed.fence, 'SUCCEEDED', 'OK'));
        assert.equal(
          (
            await request(
              '/deployments',
              'POST',
              { nodeId: node.id, releaseId: manifest.id, licenseAccepted: true },
              idem(),
            )
          ).data.error.code,
          'NODE_QUARANTINED',
        );
        const check = await job('checks');
        await new Worker(db, runner).once();
        const reconciled = await request(
          '/nodes/' + node.id + '/reconciliations',
          'POST',
          { checkId: check, reason: 'operator checked no remote install marker' },
          idem(),
        );
        assert.equal(reconciled.status, 200);
        assert.equal((await nodeRefresh()).occupancy, 'IDLE');
      },
    );
    await t.test(
      'restricted Worker role can check nodes but cannot read admins or edit addresses',
      async () => {
        const role = 'apk_worker_' + randomBytes(6).toString('hex'),
          pw = randomBytes(24).toString('hex'),
          url = new URL(process.env.DATABASE_URL);
        await provisionWorkerRole(db, role, pw, url.searchParams.get('schema'));
        url.username = role;
        url.password = pw;
        const restricted = new PrismaClient({ datasources: { db: { url: url.href } } });
        try {
          await assert.rejects(restricted.admin.findMany());
          await assert.rejects(
            restricted.node.update({ where: { id: node.id }, data: { host: 'forbidden.example' } }),
          );
          const id = await job('checks');
          await new Worker(restricted, runner, sshTransport(restricted)).once();
          assert.equal((await jobResult(id)).status, 'SUCCEEDED');
        } finally {
          await restricted.$disconnect();
          await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
          await db.$executeRawUnsafe(`DROP ROLE "${role}"`);
        }
      },
    );
    await t.test(
      'deployment setup preserves keys and exports only Worker configuration',
      async () => {
        const setup = await mkdtemp(join(dir, 'setup-'));
        const script = resolve('scripts/setup-deployment.mjs');
        const run = () =>
          execFileSync(process.execPath, [script], {
            cwd: setup,
            env: {
              ...process.env,
              DATABASE_URL: 'postgresql://do-not-copy',
              SESSION_CSRF_KEY: 'do-not-copy',
            },
            stdio: 'pipe',
            windowsHide: true,
          });
        run();
        const keyDir = join(setup, 'data/keys');
        const first = await readFile(join(keyDir, 'master.key'));
        const publicKey = await readFile(join(keyDir, 'release-public.key'));
        await unlink(join(keyDir, 'release-public.key'));
        run();
        run();
        assert.deepEqual(await readFile(join(keyDir, 'master.key')), first);
        assert.deepEqual(await readFile(join(keyDir, 'release-public.key')), publicKey);
        const workerEnv = await readFile(join(keyDir, 'worker.env'), 'utf8');
        assert.ok(!workerEnv.includes('DATABASE_URL'));
        assert.ok(!workerEnv.includes('SESSION_CSRF_KEY'));
        assert.ok(!workerEnv.includes('RELEASE_PRIVATE_KEY_FILE'));
        assert.ok(!workerEnv.includes('do-not-copy'));
      },
    );
    await t.test(
      'result and logs do not contain credentials; SDK parser locks official archives',
      async () => {
        const output =
          JSON.stringify((await request('/deployments')).data) +
          JSON.stringify((await request('/audit-events')).data);
        assert.ok(!output.includes(password));
        assert.ok(!output.includes(pair.privateKey));
        assert.ok(!output.includes(bootstrap));
        const xml =
          '<sdk-repository><remotePackage path="emulator"><revision><major>36</major><minor>1</minor><micro>2</micro></revision><archives><archive><host-os>linux</host-os><complete><checksum type="sha1">' +
          'a'.repeat(40) +
          '</checksum><url>emulator-linux-1.zip</url></complete></archive></archives></remotePackage></sdk-repository>';
        assert.equal(
          sdkArchive(xml, 'emulator', 'emulator', 'https://dl.google.com/android/repository/')
            .revision,
          '36.1.2',
        );
        assert.throws(() => parseInspection('UBUNTU=x\nDISK=bad'));
      },
    );
    await db.deploymentEvent.deleteMany();
    await db.enrollment.deleteMany();
    await db.deployment.deleteMany();
    await db.agentCredential.deleteMany();
    await db.nodeSlot.deleteMany();
    await db.run.deleteMany();
    await db.node.deleteMany();
  } finally {
    agentAbort?.abort();
    await agentRun?.catch(() => {});
    for (const socket of sockets) socket.end();
    await new Promise((r) => ssh.close(r));
    await app.close();
    await db.$disconnect();
  }
});
