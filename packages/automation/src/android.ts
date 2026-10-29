import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readdir, readFile, stat, lstat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AppiumClient } from './webdriver.js';
import { startProxyBridge, proxyObservation } from './proxy.js';
import { NetworkPolicy } from './network.js';
import { recognizeRegistrationScreenshot } from './ocr.js';
import { removeOwned } from './cache.js';
import type {
  Profile,
  ProxyCredential,
  AndroidRecord,
  AndroidSession,
} from './registration-types.js';
import { RegistrationError } from './registration-types.js';

export interface AndroidOptions {
  sdkRoot: string;
  toolsRoot: string;
  root: string;
  proxy: ProxyCredential;
  policy?: NetworkPolicy;
  proxyCheckUrl?: string;
  beforeAction: () => void;
  resources: (record: AndroidRecord | null) => Promise<void>;
}
// SettingsProvider uses Long.toHexString; leading zeroes are not guaranteed.
export function validShellAndroidId(value: string): boolean {
  return /^[a-f0-9]{1,16}$/i.test(value) && !/^0+$/.test(value);
}
export async function androidCommand(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  timeout: number,
  code: string,
  cwd?: string,
) {
  return new Promise<string>((ok, no) => {
    const child = spawn(file, args, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      shell: false,
    });
    let text = '',
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) no(error);
      else ok(text);
    };
    const abort = () => {
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new RegistrationError(code));
    }, timeout);
    child.stdout.on('data', (b: Buffer) => {
      if (text.length < 16384) text += b.toString();
    });
    child.on('error', () => finish(new RegistrationError(code)));
    child.on('exit', (status) =>
      finish(
        status === 0 ? undefined : new RegistrationError(signal?.aborted ? 'CANCELLED' : code),
      ),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(file.endsWith('avdmanager') ? 'no\n' : '');
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
async function availablePort(port = 0) {
  const s = createServer();
  await new Promise<void>((ok, no) => {
    s.once('error', no);
    s.listen(port, '127.0.0.1', ok);
  });
  const selected = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return selected;
}
async function emulatorPort() {
  for (let p = 5554; p < 5584; p += 2)
    try {
      await availablePort(p);
      await availablePort(p + 1);
      return p;
    } catch {
      /* Try another dedicated pair. */
    }
  throw new RegistrationError('ANDROID_NOT_READY');
}
async function matchingProcesses(record: AndroidRecord) {
  const found: number[] = [];
  const inspect = async (entry: string, attempt = 0): Promise<boolean> => {
    try {
      if ((await stat('/proc/' + entry)).uid !== process.getuid?.()) return false;
      const status = await readFile('/proc/' + entry + '/stat', 'utf8');
      if (/^[ZX] /.test(status.slice(status.lastIndexOf(')') + 2))) return false;
      const args = (await readFile('/proc/' + entry + '/cmdline', 'utf8')).split('\0');
      if (/(?:^|\/)adb$/.test(args[0]) && (args.includes('fork-server') || args.includes('server')))
        return false;
      const emulator = args.includes('-avd') && args[args.indexOf('-avd') + 1] === record.avdName;
      const tmpFlag = args.includes('--tmp') ? '--tmp' : '--tmp-dir';
      const appium = args.includes(tmpFlag) && args[args.indexOf(tmpFlag) + 1] === record.appiumTmp;
      const adb =
        record.serial &&
        args.includes('-s') &&
        args[args.indexOf('-s') + 1] === record.serial &&
        /(?:^|\/)adb$/.test(args[0]);
      const workspaceArgument = args.some(
        (a) =>
          a.startsWith(record.workspace + '/') ||
          a.startsWith('--database=' + record.workspace + '/') ||
          a.startsWith('--metrics-dir=' + record.workspace + '/'),
      );
      if (emulator || appium || adb || workspaceArgument) return true;
      const environment = (await readFile('/proc/' + entry + '/environ', 'utf8')).split('\0');
      return environment.includes('ANDROID_AVD_HOME=' + join(record.workspace, 'avds'));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (['ENOENT', 'ESRCH'].includes(code ?? '')) return false;
      // Linux may deny environ during exit before /proc disappears. Reinspect its
      // state; persistent denial still prevents a cleanup receipt.
      if (code === 'EACCES' && attempt < 5) {
        await new Promise((r) => setTimeout(r, 20));
        return inspect(entry, attempt + 1);
      }
      console.error('ANDROID_PROC_READ_DENIED_' + entry);
      throw error;
    }
  };
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    if (await inspect(entry)) found.push(Number(entry));
  }
  return found;
}
export async function cleanupAndroid(base: string, record: AndroidRecord) {
  if (
    process.platform !== 'linux' ||
    !resolve(record.workspace).startsWith(resolve(base) + sep) ||
    !/^p3_[a-f0-9]{32}$/.test(record.avdName) ||
    record.appiumTmp !== join(record.workspace, 'appium-tmp')
  )
    return false;
  try {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      for (const pid of await matchingProcesses(record)) {
        // Recheck ownership and complete markers immediately before signalling.
        if (!(await matchingProcesses(record)).includes(pid)) continue;
        try {
          process.kill(pid, signal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      for (let i = 0; i < 30; i++) {
        if (!(await matchingProcesses(record)).length) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if ((await matchingProcesses(record)).length) return false;
    const info = await lstat(record.workspace).catch(() => null);
    if (info?.isSymbolicLink()) return false;
    if (info) await removeOwned(base, record.workspace);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      'ANDROID_CLEANUP_' +
        (['EACCES', 'EPERM', 'ENOTEMPTY', 'ESRCH', 'ENOENT'].includes(code ?? '')
          ? code
          : 'FAILED'),
    );
    return false;
  }
}
export async function startAndroid(
  profile: Profile,
  signal: AbortSignal,
  options: AndroidOptions,
): Promise<AndroidSession> {
  if (process.platform !== 'linux') throw new RegistrationError('ANDROID_NOT_READY');
  const base = join(options.root, 'jobs');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const workspace = await mkdtemp(join(base, 'android-')),
    avdName = 'p3_' + randomUUID().replaceAll('-', '');
  const record: AndroidRecord = { workspace, avdName, appiumTmp: join(workspace, 'appium-tmp') };
  let bridge: Awaited<ReturnType<typeof startProxyBridge>> | undefined,
    client: AppiumClient | undefined;
  const children: ChildProcess[] = [];
  const env = {
    ...process.env,
    ANDROID_HOME: options.sdkRoot,
    ANDROID_SDK_ROOT: options.sdkRoot,
    ANDROID_AVD_HOME: join(workspace, 'avds'),
    ANDROID_USER_HOME: join(workspace, 'android-home'),
    ANDROID_EMULATOR_HOME: join(workspace, 'emulator-home'),
    TMPDIR: join(workspace, 'tmp'),
    APPIUM_HOME: join(options.toolsRoot, 'appium-home'),
    JAVA_HOME: '/usr/lib/jvm/java-17-openjdk-amd64',
    PATH: join(resolve(process.execPath, '../..'), 'bin') + ':/usr/bin:/bin',
  };
  const adb = join(options.sdkRoot, 'platform-tools/adb');
  const command = (
    file: string,
    args: string[],
    timeout = 10000,
    code = 'ANDROID_NOT_READY',
    interrupt = true,
  ) => androidCommand(file, args, env, interrupt ? signal : undefined, timeout, code, workspace);
  let closed = false;
  const close = async () => {
    if (closed) return true;
    await client?.close();
    if (record.serial && record.systemPort)
      await command(
        adb,
        ['-s', record.serial, 'forward', '--remove', 'tcp:' + record.systemPort],
        3000,
        'CLEANUP_INCOMPLETE',
        false,
      ).catch(() => {});
    await bridge?.close();
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
    const clean = await cleanupAndroid(base, record);
    if (clean) {
      closed = true;
      await options.resources(null);
    }
    return clean;
  };
  try {
    await options.resources(record);
    options.beforeAction();
    bridge = await startProxyBridge(options.proxy, options.policy);
    const observed = await proxyObservation(bridge.port, signal, options.proxyCheckUrl);
    options.beforeAction();
    for (const path of [
      env.ANDROID_AVD_HOME,
      env.ANDROID_USER_HOME,
      env.ANDROID_EMULATOR_HOME,
      env.TMPDIR,
    ])
      await mkdir(path, { recursive: true, mode: 0o700 });
    await command(
      join(options.sdkRoot, 'cmdline-tools/current/bin/avdmanager'),
      [
        'create',
        'avd',
        '--name',
        avdName,
        '--package',
        profile.systemImage,
        '--device',
        profile.avdDevice,
      ],
      60000,
      'DEVICE_PROFILE_UNSUPPORTED',
    );
    const port = await emulatorPort();
    record.serial = 'emulator-' + port;
    await options.resources(record);
    options.beforeAction();
    const emulator = spawn(
      join(options.sdkRoot, 'emulator/emulator'),
      [
        '-avd',
        avdName,
        '-port',
        String(port),
        '-no-window',
        '-no-audio',
        '-no-snapshot',
        '-no-boot-anim',
        '-gpu',
        'software',
        '-cores',
        '2',
        '-memory',
        '2048',
        '-http-proxy',
        bridge.url,
      ],
      { env, cwd: workspace, stdio: 'ignore', detached: true, windowsHide: true, shell: false },
    );
    children.push(emulator);
    emulator.on('error', () => {});
    record.emulatorPid = emulator.pid;
    await options.resources(record);
    const deadline = Date.now() + 180000;
    let boot = false;
    while (Date.now() < deadline) {
      options.beforeAction();
      if (emulator.exitCode !== null) throw new RegistrationError('ANDROID_NOT_READY');
      const value = await command(
        adb,
        ['-s', record.serial, 'shell', 'getprop', 'sys.boot_completed'],
        3000,
      ).catch(() => '');
      if (value.trim() === '1') {
        boot = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!boot) throw new RegistrationError('ANDROID_NOT_READY');
    options.beforeAction();
    const appiumPort = await availablePort();
    record.systemPort = await availablePort();
    await options.resources(record);
    await mkdir(record.appiumTmp, { recursive: true, mode: 0o700 });
    const appium = spawn(
      process.execPath,
      [
        join(options.toolsRoot, 'node_modules/appium/build/lib/main.js'),
        '--address',
        '127.0.0.1',
        '--port',
        String(appiumPort),
        '--base-path',
        '/',
        '--tmp',
        record.appiumTmp,
        '--log-level',
        'error',
        '--log-no-colors',
      ],
      { env, cwd: workspace, stdio: 'ignore', detached: true, windowsHide: true, shell: false },
    );
    children.push(appium);
    appium.on('error', () => {});
    record.appiumPid = appium.pid;
    await options.resources(record);
    client = new AppiumClient(appiumPort, signal);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      options.beforeAction();
      if (appium.exitCode !== null) throw new RegistrationError('APPIUM_FAILED');
      try {
        await client.command('GET', '/status', undefined, 1000);
        ready = true;
        break;
      } catch {
        /* Wait for this job's server only. */
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) throw new RegistrationError('APPIUM_FAILED');
    await client.start({
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': record.serial,
      'appium:systemPort': record.systemPort,
      'appium:noReset': true,
      'appium:autoLaunch': false,
      'appium:skipLogcatCapture': true,
      'appium:printPageSourceOnFindFailure': false,
      'appium:clearSystemFiles': true,
      'appium:newCommandTimeout': 120,
      'appium:language': profile.locale.split('-')[0],
      'appium:locale': profile.locale.split('-')[1],
    });
    await client.command('POST', client.path('/timeouts'), { implicit: 0 });
    await client.command('POST', client.path('/appium/settings'), {
      settings: {
        waitForIdleTimeout: 0,
        waitForSelectorTimeout: 1000,
        snapshotMaxDepth: 25,
        ignoreUnimportantViews: true,
        simpleBoundsCalculation: true,
      },
    });
    const get = async (args: string[]) =>
      (await command(adb, ['-s', record.serial!, 'shell', ...args])).trim();
    const api = Number(await get(['getprop', 'ro.build.version.sdk'])),
      model = (await get(['getprop', 'ro.product.model'])).slice(0, 200),
      androidId = await get(['settings', 'get', 'secure', 'android_id']);
    const locale =
      (await get(['getprop', 'persist.sys.locale'])) ||
      (await get(['getprop', 'ro.product.locale']));
    const supportedAbis = (await get(['getprop', 'ro.product.cpu.abilist']))
      .split(',')
      .filter(Boolean);
    if (!validShellAndroidId(androidId) || !Number.isInteger(api) || locale !== profile.locale)
      throw new RegistrationError('DEVICE_PROFILE_UNSUPPORTED');
    const rpc = client;
    return {
      supportedAbis,
      observation: {
        profileId: profile.id,
        avdName,
        apiLevel: api,
        model,
        locale,
        shellAndroidIdHash: createHash('sha256').update(androidId).digest('hex'),
        androidIdScope: 'SHELL_NOT_APP',
        proxyObservedIp: observed.ip,
        proxyObservedAt: observed.at,
        proxyIpScope: 'PROBE_ONLY',
        appUserAgent: 'UNVERIFIED',
        identitySource: 'EMULATOR_NOT_REAL_DEVICE',
      },
      async install(file) {
        options.beforeAction();
        const value = await command(
          adb,
          ['-s', record.serial!, 'install', '--no-incremental', file],
          120000,
          'APK_INSTALL_FAILED',
        );
        if (!/^Success\s*$/m.test(value)) throw new RegistrationError('APK_INSTALL_FAILED');
      },
      async launch(pkg, activity) {
        options.beforeAction();
        let component = pkg + '/' + activity;
        if (activity === '@launcher') {
          const resolved = await command(
            adb,
            [
              '-s',
              record.serial!,
              'shell',
              'cmd',
              'package',
              'resolve-activity',
              '--brief',
              '-a',
              'android.intent.action.MAIN',
              '-c',
              'android.intent.category.LAUNCHER',
              '-p',
              pkg,
            ],
            10000,
            'APP_LAUNCH_FAILED',
          );
          const found = resolved
            .split(/\r?\n/)
            .map((s) => s.trim())
            .find((s) => s.startsWith(pkg + '/') && /^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(s));
          if (!found) throw new RegistrationError('APP_LAUNCH_FAILED');
          component = found;
        }
        const value = await command(
          adb,
          ['-s', record.serial!, 'shell', 'am', 'start', '-W', '-n', "'" + component + "'"],
          30000,
          'APP_LAUNCH_FAILED',
        );
        if (!/Status: ok/.test(value) || /Error:|Error type/.test(value))
          throw new RegistrationError('APP_LAUNCH_FAILED');
      },
      find: (l, t, s) => rpc.find(l, t, s),
      click: (id, t) => rpc.click(id, t),
      tap: (x, y, t) => rpc.tap(x, y, t),
      ocr: (bytes, s) => recognizeRegistrationScreenshot(bytes, options.toolsRoot, workspace, s),
      submit: (id, t) => rpc.submit(id, t),
      input: (id, value) => rpc.input(id, value),
      hideKeyboard: () => rpc.hideKeyboard(),
      back: () => rpc.back(),
      rect: (id) => rpc.rect(id),
      screenshot: (s) => rpc.screenshot(s),
      source: (s) => rpc.source(s),
      close,
    };
  } catch (error) {
    const failure =
      error instanceof RegistrationError
        ? error
        : new RegistrationError(signal.aborted ? 'CANCELLED' : 'ANDROID_NOT_READY');
    console.error('ANDROID_PREPARATION_' + failure.code);
    const clean = await close();
    if (!clean) throw new RegistrationError('CLEANUP_INCOMPLETE');
    throw failure;
  }
}
