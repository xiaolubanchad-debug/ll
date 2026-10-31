import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DailyExecutionPlan, TestConfiguration } from '@apk/contracts';
import type { AutomationEvent, Target } from './download.js';
import type { RegistrationCompletion } from './registration.js';
import { ApkCache } from './cache.js';
import { canonical, sha, DownloadError } from './common.js';
import { startProxyBridge, proxyObservation } from './proxy.js';
import type { ProxyCredential } from './registration-types.js';
import type { NetworkPolicy } from './network.js';
import { runCachedAppOpens } from './concurrent-open.js';

export async function runCachedRegistrations(
  config: TestConfiguration,
  plan: DailyExecutionPlan,
  nodeId: string,
  root: string,
  signal: AbortSignal,
  emit: (event: AutomationEvent) => Promise<void>,
  beforeAction: () => void,
  register: (
    target: Target,
    apk: DailyExecutionPlan['assets'][number]['apk'],
    file: string,
    index: number,
    signal: AbortSignal,
  ) => Promise<RegistrationCompletion>,
  closeDeviceSession?: (id: string) => Promise<boolean>,
) {
  if (config.execution.appOpen && plan.openPolicy)
    return runCachedAppOpens(
      config,
      plan,
      nodeId,
      root,
      signal,
      emit,
      beforeAction,
      register,
      Date.now,
      closeDeviceSession,
    );
  const targets: Target[] = plan.assets.length
    ? Array.from({ length: plan.attemptLimit }, (_, position) => {
        const asset = plan.assets[position % plan.assets.length];
        return {
          taskId: randomUUID(),
          targetKey: sha(canonical([asset.targetKey, position])),
          label: asset.label.slice(0, 180) + ' · ' + (position + 1),
          sourceUrl: asset.sourceUrl,
          ...(asset.entryId ? { entryId: asset.entryId } : {}),
          pid: '',
          href: asset.sourceUrl,
          position,
        };
      })
    : [];
  if (!targets.length)
    await emit({
      type: 'TARGETS_DISCOVERED',
      payload: { targets: [], startIndex: 0, complete: true },
    });
  for (let start = 0; start < targets.length; start += 20) {
    beforeAction();
    await emit({
      type: 'TARGETS_DISCOVERED',
      payload: {
        targets: targets
          .slice(start, start + 20)
          .map(({ taskId, targetKey, label, sourceUrl, entryId }) => ({
            taskId,
            targetKey,
            label,
            sourceUrl,
            ...(entryId ? { entryId } : {}),
          })),
        startIndex: start,
        complete: start + 20 >= targets.length,
      },
    });
  }
  const cache = await ApkCache.open(join(root, 'cache'));
  let successes = 0,
    review = false,
    cleanupIncomplete = false,
    missing = false;
  let layoutChanged = false;
  let needsAdaptation = false;
  const directories = new Set<string>();
  let noRegisterable = false;
  try {
    for (const [index, target] of targets.entries()) {
      beforeAction();
      if (signal.aborted) throw new DownloadError('CANCELLED');
      const asset = plan.assets[index % plan.assets.length];
      await emit({
        type: 'TASK_STAGE',
        taskId: target.taskId,
        payload: { stage: 'DOWNLOADING' },
      });
      const found = await cache.get(
        nodeId,
        plan.cacheDay,
        asset.targetKey,
        config.download.maxApkBytes ?? 268435456,
        signal,
      );
      let completion: RegistrationCompletion;
      if (
        !found ||
        found.apkSha256 !== asset.apk.apkSha256 ||
        found.size !== asset.apk.size ||
        found.packageName !== asset.apk.packageName
      ) {
        missing = true;
        completion = {
          status: 'FAILED',
          proof: 'NONE',
          artifactIds: [],
          errorCode: 'CACHE_MISSING',
          cleanupComplete: true,
        };
      } else {
        cache.pin(nodeId, plan.cacheDay, asset.targetKey);
        await emit({
          type: 'TASK_STAGE',
          taskId: target.taskId,
          payload: { stage: 'DOWNLOADED', cacheHit: true, apk: asset.apk },
        });
        completion = await register(
          target,
          asset.apk,
          cache.path(cache.key(nodeId, plan.cacheDay, asset.targetKey)),
          index,
          signal,
        );
      }
      const { cleanupComplete, ...payload } = completion;
      layoutChanged = completion.errorCode === 'FLOW_STEP_FAILED';
      needsAdaptation = completion.recognition?.needsAdaptation === true;
      await emit({ type: 'TASK_FINISHED', taskId: target.taskId, payload });
      if (
        completion.status === 'SKIPPED' &&
        ['APP_NAVIGATION_ONLY', 'APP_AUTO_IDENTITY'].includes(completion.errorCode ?? '')
      )
        directories.add(asset.apk.apkSha256);
      noRegisterable = plan.assets.every((a) => directories.has(a.apk.apkSha256));
      if (completion.status === 'SUCCEEDED') successes++;
      cleanupIncomplete = !cleanupComplete;
      review = cleanupIncomplete || completion.status === 'UNKNOWN';
      if (
        review ||
        missing ||
        layoutChanged ||
        needsAdaptation ||
        noRegisterable ||
        successes >= plan.successTarget
      )
        break;
    }
  } finally {
    cache.releasePins();
    cache.close();
  }
  const errorCode = review
    ? cleanupIncomplete
      ? 'CLEANUP_INCOMPLETE'
      : 'REGISTRATION_UNKNOWN'
    : !targets.length
      ? 'NO_ADAPTED_APKS'
      : noRegisterable
        ? 'NO_REGISTERABLE_APK'
        : needsAdaptation
          ? 'AUTO_ADAPTATION_REQUIRED'
          : layoutChanged
            ? 'FLOW_LAYOUT_CHANGED'
            : missing
              ? 'CACHE_MISSING'
              : successes < plan.successTarget
                ? 'ATTEMPT_LIMIT'
                : undefined;
  await emit({
    type: 'RUN_FINISHED',
    payload: {
      status: review
        ? 'NEEDS_REVIEW'
        : successes >= plan.successTarget
          ? 'SUCCEEDED'
          : successes
            ? 'PARTIAL_FAILED'
            : 'FAILED',
      ...(errorCode ? { errorCode } : {}),
    },
  });
}

export async function runProxyCheck(
  credential: ProxyCredential,
  signal: AbortSignal,
  emit: (event: AutomationEvent) => Promise<void>,
  policy?: NetworkPolicy,
  url?: string,
) {
  let bridge: Awaited<ReturnType<typeof startProxyBridge>> | undefined;
  let observation: Record<string, unknown> = {
    status: 'FAILED',
    errorCode: 'PROXY_CHECK_FAILED',
  };
  try {
    bridge = await startProxyBridge(credential, policy);
    const observed = await proxyObservation(bridge.port, signal, url);
    observation = {
      status: 'SUCCEEDED',
      ip: observed.ip,
      at: observed.at,
      scope: 'PROBE_ONLY',
    };
  } catch {
    if (signal.aborted) throw new DownloadError('CANCELLED');
  } finally {
    await bridge?.close();
  }
  await emit({ type: 'PROXY_CHECKED', payload: observation });
  const success = observation.status === 'SUCCEEDED';
  await emit({
    type: 'RUN_FINISHED',
    payload: {
      status: success ? 'SUCCEEDED' : 'FAILED',
      ...(!success ? { errorCode: 'PROXY_CHECK_FAILED' } : {}),
    },
  });
}
