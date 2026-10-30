import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { execute } from './health.js';
import type { IdentityImage } from '@apk/automation';
export async function bootCheck(
  sdk: string,
  base = '/var/lib/apk-platform/health-check',
  image?: IdentityImage,
) {
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'check-'));
  const name = 'p1_' + randomUUID().replaceAll('-', '');
  const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: dir };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    if ((await execute(join(sdk, 'emulator/emulator'), ['-accel-check'], 30000, env)).code)
      throw Error('NO_KVM');
    const create = await execute(
      join(sdk, 'cmdline-tools/current/bin/avdmanager'),
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
      90000,
      env,
      'no\n',
    );
    if (create.code) throw Error('ANDROID_NOT_READY');
    if (image) {
      const ini = join(dir, name + '.avd', 'config.ini');
      await writeFile(
        ini,
        (await readFile(ini, 'utf8')).replace(
          /^image\.sysdir\.1=.*$/m,
          'image.sysdir.1=' + image.systemDir + '/',
        ),
      );
    }
    let port = 0;
    for (let p = 5554; p < 5584; p += 2) {
      const sockets: ReturnType<typeof createServer>[] = [];
      try {
        for (const n of [p, p + 1])
          await new Promise<void>((ok, no) => {
            const server = createServer();
            sockets.push(server);
            server.once('error', no);
            server.listen(n, '127.0.0.1', ok);
          });
        port = p;
        break;
      } catch {
        /* try another isolated emulator port */
      } finally {
        for (const s of sockets) s.close();
      }
    }
    if (!port) throw Error('ANDROID_NOT_READY');
    child = spawn(
      join(sdk, 'emulator/emulator'),
      [
        '-avd',
        name,
        '-port',
        String(port),
        '-no-window',
        ...(image ? ['-writable-system'] : []),
        '-no-audio',
        '-no-snapshot',
        '-no-boot-anim',
        '-gpu',
        'software',
      ],
      { env, stdio: 'ignore', windowsHide: true },
    );
    child.on('error', () => {});
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error('ANDROID_NOT_READY');
      const result = await execute(
        join(sdk, 'platform-tools/adb'),
        ['-s', `emulator-${port}`, 'shell', 'getprop', 'sys.boot_completed'],
        5000,
        env,
      );
      if (!result.code && result.text.trim() === '1') {
        if (image) {
          const actual = await execute(
            join(sdk, 'platform-tools/adb'),
            ['-s', `emulator-${port}`, 'shell', 'getprop', 'ro.product.model'],
            5000,
            env,
          );
          if (actual.code || actual.text.trim() !== image.model)
            throw Error('IDENTITY_MODEL_MISMATCH');
        }
        return true;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw Error('ANDROID_NOT_READY');
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((r) => child!.once('exit', () => r()));
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 5000))]);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
    const target = resolve(dir),
      prefix = resolve(base) + sep;
    if (target.startsWith(prefix)) await rm(target, { recursive: true, force: true });
  }
}
