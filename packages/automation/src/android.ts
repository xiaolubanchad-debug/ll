import type { IdentityImage } from './identity-images.js';
import { isOwnedTestPackage, deviceVariant } from '@apk/contracts';
import type { ApkInstallFailureCode } from '@apk/contracts';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readdir, readFile, writeFile, stat, lstat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { AppiumClient } from './webdriver.js';
import { startProxyBridge, proxyObservation } from './proxy.js';
import { NetworkPolicy } from './network.js';
import { recognizeRegistrationScreenshot } from './ocr.js';
import { removeOwned } from './cache.js';
import { deviceProperties, waitForAndroidNetwork } from './android-preparation.js';
import {
  addAndroidExitReasons,
  androidLaunchMarker,
  processLogLimit,
  readAndroidProcessEvents,
} from './android-process.js';
import type { MeasureOpenStep } from './open-timings.js';
import type {
  Profile,
  ProxyCredential,
  AndroidRecord,
  AndroidSession,
} from './registration-types.js';
import { RegistrationError } from './registration-types.js';

export interface AndroidOptions {
  sdkRoot: string;
  identityImage?: IdentityImage;
  toolsRoot: string;
  root: string;
  proxy: ProxyCredential;
  policy?: NetworkPolicy;
  proxyCheckUrl?: string;
  ownedTestClient?: boolean;
  controlMode?: 'LAUNCH_ONLY' | 'DEVICE_SESSION';
  measure?: MeasureOpenStep;
  beforeAction: () => void;
  resources: (record: AndroidRecord | null) => Promise<void>;
}
// SettingsProvider uses Long.toHexString; leading zeroes are not guaranteed.
export function validShellAndroidId(value: string): boolean {
  return /^[a-f0-9]{1,16}$/i.test(value) && !/^0+$/.test(value);
}
export function isForegroundPackage(output: string, pkg: string): boolean {
  const top = output.split(/\r?\n/).filter((line) => /^\s*topResumedActivity[=:]/.test(line));
  const lines = top.length
    ? top
    : output.split(/\r?\n/).filter((line) => /^\s*mResumedActivity[=:]/.test(line));
  const packages = lines.map((line) => /\bu\d+\s+([A-Za-z][A-Za-z0-9_.]*)\//.exec(line)?.[1]);
  return packages.length > 0 && packages.every((p) => p === pkg);
}
export function focusedAndroidWindow(
  output: string,
  pkg: string,
): import('./registration-types.js').ForegroundWindow {
  const { kind } = androidForegroundSample(output, pkg);
  return kind === 'BROWSER' || kind === 'STORE' || kind === 'LAUNCHER' ? 'OTHER' : kind;
}
export function androidForegroundSample(
  output: string,
  pkg: string,
): import('./registration-types.js').ForegroundSample {
  const windows = [...output.matchAll(/^[ \t]*mCurrentFocus=([^\r\n]+)$/gm)];
  if (windows.length !== 1) return { kind: 'UNKNOWN' };
  const title = /^Window\{[\da-f]+ u\d+ ([^}]+)\}$/.exec(windows[0][1].trim())?.[1];
  if (!title) return { kind: 'UNKNOWN' };
  const packageField = (value: string | undefined) =>
    value &&
    value.length <= 255 &&
    /^(?:android|[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)$/.test(value)
      ? { packageName: value }
      : {};
  if (title === 'Application Error: ' + pkg) return { kind: 'CRASH', ...packageField(pkg) };
  if (title === 'Splash Screen ' + pkg || title === 'Starting ' + pkg)
    return { kind: 'SPLASH', ...packageField(pkg) };
  const owner = /^([A-Za-z][\w.]*)\/[\w.$]+$/.exec(title)?.[1];
  if (owner === pkg) {
    const focused = [
      ...output.matchAll(/^\s*mFocusedApp=ActivityRecord\{[^\r\n]*?\bu\d+ ([A-Za-z][\w.]*)\//gm),
    ];
    return {
      kind: focused.length === 1 && focused[0][1] === pkg ? 'TARGET' : 'UNKNOWN',
      ...packageField(owner),
    };
  }
  if (
    (owner &&
      /^(?:android|com\.android\.(?:systemui|permissioncontroller|packageinstaller|settings)|com\.google\.android\.(?:permissioncontroller|packageinstaller))$/.test(
        owner,
      )) ||
    /^(?:Application Error|Application Not Responding): |^(?:NotificationShade|StatusBar|Keyguard)$/.test(
      title,
    )
  )
    return { kind: 'SYSTEM', ...packageField(owner) };
  const kind = /^(?:com\.android\.chrome|com\.android\.browser)$/.test(owner ?? '')
    ? 'BROWSER'
    : owner === 'com.android.vending'
      ? 'STORE'
      : /^(?:com\.android\.launcher3|com\.google\.android\.apps\.nexuslauncher)$/.test(owner ?? '')
        ? 'LAUNCHER'
        : owner
          ? 'OTHER'
          : 'UNKNOWN';
  return { kind, ...packageField(owner) };
}
const installRejection =
  /^(?:adb: failed to install [^\r\n]+:[ \t]*)?Failure \[(INSTALL_(?:FAILED|PARSE_FAILED)_[A-Z0-9_]+)(?::[^\r\n]*)?\][ \t]*\r?$/m;
const installCategories: Readonly<Record<string, ApkInstallFailureCode>> = {
  INSTALL_FAILED_INVALID_APK: 'APK_INSTALL_INVALID',
  INSTALL_FAILED_BAD_SIGNATURE: 'APK_INSTALL_SIGNATURE_CONFLICT',
  INSTALL_PARSE_FAILED_NO_CERTIFICATES: 'APK_INSTALL_SIGNATURE_CONFLICT',
  INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES: 'APK_INSTALL_SIGNATURE_CONFLICT',
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'APK_INSTALL_SIGNATURE_CONFLICT',
  INSTALL_FAILED_SHARED_USER_INCOMPATIBLE: 'APK_INSTALL_SIGNATURE_CONFLICT',
  INSTALL_FAILED_MISSING_SPLIT: 'APK_INSTALL_SPLIT_REQUIRED',
  INSTALL_FAILED_NO_MATCHING_ABIS: 'APK_INSTALL_ABI_MISMATCH',
  INSTALL_FAILED_CPU_ABI_INCOMPATIBLE: 'APK_INSTALL_ABI_MISMATCH',
  INSTALL_FAILED_OLDER_SDK: 'APK_INSTALL_ANDROID_VERSION',
  INSTALL_FAILED_NEWER_SDK: 'APK_INSTALL_ANDROID_VERSION',
  INSTALL_FAILED_DEPRECATED_SDK_VERSION: 'APK_INSTALL_ANDROID_VERSION',
  INSTALL_FAILED_ALREADY_EXISTS: 'APK_INSTALL_ALREADY_PRESENT',
  INSTALL_FAILED_VERSION_DOWNGRADE: 'APK_INSTALL_VERSION_CONFLICT',
  INSTALL_FAILED_INSUFFICIENT_STORAGE: 'APK_INSTALL_NO_SPACE',
  INSTALL_FAILED_USER_RESTRICTED: 'APK_INSTALL_RESTRICTED',
  INSTALL_FAILED_VERIFICATION_FAILURE: 'APK_INSTALL_RESTRICTED',
};
export function isAndroidInstallRejection(output: string) {
  return installRejection.test(output);
}
export function androidInstallFailure(output: string): ApkInstallFailureCode {
  const reason = installRejection.exec(output)?.[1];
  if (reason)
    return (
      installCategories[reason] ??
      (reason.startsWith('INSTALL_PARSE_FAILED_') ? 'APK_INSTALL_INVALID' : 'APK_INSTALL_REJECTED')
    );
  if (
    /^(?:(?:adb|error):[ \t]*)*(?:device offline|device unauthorized|no devices\/emulators found|device '[^'\r\n]+' not found)[ \t]*\r?$/im.test(
      output,
    )
  )
    return 'APK_INSTALL_DEVICE_UNAVAILABLE';
  return 'APK_INSTALL_UNCONFIRMED';
}
export async function androidCommand(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  timeout: number,
  code: string,
  cwd?: string,
  outputLimit = 16384,
  input?: Buffer,
  onNonzeroExit?: (output: string) => string | void,
  timeoutCode = code,
) {
  return new Promise<string>((ok, no) => {
    const child = spawn(file, args, {
      env,
      cwd,
      stdio: ['pipe', 'pipe', onNonzeroExit ? 'pipe' : 'ignore'],
      windowsHide: true,
      shell: false,
    });
    let text = '',
      stderr = '',
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
      finish(new RegistrationError(timeoutCode));
    }, timeout);
    child.stdout?.on('data', (b: Buffer) => {
      if (text.length < outputLimit) text += b.toString().slice(0, outputLimit - text.length);
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < outputLimit) stderr += b.toString().slice(0, outputLimit - stderr.length);
    });
    child.on('error', () => finish(new RegistrationError(code)));
    child.on(onNonzeroExit ? 'close' : 'exit', (status: number | null) => {
      const reported =
        !settled && status !== null && status !== 0 && !signal?.aborted
          ? onNonzeroExit?.(text + '\n' + stderr)
          : undefined;
      finish(
        status === 0
          ? undefined
          : new RegistrationError(signal?.aborted ? 'CANCELLED' : (reported ?? code)),
      );
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(input ?? (file.endsWith('avdmanager') ? 'no\n' : ''));
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
const reservedEmulatorPorts = new Set<number>();
async function emulatorPort() {
  for (let p = 5554; p < 5584; p += 2) {
    if (reservedEmulatorPorts.has(p)) continue;
    reservedEmulatorPorts.add(p);
    try {
      await availablePort(p);
      await availablePort(p + 1);
      return p;
    } catch {
      reservedEmulatorPorts.delete(p);
    }
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
  const record: AndroidRecord = {
    workspace,
    avdName,
    appiumTmp: join(workspace, 'appium-tmp'),
  };
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
  const measure: MeasureOpenStep = options.measure ?? (async (_name, work) => work());
  const command = (
    file: string,
    args: string[],
    timeout = 10000,
    code = 'ANDROID_NOT_READY',
    interrupt = true,
  ) => androidCommand(file, args, env, interrupt ? signal : undefined, timeout, code, workspace);
  let closed = false,
    installUnconfirmed = false;
  let installedPackage: string | undefined;
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
      if (record.serial)
        reservedEmulatorPorts.delete(Number(record.serial.slice('emulator-'.length)));
      await options.resources(null);
    }
    return clean;
  };
  try {
    await options.resources(record);
    options.beforeAction();
    bridge = await startProxyBridge(
      options.proxy,
      options.policy,
      options.ownedTestClient ? 2500 : 10000,
    );
    const bootDevice = async (preparationSignal: AbortSignal) => {
      const prepareCommand = (
        file: string,
        args: string[],
        timeout = 10000,
        code = 'ANDROID_NOT_READY',
      ) => androidCommand(file, args, env, preparationSignal, timeout, code, workspace);
      options.beforeAction();
      await measure('AVD_CREATE', async () => {
        for (const path of [
          env.ANDROID_AVD_HOME,
          env.ANDROID_USER_HOME,
          env.ANDROID_EMULATOR_HOME,
          env.TMPDIR,
        ])
          await mkdir(path, { recursive: true, mode: 0o700 });
        await prepareCommand(
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
      });
      if (options.identityImage) {
        const ini = join(env.ANDROID_AVD_HOME, avdName + '.avd', 'config.ini');
        const text = await readFile(ini, 'utf8');
        if (!/^image\.sysdir\.1=.*$/m.test(text))
          throw new RegistrationError('IDENTITY_IMAGE_INVALID');
        await writeFile(
          ini,
          text.replace(
            /^image\.sysdir\.1=.*$/m,
            'image.sysdir.1=' + options.identityImage.systemDir + '/',
          ),
        );
      }
      const variant = deviceVariant(options.identityImage?.id ?? '');
      if (variant) {
        const ini = join(env.ANDROID_AVD_HOME, avdName + '.avd', 'config.ini');
        const baseIni = (await readFile(ini, 'utf8')).replace(
          /^hw\.lcd\.(width|height|density)=.*$/gm,
          '',
        );
        await writeFile(
          ini,
          baseIni +
            '\nhw.lcd.width=' +
            variant.width +
            '\nhw.lcd.height=' +
            variant.height +
            '\nhw.lcd.density=' +
            variant.density +
            '\n',
        );
      }
      await measure('EMULATOR_BOOT', async () => {
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
            ...(options.identityImage ? ['-writable-system'] : []),
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
            bridge!.url,
          ],
          {
            env,
            cwd: workspace,
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
            shell: false,
          },
        );
        children.push(emulator);
        emulator.on('error', () => {});
        record.emulatorPid = emulator.pid;
        await options.resources(record);
        const deadline = Date.now() + 180000;
        let boot = false;
        while (Date.now() < deadline) {
          options.beforeAction();
          if (preparationSignal.aborted) throw new RegistrationError('CANCELLED');
          if (!emulator.pid || emulator.exitCode !== null || emulator.signalCode !== null)
            throw new RegistrationError('ANDROID_NOT_READY');
          const value = await prepareCommand(
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
        await waitForAndroidNetwork(
          preparationSignal,
          () =>
            androidCommand(
              adb,
              ['-s', record.serial!, 'shell', 'dumpsys', 'connectivity'],
              env,
              preparationSignal,
              3000,
              'ANDROID_NOT_READY',
              workspace,
              262144,
            ),
          options.beforeAction,
        );
      });
      options.beforeAction();
    };
    const checkProxy = (s: AbortSignal) =>
      measure('PROXY_CHECK', () => proxyObservation(bridge!.port, s, options.proxyCheckUrl));
    const observed =
      options.controlMode !== undefined
        ? await (async () => {
            await bootDevice(signal);
            return undefined;
          })()
        : await (async () => {
            const observation = await checkProxy(signal);
            await bootDevice(signal);
            return observation;
          })();
    options.beforeAction();
    if (options.controlMode !== 'LAUNCH_ONLY') {
      await measure('APPIUM_PREPARE', async () => {
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
          {
            env,
            cwd: workspace,
            stdio: 'ignore',
            detached: true,
            windowsHide: true,
            shell: false,
          },
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
      });
    }
    const get = async (args: string[]) =>
      (await command(adb, ['-s', record.serial!, 'shell', ...args])).trim();
    const { api, model, androidId, locale, supportedAbis } = await measure(
      'DEVICE_CHECK',
      async () => {
        if (options.controlMode !== undefined) {
          const [text, androidId] = await Promise.all([
            androidCommand(
              adb,
              ['-s', record.serial!, 'shell', 'getprop'],
              env,
              signal,
              10000,
              'DEVICE_PROFILE_UNSUPPORTED',
              workspace,
              262144,
            ),
            get(['settings', 'get', 'secure', 'android_id']),
          ]);
          const values = { ...deviceProperties(text), androidId };
          if (
            !validShellAndroidId(androidId) ||
            !Number.isInteger(values.api) ||
            !values.model ||
            !values.supportedAbis.length ||
            values.locale !== profile.locale
          )
            throw new RegistrationError('DEVICE_PROFILE_UNSUPPORTED');
          return values;
        }
        const api = Number(await get(['getprop', 'ro.build.version.sdk'])),
          model = (await get(['getprop', 'ro.product.model'])).slice(0, 200),
          androidId = await get(['settings', 'get', 'secure', 'android_id']);
        const locale =
          (await get(['getprop', 'persist.sys.locale'])) ||
          (await get(['getprop', 'ro.product.locale']));
        const supportedAbis = (await get(['getprop', 'ro.product.cpu.abilist']))
          .split(',')
          .filter(Boolean);
        return { api, model, androidId, locale, supportedAbis };
      },
    );
    if (!validShellAndroidId(androidId) || !Number.isInteger(api) || locale !== profile.locale)
      throw new RegistrationError('DEVICE_PROFILE_UNSUPPORTED');
    if (
      options.identityImage &&
      (model !== options.identityImage.model ||
        (options.identityImage.apiLevel !== undefined && api !== options.identityImage.apiLevel))
    )
      throw new RegistrationError('IDENTITY_MODEL_MISMATCH');
    const rpc = () => {
      if (!client) throw new RegistrationError('ANDROID_CONTROL_DISABLED');
      return client;
    };
    return {
      supportedAbis,
      observation: {
        profileId: profile.id,
        ...(options.identityImage
          ? {
              variantId: options.identityImage.id,
              systemImageSha256: options.identityImage.sha256,
            }
          : {}),
        avdName,
        apiLevel: api,
        model,
        locale,
        shellAndroidIdHash: createHash('sha256').update(androidId).digest('hex'),
        androidIdScope: 'SHELL_NOT_APP',
        ...(observed ? { proxyObservedIp: observed.ip, proxyObservedAt: observed.at } : {}),
        proxyIpScope: observed ? 'PROBE_ONLY' : 'NOT_CHECKED',
        appUserAgent: 'UNVERIFIED',
        identitySource: 'EMULATOR_NOT_REAL_DEVICE',
      },
      async install(file, resolvePackage = false) {
        options.beforeAction();
        installedPackage = undefined;
        const packages = async () => {
          const listed = await command(
            adb,
            ['-s', record.serial!, 'shell', 'pm', 'list', 'packages', '-3'],
            10000,
            'APP_PACKAGE_UNCONFIRMED',
          );
          const names = listed
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .map(
              (line) =>
                /^package:([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)$/.exec(line)?.[1],
            );
          if (names.some((name) => name === undefined))
            throw new RegistrationError('APP_PACKAGE_UNCONFIRMED');
          return new Set(names.filter((name) => name !== undefined));
        };
        const previous =
          resolvePackage || options.controlMode === 'DEVICE_SESSION' ? await packages() : null;
        installUnconfirmed = true;
        let rejected = false;
        const value = await androidCommand(
          adb,
          ['-s', record.serial!, 'install', '--no-incremental', file],
          env,
          signal,
          120000,
          'APK_INSTALL_UNCONFIRMED',
          workspace,
          16384,
          undefined,
          (output) => {
            rejected = isAndroidInstallRejection(output);
            return androidInstallFailure(output);
          },
          'APK_INSTALL_TIMEOUT',
        ).catch(async (error: unknown) => {
          if (rejected && previous) {
            const current = await packages().catch(() => null);
            if (current?.size === previous.size && [...current].every((pkg) => previous.has(pkg)))
              installUnconfirmed = false;
          }
          throw error;
        });
        if (!/^Success[ \t]*\r?$/m.test(value) || isAndroidInstallRejection(value))
          throw new RegistrationError('APK_INSTALL_UNCONFIRMED');
        if (previous) {
          const added = [...(await packages())].filter((pkg) => !previous.has(pkg));
          if (added.length !== 1) throw new RegistrationError('APP_PACKAGE_UNCONFIRMED');
          installedPackage = added[0];
          installUnconfirmed = false;
          return installedPackage;
        }
        installUnconfirmed = false;
      },
      async finishApplication(pkg = installedPackage) {
        if (installUnconfirmed) return false;
        if (options.controlMode === 'DEVICE_SESSION') pkg = installedPackage;
        if (!pkg) {
          bridge?.resetConnections();
          return true;
        }
        if (!/^[A-Za-z][A-Za-z0-9_.]{1,255}$/.test(pkg))
          throw new RegistrationError('CLEANUP_INCOMPLETE');
        const initial = await command(
          adb,
          ['-s', record.serial!, 'shell', 'pm', 'list', 'packages', pkg],
          10000,
          'CLEANUP_INCOMPLETE',
          false,
        );
        if (!initial.split(/\r?\n/).some((line) => line.trim() === 'package:' + pkg)) {
          bridge?.resetConnections();
          return true;
        }
        await command(
          adb,
          ['-s', record.serial!, 'shell', 'am', 'force-stop', pkg],
          10000,
          'CLEANUP_INCOMPLETE',
          false,
        );
        const removed = await command(
          adb,
          ['-s', record.serial!, 'uninstall', pkg],
          30000,
          'CLEANUP_INCOMPLETE',
          false,
        );
        if (!/^Success\s*$/m.test(removed)) return false;
        const listed = await command(
          adb,
          ['-s', record.serial!, 'shell', 'pm', 'list', 'packages', pkg],
          10000,
          'CLEANUP_INCOMPLETE',
          false,
        );
        bridge?.resetConnections();
        return !listed.split(/\r?\n/).some((line) => line.trim() === 'package:' + pkg);
      },
      async testClientStatus(pkg = 'com.apkplatform.testclient') {
        if (!isOwnedTestPackage(pkg)) throw new RegistrationError('TEST_CLIENT_SCOPE');
        options.beforeAction();
        const value = await command(
          adb,
          ['-s', record.serial!, 'shell', 'run-as', pkg, 'cat', 'files/report-status'],
          2000,
          'TEST_CLIENT_STATUS_READ',
        ).catch(() => 'UNCONFIRMED');
        return /^(?:PREPARING|CONFIG_ERROR|NETWORK_(?:ERROR|TLS|TIMEOUT|CONNECT)|HTTP_[1-5][0-9]{2})$/.test(
          value.trim(),
        )
          ? value.trim()
          : 'UNCONFIRMED';
      },
      async provisionTestClient(bootstrap, pkg = 'com.apkplatform.testclient') {
        if (!isOwnedTestPackage(pkg)) throw new RegistrationError('TEST_CLIENT_SCOPE');
        options.beforeAction();
        await command(
          adb,
          ['-s', record.serial!, 'shell', 'run-as', pkg, 'mkdir', '-p', 'files'],
          10000,
          'TEST_BOOTSTRAP_FAILED',
        );
        await androidCommand(
          adb,
          [
            '-s',
            record.serial!,
            'shell',
            '-T',
            'run-as',
            pkg,
            'sh',
            '-c',
            "'cat > files/bootstrap.json'",
          ],
          env,
          signal,
          10000,
          'TEST_BOOTSTRAP_FAILED',
          workspace,
          16384,
          Buffer.from(JSON.stringify(bootstrap)),
        );
      },
      async launch(pkg, activity, onIssued) {
        options.beforeAction();
        const opening = options.controlMode !== undefined;
        const launchCommand = (args: string[], timeout: number, timeoutCode: string) =>
          androidCommand(
            adb,
            ['-s', record.serial!, 'shell', ...args],
            env,
            signal,
            timeout,
            opening ? 'APP_LAUNCH_COMMAND_FAILED' : 'APP_LAUNCH_FAILED',
            workspace,
            16384,
            undefined,
            opening
              ? (output) =>
                  /^\s*(?:Error:|Error type |Security exception:)/im.test(output)
                    ? 'APP_LAUNCH_REJECTED'
                    : undefined
              : undefined,
            opening ? timeoutCode : 'APP_LAUNCH_FAILED',
          );
        let component = pkg + '/' + activity;
        if (activity === '@launcher') {
          const resolved = await launchCommand(
            [
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
            'APP_LAUNCH_RESOLVE_TIMEOUT',
          );
          const found = resolved
            .split(/\r?\n/)
            .map((s) => s.trim())
            .find((s) => s.startsWith(pkg + '/') && /^[A-Za-z0-9_.$]+\/[A-Za-z0-9_.$]+$/.test(s));
          if (!found)
            throw new RegistrationError(
              opening ? 'APP_LAUNCH_ENTRY_UNRESOLVED' : 'APP_LAUNCH_FAILED',
            );
          component = found;
        }
        if (onIssued) {
          const marker = await command(
            adb,
            ['-s', record.serial!, 'shell', "pidof system_server; date '+%s.%N %z'"],
            1000,
            'APP_PROCESS_OBSERVATION_UNAVAILABLE',
          ).then(androidLaunchMarker, () => undefined);
          signal.throwIfAborted();
          options.beforeAction();
          onIssued(marker);
        }
        const value = await launchCommand(
          ['am', 'start', ...(opening ? [] : ['-W']), '-n', "'" + component + "'"],
          opening ? 3000 : 30000,
          'APP_LAUNCH_TIMEOUT',
        );
        if (opening && /^\s*Status: timeout\s*$/im.test(value))
          throw new RegistrationError('APP_LAUNCH_TIMEOUT');
        if (/Error:|Error type/.test(value))
          throw new RegistrationError(opening ? 'APP_LAUNCH_REJECTED' : 'APP_LAUNCH_FAILED');
        if (!(opening ? /^Starting: Intent /m.test(value) : /Status: ok/.test(value)))
          throw new RegistrationError(opening ? 'APP_LAUNCH_UNCONFIRMED' : 'APP_LAUNCH_FAILED');
      },
      async foreground(pkg) {
        bridge?.assertHealthy();
        options.beforeAction();
        const output = await command(
          adb,
          ['-s', record.serial!, 'shell', 'dumpsys', 'activity', 'activities'],
          3000,
          'APP_FOREGROUND_FAILED',
        );
        return isForegroundPackage(output, pkg);
      },
      async foregroundWindow(pkg, observationSignal) {
        bridge?.assertHealthy();
        options.beforeAction();
        const output = await androidCommand(
          adb,
          ['-s', record.serial!, 'shell', 'dumpsys', 'window', 'displays'],
          env,
          observationSignal,
          3000,
          'APP_FOREGROUND_FAILED',
          workspace,
          128 * 1024,
        );
        return androidForegroundSample(output, pkg);
      },
      async processEvents(pkg, marker, observationSignal) {
        options.beforeAction();
        const output = await androidCommand(
          adb,
          [
            '-s',
            record.serial!,
            'shell',
            'logcat',
            '-b',
            'events',
            '-v',
            'threadtime',
            '-v',
            'epoch',
            '-t',
            '2000',
            'am_proc_start:I',
            'am_proc_died:I',
            'am_crash:I',
            "'*:S'",
          ],
          env,
          observationSignal,
          2000,
          'APP_PROCESS_OBSERVATION_UNAVAILABLE',
          workspace,
          processLogLimit,
        );
        const process = readAndroidProcessEvents(output, pkg, marker);
        if (
          api < 30 ||
          !marker.utcOffset ||
          !process.events.some((event) => event.kind === 'EXITED') ||
          !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(pkg) ||
          observationSignal.aborted
        )
          return process;
        const exits = await androidCommand(
          adb,
          ['-s', record.serial!, 'shell', 'dumpsys', 'activity', 'exit-info', pkg],
          env,
          observationSignal,
          1500,
          'APP_PROCESS_OBSERVATION_UNAVAILABLE',
          workspace,
          processLogLimit,
        ).catch(() => '');
        return addAndroidExitReasons(exits, pkg, marker, process);
      },
      find: (l, t, s) => rpc().find(l, t, s),
      click: (id, t) => rpc().click(id, t),
      tap: (x, y, t) => rpc().tap(x, y, t),
      ocr: (bytes, s) => recognizeRegistrationScreenshot(bytes, options.toolsRoot, workspace, s),
      submit: (id, t) => rpc().submit(id, t),
      input: (id, value) => rpc().input(id, value),
      hideKeyboard: () => rpc().hideKeyboard(),
      back: (t, s) => rpc().back(t, s),
      rect: (id, s) => rpc().rect(id, s),
      attached: (id, s) => rpc().attached(id, s),
      screenshot: (s) => rpc().screenshot(s),
      source: (s) => rpc().source(s),
      close,
    };
  } catch (error) {
    const failure =
      error instanceof RegistrationError
        ? error
        : new RegistrationError(signal.aborted ? 'CANCELLED' : 'ANDROID_NOT_READY');
    console.error('ANDROID_PREPARATION_' + failure.code);
    const clean = await measure('CLEANUP', close);
    if (!clean) throw new RegistrationError('CLEANUP_INCOMPLETE');
    throw failure;
  }
}
