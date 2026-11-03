import { appLoading, labels, readRegistrationPage } from './registration-ui.js';
import type { AppForegroundDiagnostic, AppForegroundSample } from '@apk/contracts';
import {
  obstructionCandidates,
  obstructionEvidence,
  type ObstructionNote,
} from './app-readiness.js';
import {
  RegistrationError,
  type AndroidSession,
  type ForegroundSample,
} from './registration-types.js';
import type { MeasureOpenStep } from './open-timings.js';
import { setTimeout as delay } from 'node:timers/promises';

const dwellMs = 10000;
const waitingMs = 20000;
const totalMs = 40000;
type Clock = { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> };

export function foregroundTrace(now: () => number) {
  const began = now();
  const samples: AppForegroundSample[] = [];
  let targetFocus: AppForegroundDiagnostic['targetFocus'] = 'UNOBSERVED';
  let last: AppForegroundSample | null = null;
  let switchCount = 0;
  return {
    record(sample: ForegroundSample) {
      const next = {
        ...sample,
        offsetMs: Math.min(120000, Math.max(0, Math.floor(now() - began))),
      };
      if (sample.kind === 'TARGET') targetFocus = 'SEEN';
      else if (targetFocus === 'UNOBSERVED' && sample.kind !== 'UNKNOWN') targetFocus = 'NOT_SEEN';
      if (last?.kind !== next.kind || last.packageName !== next.packageName) {
        if (last) switchCount = Math.min(256, switchCount + 1);
        if (samples.length < 8) samples.push(next);
      }
      last = next;
    },
    snapshot(scope: AppForegroundDiagnostic['scope']): AppForegroundDiagnostic {
      return { scope, targetFocus, switchCount, samples, last };
    },
    get hasSamples() {
      return last !== null;
    },
  };
}

export function watchLaunchWindows(
  read: (signal: AbortSignal) => Promise<ForegroundSample>,
  record: (sample: ForegroundSample) => void,
  signal: AbortSignal,
) {
  const stop = new AbortController();
  const bounded = AbortSignal.any([signal, stop.signal]);
  const watching = Promise.resolve()
    .then(async () => {
      while (!bounded.aborted) {
        const sample = await read(bounded).catch((): ForegroundSample => ({ kind: 'UNKNOWN' }));
        if (bounded.aborted) return;
        record(sample);
        await delay(250, undefined, { signal: bounded });
      }
    })
    .catch(() => {});
  return async () => {
    stop.abort();
    await watching;
  };
}

export async function holdAppInForeground(
  session: AndroidSession,
  pkg: string,
  inspectStartup: boolean,
  signal: AbortSignal,
  action: () => void,
  clock: Clock,
  measure: MeasureOpenStep,
  holding: () => Promise<void>,
  note: (value: ObstructionNote) => Promise<void>,
  record: (value: ForegroundSample) => void,
) {
  const deadline = clock.now() + totalMs;
  let waitLeft = waitingMs;
  const clicked = new Set<string>();
  const observe = async (bounded: AbortSignal) => {
    action();
    bounded.throwIfAborted();
    const sample: ForegroundSample =
      'foregroundWindow' in session && session.foregroundWindow
        ? await session.foregroundWindow(pkg, bounded).catch((error: unknown) => {
            if (error instanceof RegistrationError && error.code === 'APP_FOREGROUND_FAILED')
              return { kind: 'UNKNOWN' as const };
            throw error;
          })
        : session.foreground && (await session.foreground(pkg))
          ? { kind: 'TARGET' }
          : { kind: 'UNKNOWN' };
    record(sample);
    const { kind } = sample;
    return kind === 'BROWSER' || kind === 'STORE' || kind === 'LAUNCHER' ? 'OTHER' : kind;
  };
  const reasonFor = (window: Awaited<ReturnType<typeof observe>>) =>
    window === 'SPLASH'
      ? 'APP_SPLASH_TIMEOUT'
      : window === 'SYSTEM'
        ? 'APP_SYSTEM_WINDOW_BLOCKED'
        : window === 'OTHER'
          ? 'APP_EXTERNAL_WINDOW_TIMEOUT'
          : 'foregroundWindow' in session
            ? 'APP_FOREGROUND_UNCONFIRMED'
            : 'APP_NOT_FOREGROUND';

  const ready = async (initialReason = 'APP_NOT_FOREGROUND') => {
    const started = clock.now();
    const until = Math.min(started + waitLeft, deadline - dwellMs);
    let reason = initialReason;
    if (until <= started) throw new RegistrationError(reason);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(until - started))]);
    let previousCandidate: string | undefined;
    let stable = false;
    try {
      while (clock.now() < until) {
        const window = await observe(bounded);
        if (window === 'CRASH') throw new RegistrationError('APP_STARTUP_CRASH');
        reason = reasonFor(window);
        if (window === 'TARGET') {
          if (!inspectStartup) return;
          try {
            const page = readRegistrationPage(await session.source(bounded), pkg);
            const candidates = obstructionCandidates(page);
            if (
              candidates.some((candidate) => candidate.action === 'WAIT_SPLASH') ||
              page.controls.some(
                (control) =>
                  /(?:skip|splash|ad)[_/-]?(?:timer|countdown|skip)(?:$|[_/-])/i.test(
                    control.resourceId,
                  ) && labels(control).some((label) => /^\s*[1-9]\d?\s*(?:s|秒)?\s*$/i.test(label)),
              )
            ) {
              if (previousCandidate !== 'SPLASH')
                await note({
                  action: 'WAIT_SPLASH',
                  method: 'CONTROLS',
                  index: 1,
                  phase: 'WAITING',
                });
              reason = 'APP_SPLASH_TIMEOUT';
              previousCandidate = 'SPLASH';
            } else if (appLoading({ ...page, foreign: false })) {
              reason = 'APP_STARTUP_LOADING_TIMEOUT';
              previousCandidate = undefined;
            } else if (candidates.length) {
              const [candidate] = candidates;
              reason = 'APP_STARTUP_OBSTRUCTION_TIMEOUT';
              if (
                candidates.length === 1 &&
                candidate.locator &&
                candidate.action !== 'ACK_NOTICE' &&
                !page.foreign &&
                previousCandidate === candidate.key &&
                !clicked.has(candidate.key) &&
                clicked.size < 8
              ) {
                const timeout = Math.max(1, Math.min(1500, Math.floor(until - clock.now())));
                const id = await session.find(candidate.locator, timeout, bounded);
                const rect = await session.rect(id, bounded);
                const index = clicked.size + 1;
                await note({
                  action: candidate.action,
                  method: candidate.method,
                  index,
                  phase: 'DETECTED',
                });
                if (
                  (['x', 'y', 'width', 'height'] as const).every(
                    (axis) => Math.abs(rect[axis] - candidate.rect[axis]) <= 2,
                  ) &&
                  (await observe(bounded)) === 'TARGET' &&
                  clock.now() < until
                ) {
                  clicked.add(candidate.key);
                  await session.click(
                    id,
                    Math.max(1, Math.min(timeout, Math.floor(until - clock.now()))),
                  );
                  await note({
                    action: candidate.action,
                    method: candidate.method,
                    index,
                    phase: 'ACTION_SENT',
                  });
                }
              }
              previousCandidate = candidate.key;
            } else if (obstructionEvidence(page)) {
              reason = 'APP_STARTUP_OBSTRUCTION_TIMEOUT';
              previousCandidate = undefined;
            } else {
              if (stable) {
                const verified = await observe(bounded);
                if (verified === 'CRASH') throw new RegistrationError('APP_STARTUP_CRASH');
                if (verified === 'TARGET' && clock.now() < until) return;
                reason = reasonFor(verified);
                stable = false;
              } else stable = true;
              previousCandidate = undefined;
              await clock.sleep(Math.min(400, Math.max(1, until - clock.now())), bounded);
              continue;
            }
          } catch (error) {
            if (bounded.aborted) throw error;
            if (!(error instanceof RegistrationError)) throw error;
            if (
              ['AUTO_CONTROL_AMBIGUOUS', 'FLOW_STEP_FAILED', 'EVIDENCE_UNSAFE'].includes(error.code)
            )
              reason = 'APP_STARTUP_OBSTRUCTION_TIMEOUT';
            else if (/^(?:APPIUM_|AUTO_PAGE_)/.test(error.code))
              reason = 'APP_STARTUP_UI_UNAVAILABLE';
            else throw error;
            previousCandidate = undefined;
          }
        } else previousCandidate = undefined;
        stable = false;
        await clock.sleep(Math.min(400, Math.max(1, until - clock.now())), bounded);
      }
    } catch (error) {
      if (!bounded.aborted || signal.aborted) throw error;
    } finally {
      waitLeft -= clock.now() - started;
    }
    throw new RegistrationError(reason);
  };

  await measure(inspectStartup ? 'STARTUP_ADS' : 'FOREGROUND_CHECK', () => ready());
  return measure('FOREGROUND_DWELL', async () => {
    await holding();
    const bounded = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, Math.ceil(deadline - clock.now()))),
    ]);
    let began = clock.now(),
      samples = 1;
    try {
      while (clock.now() < deadline) {
        await clock.sleep(Math.min(1000, Math.max(1, dwellMs - (clock.now() - began))), bounded);
        const window = await observe(bounded);
        if (window === 'CRASH') throw new RegistrationError('APP_STARTUP_CRASH');
        if (window !== 'TARGET') {
          await ready(reasonFor(window));
          began = clock.now();
          samples = 1;
          continue;
        }
        samples++;
        const elapsedMs = Math.floor(clock.now() - began);
        if (elapsedMs >= dwellMs && clock.now() <= deadline) return { elapsedMs, samples };
      }
    } catch (error) {
      if (!bounded.aborted || signal.aborted) throw error;
    }
    throw new RegistrationError('APP_OPEN_TIMEOUT');
  });
}
