import { readFile } from 'node:fs/promises';
import {
  environmentChecked,
  planEnvironment,
  captureEnvironment,
  reuseEnvironment,
} from './environment.js';
import type { EnvironmentInput } from '@apk/contracts';
async function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('ROOT_REQUIRED');
  const [action, requested] = process.argv.slice(2);
  if (!['plan', 'capture', 'reuse'].includes(action) || !['AUTO', 'FULL'].includes(requested))
    throw Error('ENVIRONMENT_INVALID');
  const input = environmentChecked<EnvironmentInput>(
    'EnvironmentInput',
    JSON.parse(await readFile('/var/lib/apk-platform/environment-input.json', 'utf8')),
  );
  if (action === 'capture') await captureEnvironment(input);
  if (action === 'reuse') await reuseEnvironment(input);
  if (action === 'plan')
    console.log(JSON.stringify(await planEnvironment(input, requested as 'AUTO' | 'FULL')));
}
main().catch(() => {
  console.error('ENVIRONMENT_CHECK_FAILED');
  process.exitCode = 1;
});
