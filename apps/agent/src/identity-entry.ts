import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  identityImageRoot,
  identityManifest,
  phoneManifest,
  phoneImageRoot,
} from '@apk/automation';
import { verifiedBootReceipts } from './boot-receipts.js';
import { imageDigest } from '@apk/automation';
import { buildIdentityImages, buildPhoneImages } from './identity-builder.js';
const sdk = process.env.ANDROID_HOME ?? '';
async function loadProof(images: import('@apk/automation').IdentityImage[]) {
  const path = join(sdk, 'phone-boot-proof.json'),
    stat = await lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.mode & 0o022 ||
    stat.size > 65536
  )
    throw Error('IDENTITY_PROOF_INVALID');
  const value = JSON.parse(
    (await readFile(path, 'utf8')).split(/\r?\n/).find((line) => line.startsWith('{')) ?? 'null',
  );
  return verifiedBootReceipts(value, sdk, images);
}
async function main() {
  if (process.argv.slice(2).join(' ') === '--check') {
    if (process.getuid?.() !== 0) throw Error('IDENTITY_ROOT_REQUIRED');
    const images = [...(await identityManifest(sdk)), ...(await phoneManifest(sdk))];
    await loadProof(images);
    for (const image of images)
      if ((await imageDigest(join(image.systemDir, 'system.img'))) !== image.sha256)
        throw Error('IDENTITY_IMAGE_INVALID');
    console.log('IDENTITY_CACHE_VERIFIED');
    return;
  }
  if (process.argv.slice(2).join(' ') === '--seal') {
    if (process.getuid?.() !== 0) throw Error('IDENTITY_ROOT_REQUIRED');
    const phones = process.env.DEVICE_SESSIONS === '1';
    await (phones ? phoneManifest : identityManifest)(sdk, true);
    const root = phones ? phoneImageRoot(sdk) : identityImageRoot(sdk),
      path = join(root, 'manifest.json');
    if (phones) {
      const images = await phoneManifest(sdk, true);
      const actualAbis = await loadProof([...(await identityManifest(sdk, true)), ...images]);
      const manifest = JSON.parse(await readFile(path, 'utf8')) as {
        images: { id: string; supportedAbis?: string[] }[];
      };
      manifest.images.forEach((p) => {
        p.supportedAbis = actualAbis.get(p.id)!;
      });
      await writeFile(path, JSON.stringify(manifest), { mode: 0o644 });
      const legacy = identityImageRoot(sdk) + '/manifest.json';
      const old = JSON.parse(await readFile(legacy, 'utf8')) as {
        images: { verified: boolean }[];
      };
      old.images.forEach((x) => {
        x.verified = true;
      });
      await writeFile(legacy + '.tmp', JSON.stringify(old), { mode: 0o644 });
      await rename(legacy + '.tmp', legacy);
    }
    const m = JSON.parse(await readFile(path, 'utf8')) as {
      images: { verified: boolean }[];
    };
    m.images.forEach((x) => {
      x.verified = true;
    });
    await writeFile(path + '.tmp', JSON.stringify(m), { mode: 0o644 });
    await rename(path + '.tmp', path);
  } else if (process.argv.length === 2)
    await (process.env.DEVICE_SESSIONS === '1' ? buildPhoneImages : buildIdentityImages)(sdk);
  else throw Error('IDENTITY_ARGUMENT_INVALID');
  console.log('IDENTITY_IMAGES_READY');
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[A-Z_]{1,80}$/.test(error.message) ? error.message : 'UNKNOWN';
  console.error('IDENTITY_IMAGES_NOT_READY:' + code);
  process.exitCode = 1;
});
