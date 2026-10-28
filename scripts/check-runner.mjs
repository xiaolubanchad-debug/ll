import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm, readdir, chmod, chown } from 'node:fs/promises';
import { join, resolve, sep, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { createServer, connect } from 'node:net';
import ssh2 from 'ssh2';
import { AnsibleRunner } from '../apps/deploy-worker/dist/runner.js';
import { hostKeyLine, fingerprint, playbookDigest, digest } from '@apk/platform';
if (process.platform !== 'linux' || process.getuid() !== 0)
  throw Error('ISOLATED_LINUX_ROOT_REQUIRED');
if (process.argv[2])
  process.env.PATH = dirname(resolve(process.argv[2])) + delimiter + process.env.PATH;
const base = resolve(tmpdir());
const dir = await mkdtemp(join(base, 'apk-runner-ssh-'));
await chmod(dir, 0o755);
const user = 'apk_fixture_' + randomBytes(4).toString('hex');
const pair = (passphrase) =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: 'pkcs1',
      format: 'pem',
      ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}),
    },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
const host = pair(),
  hostKey = ssh2.utils.parseKey(host.privateKey),
  plain = pair(),
  passphrase = 'Fixture literal passphrase',
  encrypted = pair(passphrase),
  wrong = pair();
const call = (name, args, options = {}) => execFileSync(name, args, { stdio: 'pipe', ...options });
let daemon,
  userCreated = false,
  daemonLog = '';
try {
  const home = join(dir, 'home');
  await mkdir(home, { mode: 0o700 });
  call('/usr/sbin/useradd', ['--no-create-home', '--home-dir', home, '--shell', '/bin/sh', user]);
  userCreated = true;
  call('/usr/sbin/chpasswd', [], { input: user + ':' + randomBytes(24).toString('hex') + '\n' });
  const uid = Number(call('/usr/bin/id', ['-u', user]).toString().trim()),
    gid = Number(call('/usr/bin/id', ['-g', user]).toString().trim());
  await chown(home, uid, gid);
  const sshDir = join(home, '.ssh');
  await mkdir(sshDir, { mode: 0o700 });
  await chown(sshDir, uid, gid);
  await writeFile(
    join(sshDir, 'authorized_keys'),
    [ssh2.utils.parseKey(plain.privateKey), ssh2.utils.parseKey(encrypted.privateKey, passphrase)]
      .map((k) => hostKeyLine(k.getPublicSSH()))
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  await chown(join(sshDir, 'authorized_keys'), uid, gid);
  await writeFile(join(dir, 'host_key'), host.privateKey, { mode: 0o600 });
  await mkdir('/run/sshd', { recursive: true, mode: 0o755 });
  const port = await new Promise((ok, no) => {
    const s = createServer();
    s.on('error', no);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => ok(p));
    });
  });
  const conf = join(dir, 'sshd_config');
  await writeFile(
    conf,
    `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${join(dir, 'host_key')}\nPidFile ${join(dir, 'sshd.pid')}\nAuthorizedKeysFile ${join(sshDir, 'authorized_keys')}\nStrictModes yes\nAllowUsers ${user}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nPermitRootLogin no\nLogLevel ERROR\n`,
  );
  call('/usr/sbin/sshd', ['-t', '-f', conf]);
  daemon = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', conf], {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  daemon.stderr.on('data', (b) => {
    daemonLog = (daemonLog + b).slice(-4000);
  });
  let ready = false;
  for (let i = 0; i < 50 && !ready; i++) {
    if (daemon.exitCode !== null) throw Error('SSH_FIXTURE_START_FAILED');
    ready = await new Promise((ok) => {
      const s = connect({ host: '127.0.0.1', port });
      s.on('connect', () => {
        s.destroy();
        ok(true);
      });
      s.on('error', () => ok(false));
    });
    if (!ready) await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.ok(ready, 'SSH fixture ready');
  const books = join(dir, 'books'),
    releaseDir = join(dir, 'releases'),
    jobs = join(dir, 'jobs');
  await mkdir(books);
  await mkdir(releaseDir);
  await mkdir(jobs);
  const book =
    '- hosts: target\n  gather_facts: false\n  vars:\n    ansible_become: false\n  tasks:\n    - name: Owned SSH fixture connection\n      ansible.builtin.raw: printf APK_RUNNER_TRANSPORT_OK\n      changed_when: false\n';
  await writeFile(join(books, 'install.yml'), book);
  await writeFile(join(books, 'activate.yml'), book);
  const bytes = Buffer.from('owned-runner-fixture-not-a-release'),
    sha = digest(bytes),
    artifactName = 'agent-' + sha + '.tgz';
  await writeFile(join(releaseDir, artifactName), bytes);
  process.env.RELEASE_DIR = releaseDir;
  process.env.DEPLOY_TEMP_DIR = jobs;
  const runner = new AnsibleRunner(books, process.argv[2] ?? 'ansible-runner');
  const context = {
    node: {
      id: randomUUID(),
      host: '127.0.0.1',
      port,
      username: user,
      hostKey: hostKeyLine(hostKey.getPublicSSH()),
      expectedFingerprint: fingerprint(hostKey.getPublicSSH()),
    },
    manifest: {
      id: randomUUID(),
      agentVersion: '0.3.1',
      artifactName,
      sha256: sha,
      playbookSha256: await playbookDigest(books),
      toolchain: { nodeVersion: '24.18.0' },
    },
    deploymentId: randomUUID(),
    apiUrl: 'https://hub.example.test',
    ssh: { privateKey: plain.privateKey },
  };
  for (const ssh of [
    { privateKey: plain.privateKey },
    { privateKey: encrypted.privateKey, passphrase },
  ]) {
    console.log('Checking ' + (ssh.passphrase ? 'encrypted' : 'plain') + ' fixture key');
    await runner.install({ ...context, ssh }, AbortSignal.timeout(20000));
    assert.deepEqual(await readdir(jobs), []);
  }
  await assert.rejects(
    runner.install(
      { ...context, ssh: { privateKey: wrong.privateKey } },
      AbortSignal.timeout(20000),
    ),
    (e) => e.code === 'SSH_AUTH_FAILED',
  );
  await assert.rejects(
    runner.install(
      {
        ...context,
        node: {
          ...context.node,
          hostKey: hostKeyLine(ssh2.utils.parseKey(wrong.privateKey).getPublicSSH()),
        },
      },
      AbortSignal.timeout(20000),
    ),
    (e) => e.code === 'HOST_KEY_MISMATCH',
  );
  assert.deepEqual(await readdir(jobs), []);
  console.log(
    'PASS real Ansible Runner/OpenSSH server/client: plain/encrypted keys selected, wrong key/host denied, private workspaces cleaned.',
  );
} catch (error) {
  console.error(daemonLog);
  throw error;
} finally {
  if (daemon?.pid && daemon.exitCode === null) {
    try {
      process.kill(-daemon.pid, 'SIGTERM');
    } catch {
      /* Already closed. */
    }
    if (daemon.exitCode === null) await new Promise((ok) => daemon.once('exit', ok));
  }
  if (userCreated && /^apk_fixture_[a-f0-9]{8}$/.test(user)) call('/usr/sbin/userdel', [user]);
  const target = resolve(dir);
  if (target.startsWith(base + sep) && target.slice(base.length + 1).startsWith('apk-runner-ssh-'))
    await rm(target, { recursive: true, force: true });
}
