import type { DailyExecutionPlan } from '@apk/contracts';
import type { AutomationEvent } from './download.js';
import { DownloadError } from './common.js';

interface DeviceRoundResult {
  success: boolean;
  failed: boolean;
  missing: boolean;
  replaceDevice?: boolean;
  preparationFailed?: boolean;
  appiumFailed?: boolean;
}

export async function scheduleDeviceSessions(
  plan: DailyExecutionPlan,
  signal: AbortSignal,
  beforeAction: () => void,
  emit: (event: AutomationEvent) => Promise<void>,
  round: (position: number, epoch?: number) => Promise<DeviceRoundResult>,
  close: (id: string) => Promise<boolean>,
  now: () => number = Date.now,
  cancelOthers: () => void = () => {},
) {
  const policy = plan.openPolicy!;
  const sessions = policy.sessions!;
  const deadline = Date.parse(policy.admissionDeadline);
  if (sessions.reduce((total, group) => total + group.assetIndexes.length, 0) !== plan.attemptLimit)
    throw new DownloadError('DEVICE_SESSION_PLAN_INVALID');
  let successes = 0;
  let skipped = 0;
  let dirty = false;
  let missing = false;
  let preparationFailed = false;
  const canContinue = () =>
    !dirty && !missing && !preparationFailed && successes < plan.successTarget && now() < deadline;
  let offset = 0;
  for (const group of sessions) {
    let cursor = 0;
    let epoch = 0;
    let retryingPreparation = false;
    while (cursor < group.assetIndexes.length && canContinue()) {
      beforeAction();
      signal.throwIfAborted();
      epoch++;
      const began = now();
      const session = {
        sessionId: group.id,
        ...(policy.preserveQueue ? { deviceEpoch: epoch } : {}),
      };
      await emit({
        type: 'DEVICE_SESSION',
        payload: { ...session, phase: 'STARTED', elapsedMs: 0, cleanupComplete: false },
      });
      let replacementReason:
        | 'APP_CLEANUP_UNCONFIRMED'
        | 'DEVICE_PREPARATION_FAILED'
        | 'APPIUM_FAILED'
        | undefined;
      let skipRemaining = false;
      try {
        while (cursor < group.assetIndexes.length && canContinue()) {
          beforeAction();
          signal.throwIfAborted();
          const result = await round(offset + cursor, policy.preserveQueue ? epoch : undefined);
          if (policy.preserveQueue && result.preparationFailed) {
            replacementReason = result.appiumFailed ? 'APPIUM_FAILED' : 'DEVICE_PREPARATION_FAILED';
            preparationFailed = retryingPreparation;
            retryingPreparation = true;
            break;
          }
          cursor++;
          if (result.success) successes++;
          missing = result.missing;
          if (policy.preserveQueue && result.replaceDevice) {
            retryingPreparation = false;
            if (cursor < group.assetIndexes.length) replacementReason = 'APP_CLEANUP_UNCONFIRMED';
            break;
          }
          if (!policy.preserveQueue && result.failed) {
            skipRemaining = cursor < group.assetIndexes.length;
            break;
          }
        }
      } finally {
        const clean = await close(group.id).catch(() => false);
        dirty = !clean;
        if (!clean) cancelOthers();
        if (clean && skipRemaining) skipped += group.assetIndexes.length - cursor;
        await emit({
          type: 'DEVICE_SESSION',
          payload: {
            ...session,
            phase: clean ? 'CLOSED' : 'FAILED',
            elapsedMs: Math.max(0, now() - began),
            cleanupComplete: clean,
            ...(clean && skipRemaining ? { skipRemaining: true } : {}),
            ...(clean && replacementReason ? { replacementReason } : {}),
          },
        });
      }
      if (!replacementReason) break;
    }
    offset += group.assetIndexes.length;
    if (!canContinue()) break;
  }
  return { successes, skipped, dirty, missing, preparationFailed, cutoff: now() >= deadline };
}
