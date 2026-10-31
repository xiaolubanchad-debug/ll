import { readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  identityImageRoot,
  identityManifest,
  phoneManifest,
  phoneImageRoot,
} from '@apk/automation';
import { buildIdentityImages, buildPhoneImages } from './identity-builder.js';
const sdk = process.env.ANDROID_HOME ?? '';
async function main() {
  if (process.argv.slice(2).join(' ') === '--seal') {
    if (process.getuid?.() !== 0) throw Error('IDENTITY_ROOT_REQUIRED');
    const phones = process.env.DEVICE_SESSIONS === '1';
    await (phones ? phoneManifest : identityManifest)(sdk, true);
    const root = phones ? phoneImageRoot(sdk) : identityImageRoot(sdk),
      path = join(root, 'manifest.json');
    if (phones) {
      const proofPath = join(sdk, 'phone-boot-proof.json');
      const stat = await lstat(proofPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== 0 ||
        stat.mode & 0o022 ||
        stat.size > 65536
      )
        throw Error('IDENTITY_PROOF_INVALID');
      const receipt = JSON.parse(
        (await readFile(proofPath, 'utf8')).split(/\r?\n/).find((line) => line.startsWith('{')) ??
          'null',
      ) as {
        version: number;
        sdkRoot: string;
        images: {
          id: string;
          model: string;
          apiLevel: number;
          sha256: string;
          supportedAbis: string[];
        }[];
      };
      if (
        receipt?.version !== 1 ||
        receipt.sdkRoot !== sdk ||
        !Array.isArray(receipt.images) ||
        receipt.images.length !== 33 ||
        new Set(receipt.images.map((p) => p.id)).size !== 33
      )
        throw Error('IDENTITY_PROOF_INVALID');
      const images = await phoneManifest(sdk, true);
      for (const image of images) {
        const actual = receipt.images.find((p) => p.id === image.id);
        if (
          !actual ||
          actual.model !== image.model ||
          actual.apiLevel !== image.apiLevel ||
          actual.sha256 !== image.sha256 ||
          !Array.isArray(actual.supportedAbis) ||
          !actual.supportedAbis.length ||
          actual.supportedAbis.length > 8 ||
          actual.supportedAbis.some((a) => !/^[A-Za-z0-9_-]{1,40}$/.test(a))
        )
          throw Error('IDENTITY_PROOF_INVALID');
      }
      const manifest = JSON.parse(await readFile(path, 'utf8')) as {
        images: { id: string; supportedAbis?: string[] }[];
      };
      manifest.images.forEach((p) => {
        p.supportedAbis = receipt.images.find((r) => r.id === p.id)!.supportedAbis;
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
