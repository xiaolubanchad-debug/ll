import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { IDENTITY_MODELS, DEVICE_CATALOG } from '@apk/contracts';
// Explicit environment boundary. Ordinary download/UI/task changes do not invalidate SDK receipts.
export const environmentFiles = [
  'deploy/ansible/install.yml',
  'deploy/ansible/update.yml',
  'deploy/ansible/tasks/platform-check.yml',
  'deploy/ansible/templates/android-generic-package.xml.j2',
  'deploy/ansible/templates/apk-agent.service.j2',
  'apps/agent/src/environment.ts',
  'apps/agent/src/environment-entry.ts',
  'apps/agent/src/boot-entry.ts',
  'apps/agent/src/boot-check.ts',
  'apps/agent/src/identity-entry.ts',
  'apps/agent/src/identity-builder.ts',
  'apps/agent/src/boot-receipts.ts',
  'apps/agent/src/boot-process.ts',
  'packages/automation/src/identity-images.ts',
  'packages/contracts/src/device-catalog.ts',
];
export async function environmentRecipe(root) {
  const hash = (b) => createHash('sha256').update(b).digest('hex');
  return hash(
    JSON.stringify({ IDENTITY_MODELS, DEVICE_CATALOG }) +
      '\n' +
      (
        await Promise.all(
          environmentFiles.map(async (f) => f + '\n' + hash(await readFile(join(root, f)))),
        )
      ).join('\n'),
  );
}
