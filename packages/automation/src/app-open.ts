import { setTimeout as delay } from 'node:timers/promises';
import type { ApkMetadata, TestConfiguration } from '@apk/contracts';
import { inspectApk } from './apk.js';
import { startAndroid } from './android.js';
import type { AndroidOptions } from './android.js';
import type { AutomationEvent, Target } from './download.js';
import type { AndroidSession, TaskCompletion } from './registration-types.js';
import { RegistrationError } from './registration-types.js';
import type { RegistrationCompletion } from './registration.js';

export interface AppOpenHooks extends AndroidOptions {
  androidFactory?: typeof startAndroid;
  clock?: { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };
}
// This path never creates accounts, reads APP content, or calls UI automation.
export async function openApk(
  config: TestConfiguration,
  target: Target,
  apk: ApkMetadata,
  file: string,
  index: number,
  signal: AbortSignal,
  emit: (event: AutomationEvent) => Promise<void>,
  hooks: AppOpenHooks,
): Promise<RegistrationCompletion> {
  let session: AndroidSession | undefined,
    cleanupComplete = true;
  let result: TaskCompletion;
  const stage = (name: string, extra: Record<string, unknown> = {}) =>
    emit({ type: 'TASK_STAGE', taskId: target.taskId, payload: { stage: name, ...extra } });
  const action = () => {
    if (signal.aborted) throw new RegistrationError('CANCELLED');
    hooks.beforeAction();
  };
  const clock = hooks.clock ?? {
    now: () => performance.now(),
    sleep: async (ms: number, s: AbortSignal) => {
      await delay(ms, undefined, { signal: s });
    },
  };
  try {
    action();
    if (config.execution.appOpen?.dwellMs !== 10000)
      throw new RegistrationError('APP_OPEN_CONFIG_INVALID');
    await stage('PREPARING');
    const profile = config.execution.deviceProfiles[index % config.execution.deviceProfiles.length];
    session = await (hooks.androidFactory ?? startAndroid)(profile, signal, {
      ...hooks,
      controlMode: 'LAUNCH_ONLY',
    });
    action();
    if (apk.abis.length && !apk.abis.some((abi) => session!.supportedAbis.includes(abi)))
      throw new RegistrationError('APK_ABI_UNSUPPORTED');
    const actual = await inspectApk(
      file,
      config.download.maxApkBytes ?? 268435456,
      apk.cacheDay,
      signal,
    );
    if (
      actual.apkSha256 !== apk.apkSha256 ||
      actual.size !== apk.size ||
      actual.packageName !== apk.packageName
    )
      throw new RegistrationError('APK_INVALID');
    await stage('INSTALLING', { observation: session.observation });
    await session.install(file);
    action();
    await stage('LAUNCHING');
    await session.launch(apk.packageName, '@launcher');
    action();
    if (!session.foreground || !(await session.foreground(apk.packageName)))
      throw new RegistrationError('APP_NOT_FOREGROUND');
    const began = clock.now();
    let samples = 1;
    await stage('HOLDING');
    while (true) {
      action();
      await clock.sleep(Math.min(1000, Math.max(1, 10000 - (clock.now() - began))), signal);
      action();
      if (!(await session.foreground(apk.packageName)))
        throw new RegistrationError('APP_NOT_FOREGROUND');
      samples++;
      const elapsedMs = Math.floor(clock.now() - began);
      if (elapsedMs > 60000) throw new RegistrationError('APP_OPEN_TIMEOUT');
      if (elapsedMs >= 10000) {
        action();
        result = {
          status: 'SUCCEEDED',
          proof: 'APP_OPEN',
          artifactIds: [],
          openObservation: {
            dwellMs: 10000,
            elapsedMs,
            samples,
            scope: 'FOREGROUND_POLL_ONLY',
            cleanupComplete: true,
          },
        };
        break;
      }
    }
  } catch (error) {
    result = {
      status: signal.aborted ? 'CANCELLED' : 'FAILED',
      proof: 'NONE',
      artifactIds: [],
      errorCode: signal.aborted
        ? 'CANCELLED'
        : error instanceof RegistrationError
          ? error.code
          : 'APP_OPEN_FAILED',
    };
    if (error instanceof RegistrationError && error.code === 'CLEANUP_INCOMPLETE')
      cleanupComplete = false;
  } finally {
    if (session) cleanupComplete = await session.close().catch(() => false);
  }
  // Never publish a completion before cleanup; a stop received during cleanup wins.
  if (!cleanupComplete)
    result = { status: 'FAILED', proof: 'NONE', artifactIds: [], errorCode: 'CLEANUP_INCOMPLETE' };
  else if (signal.aborted)
    result = { status: 'CANCELLED', proof: 'NONE', artifactIds: [], errorCode: 'CANCELLED' };
  return { ...result, cleanupComplete };
}
