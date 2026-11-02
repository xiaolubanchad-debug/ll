import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { releasePlan } from './release-plan.mjs';
import { validateHubConfig, moduleOverrides } from './hub-release-config.mjs';

// This is a root-operated host CLI. Containers never receive the Docker socket.
if (
  process.platform !== 'linux' ||
  process.getuid?.() !== 0 ||
  !process.versions.node.startsWith('24.')
)
  throw Error('LINUX_NODE24_ROOT_REQUIRED');
const [base, receiptFile] = process.argv.slice(2);
const source = resolve(new URL('../', import.meta.url).pathname),
  ops = resolve(source, '../ops');
if (source !== '/opt/apk-hub/source') throw Error('HOST_LAYOUT_INVALID');
const plan = releasePlan(base, 'HEAD', source),
  sha = plan.to.slice(0, 12);
if (execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim())
  throw Error('SOURCE_DIRTY');
const receipt = JSON.parse(await readFile(resolve(receiptFile), 'utf8'));
const planSha256 = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
if (
  !receipt.passed ||
  receipt.to !== plan.to ||
  receipt.from !== plan.from ||
  receipt.planSha256 !== planSha256 ||
  !Array.isArray(receipt.checks) ||
  receipt.checks.length < 4
)
  throw Error('VERIFICATION_REQUIRED');
const lock = join(ops, 'module-release.lock.d'),
  journal = join(ops, 'module-release.json');
const previousJournal = JSON.parse(await readFile(journal, 'utf8').catch(() => 'null'));
if (previousJournal && !['SUCCEEDED', 'ROLLED_BACK'].includes(previousJournal.status))
  throw Error('PREVIOUS_RELEASE_NEEDS_REVIEW');
await mkdir(lock, { mode: 0o700 });
let guard,
  locked = false,
  switched = false,
  migrationStarted = false;
let override, previousOverride, snapshot;
const state = {
  version: 1,
  status: 'IN_PROGRESS',
  from: plan.from,
  to: plan.to,
  modules: plan.modules,
  startedAt: new Date().toISOString(),
  verified: receipt,
};
const saveState = async () => {
  await writeFile(journal + '.pending', JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  await rename(journal + '.pending', journal);
};
const command = (exe, args) =>
  new Promise((yes, no) => {
    const child = spawn(exe, args, { cwd: ops, stdio: 'inherit', windowsHide: true });
    child.on('error', no);
    child.on('exit', (code) => (code === 0 ? yes() : no(Error('HOST_COMMAND_FAILED'))));
  });
const output = (args) =>
  execFileSync('docker', ['compose', ...args], { cwd: ops, encoding: 'utf8' });
const compose = (args) => command('docker', ['compose', ...args]);
const running = plan.modules.filter((x) => ['api', 'worker', 'web'].includes(x));
const selected = plan.modules.filter((x) => x !== 'agent');
try {
  await saveState();
  const config = validateHubConfig(
    JSON.parse(output(['--profile', 'maintenance', 'config', '--format', 'json'])),
  );
  const guardArgs = [
    'compose',
    'run',
    '--rm',
    '-T',
    '--no-deps',
    '-v',
    source + '/scripts/hub-release-lock.mjs:/app/scripts/hub-release-lock.mjs:ro',
    'tools',
    'node',
    'scripts/hub-release-lock.mjs',
  ];
  guard = spawn('docker', guardArgs, { cwd: ops, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((yes, no) => {
    let text = '';
    const timer = setTimeout(() => no(Error('RELEASE_LOCK_TIMEOUT')), 30000);
    guard.stdout.on('data', (b) => {
      text += b.toString();
      if (text.includes('RELEASE_LOCK_READY')) {
        clearTimeout(timer);
        yes();
      }
    });
    guard.on('error', no);
    guard.on('exit', () => {
      clearTimeout(timer);
      no(Error('RELEASE_LOCK_LOST'));
    });
  });
  locked = true;
  guard.on('exit', () => {
    locked = false;
  });
  snapshot = join(ops, 'module-releases', plan.to + '-' + Date.now());
  await mkdir(snapshot, { recursive: true, mode: 0o700 });
  previousOverride = await readFile(join(ops, 'compose.override.yml'), 'utf8').catch(() => null);
  await writeFile(join(snapshot, 'compose.yml'), await readFile(join(ops, 'compose.yml')), {
    mode: 0o600,
  });
  if (previousOverride)
    await writeFile(join(snapshot, 'compose.override.yml'), previousOverride, { mode: 0o600 });
  const before = JSON.parse(
    output(['ps', '--format', 'json'])
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((x) => x.trim())
      .join(',')
      .replace(/^/, '[')
      .replace(/$/, ']'),
  );
  state.before = before.map((x) => ({ service: x.Service, id: x.ID, image: x.Image }));
  await saveState();
  override = previousOverride ? JSON.parse(previousOverride) : { services: {} };
  // Freeze previous live image tags for rollback, including first adoption from the shared runtime image.
  const rollback = { services: {} };
  for (const service of ['api', 'worker', 'web', 'tools'])
    rollback.services[service] = { image: config.services[service].image };
  await writeFile(join(snapshot, 'rollback.json'), JSON.stringify(rollback), { mode: 0o600 });
  override = moduleOverrides(config, selected, sha, source, override);
  const pending = join(ops, 'compose.pending.json');
  await writeFile(pending, JSON.stringify(override, null, 2), { mode: 0o600 });
  const withPending = ['-f', 'compose.yml', '-f', 'compose.pending.json'];
  if (selected.length) await compose([...withPending, 'build', ...selected]);
  if (!locked) throw Error('RELEASE_LOCK_LOST');
  await command('systemctl', ['start', 'apk-hub-backup.service']);
  if (plan.migrate) {
    migrationStarted = true;
    await compose([
      ...withPending,
      'run',
      '--rm',
      '--no-deps',
      'tools',
      'npm',
      'run',
      'db:migrate',
    ]);
  }
  if (!locked) throw Error('RELEASE_LOCK_LOST');
  if (running.length) {
    switched = true;
    await compose([
      ...withPending,
      'up',
      '-d',
      '--no-deps',
      '--no-build',
      '--wait',
      '--wait-timeout',
      '120',
      ...running,
    ]);
  }
  await compose([
    ...withPending,
    'exec',
    '-T',
    'api',
    'node',
    '-e',
    "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
  ]);
  if (running.includes('api') || running.includes('web')) {
    await compose([...withPending, 'exec', '-T', 'web', 'nginx', '-t']);
    await compose([...withPending, 'exec', '-T', 'web', 'nginx', '-s', 'reload']);
  }
  if (!locked) throw Error('RELEASE_LOCK_LOST');
  await rename(pending, join(ops, 'compose.override.yml'));
  state.status = 'SUCCEEDED';
  state.finishedAt = new Date().toISOString();
  await saveState();
  console.log(
    JSON.stringify({
      status: state.status,
      modules: selected,
      restarted: running,
      seconds: Math.round((Date.now() - Date.parse(state.startedAt)) / 1000),
    }),
  );
} catch (error) {
  state.status = 'NEEDS_REVIEW';
  if (!switched && !migrationStarted) state.status = 'ROLLED_BACK';
  else if (locked && !migrationStarted) {
    try {
      if (switched)
        await compose([
          '-f',
          'compose.yml',
          '-f',
          join(snapshot, 'rollback.json'),
          'up',
          '-d',
          '--no-deps',
          '--no-build',
          '--wait',
          ...running,
        ]);
      state.status = 'ROLLED_BACK';
    } catch {
      /* Preserve uncertain state for explicit review. */
    }
  }
  state.error =
    error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : 'HUB_RELEASE_FAILED';
  await saveState();
  throw Error(state.error, { cause: error });
} finally {
  if (guard && locked) {
    guard.stdin.end('RELEASE\n');
    await new Promise((r) => guard.once('exit', r));
  } else guard?.kill();
  await rm(lock, { recursive: true, force: true });
}
