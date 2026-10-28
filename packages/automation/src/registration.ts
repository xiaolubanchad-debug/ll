import type { ApkMetadata, TestConfiguration } from '@apk/contracts';
import { registrationFlowFor } from '@apk/contracts';
import { startAndroid } from './android.js';
import type { AndroidOptions } from './android.js';
import { inspectApk } from './apk.js';
import { redactScreenshot } from './screenshot.js';
import type { Target, AutomationEvent } from './download.js';
import { RegistrationError } from './registration-types.js';
import type { Account, AndroidSession, Rect, TaskCompletion } from './registration-types.js';

export interface RegistrationHooks extends AndroidOptions {
  account(taskId: string): Promise<Account>;
  intent(taskId: string, accountRef: string, signal: AbortSignal): Promise<void>;
  evidence(taskId: string, bytes: Buffer, signal: AbortSignal): Promise<string>;
  androidFactory?: typeof startAndroid;
}
export type RegistrationCompletion = TaskCompletion & { cleanupComplete: boolean };
export async function registerApk(
  config: TestConfiguration,
  target: Target,
  apk: ApkMetadata,
  file: string,
  index: number,
  signal: AbortSignal,
  emit: (event: AutomationEvent) => Promise<void>,
  hooks: RegistrationHooks,
): Promise<RegistrationCompletion> {
  const template = registrationFlowFor(config, apk.packageName, target.entryId);
  if (!template)
    return {
      status: 'SKIPPED',
      proof: 'NONE',
      artifactIds: [],
      errorCode: 'FLOW_NOT_CONFIGURED',
      cleanupComplete: true,
    };
  const flow = structuredClone(template);
  flow.packageName = apk.packageName;
  for (const locator of [
    ...flow.steps.map((s) => s.locator),
    flow.success.locator,
    flow.failure?.locator,
  ])
    if (locator) locator.value = locator.value.replaceAll('{packageName}', apk.packageName);
  let session: AndroidSession | undefined,
    account: Account | undefined,
    submitted = false,
    clean = true;
  let result: TaskCompletion = {
    status: 'FAILED',
    proof: 'NONE',
    artifactIds: [],
    errorCode: 'ANDROID_FAILED',
  };
  const stage = async (name: string, extra: Record<string, unknown> = {}) =>
    emit({ type: 'TASK_STAGE', taskId: target.taskId, payload: { stage: name, ...extra } });
  const action = () => {
    if (signal.aborted) throw new RegistrationError('CANCELLED');
    hooks.beforeAction();
  };
  try {
    action();
    await stage('PREPARING');
    const profile = config.execution.deviceProfiles[index % config.execution.deviceProfiles.length];
    session = await (hooks.androidFactory ?? startAndroid)(profile, signal, hooks);
    action();
    if (apk.abis.length && !apk.abis.some((abi) => session!.supportedAbis.includes(abi)))
      throw new RegistrationError('APK_ABI_UNSUPPORTED');
    // Reinspect immediately before installation; cached bytes are never trusted by name alone.
    const actual = await inspectApk(
      file,
      config.download.maxApkBytes ?? 268435456,
      apk.cacheDay,
      signal,
    );
    if (
      actual.apkSha256 !== apk.apkSha256 ||
      actual.size !== apk.size ||
      actual.packageName !== flow.packageName
    )
      throw new RegistrationError('APK_INVALID');
    await stage('INSTALLING', { observation: session.observation });
    await session.install(file);
    action();
    await stage('LAUNCHING');
    await session.launch(flow.packageName, flow.activity);
    action();
    await stage('REGISTERING');
    account = await hooks.account(target.taskId);
    const inputs: Rect[] = [];
    for (const [position, step] of flow.steps.entries()) {
      if (submitted) break; // Verification below is read-only, including when stop has been requested.
      action();
      if (step.action === 'back') {
        await session.back();
        continue;
      }
      let id: string;
      try {
        id = await session.find(step.locator!, step.timeoutMs, signal);
      } catch (error) {
        if (
          step.optional &&
          !signal.aborted &&
          error instanceof RegistrationError &&
          error.code === 'FLOW_STEP_FAILED'
        )
          continue;
        throw error;
      }
      action();
      if (step.action === 'input') {
        inputs.push(await session.rect(id));
        await session.input(id, step.text === '{username}' ? account.username : account.password);
      } else if (step.action === 'click') await session.click(id, Math.min(step.timeoutMs, 10000));
      else if (step.action === 'submit') {
        // This durable intent MUST precede the sole transport attempt. Never retry it.
        const deadline = Date.now() + Math.min(60000, flow.success.timeoutMs);
        const verificationSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
        await hooks.intent(target.taskId, account.accountRef, verificationSignal);
        submitted = true;
        try {
          action();
          if (Date.now() >= deadline) throw new RegistrationError('REGISTRATION_UNKNOWN');
          await session.submit(id, Math.min(10000, Math.max(1, deadline - Date.now())));
        } catch {
          /* The result may already exist. Query only. */
        }
        await stage('VERIFYING');
        for (const next of flow.steps.slice(position + 1)) {
          try {
            await session.find(
              next.locator!,
              Math.min(next.timeoutMs, Math.max(1, deadline - Date.now())),
              verificationSignal,
            );
          } catch (error) {
            if (!next.optional) throw error;
          }
        }
        let outcome: 'SUCCEEDED' | 'FAILED' | undefined;
        while (Date.now() < deadline) {
          const remaining = () => Math.max(1, deadline - Date.now());
          const success = await session
            .find(flow.success.locator, Math.min(500, remaining()), verificationSignal)
            .then(
              () => true,
              () => false,
            );
          const failure =
            flow.failure && Date.now() < deadline
              ? await session
                  .find(flow.failure.locator, Math.min(500, remaining()), verificationSignal)
                  .then(
                    () => true,
                    () => false,
                  )
              : false;
          if (success && failure) break; // Conflicting UI cannot confirm either result.
          if (success || failure) {
            outcome = success ? 'SUCCEEDED' : 'FAILED';
            break;
          }
        }
        result = {
          status: 'UNKNOWN',
          proof: 'NONE',
          accountRef: account.accountRef,
          artifactIds: [],
          errorCode: 'REGISTRATION_UNKNOWN',
        };
        if (outcome) {
          const tree = await session.source(verificationSignal),
            screenshot = await session.screenshot(verificationSignal);
          if (tree !== (await session.source(verificationSignal)))
            throw new RegistrationError('EVIDENCE_UNSAFE');
          const bytes = redactScreenshot(screenshot, tree, account, inputs);
          if (Date.now() >= deadline) throw new RegistrationError('REGISTRATION_UNKNOWN');
          const artifactId = await hooks.evidence(target.taskId, bytes, verificationSignal);
          result = {
            status: outcome,
            proof: 'APP_UI',
            artifactIds: [artifactId],
            accountRef: account.accountRef,
            ...(outcome === 'FAILED' ? { errorCode: 'REGISTRATION_REJECTED' } : {}),
          };
        }
      }
    }
  } catch (error) {
    if (submitted)
      result = {
        status: 'UNKNOWN',
        proof: 'NONE',
        artifactIds: [],
        accountRef: account!.accountRef,
        errorCode: 'REGISTRATION_UNKNOWN',
      };
    else {
      const code = error instanceof RegistrationError ? error.code : 'ANDROID_FAILED';
      if (code === 'CLEANUP_INCOMPLETE') clean = false;
      result = {
        status: signal.aborted ? 'CANCELLED' : 'FAILED',
        proof: 'NONE',
        artifactIds: [],
        errorCode: code,
      };
    }
  } finally {
    if (session) clean = await session.close().catch(() => false);
  }
  return { ...result, cleanupComplete: clean };
}
