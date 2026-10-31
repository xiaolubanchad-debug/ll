import { isOwnedTestPackage, deviceVariant } from '@apk/contracts';
import { appObstructions } from './app-readiness.js';
import { loadIdentityImage } from './identity-images.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ApkMetadata, TestConfiguration } from '@apk/contracts';
import { verifyApkIntegrity } from './apk.js';
import { DownloadError } from './common.js';
import { openTimer } from './open-timings.js';
import { startAndroid } from './android.js';
import type { AndroidOptions } from './android.js';
import type { AutomationEvent, Target } from './download.js';
import type { AndroidSession, TaskCompletion } from './registration-types.js';
import { RegistrationError } from './registration-types.js';
import type { RegistrationCompletion } from './registration.js';

export interface AppOpenHooks extends AndroidOptions {
  testBootstrap?: () => Promise<import('@apk/contracts').TestBootstrap>;
  androidFactory?: typeof startAndroid;
  clock?: {
    now(): number;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
  };
}
// Device sessions use bounded native controls for startup barriers; raw APP content is never returned.
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
  let result: TaskCompletion = {
    status: 'FAILED',
    proof: 'NONE',
    artifactIds: [],
    errorCode: 'APP_OPEN_FAILED',
  };
  const stage = (name: string, extra: Record<string, unknown> = {}) =>
    emit({
      type: 'TASK_STAGE',
      taskId: target.taskId,
      payload: { stage: name, ...extra },
    });
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
  const timer = openTimer(clock.now);
  try {
    action();
    if (config.execution.appOpen?.dwellMs !== 10000)
      throw new RegistrationError('APP_OPEN_CONFIG_INVALID');
    await stage('PREPARING');
    const baseProfile =
      config.execution.deviceProfiles[index % config.execution.deviceProfiles.length];
    const variant = deviceVariant(target.variantId ?? '');
    const profile = variant
      ? {
          ...baseProfile,
          systemImage: 'system-images;android-' + variant.apiLevel + ';google_apis;x86_64',
        }
      : baseProfile;
    session = await (hooks.androidFactory ?? startAndroid)(profile, signal, {
      ...hooks,
      ownedTestClient: config.execution.appOpen.ownedTestClient === true,
      ...(config.execution.appOpen.randomDeviceProfile
        ? {
            identityImage: await timer.measure('IDENTITY_IMAGE_CHECK', () =>
              loadIdentityImage(hooks.sdkRoot, target.variantId ?? ''),
            ),
          }
        : {}),
      controlMode: config.execution.appOpen.appsPerDevice ? 'DEVICE_SESSION' : 'LAUNCH_ONLY',
      measure: timer.measure,
    });
    action();
    if (apk.abis.length && !apk.abis.some((abi) => session!.supportedAbis.includes(abi)))
      throw new RegistrationError('APK_ABI_UNSUPPORTED');
    await timer.measure('APK_VERIFY', () =>
      verifyApkIntegrity(file, apk, config.download.maxApkBytes ?? 268435456, signal),
    );
    await stage('INSTALLING', {
      observation: {
        ...session.observation,
        ...(target.deviceSessionId
          ? {
              deviceSessionId: target.deviceSessionId,
              appIndex: target.appIndex,
            }
          : {}),
      },
    });
    await timer.measure('APK_INSTALL', () => session!.install(file));
    if (config.execution.appOpen.ownedTestClient) {
      if (
        !isOwnedTestPackage(apk.packageName) ||
        !hooks.testBootstrap ||
        !session.provisionTestClient
      )
        throw new RegistrationError('TEST_BOOTSTRAP_REQUIRED');
      const bootstrap = await hooks.testBootstrap();
      action();
      await session.provisionTestClient(bootstrap, apk.packageName);
    }
    action();
    await stage('LAUNCHING');
    await timer.measure('APP_LAUNCH', () => session!.launch(apk.packageName, '@launcher'));
    action();
    if (config.execution.appOpen.appsPerDevice) {
      await timer.measure('STARTUP_ADS', () =>
        appObstructions(
          session!,
          apk.packageName,
          hooks.beforeAction,
          async (note) => {
            await emit({
              type: 'APP_OBSTRUCTION',
              taskId: target.taskId,
              payload: { ...note },
            });
          },
          false,
          { totalTimeoutMs: 30000, maxActions: 8 },
        ).clear(signal),
      );
    }
    await timer.measure('FOREGROUND_CHECK', async () => {
      const deadline = clock.now() + 30000;
      if (!session!.foreground) throw new RegistrationError('APP_NOT_FOREGROUND');
      while (true) {
        action();
        if (await session!.foreground(apk.packageName)) return;
        if (clock.now() >= deadline) throw new RegistrationError('APP_NOT_FOREGROUND');
        await clock.sleep(250, signal);
      }
    });
    await timer.measure('FOREGROUND_DWELL', async () => {
      const began = clock.now();
      let samples = 1;
      await stage('HOLDING');
      while (true) {
        action();
        await clock.sleep(Math.min(1000, Math.max(1, 10000 - (clock.now() - began))), signal);
        action();
        if (!(await session!.foreground!(apk.packageName)))
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
              ...(target.deviceSessionId
                ? {
                    cleanupScope: 'APP_UNINSTALLED' as const,
                    deviceSessionId: target.deviceSessionId,
                    appIndex: target.appIndex,
                  }
                : {}),
            },
          };
          break;
        }
      }
    });
    if (config.execution.appOpen.ownedTestClient) {
      action();
      const status =
        (await session.testClientStatus?.(apk.packageName).catch(() => 'UNCONFIRMED')) ??
        'UNCONFIRMED';
      const message =
        status === 'HTTP_200'
          ? '自有测试 APK：账户已上报'
          : status === 'CONFIG_ERROR'
            ? '自有测试 APK：配置读取失败'
            : /^HTTP_/.test(status)
              ? '自有测试 APK：请求未获接受'
              : status.startsWith('NETWORK_')
                ? '自有测试 APK：网络响应尚未确认'
                : '自有测试 APK：上报结果尚未确认';
      await emit({
        type: 'LOG',
        taskId: target.taskId,
        payload: { level: 'INFO', message },
      });
    }
  } catch (error) {
    result = {
      status: signal.aborted ? 'CANCELLED' : 'FAILED',
      proof: 'NONE',
      artifactIds: [],
      errorCode: signal.aborted
        ? 'CANCELLED'
        : error instanceof RegistrationError || error instanceof DownloadError
          ? error.code
          : 'APP_OPEN_FAILED',
    };
    if (error instanceof RegistrationError && error.code === 'CLEANUP_INCOMPLETE')
      cleanupComplete = false;
  } finally {
    if (session)
      cleanupComplete = await timer.measure('CLEANUP', () => session!.close()).catch(() => false);
  }
  // Never publish a completion before cleanup; a stop received during cleanup wins.
  if (!cleanupComplete)
    result = {
      status: 'FAILED',
      proof: 'NONE',
      artifactIds: [],
      errorCode: 'CLEANUP_INCOMPLETE',
    };
  else if (signal.aborted)
    result = {
      status: 'CANCELLED',
      proof: 'NONE',
      artifactIds: [],
      errorCode: 'CANCELLED',
    };
  return { ...result, openTimings: timer.finish(), cleanupComplete };
}
