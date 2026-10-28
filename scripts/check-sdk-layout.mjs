import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  chown,
  chmod,
  readFile,
  writeFile,
  realpath,
  unlink,
  rm,
} from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';

if (process.platform !== 'linux' || process.getuid() !== 0)
  throw Error('ISOLATED_LINUX_ROOT_REQUIRED');
const ansible = process.argv[2];
if (!ansible) throw Error('ANSIBLE_REQUIRED');
const pin = JSON.parse(await readFile('tests/ubuntu/android-tools.json', 'utf8'));
const uid = Number(execFileSync('id', ['-u', 'apk-runner'], { encoding: 'utf8' }).trim());
const gid = Number(execFileSync('id', ['-g', 'apk-runner'], { encoding: 'utf8' }).trim());
const home = execFileSync('getent', ['passwd', 'apk-runner'], { encoding: 'utf8' }).split(':')[5];
const base = '/tmp/apk-sdk-layout-tests';
await mkdir(base, { recursive: true, mode: 0o755 });
const dir = await mkdtemp(join(base, 'sdk-'));
await chmod(dir, 0o755);
const sdk = join(dir, 'android'),
  avds = join(dir, 'avds');
const archives = [
  { role: 'cmdlineTools', revision: pin.revision },
  { role: 'emulator', revision: '37.3.5' },
];
const env = {
  ...process.env,
  HOME: home,
  JAVA_HOME: '/usr/lib/jvm/java-17-openjdk-amd64',
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  ANDROID_AVD_HOME: avds,
};
const create = (cli, name) =>
  spawnSync(
    cli,
    [
      'create',
      'avd',
      '--name',
      name,
      '--package',
      'system-images;android-35;google_apis;x86_64',
      '--device',
      'pixel_6',
    ],
    { uid, gid, env, input: 'no\n', encoding: 'utf8', timeout: 60000 },
  );
const layout = (items = archives) =>
  execFileSync(
    ansible,
    [
      '-i',
      'target,',
      '-c',
      'local',
      'deploy/ansible/install.yml',
      '--tags',
      'sdk_layout',
      '--extra-vars',
      JSON.stringify({ sdk_root: sdk, toolchain: { archives: items } }),
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: 60000 },
  );
try {
  const response = await fetch(pin.url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
  assert.ok(response.ok);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(createHash('sha1').update(bytes).digest('hex'), pin.sha1);
  const zip = join(dir, 'cmdline.zip');
  await writeFile(zip, bytes);
  await mkdir(join(sdk, 'cmdline-tools/archive'), { recursive: true });
  execFileSync('unzip', ['-q', zip, '-d', join(sdk, 'cmdline-tools/archive')]);
  await mkdir(avds);
  await chown(avds, uid, gid);
  await mkdir(join(sdk, 'emulator'));
  await mkdir(join(sdk, 'emulator/lib'));
  await writeFile(
    join(sdk, 'emulator/lib/hardware-properties.ini'),
    'name = hw.cpu.arch\ntype = string\ndefault = x86_64\nabstract = Fixture CPU\ndescription = Owned AVD creation fixture\n',
  );
  await writeFile(
    join(sdk, 'emulator/source.properties'),
    'Pkg.Revision=37.3.5\nPkg.Desc=Fixture emulator; never launched\n',
  );
  const image = join(sdk, 'system-images/android-35/google_apis/x86_64');
  await mkdir(image, { recursive: true });
  await writeFile(join(image, 'system.img'), 'fixture; never booted');
  await writeFile(join(image, 'userdata.img'), 'fixture; never booted');
  await writeFile(
    join(image, 'source.properties'),
    'Pkg.Desc=Owned fixture system image\nPkg.Revision=1\nAndroidVersion.ApiLevel=35\nSystemImage.Abi=x86_64\nSystemImage.TagId=google_apis\nSystemImage.TagDisplay=Google APIs\nAddon.VendorId=google\nAddon.VendorDisplay=Google Inc.\n',
  );
  await writeFile(
    join(image, 'package.xml'),
    '<?xml version="1.0"?><r:repository xmlns:r="http://schemas.android.com/repository/android/common/02" xmlns:s="http://schemas.android.com/sdk/android/repo/sys-img2/04" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><localPackage path="system-images;android-35;google_apis;x86_64" obsolete="false"><type-details xsi:type="s:sysImgDetailsType"><api-level>35</api-level><tag><id>google_apis</id><display>Google APIs</display></tag><vendor><id>google</id><display>Google Inc.</display></vendor><abi>x86_64</abi><abis>x86_64</abis></type-details><revision><major>1</major></revision><display-name>Owned fixture image; never booted</display-name></localPackage></r:repository>',
  );
  const wrong = create(
    join(sdk, 'cmdline-tools/archive/cmdline-tools/bin/avdmanager'),
    'wrong_layout',
  );
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.stdout + wrong.stderr, /Package path is not valid/);
  layout();
  const current = join(sdk, 'cmdline-tools/current');
  assert.equal(await realpath(current), join(sdk, 'cmdline-tools/19.0'));
  const valid = create(join(current, 'bin/avdmanager'), 'valid_layout');
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  layout();
  const metadata = join(sdk, 'emulator/package.xml');
  const original = await readFile(metadata, 'utf8');
  assert.throws(
    () =>
      layout([
        { role: 'cmdlineTools', revision: pin.revision },
        { role: 'emulator', revision: '37.3<&' },
      ]),
    (error) => {
      assert.match(error.stdout, /TOOLCHAIN_MISMATCH/);
      return true;
    },
  );
  assert.equal(await readFile(metadata, 'utf8'), original);
  await unlink(metadata);
  const missing = create(join(current, 'bin/avdmanager'), 'missing_emulator');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout + missing.stderr, /emulator.*package must be installed/);
  console.log(
    'PASS real Google AVD manager: canonical layout, local package metadata, repeat migration, invalid revision rejected. Fixture image was never booted.',
  );
} finally {
  if (resolve(dir).startsWith(base + sep)) await rm(dir, { recursive: true, force: true });
}
