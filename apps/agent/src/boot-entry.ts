import { bootCheck } from './boot-check.js';
import { identityManifest } from '@apk/automation';
async function check() {
  const sdk = process.env.ANDROID_HOME ?? '/opt/apk-platform/android';
  if (process.argv.slice(2).join(' ') === '--verify-identities') {
    for (const image of await identityManifest(sdk, true)) await bootCheck(sdk, undefined, image);
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
