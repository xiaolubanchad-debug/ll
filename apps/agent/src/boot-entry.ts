import { writeFile } from 'node:fs/promises';
import { bootCheck } from './boot-check.js';
import { identityManifest, phoneManifest } from '@apk/automation';
async function check() {
  const sdk = process.env.ANDROID_HOME ?? '/opt/apk-platform/android';
  if (process.argv.slice(2).join(' ') === '--verify-identities') {
    const images =
      process.env.DEVICE_SESSIONS === '1'
        ? [...(await identityManifest(sdk, true)), ...(await phoneManifest(sdk, true))]
        : await identityManifest(sdk, true);
    const proofs = [];
    for (const image of images) {
      try {
        proofs.push(await bootCheck(sdk, undefined, image));
      } catch (error) {
        console.error('BOOT_MODEL_FAILED ' + image.id);
        throw error;
      }
      await writeFile(
        '/var/lib/apk-platform/health-check/identity-progress.json',
        JSON.stringify({
          sdkRoot: sdk,
          completed: proofs.length,
          total: images.length,
          last: image.id,
          at: new Date().toISOString(),
        }),
        { mode: 0o600 },
      ).catch(() => {});
    }
    console.log(JSON.stringify({ version: 1, sdkRoot: sdk, images: proofs }));
  } else if (process.argv.length === 2) await bootCheck(sdk);
  else throw Error('BOOT_ARGUMENT_INVALID');
}
check().then(
  () => console.log('BOOT_OK'),
  () => {
    console.error('ANDROID_NOT_READY');
    process.exitCode = 1;
  },
);
