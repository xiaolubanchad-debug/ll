import { readFile, access, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { arch, totalmem } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { executionOSSupported } from '@apk/contracts';
import { identityManifest, phoneManifest } from '@apk/automation';
export interface AgentHealth {
  ubuntu: string;
  arch: string;
  memoryKiB: number;
  freeDiskBytes: number;
  kvm: boolean;
  sudo: boolean;
  markerPresent: boolean;
  android: boolean;
  download: boolean;
  versions: Record<string, string>;
  errors: string[];
}
export async function execute(
  file: string,
  args: string[],
  timeout = 10000,
  env: NodeJS.ProcessEnv = process.env,
  input?: string,
): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    let text = '';
    let done = false;
    const child = spawn(file, args, {
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, text });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(124);
    }, timeout);
    child.stdout.on('data', (b: Buffer) => {
      if (text.length < 16000) text += b.toString('utf8');
    });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(127));
    child.on('exit', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}
const exists = (file: string, mode = constants.F_OK) =>
  access(file, mode).then(
    () => true,
    () => false,
  );
export async function collectHealth(
  sdkRoot: string,
  toolsRoot: string,
  releaseId: string,
): Promise<AgentHealth> {
  const os = await readFile('/etc/os-release', 'utf8').catch(() => '');
  const id = os.match(/^ID=["']?([^\s"']+)/m)?.[1] ?? 'unknown';
  const version = os.match(/^VERSION_ID=["']?([^\s"']+)/m)?.[1] ?? 'unknown';
  const space = await statfs('/var/lib/apk-platform').catch(() => null);
  const freeDiskBytes = space ? space.bavail * space.bsize : 0;
  const kvm = await exists('/dev/kvm', constants.R_OK | constants.W_OK);
  const markerPresent = await exists('/var/lib/apk-platform/install.lock');
  const versions: Record<string, string> = {
    node: process.versions.node,
    systemImage: 'system-images;android-35;google_apis;x86_64',
  };
  const phones = await phoneManifest(sdkRoot).catch(() => []);
  versions.identityCatalog = JSON.stringify(phones.map((p) => p.id));
  versions.identityAbis = JSON.stringify(
    Object.fromEntries(phones.map((p) => [p.id, p.supportedAbis])),
  );
  versions.identityModels = String(
    phones.length ||
      (await identityManifest(sdkRoot).then(
        (x) => x.length,
        () => 0,
      )),
  );
  const env = {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    APPIUM_HOME: join(toolsRoot, 'appium-home'),
  };
  const adb = await execute(join(sdkRoot, 'platform-tools/adb'), ['version'], 10000, env);
  if (!adb.code) versions.adb = adb.text.match(/Version ([\w.-]+)/)?.[1] ?? 'installed';
  const acceleration = await execute(
    join(sdkRoot, 'emulator/emulator'),
    ['-accel-check'],
    10000,
    env,
  );
  const appium = await execute(
    process.execPath,
    [join(toolsRoot, 'node_modules/appium/build/lib/main.js'), '--version'],
    10000,
    env,
  );
  if (!appium.code) versions.appium = appium.text.trim().slice(0, 80);
  const browser = await exists(join(toolsRoot, 'browsers'));
  if (browser) versions.playwright = 'installed';
  const proof = JSON.parse(
    await readFile('/var/lib/apk-platform/health.json', 'utf8').catch(() => 'null'),
  ) as { releaseId?: string; bootSucceeded?: boolean } | null;
  const android =
    kvm &&
    acceleration.code === 0 &&
    adb.code === 0 &&
    appium.code === 0 &&
    proof?.releaseId === releaseId &&
    proof.bootSucceeded === true;
  const errors: string[] = [];
  if (!kvm) errors.push('NO_KVM');
  if (freeDiskBytes < 20 * 1024 ** 3) errors.push('DISK_LOW');
  if (!executionOSSupported(id, version)) errors.push('UNSUPPORTED_OS');
  if (arch() !== 'x64') errors.push('UNSUPPORTED_ARCH');
  if (!android) errors.push('ANDROID_NOT_READY');
  return {
    ubuntu: id + ':' + version,
    arch: arch() === 'x64' ? 'x86_64' : arch(),
    memoryKiB: Math.floor(totalmem() / 1024),
    freeDiskBytes,
    kvm,
    sudo: false,
    markerPresent,
    android,
    download: browser,
    versions,
    errors,
  };
}
