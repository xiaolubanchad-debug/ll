import { lstat, readFile, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { IDENTITY_MODELS, DEVICE_CATALOG, deviceVariant } from '@apk/contracts';
import { RegistrationError } from './registration-types.js';

export const identityModel = (id: string) =>
  'QA-Mobile-000' + (IDENTITY_MODELS.indexOf(id as (typeof IDENTITY_MODELS)[number]) + 1);
export function identityImageRoot(sdk: string) {
  const key = basename(dirname(sdk));
  if (!/^[a-f0-9]{64}$/.test(key) || basename(sdk) !== 'android')
    throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  return join(dirname(dirname(dirname(resolve(sdk)))), 'identity-images', key);
}
export interface IdentityImage {
  id: string;
  model: string;
  systemDir: string;
  sha256: string;
  vendorSha256?: string;
  apiLevel?: number;
  supportedAbis?: string[];
}

export function phoneImageRoot(sdk: string) {
  return (
    identityImageRoot(sdk) +
    '-phones-r3-' +
    createHash('sha256').update(JSON.stringify(DEVICE_CATALOG)).digest('hex').slice(0, 16)
  );
}

export async function phoneManifest(
  sdk: string,
  allowUnverified = false,
): Promise<IdentityImage[]> {
  const root = phoneImageRoot(sdk);
  await sealed(root, true);
  if ((await realpath(root)) !== root) throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  const path = join(root, 'manifest.json');
  if ((await sealed(path)).size > 65536) throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  const m = JSON.parse(await readFile(path, 'utf8')) as {
    version?: number;
    sdkRoot?: string;
    images?: {
      id: string;
      model: string;
      apiLevel: number;
      sha256: string;
      vendorSha256: string;
      verified: boolean;
      supportedAbis?: string[];
    }[];
  };
  if (
    m.version !== 3 ||
    m.sdkRoot !== resolve(sdk) ||
    !Array.isArray(m.images) ||
    m.images.length !== 30
  )
    throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  const result: IdentityImage[] = [];
  for (const [i, item] of m.images.entries()) {
    const expected = DEVICE_CATALOG[i];
    if (
      item.id !== expected.id ||
      item.model !== expected.model ||
      item.apiLevel !== expected.apiLevel ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      !/^[a-f0-9]{64}$/.test(item.vendorSha256) ||
      (!allowUnverified &&
        (item.verified !== true ||
          !Array.isArray(item.supportedAbis) ||
          !item.supportedAbis.length ||
          item.supportedAbis.some((a) => !/^[A-Za-z0-9_-]{1,40}$/.test(a))))
    )
      throw new RegistrationError('IDENTITY_IMAGE_INVALID');
    const dir = join(root, item.id);
    await sealed(dir, true);
    if ((await realpath(dir)) !== dir) throw new RegistrationError('IDENTITY_IMAGE_INVALID');
    await sealed(join(dir, 'system.img'));
    await sealed(join(dir, 'vendor.img'));
    result.push({
      id: item.id,
      model: item.model,
      apiLevel: item.apiLevel,
      supportedAbis: item.supportedAbis,
      systemDir: dir,
      sha256: item.sha256,
      vendorSha256: item.vendorSha256,
    });
  }
  return result;
}
export async function imageDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function sealed(path: string, directory = false) {
  const s = await lstat(path);
  if (
    s.isSymbolicLink() ||
    s.uid !== 0 ||
    s.mode & 0o022 ||
    (directory ? !s.isDirectory() : !s.isFile())
  )
    throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  return s;
}
export async function identityManifest(
  sdk: string,
  allowUnverified = false,
): Promise<IdentityImage[]> {
  const root = identityImageRoot(sdk);
  await sealed(root, true);
  if ((await realpath(root)) !== root) throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  const path = join(root, 'manifest.json');
  if ((await sealed(path)).size > 65536) throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  const m = JSON.parse(await readFile(path, 'utf8')) as {
    version?: number;
    sdkRoot?: string;
    images?: { id: string; model: string; sha256: string; verified: boolean }[];
  };
  if (
    m.version !== 1 ||
    m.sdkRoot !== resolve(sdk) ||
    !Array.isArray(m.images) ||
    m.images.length !== 3
  )
    throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  const result: IdentityImage[] = [];
  for (const [i, item] of m.images.entries()) {
    if (
      item.id !== IDENTITY_MODELS[i] ||
      item.model !== identityModel(item.id) ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      (!allowUnverified && item.verified !== true)
    )
      throw new RegistrationError('IDENTITY_IMAGE_INVALID');
    const dir = join(root, item.id);
    await sealed(dir, true);
    if ((await realpath(dir)) !== dir) throw new RegistrationError('IDENTITY_IMAGE_INVALID');
    await sealed(join(dir, 'system.img'));
    result.push({
      id: item.id,
      model: item.model,
      sha256: item.sha256,
      systemDir: dir,
    });
  }
  return result;
}
const hashes = new Map<string, Promise<string>>();
export async function loadIdentityImage(sdk: string, id: string): Promise<IdentityImage> {
  if (!IDENTITY_MODELS.includes(id as (typeof IDENTITY_MODELS)[number]) && !deviceVariant(id))
    throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  const image = (await (deviceVariant(id) ? phoneManifest(sdk) : identityManifest(sdk))).find(
    (x) => x.id === id,
  )!;
  for (const [name, expected] of [
    ['system.img', image.sha256],
    ...(image.vendorSha256 ? [['vendor.img', image.vendorSha256]] : []),
  ]) {
    const path = join(image.systemDir, name),
      s = await sealed(path);
    const key = [path, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
    let pending = hashes.get(key);
    if (!pending) {
      pending = imageDigest(path);
      hashes.set(key, pending);
    }
    if ((await pending) !== expected) throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  }
  return image;
}
