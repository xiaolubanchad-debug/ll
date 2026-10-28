import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, chown, readFile, realpath, symlink, stat, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';

if (process.platform !== 'linux' || process.getuid() !== 0)
  throw Error('ISOLATED_LINUX_ROOT_REQUIRED');
const [ansible, tools] = process.argv.slice(2);
if (!ansible || !tools) throw Error('ANSIBLE_AND_FROZEN_TOOLS_REQUIRED');
const toolsRoot = resolve(tools);
const uid = Number(execFileSync('id', ['-u', 'apk-runner'], { encoding: 'utf8' }).trim());
const gid = Number(execFileSync('id', ['-g', 'apk-runner'], { encoding: 'utf8' }).trim());
assert.ok(uid > 0 && gid > 0);
const base = '/tmp/apk-appium-tests';
await mkdir(base, { recursive: true, mode: 0o755 });
const dir = await mkdtemp(join(base, 'appium-permissions-'));
await chown(dir, uid, gid);
await chown(toolsRoot, uid, gid);
const runtime = join(dir, 'runtime');
await mkdir(runtime);
await symlink('/usr/local', join(runtime, 'node'));
const cli = join(toolsRoot, 'node_modules/appium/build/lib/main.js');
const driver = join(toolsRoot, 'node_modules/appium-uiautomator2-driver');
const version = JSON.parse(await readFile(join(driver, 'package.json'), 'utf8')).version;
assert.equal(version, '8.7.2');
const home = execFileSync('getent', ['passwd', 'apk-runner'], { encoding: 'utf8' }).split(':')[5];
try {
  const originalRuntime = await stat('/usr/local/lib/node_modules');
  assert.equal(originalRuntime.uid, 0);
  assert.equal(originalRuntime.mode & 0o022, 0);
  const denied = spawnSync(process.execPath, [cli, 'driver', 'install', '--source=local', driver], {
    uid,
    gid,
    env: {
      ...process.env,
      HOME: home,
      APPIUM_HOME: join(dir, 'denied-home'),
      npm_config_prefix: '/usr/local',
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stdout + denied.stderr, /EACCES/);
  execFileSync(
    ansible,
    [
      '-i',
      'target,',
      '-c',
      'local',
      'deploy/ansible/install.yml',
      '--tags',
      'appium_driver',
      '--extra-vars',
      JSON.stringify({ tools_root: toolsRoot, runtime_root: runtime }),
    ],
    { stdio: 'pipe', encoding: 'utf8', timeout: 120000 },
  );
  const listed = execFileSync(process.execPath, [cli, 'driver', 'list', '--installed', '--json'], {
    uid,
    gid,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, HOME: home, APPIUM_HOME: join(toolsRoot, 'appium-home') },
  });
  const info = JSON.parse(listed);
  assert.equal(info.uiautomator2.version, version);
  assert.equal(
    await realpath(join(toolsRoot, 'npm-global/lib/node_modules/appium-uiautomator2-driver')),
    await realpath(driver),
  );
  assert.equal((await stat('/usr/local/lib/node_modules')).uid, originalRuntime.uid);
  assert.equal((await stat('/usr/local/lib/node_modules')).mode, originalRuntime.mode);
  console.log(
    'PASS real Appium: unprivileged local driver registration, isolated npm prefix, protected runtime rejects default global link.',
  );
} finally {
  if (resolve(dir).startsWith(base + sep)) await rm(dir, { recursive: true, force: true });
}
