import type { DailyExecutionPlan, TestConfiguration } from './generated/types.js';
import { deviceVariant } from './device-catalog.js';
export function deviceAssignments(plan: DailyExecutionPlan | null | undefined) {
  return plan?.openPolicy?.sessions?.flatMap((session, sessionIndex) =>
    session.assetIndexes.map((assetIndex, appIndex) => ({
      sessionId: session.id,
      sessionIndex,
      variantId: session.variantId,
      assetIndex,
      appIndex,
    })),
  );
}

export function devicePlanIssues(config: TestConfiguration, plan: DailyExecutionPlan): string[] {
  const range = config.execution.appOpen?.appsPerDevice,
    sessions = plan.openPolicy?.sessions;
  if (!range || plan.purpose !== 'REGISTER') return sessions ? ['UNEXPECTED_DEVICE_SESSIONS'] : [];
  if (plan.openPolicy?.variantIds) return ['MIXED_DEVICE_POLICIES'];
  if (!sessions || !plan.openPolicy || plan.purpose !== 'REGISTER' || !sessions.length)
    return ['DEVICE_SESSION_PLAN_REQUIRED'];
  if (new Set(sessions.map((s) => s.id)).size !== sessions.length)
    return ['DUPLICATE_DEVICE_SESSION'];
  if (sessions.reduce((n, s) => n + s.assetIndexes.length, 0) !== plan.attemptLimit)
    return ['DEVICE_SESSION_BUDGET'];
  for (const [i, s] of sessions.entries()) {
    if (
      s.assetIndexes.length > range.max ||
      (i !== sessions.length - 1 && s.assetIndexes.length < range.min)
    )
      return ['DEVICE_SESSION_SIZE'];
    if (config.execution.appOpen?.randomDeviceProfile && !deviceVariant(s.variantId ?? ''))
      return ['DEVICE_VARIANT_REQUIRED'];
    const assets = s.assetIndexes.map((j) => plan.assets[j]);
    if (
      assets.some((a) => !a) ||
      new Set(assets.map((a) => a?.apk.packageName)).size !== assets.length
    )
      return ['DUPLICATE_OR_MISSING_APP'];
    if (
      assets.some(
        (a) =>
          a.apk.minSdkVersion === undefined ||
          (a.apk.minSdkVersion ?? 1) > (deviceVariant(s.variantId ?? '')?.apiLevel ?? 100) ||
          (a.apk.abis.length && !a.apk.abis.some((abi) => s.supportedAbis?.includes(abi))),
      )
    )
      return ['APP_INCOMPATIBLE'];
  }
  return [];
}
