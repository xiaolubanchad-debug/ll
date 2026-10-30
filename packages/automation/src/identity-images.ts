import { lstat, readFile, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { IDENTITY_MODELS } from '@apk/contracts';
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
    result.push({ id: item.id, model: item.model, sha256: item.sha256, systemDir: dir });
  }
  return result;
}
const hashes = new Map<string, Promise<string>>();
export async function loadIdentityImage(sdk: string, id: string): Promise<IdentityImage> {
  if (!IDENTITY_MODELS.includes(id as (typeof IDENTITY_MODELS)[number]))
    throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  const image = (await identityManifest(sdk)).find((x) => x.id === id)!;
  const path = join(image.systemDir, 'system.img'),
    s = await sealed(path);
  const key = [path, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
  let pending = hashes.get(key);
  if (!pending) {
    pending = imageDigest(path);
    hashes.set(key, pending);
  }
  if ((await pending) !== image.sha256) throw new RegistrationError('IDENTITY_IMAGE_INVALID');
  return image;
}
