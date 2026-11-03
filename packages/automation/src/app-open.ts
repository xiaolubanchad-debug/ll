import {
  isOwnedTestPackage,
  deviceVariant,
  schemaIssues,
  apkInstallDiagnosticCode,
  APK_INSTALL_DIAGNOSTIC_PREFIX,
  APP_FOREGROUND_LOG,
} from '@apk/contracts';
import { foregroundTrace, holdAppInForeground, watchLaunchWindows } from './app-open-foreground.js';
import { unavailableProcessObservation, type AndroidLaunchMarker } from './android-process.js';
import { loadIdentityImage } from './identity-images.js';
import { setTimeout as delay } from 'node:timers/promises';
import type { ApkMetadata, AppForegroundDiagnostic, TestConfiguration } from '@apk/contracts';
import { verifyFileTransfer } from './apk.js';
import { DownloadError } from './common.js';
import { openTimer } from './open-timings.js';
import { startAndroid } from './android.js';
import type { AndroidOptions } from './android.js';
import type { AutomationEvent, Target } from './download.js';
import type { AndroidSession, TaskCompletion } from './registration-types.js';
import { RegistrationError } from './registration-types.js';
import type { RegistrationCompletion } from './registration.js';

export interface AppOpenHooks extends AndroidOptions {
  beginAttempt?: () => Promise<void>;
  testBootstrap?: () => Promise<import('@apk/contracts').TestBootstrap>;
  testReceipt?: (signal: AbortSignal) => Promise<import('@apk/contracts').TestClientReceipt>;
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
): Promise<RegistrationCompletion & { preparationFailed?: boolean }> {
  let session: AndroidSession | undefined,
    cleanupComplete = true,
    reportUnconfirmed = false;
  let packageName = apk.packageName;
  let result: TaskCompletion;
  let trace: ReturnType<typeof foregroundTrace> | undefined;
  let launchMarker: AndroidLaunchMarker | undefined;
  let launchStartedAt: number | undefined;
  let launchReceipt: AppForegroundDiagnostic['launchReceipt'] = 'NOT_ISSUED';
  let foregroundCheckStarted = false;
  let confirmedCrash = false;
  let processWithoutWindow = false;
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
    if (!hooks.beginAttempt) await stage('PREPARING');
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
    if (hooks.beginAttempt) {
      await hooks.beginAttempt();
      await stage('PREPARING');
    }
    if (apk.abis.length && !apk.abis.some((abi) => session!.supportedAbis.includes(abi)))
      throw new RegistrationError('APK_ABI_UNSUPPORTED');
    await timer.measure('APK_VERIFY', () =>
      verifyFileTransfer(file, apk, config.download.maxApkBytes ?? 268435456, signal),
    );
    await stage('INSTALLING', {
      observation: {
        ...session.observation,
        ...(target.deviceSessionId
          ? {
              deviceSessionId: target.deviceSessionId,
              appIndex: target.appIndex,
              ...(target.deviceEpoch ? { deviceEpoch: target.deviceEpoch } : {}),
            }
          : {}),
      },
    });
    const installed = await timer
      .measure('APK_INSTALL', () => session!.install(file, apk.validationPolicy === 'FILE_NAME'))
      .catch(async (error: unknown) => {
        const message =
          error instanceof RegistrationError ? APK_INSTALL_DIAGNOSTIC_PREFIX + error.code : '';
        if (!signal.aborted && apkInstallDiagnosticCode(message))
          await emit({ type: 'LOG', taskId: target.taskId, payload: { level: 'INFO', message } });
        throw error;
      });
    if (apk.validationPolicy === 'FILE_NAME')
      packageName = typeof installed === 'string' ? installed : undefined;
    if (!packageName) throw new RegistrationError('APP_PACKAGE_UNCONFIRMED');
    await stage(
      'LAUNCHING',
      apk.validationPolicy === 'FILE_NAME' ? { installedPackageName: packageName } : {},
    );
    if (config.execution.appOpen.ownedTestClient) {
      if (!isOwnedTestPackage(packageName) || !hooks.testBootstrap || !session.provisionTestClient)
        throw new RegistrationError('TEST_BOOTSTRAP_REQUIRED');
      const bootstrap = await hooks.testBootstrap();
      action();
      await session.provisionTestClient(bootstrap, packageName);
    }
    action();
    trace = foregroundTrace(clock.now);
    try {
      await timer.measure('APP_LAUNCH', async () => {
        let stopWatching: (() => Promise<void>) | undefined;
        try {
          await session!.launch(packageName!, '@launcher', (marker) => {
            launchMarker = marker;
            launchStartedAt = clock.now();
            trace = foregroundTrace(clock.now);
            if ('foregroundWindow' in session! && session!.foregroundWindow)
              stopWatching = watchLaunchWindows(
                (bounded) => session!.foregroundWindow!(packageName!, bounded),
                trace.record,
                signal,
              );
          });
        } finally {
          await stopWatching?.();
        }
      });
      launchReceipt = 'ACCEPTED';
    } catch (error) {
      if (!(error instanceof RegistrationError) || signal.aborted) throw error;
      if (error.code === 'APP_LAUNCH_REJECTED') launchReceipt = 'REJECTED';
      if (launchStartedAt === undefined) throw error;
      if (error.code === 'APP_LAUNCH_TIMEOUT') launchReceipt = 'TIMEOUT';
      else if (['APP_LAUNCH_UNCONFIRMED', 'APP_LAUNCH_COMMAND_FAILED'].includes(error.code))
        launchReceipt = 'UNCONFIRMED';
      else throw error;
    }
    action();
    if (trace.crashSeen) throw new RegistrationError('APP_STARTUP_CRASH');
    foregroundCheckStarted = true;
    const foreground = await holdAppInForeground(
      session,
      packageName,
      !!config.execution.appOpen.appsPerDevice,
      signal,
      action,
      clock,
      timer.measure,
      () => stage('HOLDING'),
      async (note) =>
        emit({ type: 'APP_OBSTRUCTION', taskId: target.taskId, payload: { ...note } }),
      trace.record,
      { startedAt: launchStartedAt, lastKind: trace.lastKind },
    );
    result = {
      status: 'SUCCEEDED',
      proof: 'APP_OPEN',
      artifactIds: [],
      openObservation: {
        dwellMs: 10000,
        ...foreground,
        scope: 'FOREGROUND_POLL_ONLY',
        cleanupComplete: true,
        ...(target.deviceSessionId
          ? {
              cleanupScope: 'APP_UNINSTALLED' as const,
              deviceSessionId: target.deviceSessionId,
              appIndex: target.appIndex,
              ...(target.deviceEpoch ? { deviceEpoch: target.deviceEpoch } : {}),
            }
          : {}),
      },
    };
    if (config.execution.appOpen.ownedTestClient) {
      action();
      const status =
        (await session.testClientStatus?.(packageName).catch(() => 'UNCONFIRMED')) ?? 'UNCONFIRMED';
      reportUnconfirmed =
        status.startsWith('NETWORK_') || !/^(?:HTTP_[1-4][0-9]{2}|CONFIG_ERROR)$/.test(status);
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
    if (trace && session && packageName && !signal.aborted) {
      const scope = foregroundCheckStarted || trace.hasSamples ? 'POLL' : 'AFTER_LAUNCH_ERROR';
      if (!foregroundCheckStarted && 'foregroundWindow' in session && session.foregroundWindow) {
        const probe = AbortSignal.any([signal, AbortSignal.timeout(1500)]);
        try {
          action();
          trace.record(await session.foregroundWindow(packageName, probe));
        } catch {
          // No sample is also a useful distinction from an observed external window.
        }
      }
      let process = unavailableProcessObservation;
      if (launchMarker && 'processEvents' in session && session.processEvents && !signal.aborted) {
        try {
          action();
          const probe = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
          process = await session.processEvents(packageName, launchMarker, probe);
        } catch {
          // Window evidence and the original task result still apply.
        }
      }
      const snapshot = trace.snapshot(scope);
      confirmedCrash =
        trace.crashSeen ||
        process.events.some(
          (e) =>
            e.process === 'MAIN' &&
            (e.kind === 'CRASH' || e.exitReason === 'CRASH' || e.exitReason === 'NATIVE_CRASH'),
        );
      processWithoutWindow =
        snapshot.targetFocus !== 'SEEN' &&
        process.events.some((e) => e.process === 'MAIN' && e.kind === 'STARTED');
      if (!signal.aborted)
        await emit({
          type: 'LOG',
          taskId: target.taskId,
          payload: {
            level: 'INFO',
            message: APP_FOREGROUND_LOG,
            appForeground: { ...snapshot, launchReceipt, process },
          },
        }).catch(() => {});
    }
    if (session)
      cleanupComplete = await timer.measure('CLEANUP', () => session!.close()).catch(() => false);
  }
  if (confirmedCrash && result.errorCode !== 'CLEANUP_INCOMPLETE')
    result = { status: 'FAILED', proof: 'NONE', artifactIds: [], errorCode: 'APP_STARTUP_CRASH' };
  else if (
    processWithoutWindow &&
    ['APP_FOREGROUND_UNCONFIRMED', 'APP_NOT_FOREGROUND'].includes(result.errorCode ?? '')
  )
    result.errorCode = 'APP_PROCESS_WITHOUT_WINDOW';
  if (cleanupComplete && !signal.aborted && reportUnconfirmed && hooks.testReceipt) {
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), 2000);
    const receiptSignal = AbortSignal.any([signal, deadline.signal]);
    let onAbort: (() => void) | undefined;
    try {
      action();
      receiptSignal.throwIfAborted();
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new RegistrationError('TEST_RECEIPT_UNCONFIRMED'));
        receiptSignal.addEventListener('abort', onAbort, { once: true });
      });
      const receipt = await Promise.race([hooks.testReceipt(receiptSignal), aborted]);
      action();
      if (!schemaIssues('TestClientReceipt', receipt).length && receipt.received)
        await emit({
          type: 'LOG',
          taskId: target.taskId,
          payload: {
            level: 'INFO',
            message: '自有测试 APK：中台已确认收到（APP响应未确认）',
          },
        });
    } catch {
      // Preserve the original native result; a failed read never creates or retries an account.
    } finally {
      clearTimeout(timeout);
      if (onAbort) receiptSignal.removeEventListener('abort', onAbort);
    }
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
  return {
    ...result,
    openTimings: timer.finish(),
    cleanupComplete,
    ...(hooks.beginAttempt && !session && !signal.aborted ? { preparationFailed: true } : {}),
  };
}
