import { mkdir, readFile, writeFile, copyFile, readdir, chmod } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
if (process.platform !== 'linux') throw Error('LINUX_ANDROID_BUILD_REQUIRED');
process.umask(0o077);
const source = dirname(fileURLToPath(import.meta.url)),
  out = resolve(process.argv[2]),
  cache = resolve(process.argv[3]);
await mkdir(out, { recursive: true, mode: 0o700 });
const first = async (path) =>
  join(path, (await readdir(path, { withFileTypes: true })).find((x) => x.isDirectory()).name);
const tools = await first(join(cache, 'buildTools')),
  platform = await first(join(cache, 'platform')),
  android = join(platform, 'android.jar');
for (const name of ['aapt2', 'd8', 'zipalign', 'apksigner']) await chmod(join(tools, name), 0o700);
const pw = join(out, 'signing-password'),
  key = join(out, 'test-client.jks');
let password;
try {
  password = await readFile(pw, 'utf8');
} catch {
  password = randomBytes(32).toString('base64url');
  await writeFile(pw, password, { mode: 0o600, flag: 'wx' });
}
const env = { ...process.env, TEST_APK_SIGN_PASSWORD: password };
const run = (file, args, cwd = out) =>
  execFileSync(file, args, { cwd, env, shell: false, stdio: 'ignore' });
try {
  await readFile(key);
} catch {
  run('keytool', [
    '-genkeypair',
    '-keystore',
    key,
    '-storepass:env',
    'TEST_APK_SIGN_PASSWORD',
    '-keypass:env',
    'TEST_APK_SIGN_PASSWORD',
    '-alias',
    'test-client',
    '-dname',
    'CN=APK Platform Owned Test Client',
    '-keyalg',
    'RSA',
    '-keysize',
    '2048',
    '-validity',
    '3650',
  ]);
}
const suite = [];
for (const appNumber of [0, ...Array.from({ length: 10 }, (_, i) => i + 1)]) {
  const pkg = 'com.apkplatform.testclient' + (appNumber ? '.app' + appNumber : '');
  const work = join(out, 'work-' + appNumber);
  for (const p of ['res/values', 'classes', 'dex', 'generated'])
    await mkdir(join(work, p), { recursive: true });
  await writeFile(
    join(work, 'res/values/strings.xml'),
    '<resources><string name="app_name">测试 APP ' + appNumber + '</string></resources>',
  );
  await writeFile(
    join(work, 'AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="' +
      pkg +
      '" android:versionCode="3" android:versionName="1.1.0"><uses-sdk android:minSdkVersion="26" android:targetSdkVersion="35"/><uses-permission android:name="android.permission.INTERNET"/><application android:label="@string/app_name" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:allowBackup="false" android:debuggable="true" android:usesCleartextTraffic="false"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>',
  );
  await writeFile(
    join(work, 'MainActivity.java'),
    (await readFile(join(source, 'MainActivity.java'), 'utf8')).replace(
      'package com.apkplatform.testclient;',
      'package ' + pkg + ';',
    ),
  );
  run(join(tools, 'aapt2'), [
    'compile',
    '--dir',
    join(work, 'res'),
    '-o',
    join(work, 'compiled.zip'),
  ]);
  run(join(tools, 'aapt2'), [
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
  ]);
  run('javac', [
    '--release',
    '8',
    '-classpath',
    android,
    '-d',
    join(work, 'classes'),
    join(work, 'MainActivity.java'),
  ]);
  const classes = [];
  async function walk(p) {
    for (const e of await readdir(p, { withFileTypes: true })) {
      const f = join(p, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.name.endsWith('.class')) classes.push(f);
    }
  }
  await walk(join(work, 'classes'));
  run(join(tools, 'd8'), [
    '--lib',
    android,
    '--min-api',
    '26',
    '--output',
    join(work, 'dex'),
    ...classes,
  ]);
  await copyFile(join(work, 'dex/classes.dex'), join(work, 'classes.dex'));
  run('zip', ['-q', join(work, 'unsigned.apk'), 'classes.dex'], work);
  run(join(tools, 'zipalign'), ['-f', '4', join(work, 'unsigned.apk'), join(work, 'aligned.apk')]);
  const file = join(out, appNumber ? appNumber + '.apk' : 'test-client.apk');
  run(join(tools, 'apksigner'), [
    'sign',
    '--ks',
    key,
    '--ks-key-alias',
    'test-client',
    '--ks-pass',
    'env:TEST_APK_SIGN_PASSWORD',
    '--key-pass',
    'env:TEST_APK_SIGN_PASSWORD',
    '--out',
    file,
    join(work, 'aligned.apk'),
  ]);
  run(join(tools, 'apksigner'), ['verify', file]);
  const sha256 = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
  await copyFile(file, join(out, sha256 + '.apk'));
  if (appNumber)
    suite.push({
      number: appNumber,
      packageName: pkg,
      sha256,
      version: '1.1.0',
      filename: appNumber + '.apk',
    });
  else
    await writeFile(
      join(out, 'current.json'),
      JSON.stringify({ sha256, version: '1.1.0', packageName: pkg }) + '\n',
      { mode: 0o644 },
    );
  console.log(JSON.stringify({ built: true, sha256, packageName: pkg }));
}
await writeFile(join(out, 'suite.json'), JSON.stringify({ version: 1, apps: suite }) + '\n', {
  mode: 0o644,
});
