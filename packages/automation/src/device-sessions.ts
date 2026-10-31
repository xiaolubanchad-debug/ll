import { EXECUTION_DEVICE_LIMIT, type DailyExecutionPlan } from '@apk/contracts';
import type { AutomationEvent } from './download.js';
import { DownloadError } from './common.js';

// A device must close before the next session is admitted; N/M still count APP attempts.
export async function scheduleDeviceSessions(
  plan: DailyExecutionPlan,
  signal: AbortSignal,
  beforeAction: () => void,
  emit: (event: AutomationEvent) => Promise<void>,
  round: (position: number) => Promise<{ success: boolean; clean: boolean; missing: boolean }>,
  close: (id: string) => Promise<boolean>,
  now: () => number = Date.now,
  cancelOthers: () => void = () => {},
) {
  const policy = plan.openPolicy!,
    sessions = policy.sessions!;
  const groups = sessions.map((s) => ({
    ...s,
    positions: [] as number[],
    next: 0,
  }));
  let position = 0;
  for (const group of groups)
    for (let i = 0; i < group.assetIndexes.length; i++) group.positions.push(position++);
  if (position !== plan.attemptLimit) throw new DownloadError('DEVICE_SESSION_PLAN_INVALID');
  const active = new Map<
    string,
    { group: (typeof groups)[number]; began: number; busy: boolean }
  >();
  const used = new Set<string>(),
    jobs = new Set<Promise<void>>();
  let successes = 0,
    dirty = false,
    missing = false,
    fatal: unknown;
  const finish = async (id: string) => {
    const state = active.get(id)!;
    const clean = await close(id).catch(() => false);
    if (!clean) {
      dirty = true;
      cancelOthers();
    }
    await emit({
      type: 'DEVICE_SESSION',
      payload: {
        sessionId: id,
        phase: clean ? 'CLOSED' : 'FAILED',
        elapsedMs: Math.max(0, now() - state.began),
        cleanupComplete: clean,
      },
    });
    active.delete(id);
  };
  try {
    while (true) {
      beforeAction();
      signal.throwIfAborted();
      const cutoff = now() >= Date.parse(policy.admissionDeadline);
      if (!fatal && !dirty && !missing && !cutoff && successes < plan.successTarget) {
        while (active.size < Math.min(EXECUTION_DEVICE_LIMIT, plan.successTarget - successes)) {
          const candidate = groups.find((g) => !used.has(g.id));
          if (
            candidate?.variantId &&
            Array.from(active.values()).some((s) => s.group.variantId === candidate.variantId)
          )
            break;
          if (!candidate) break;
          used.add(candidate.id);
          active.set(candidate.id, {
            group: candidate,
            began: now(),
            busy: false,
          });
          await emit({
            type: 'DEVICE_SESSION',
            payload: {
              sessionId: candidate.id,
              phase: 'STARTED',
              elapsedMs: 0,
              cleanupComplete: false,
            },
          });
        }
        for (const state of active.values()) {
          if (
            state.busy ||
            state.group.next >= state.group.positions.length ||
            successes + jobs.size >= plan.successTarget
          )
            continue;
          const index = state.group.positions[state.group.next++];
          state.busy = true;
          const job = round(index)
            .then((r) => {
              if (r.success) successes++;
              dirty ||= !r.clean;
              missing ||= r.missing;
              if (!r.clean) cancelOthers();
            })
            .catch((e: unknown) => {
              fatal ??= e;
              cancelOthers();
            })
            .finally(() => {
              state.busy = false;
              jobs.delete(job);
            });
          jobs.add(job);
        }
      }
      for (const [id, state] of active)
        if (
          !state.busy &&
          (state.group.next >= state.group.positions.length ||
            successes >= plan.successTarget ||
            fatal ||
            dirty ||
            missing ||
            cutoff)
        )
          await finish(id);
      if (!jobs.size) {
        if (
          !fatal &&
          !dirty &&
          !missing &&
          !cutoff &&
          successes < plan.successTarget &&
          groups.some((g) => !used.has(g.id))
        )
          continue;
        break;
      }
      await Promise.race(jobs);
    }
  } finally {
    await Promise.allSettled(jobs);
    for (const id of active.keys()) await finish(id);
  }
  if (fatal) throw fatal;
  return {
    successes,
    dirty,
    missing,
    cutoff: now() >= Date.parse(policy.admissionDeadline),
  };
}
