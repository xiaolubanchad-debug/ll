import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DailyExecutionPlan, TestConfiguration } from '@apk/contracts';
import type { Target, AutomationEvent } from './download.js';
import type { RegistrationCompletion } from './registration.js';
import { ApkCache } from './cache.js';
import { canonical, sha, DownloadError } from './common.js';

export type CachedOpenAction = (
  target: Target,
  apk: DailyExecutionPlan['assets'][number]['apk'],
  file: string,
  index: number,
  signal: AbortSignal,
) => Promise<RegistrationCompletion>;

export async function runCachedAppOpens(
  config: TestConfiguration,
  plan: DailyExecutionPlan,
  nodeId: string,
  root: string,
  signal: AbortSignal,
  emit: (event: AutomationEvent) => Promise<void>,
  beforeAction: () => void,
  execute: CachedOpenAction,
  now: () => number = Date.now,
) {
  const policy = plan.openPolicy;
  if (
    !policy ||
    !config.execution.appOpen ||
    policy.concurrency !== (config.execution.appOpen.concurrency ?? 1)
  )
    throw new DownloadError('OPEN_POLICY_INVALID');
  const deadline = Date.parse(policy.admissionDeadline);
  if (!Number.isFinite(deadline) || policy.dailyLimit !== 800 || plan.attemptLimit > 800)
    throw new DownloadError('OPEN_POLICY_INVALID');
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
  const drain = new AbortController(),
    attemptSignal = AbortSignal.any([signal, drain.signal]);
  const running = new Map<number, Promise<void>>();
  let next = 0,
    successes = 0,
    missing = false,
    dirty = false,
    cutoff = false;
  let fatal: unknown;
  const round = async (index: number) => {
    beforeAction();
    attemptSignal.throwIfAborted();
    const target = targets[index],
      asset = plan.assets[index % plan.assets.length];
    await emit({ type: 'TASK_STAGE', taskId: target.taskId, payload: { stage: 'DOWNLOADING' } });
    const found = await cache.get(
      nodeId,
      plan.cacheDay,
      asset.targetKey,
      config.download.maxApkBytes ?? 268435456,
      attemptSignal,
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
      completion = await execute(
        target,
        asset.apk,
        cache.path(cache.key(nodeId, plan.cacheDay, asset.targetKey)),
        index,
        attemptSignal,
      );
    }
    if (!completion.cleanupComplete) {
      dirty = true;
      completion = {
        status: 'FAILED',
        proof: 'NONE',
        artifactIds: [],
        errorCode: 'CLEANUP_INCOMPLETE',
        cleanupComplete: false,
        ...(completion.openTimings ? { openTimings: completion.openTimings } : {}),
      };
    }
    const { cleanupComplete, ...payload } = completion;
    await emit({ type: 'TASK_FINISHED', taskId: target.taskId, payload });
    if (completion.status === 'SUCCEEDED') successes++;
    if (!cleanupComplete) drain.abort();
  };
  try {
    while (true) {
      beforeAction();
      if (signal.aborted) throw new DownloadError('CANCELLED');
      if (now() >= deadline) cutoff = true;
      while (
        !fatal &&
        !dirty &&
        !missing &&
        !cutoff &&
        next < targets.length &&
        running.size < policy.concurrency &&
        successes + running.size < plan.successTarget
      ) {
        const index = next++;
        const job = round(index)
          .catch((error: unknown) => {
            if (!dirty) fatal ??= error;
            drain.abort();
          })
          .finally(() => {
            running.delete(index);
          });
        running.set(index, job);
      }
      if (!running.size) break;
      await Promise.race(running.values());
      if (fatal) break;
    }
  } catch (error) {
    fatal ??= error;
    drain.abort();
  } finally {
    // No cache, node or next-day handoff before every active emulator has closed.
    await Promise.allSettled(running.values());
    cache.releasePins();
    cache.close();
  }
  if (fatal) throw fatal;
  if (signal.aborted) throw new DownloadError('CANCELLED');
  const reached = successes >= plan.successTarget;
  const errorCode = dirty
    ? 'CLEANUP_INCOMPLETE'
    : reached
      ? undefined
      : missing
        ? 'CACHE_MISSING'
        : !targets.length
          ? 'NO_ADAPTED_APKS'
          : cutoff
            ? 'DAY_CUTOFF'
            : 'ATTEMPT_LIMIT';
  await emit({
    type: 'RUN_FINISHED',
    payload: {
      status: dirty
        ? 'NEEDS_REVIEW'
        : reached
          ? 'SUCCEEDED'
          : successes
            ? 'PARTIAL_FAILED'
            : 'FAILED',
      ...(errorCode ? { errorCode } : {}),
    },
  });
}
