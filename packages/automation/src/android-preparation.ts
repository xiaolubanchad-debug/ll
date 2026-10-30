import { RegistrationError } from './registration-types.js';

// Both branches must settle before caller cleanup can remove their resources.
export async function prepareAndroidInParallel<T>(
  signal: AbortSignal,
  checkProxy: (signal: AbortSignal) => Promise<T>,
  boot: (signal: AbortSignal) => Promise<void>,
): Promise<T> {
  const cancel = new AbortController(),
    child = AbortSignal.any([signal, cancel.signal]);
  let firstError: unknown,
    failed = false;
  const run = async <V>(work: (signal: AbortSignal) => Promise<V>) => {
    try {
      if (child.aborted) throw new RegistrationError('CANCELLED');
      return await work(child);
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
      cancel.abort();
      throw error;
    }
  };
  const results = await Promise.allSettled([run(checkProxy), run(boot)]);
  if (signal.aborted) throw new RegistrationError('CANCELLED');
  if (failed) throw firstError;
  if (results[0].status !== 'fulfilled') throw new RegistrationError('PROXY_CHECK_FAILED');
  return results[0].value;
}

// Parse only the fixed allowlist; full property output must never reach logs.
export function deviceProperties(text: string) {
  const keys = [
    'ro.build.version.sdk',
    'ro.product.model',
    'persist.sys.locale',
    'ro.product.locale',
    'ro.product.cpu.abilist',
  ] as const;
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\[([^\]]+)\]: \[(.*)\]$/.exec(line);
    if (match && keys.some((key) => key === match[1])) {
      if (match[1] in values) throw new RegistrationError('DEVICE_PROFILE_UNSUPPORTED');
      values[match[1]] = match[2];
    }
  }
  return {
    api: Number(values[keys[0]]),
    model: (values[keys[1]] ?? '').slice(0, 200),
    locale: values[keys[2]] || values[keys[3]] || '',
    supportedAbis: (values[keys[4]] ?? '').split(',').filter(Boolean),
  };
}
