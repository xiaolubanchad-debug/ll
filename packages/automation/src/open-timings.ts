import type { AppOpenTimings } from '@apk/contracts';

export type OpenStep = AppOpenTimings['steps'][number]['name'];
export type MeasureOpenStep = <T>(name: OpenStep, work: () => Promise<T>) => Promise<T>;

export function openTimer(now: () => number = () => performance.now()) {
  const began = now(),
    steps: AppOpenTimings['steps'] = [];
  const offset = () => Math.max(0, Math.floor(now() - began));
  const measure: MeasureOpenStep = async (name, work) => {
    const startedMs = offset();
    let outcome: AppOpenTimings['steps'][number]['outcome'] = 'SUCCEEDED';
    try {
      const value = await work();
      if (value === false) outcome = 'FAILED';
      return value;
    } catch (error) {
      outcome =
        error instanceof Error && (error.name === 'AbortError' || error.message === 'CANCELLED')
          ? 'CANCELLED'
          : 'FAILED';
      throw error;
    } finally {
      steps.push({ name, startedMs, elapsedMs: Math.max(0, offset() - startedMs), outcome });
    }
  };
  return { measure, finish: (): AppOpenTimings => ({ version: 1, totalMs: offset(), steps }) };
}
