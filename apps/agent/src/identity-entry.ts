import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { identityImageRoot, identityManifest } from '@apk/automation';
import { buildIdentityImages } from './identity-builder.js';
const sdk = process.env.ANDROID_HOME ?? '';
async function main() {
  if (process.argv.slice(2).join(' ') === '--seal') {
    if (process.getuid?.() !== 0) throw Error('IDENTITY_ROOT_REQUIRED');
    await identityManifest(sdk, true);
    const root = identityImageRoot(sdk),
      path = join(root, 'manifest.json');
    const m = JSON.parse(await readFile(path, 'utf8')) as { images: { verified: boolean }[] };
    m.images.forEach((x) => {
      x.verified = true;
    });
    await writeFile(path + '.tmp', JSON.stringify(m), { mode: 0o644 });
    await rename(path + '.tmp', path);
  } else if (process.argv.length === 2) await buildIdentityImages(sdk);
  else throw Error('IDENTITY_ARGUMENT_INVALID');
  console.log('IDENTITY_IMAGES_READY');
}
main().catch(() => {
  console.error('IDENTITY_IMAGES_NOT_READY');
  process.exitCode = 1;
});
