import { mkdir, readFile, writeFile, copyFile, readdir, chmod } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkArchive } from '../../scripts/release-agent.mjs';
if (process.platform !== 'linux') throw Error('Linux build with JDK, unzip and zip required');
process.umask(0o077);
const source = dirname(fileURLToPath(import.meta.url)),
  out = resolve(process.argv[2] ?? '.tmp/p3-android-fixture');
await mkdir(out, { recursive: true });
const response = await fetch('https://dl.google.com/android/repository/repository2-1.xml', {
  redirect: 'error',
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw Error('OFFICIAL_METADATA_UNAVAILABLE');
const xml = await response.text();
const records = [];
for (const [path, role] of [
  ['build-tools;35.0.0', 'buildTools'],
  ['platforms;android-35', 'platform'],
]) {
  const record = sdkArchive(xml, path, role, 'https://dl.google.com/android/repository/');
  records.push(record);
  const archive = join(out, role + '.zip');
  let good = false;
  try {
    good =
      createHash('sha1')
        .update(await readFile(archive))
        .digest('hex') === record.checksum.slice(5);
  } catch {
    /* Download this exact official archive. */
  }
  if (!good) {
    const r = await fetch(record.url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
    if (!r.ok || !r.body) throw Error('SDK_DOWNLOAD_FAILED');
    await pipeline(r.body, createWriteStream(archive, { mode: 0o600 }));
  }
  const hash = createHash('sha1');
  for await (const bytes of createReadStream(archive)) hash.update(bytes);
  if ('sha1:' + hash.digest('hex') !== record.checksum) throw Error('SDK_CHECKSUM_FAILED');
  const folder = join(out, role);
  await mkdir(folder, { recursive: true });
  execFileSync('unzip', ['-qo', archive, '-d', folder], { stdio: 'ignore' });
}
const firstFolder = async (path) =>
  join(path, (await readdir(path, { withFileTypes: true })).find((e) => e.isDirectory()).name);
const tools = await firstFolder(join(out, 'buildTools')),
  platform = await firstFolder(join(out, 'platform')),
  android = join(platform, 'android.jar');
for (const binary of ['aapt2', 'd8', 'zipalign', 'apksigner'])
  await chmod(join(tools, binary), 0o700);
let secret;
const passwordFile = join(out, 'signing-password');
try {
  secret = await readFile(passwordFile, 'utf8');
} catch {
  secret = randomBytes(24).toString('hex');
  await writeFile(passwordFile, secret, { flag: 'wx', mode: 0o600 });
}
const env = { ...process.env, P3_SIGN_PASSWORD: secret };
const run = (file, args, cwd) =>
  execFileSync(file, args, { cwd, env, stdio: 'ignore', shell: false });
const key = join(out, 'fixture-signing.jks');
try {
  await readFile(key);
} catch {
  run('keytool', [
    '-genkeypair',
    '-keystore',
    key,
    '-storepass:env',
    'P3_SIGN_PASSWORD',
    '-keypass:env',
    'P3_SIGN_PASSWORD',
    '-alias',
    'fixture',
    '-dname',
    'CN=Owned Automation Fixture',
    '-keyalg',
    'RSA',
    '-keysize',
    '2048',
    '-validity',
    '2',
  ]);
}
// The signing password is ephemeral; the whole test directory is recreated for a new build.
const built = [];
for (const variant of [
  'alpha',
  'beta',
  'gamma',
  'delta',
  'epsilon',
  'zeta',
  'eta',
  'theta',
  'iota',
]) {
  const pkg = 'com.example.p3' + variant,
    work = join(out, variant);
  await mkdir(join(work, 'res/values'), { recursive: true });
  await mkdir(join(work, 'classes'), { recursive: true });
  await mkdir(join(work, 'dex'), { recursive: true });
  await mkdir(join(work, 'generated'), { recursive: true });
  await writeFile(
    join(work, 'res/values/ids.xml'),
    '<resources>' +
      [
        'open_register',
        'username',
        'password',
        'next',
        'submit',
        'account_home',
        'rejected',
        'pending',
        'my',
        'login',
        'login_submit',
        'login_username',
        'login_password',
        'skip_ad',
        'notice_ack',
        'ad_panel',
        'graphic_target',
        'retry_load',
        'modal_barrier',
        'modal_panel',
      ]
        .map((id) => '<item type="id" name="' + id + '"/>')
        .join('') +
      '</resources>',
  );
  await writeFile(
    join(work, 'AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="' +
      pkg +
      '" android:versionCode="1" android:versionName="1.0"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35"/><uses-permission android:name="android.permission.INTERNET"/><application android:label="Owned P3 ' +
      variant +
      '" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:usesCleartextTraffic="true" android:allowBackup="false"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>',
  );
  await writeFile(
    join(work, 'MainActivity.java'),
    (await readFile(join(source, 'MainActivity.java'), 'utf8'))
      .replace('FIXTURE_PACKAGE', pkg)
      .replaceAll('FIXTURE_BETA', variant === 'beta' ? 'true' : 'false')
      .replaceAll('FIXTURE_GAMMA', variant === 'gamma' ? 'true' : 'false')
      .replaceAll('FIXTURE_DELTA', variant === 'delta' ? 'true' : 'false')
      .replaceAll('FIXTURE_EPSILON', variant === 'epsilon' ? 'true' : 'false')
      .replaceAll('FIXTURE_ZETA', variant === 'zeta' ? 'true' : 'false')
      .replaceAll('FIXTURE_ETA', variant === 'eta' ? 'true' : 'false')
      .replaceAll('FIXTURE_THETA', variant === 'theta' ? 'true' : 'false')
      .replaceAll('FIXTURE_IOTA', variant === 'iota' ? 'true' : 'false'),
  );
  run(
    join(tools, 'aapt2'),
    ['compile', '--dir', join(work, 'res'), '-o', join(work, 'compiled.zip')],
    work,
  );
  run(
    join(tools, 'aapt2'),
    [
      'link',
      '-o',
      join(work, 'unsigned.apk'),
      '-I',
      android,
      '--manifest',
      join(work, 'AndroidManifest.xml'),
      '--java',
      join(work, 'generated'),
      join(work, 'compiled.zip'),
    ],
    work,
  );
  run(
    'javac',
    [
      '--release',
      '8',
      '-classpath',
      android,
      '-d',
      join(work, 'classes'),
      join(work, 'MainActivity.java'),
      join(work, 'generated', ...pkg.split('.'), 'R.java'),
    ],
    work,
  );
  const classes = [];
  async function walk(path) {
    for (const e of await readdir(path, { withFileTypes: true })) {
      const file = join(path, e.name);
      if (e.isDirectory()) await walk(file);
      else if (e.name.endsWith('.class')) classes.push(file);
    }
  }
  await walk(join(work, 'classes'));
  run(
    join(tools, 'd8'),
    ['--lib', android, '--min-api', '26', '--output', join(work, 'dex'), ...classes],
    work,
  );
  await copyFile(join(work, 'dex/classes.dex'), join(work, 'classes.dex'));
  run('zip', ['-q', join(work, 'unsigned.apk'), 'classes.dex'], work);
  run(
    join(tools, 'zipalign'),
    ['-f', '4', join(work, 'unsigned.apk'), join(work, 'aligned.apk')],
    work,
  );
  const file = join(out, variant + '.apk');
  run(
    join(tools, 'apksigner'),
    [
      'sign',
      '--ks',
      key,
      '--ks-key-alias',
      'fixture',
      '--ks-pass',
      'env:P3_SIGN_PASSWORD',
      '--key-pass',
      'env:P3_SIGN_PASSWORD',
      '--out',
      file,
      join(work, 'aligned.apk'),
    ],
    work,
  );
  run(join(tools, 'apksigner'), ['verify', file], work);
  built.push({
    packageName: pkg,
    file: variant + '.apk',
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  });
}
await writeFile(
  join(out, 'build-evidence.json'),
  JSON.stringify({ archives: records, packages: built }, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify({ ownedFixturePackages: built }));
