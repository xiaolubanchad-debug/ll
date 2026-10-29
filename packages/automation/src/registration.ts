import type { ApkMetadata, TestConfiguration, RegistrationRecognition } from '@apk/contracts';
import { registrationFlowFor } from '@apk/contracts';
import { appObstructions } from './app-obstructions.js';
import { startAndroid } from './android.js';
import type { AndroidOptions } from './android.js';
import { inspectApk } from './apk.js';
import { functionalEvidence } from './functional-evidence.js';
import type { Target, AutomationEvent } from './download.js';
import { RegistrationError } from './registration-types.js';
import type { Account, AndroidSession, TaskCompletion } from './registration-types.js';
import { canonical, sha } from './common.js';
import { discoverRegistration } from './registration-discovery.js';
import type { RegistrationDiscovery, RegistrationLearning } from './registration-discovery.js';
import {
  readRegistrationPage,
  registrationOutcome,
  registrationBindingsValid,
} from './registration-ui.js';

export interface RegistrationHooks extends AndroidOptions {
  account(taskId: string): Promise<Account>;
  intent(taskId: string, accountRef: string, signal: AbortSignal): Promise<void>;
  evidence(taskId: string, bytes: Buffer, signal: AbortSignal): Promise<string>;
  androidFactory?: typeof startAndroid;
  learning?: RegistrationLearning;
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
  const automatic = !template && config.execution.autoRegistration?.enabled === true;
  if (!template && !automatic)
    return {
      status: 'SKIPPED',
      proof: 'NONE',
      artifactIds: [],
      errorCode: 'FLOW_NOT_CONFIGURED',
      cleanupComplete: true,
    };
  const flow: TestConfiguration['registrationFlows'][number] = template
    ? structuredClone(template)
    : {
        packageName: apk.packageName,
        activity: '@launcher',
        enabled: true,
        steps: [],
        success: {
          locator: { by: 'xpath', value: '//*[@text="注册成功"]' },
          timeoutMs: config.execution.autoRegistration!.successTimeoutMs,
        },
      };
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
  let recognition: RegistrationRecognition | undefined;
  let discovery: RegistrationDiscovery | undefined,
    learningKey = '',
    beforeSubmit = '',
    discovering = false;
  let readiness: ReturnType<typeof appObstructions> | undefined;
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
    readiness = appObstructions(
      session,
      apk.packageName,
      action,
      async (payload) => {
        await emit({ type: 'APP_OBSTRUCTION', taskId: target.taskId, payload: { ...payload } });
      },
      config.execution.autoRegistration?.screenshotFallback ?? false,
      config.execution.autoRegistration?.startup,
    );
    if (!automatic) await readiness.clear(signal);
    if (automatic) {
      recognition = {
        source: 'CONTROLS',
        navigationSteps: 0,
        cache: 'MISS',
        learned: false,
        needsAdaptation: false,
      };
      await stage('DISCOVERING');
      discovering = true;
      learningKey = sha(
        canonical([
          'AUTO_V1',
          config.source.url,
          config.source.xpath,
          target.entryId ?? apk.packageName,
          profile,
          config.execution.autoRegistration,
        ]),
      );
      discovery = await discoverRegistration(
        session,
        apk.packageName,
        config.execution.autoRegistration!,
        learningKey,
        signal,
        action,
        recognition!,
        hooks.learning,
        readiness.clear,
      );
      discovering = false;
      const form = discovery.form;
      const input = (locator: typeof form.username, text: '{username}' | '{password}') => ({
        action: 'input' as const,
        locator,
        text,
        timeoutMs: 10000,
        optional: false,
      });
      flow.steps = [
        ...(form.agreement
          ? [
              {
                action: 'click' as const,
                locator: form.agreement,
                timeoutMs: 10000,
                optional: false,
              },
            ]
          : []),
        input(form.username, '{username}'),
        input(form.password, '{password}'),
        ...(form.confirm ? [input(form.confirm, '{password}')] : []),
        { action: 'submit', locator: form.submit, timeoutMs: 10000, optional: false },
      ];
    }
    await stage('REGISTERING', recognition ? { recognition: structuredClone(recognition) } : {});
    account = await hooks.account(target.taskId);
    for (const [position, step] of flow.steps.entries()) {
      if (submitted) break; // Verification below is read-only, including when stop has been requested.
      action();
      if (step.action === 'back') {
        await session.back();
        continue;
      }
      let id: string;
      try {
        if (readiness) {
          const tree = await readiness.clear(signal);
          if (automatic) {
            const binding = { ...discovery!.form };
            delete binding.agreement;
            if (
              !registrationBindingsValid(
                readRegistrationPage(tree, apk.packageName),
                binding,
                step.action !== 'submit',
              )
            )
              throw new RegistrationError('AUTO_FORM_CHANGED');
          }
        }
        if (automatic && step.action === 'submit') {
          await session.hideKeyboard?.();
          action();
          beforeSubmit = await session.source(signal);
          if (
            !registrationBindingsValid(
              readRegistrationPage(beforeSubmit, apk.packageName),
              discovery!.form,
            )
          )
            throw new RegistrationError('AUTO_FORM_CHANGED');
        }
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
          if (automatic) {
            try {
              outcome = registrationOutcome(
                await session.source(verificationSignal),
                apk.packageName,
                account,
                beforeSubmit,
              );
            } catch {
              /* A read failure does not justify another submission. */
            }
            if (outcome) break;
            await new Promise((r) => setTimeout(r, Math.min(200, remaining())));
            continue;
          }
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
          const tree = await session.source(verificationSignal);
          if (
            automatic &&
            registrationOutcome(tree, apk.packageName, account, beforeSubmit) !== outcome
          )
            throw new RegistrationError('EVIDENCE_UNSAFE');
          if (!automatic) {
            const selected = outcome === 'SUCCEEDED' ? flow.success : flow.failure;
            if (!selected) throw new RegistrationError('EVIDENCE_UNSAFE');
            await session.find(
              selected.locator,
              Math.min(500, Math.max(1, deadline - Date.now())),
              verificationSignal,
            );
            const opposite = outcome === 'SUCCEEDED' ? flow.failure : flow.success;
            if (
              opposite &&
              (await session
                .find(
                  opposite.locator,
                  Math.min(500, Math.max(1, deadline - Date.now())),
                  verificationSignal,
                )
                .then(
                  () => true,
                  () => false,
                ))
            )
              throw new RegistrationError('EVIDENCE_UNSAFE');
          }
          if (tree !== (await session.source(verificationSignal)))
            throw new RegistrationError('EVIDENCE_UNSAFE');
          const bytes = functionalEvidence(tree, apk.packageName, { outcome, automatic });
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
      let code = error instanceof RegistrationError ? error.code : 'ANDROID_FAILED';
      if (code === 'AUTO_ENTRY_NOT_FOUND' && recognition?.automaticIdentity && !account)
        code = 'APP_AUTO_IDENTITY';
      if (automatic && (code === 'FLOW_STEP_FAILED' || (discovering && code === 'APPIUM_FAILED')))
        code = discovering ? 'AUTO_PAGE_UNREADABLE' : 'AUTO_FORM_CHANGED';
      if (code === 'CLEANUP_INCOMPLETE') clean = false;
      result = {
        status: signal.aborted
          ? 'CANCELLED'
          : ['APP_NAVIGATION_ONLY', 'APP_AUTO_IDENTITY'].includes(code) && !account
            ? 'SKIPPED'
            : 'FAILED',
        proof: 'NONE',
        artifactIds: [],
        errorCode: code,
      };
      if (
        recognition &&
        !signal.aborted &&
        (code.startsWith('AUTO_') || ['APP_NAVIGATION_ONLY', 'APP_AUTO_IDENTITY'].includes(code))
      ) {
        recognition.needsAdaptation = !['APP_NAVIGATION_ONLY', 'APP_AUTO_IDENTITY'].includes(code);
        try {
          action();
          const proofSignal = AbortSignal.timeout(5000),
            tree = await session!.source(proofSignal);
          if (tree !== (await session!.source(proofSignal)))
            throw new RegistrationError('EVIDENCE_UNSAFE');
          const bytes = functionalEvidence(tree, apk.packageName);
          result.artifactIds.push(await hooks.evidence(target.taskId, bytes, proofSignal));
        } catch {
          /* Unsafe or unavailable diagnostic structures are withheld. */
        }
      }
    }
  } finally {
    if (session) clean = await session.close().catch(() => false);
  }
  if (result.status === 'SUCCEEDED' && clean && discovery && hooks.learning) {
    try {
      await hooks.learning.save(learningKey, discovery.template);
      recognition!.learned = true;
    } catch {
      /* A cache write cannot change an already proved registration outcome. */
    }
  }
  return { ...result, ...(recognition ? { recognition } : {}), cleanupComplete: clean };
}
