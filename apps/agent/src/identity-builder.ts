import { open, mkdir, cp, copyFile, chmod, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { IDENTITY_MODELS, DEVICE_CATALOG } from '@apk/contracts';
import {
  identityImageRoot,
  identityManifest,
  identityModel,
  imageDigest,
  phoneImageRoot,
} from '@apk/automation';

// These are labelled QA images, with AVB disabled only in their private copies.
// The signed upstream SDK is never modified. Layout changes fail closed.
export function propertyPatch(text: string, model: string): { text: string; changed: number } {
  const variant = DEVICE_CATALOG.find((v) => v.model === model);
  let changed = 0;
  const output = text.replace(
    /^(ro\.product(?:\.[a-z_]+)?\.(?:model|brand|manufacturer))=([^\r\n]*)/gm,
    (line: string, key: string, value: string) => {
      const v = key.endsWith('.model')
        ? model
        : key.endsWith('.brand')
          ? (variant?.brand ?? 'qatest')
          : (variant?.manufacturer ?? 'QATest');
      if (!variant && v.length > value.length) return line;
      changed++;
      return key + '=' + (variant ? v : v.padEnd(value.length, ' '));
    },
  );
  const padded = variant ? output.padEnd(text.length, ' ') : output;
  if (Buffer.byteLength(padded) !== Buffer.byteLength(text))
    throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
  return { text: padded, changed };
}
async function patchImage(dest: string, temp: string, model: string) {
  const f = await open(dest, 'r+'),
    size = (await f.stat()).size;
  const read = async (n: number, at: number) => {
    if (!Number.isSafeInteger(at) || at < 0 || n < 0 || n > 1048576 || at + n > size)
      throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
    const b = Buffer.alloc(n);
    if ((await f.read(b, 0, n, at)).bytesRead !== n) throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
    return b;
  };
  const num = (b: bigint) => {
    const n = Number(b);
    if (!Number.isSafeInteger(n)) throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
    return n;
  };
  const debug = (args: string[]) =>
    execFileSync('/usr/sbin/debugfs', args, {
      encoding: 'utf8',
      maxBuffer: 262144,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  let changes = 0;
  try {
    const magic = await read(2, 1080);
    if (magic.readUInt16LE(0) === 0xef53) {
      changes += await patchExt4(dest, 0, size, f, model);
      if (changes < 1) throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
      const footer = await read(64, size - 64);
      if (footer.subarray(0, 4).toString() === 'AVBf') {
        const at = num(footer.readBigUInt64BE(20)),
          avb = await read(256, at);
        if (avb.subarray(0, 4).toString() !== 'AVB0') throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
        const flags = Buffer.alloc(4);
        flags.writeUInt32BE(avb.readUInt32BE(120) | 3);
        await f.write(flags, 0, 4, at + 120);
      }
      await f.sync();
      return;
    }
    const g = await read(512, 512),
      entrySize = g.readUInt32LE(84),
      count = g.readUInt32LE(80);
    if (g.subarray(0, 8).toString() !== 'EFI PART' || count > 128 || entrySize !== 128)
      throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
    const entries = await read(count * entrySize, num(g.readBigUInt64LE(72)) * 512);
    let sup = 0,
      vb = 0,
      superEnd = 0;
    for (let i = 0; i < count; i++) {
      const e = entries.subarray(i * entrySize, (i + 1) * entrySize),
        name = e.subarray(56, 128).toString('utf16le').replaceAll('\0', '');
      if (name === 'super') {
        sup = num(e.readBigUInt64LE(32)) * 512;
        superEnd = (num(e.readBigUInt64LE(40)) + 1) * 512;
      }
      if (name === 'vbmeta') vb = num(e.readBigUInt64LE(32)) * 512;
    }
    if (!sup || !vb || superEnd > size) throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
    const h = await read(256, sup + 12288);
    if (
      h.readUInt32LE(0) !== 0x414c5030 ||
      h.readUInt32LE(8) < 128 ||
      h.readUInt32LE(8) > 256 ||
      h.readUInt32LE(84) > 32 ||
      h.readUInt32LE(88) !== 52 ||
      h.readUInt32LE(100) !== 24
    )
      throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
    const tables = await read(h.readUInt32LE(44), sup + 12288 + h.readUInt32LE(8));
    for (let i = 0; i < h.readUInt32LE(84); i++) {
      const at = h.readUInt32LE(80) + i * 52;
      if (at + 52 > tables.length) throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
      const p = tables.subarray(at, at + 52),
        name = p.subarray(0, 36).toString().replaceAll('\0', '');
      if (!['system', 'system_ext', 'product', 'vendor'].includes(name)) continue;
      const extent = h.readUInt32LE(92) + p.readUInt32LE(40) * 24;
      if (p.readUInt32LE(44) !== 1 || extent + 24 > tables.length)
        throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
      const e = tables.subarray(extent, extent + 24);
      if (e.readUInt32LE(8) !== 0 || e.readUInt32LE(20) !== 0)
        throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
      const offset = sup + num(e.readBigUInt64LE(12)) * 512,
        length = num(e.readBigUInt64LE(0)) * 512;
      if (offset < sup || offset + length > superEnd) throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
      const file = join(temp, name + '.partition.img'),
        out = await open(file, 'wx', 0o600),
        buffer = Buffer.alloc(1048576);
      try {
        for (let pos = 0; pos < length; pos += buffer.length) {
          const n = Math.min(buffer.length, length - pos);
          if ((await f.read(buffer, 0, n, offset + pos)).bytesRead !== n)
            throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
          await out.write(buffer, 0, n, pos);
        }
      } finally {
        await out.close();
      }
      const part = await open(file, 'r'),
        sb = Buffer.alloc(1024);
      try {
        await part.read(sb, 0, 1024, 1024);
      } finally {
        await part.close();
      }
      if (sb.readUInt16LE(56) !== 0xef53 || sb.readUInt32LE(24) > 6)
        throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
      const blockSize = 1024 * 2 ** sb.readUInt32LE(24);
      for (const path of name === 'system'
        ? ['/system/build.prop', '/build.prop', '/system/etc/prop.default']
        : ['/build.prop', '/etc/build.prop']) {
        const original = debug(['-R', 'cat ' + path, file]);
        if (!original) continue;
        const patch = propertyPatch(original, model);
        if (!patch.changed) continue;
        const bytes = Buffer.from(patch.text);
        for (let pos = 0; pos < bytes.length; pos += blockSize) {
          const mapped = debug([
            '-R',
            'bmap ' + path + ' ' + Math.floor(pos / blockSize),
            file,
          ]).trim();
          if (!/^[1-9][0-9]*$/.test(mapped) || Number(mapped) * blockSize + blockSize > length)
            throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
          const data = bytes.subarray(pos, Math.min(bytes.length, pos + blockSize));
          await f.write(data, 0, data.length, offset + Number(mapped) * blockSize);
        }
        changes += patch.changed;
      }
      await rm(file);
    }
    const avb = await read(256, vb);
    if (avb.subarray(0, 4).toString() !== 'AVB0' || changes < 3)
      throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
    const flags = Buffer.alloc(4);
    flags.writeUInt32BE(avb.readUInt32BE(120) | 3);
    await f.write(flags, 0, 4, vb + 120);
    await f.sync();
  } finally {
    await f.close();
  }
}
export async function buildIdentityImages(sdk: string) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw Error('IDENTITY_ROOT_REQUIRED');
  const root = identityImageRoot(sdk),
    src = join(sdk, 'system-images/android-35/google_apis/x86_64');
  try {
    await lstat(root);
    await identityManifest(sdk, true);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const temp = root + '.building';
  await mkdir(temp, { recursive: true, mode: 0o755 });
  // Refuse an interrupted build rather than overwriting an unreviewed directory.
  const marker = await open(join(temp, 'build.lock'), 'wx', 0o600);
  await marker.close();
  try {
    const sourceSha256 = await imageDigest(join(src, 'system.img')),
      images = [];
    for (const id of IDENTITY_MODELS) {
      const dir = join(temp, id);
      await mkdir(dir, { mode: 0o755 });
      for (const name of [
        'system.img',
        'encryptionkey.img',
        'vendor.img',
        'kernel-ranchu',
        'ramdisk.img',
        'build.prop',
        'advancedFeatures.ini',
        'source.properties',
        'package.xml',
        'VerifiedBootParams.textproto',
        'kernel_cmdline.txt',
      ]) {
        const from = join(src, name);
        if (!(await lstat(from)).isFile()) throw Error('IDENTITY_SOURCE_INVALID');
        await copyFile(from, join(dir, name));
        await chmod(join(dir, name), 0o644);
      }
      await cp(join(src, 'data'), join(dir, 'data'), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      await patchImage(join(dir, 'system.img'), dir, identityModel(id));
      execFileSync('/usr/bin/fallocate', ['--dig-holes', join(dir, 'system.img')], {
        stdio: 'ignore',
        timeout: 120000,
      });
      await chmod(join(dir, 'system.img'), 0o444);
      images.push({
        id,
        model: identityModel(id),
        sha256: await imageDigest(join(dir, 'system.img')),
        verified: false,
      });
    }
    await writeFile(
      join(temp, 'manifest.json'),
      JSON.stringify({
        version: 1,
        sdkRoot: resolve(sdk),
        sourceSha256,
        testImage: true,
        verifiedBootDisabled: true,
        images,
      }),
      { mode: 0o644 },
    );
    await rename(temp, root);
  } catch (e) {
    await rm(temp, { recursive: true, force: true });
    throw e;
  }
}

async function patchExt4(
  file: string,
  offset: number,
  length: number,
  output: Awaited<ReturnType<typeof open>>,
  model: string,
) {
  const debug = (command: string) =>
    execFileSync('/usr/sbin/debugfs', ['-R', command, file], {
      encoding: 'utf8',
      maxBuffer: 262144,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  const input = await open(file, 'r'),
    sb = Buffer.alloc(1024);
  try {
    await input.read(sb, 0, 1024, 1024);
  } finally {
    await input.close();
  }
  if (sb.readUInt16LE(56) !== 0xef53 || sb.readUInt32LE(24) > 6)
    throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
  const block = 1024 * 2 ** sb.readUInt32LE(24);
  let changed = 0;
  for (const path of [
    '/system/build.prop',
    '/build.prop',
    '/system/etc/prop.default',
    '/etc/build.prop',
  ]) {
    const original = debug('cat ' + path);
    if (!original) continue;
    const patch = propertyPatch(original, model);
    if (!patch.changed) continue;
    const bytes = Buffer.from(patch.text);
    for (let at = 0; at < bytes.length; at += block) {
      const mapped = debug('bmap ' + path + ' ' + Math.floor(at / block)).trim();
      if (!/^[1-9][0-9]*$/.test(mapped) || Number(mapped) * block + block > length)
        throw Error('IDENTITY_LAYOUT_UNSUPPORTED');
      const data = bytes.subarray(at, Math.min(bytes.length, at + block));
      await output.write(data, 0, data.length, offset + Number(mapped) * block);
    }
    changed += patch.changed;
  }
  return changed;
}

export async function buildPhoneImages(sdk: string) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw Error('IDENTITY_ROOT_REQUIRED');
  await buildIdentityImages(sdk);
  const root = phoneImageRoot(sdk);
  try {
    await lstat(root);
    await (await import('@apk/automation')).phoneManifest(sdk, true);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const temp = root + '.building';
  await mkdir(temp, { recursive: true, mode: 0o755 });
  const lock = await open(join(temp, 'build.lock'), 'wx', 0o600);
  await lock.close();
  try {
    const images = [];
    for (const variant of DEVICE_CATALOG) {
      const src = join(sdk, 'system-images/android-' + variant.apiLevel + '/google_apis/x86_64'),
        dir = join(temp, variant.id);
      const space = await (await import('node:fs/promises')).statfs(temp);
      if (space.bavail * space.bsize < (await lstat(join(src, 'system.img'))).size + 20 * 1024 ** 3)
        throw Error('IDENTITY_DISK_LOW');
      await mkdir(dir, { mode: 0o755 });
      for (const name of await (await import('node:fs/promises')).readdir(src)) {
        if (name.includes('/') || name.startsWith('.')) continue;
        const from = join(src, name),
          info = await lstat(from);
        if (info.isSymbolicLink()) throw Error('IDENTITY_SOURCE_INVALID');
        if (info.isDirectory())
          await cp(from, join(dir, name), {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
        else if (info.isFile()) {
          await copyFile(from, join(dir, name));
          await chmod(join(dir, name), 0o644);
        }
      }
      await patchImage(join(dir, 'system.img'), dir, variant.model);
      const vendor = join(dir, 'vendor.img');
      try {
        const stat = await lstat(vendor);
        if (stat.isFile()) {
          const handle = await open(vendor, 'r+');
          const magic = Buffer.alloc(2);
          try {
            await handle.read(magic, 0, 2, 1080);
            if (magic.readUInt16LE(0) === 0xef53)
              await patchExt4(vendor, 0, stat.size, handle, variant.model);
          } finally {
            await handle.close();
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      execFileSync('/usr/bin/fallocate', ['--dig-holes', join(dir, 'system.img')], {
        stdio: 'ignore',
        timeout: 120000,
      });
      await chmod(join(dir, 'system.img'), 0o444);
      images.push({
        id: variant.id,
        model: variant.model,
        apiLevel: variant.apiLevel,
        sha256: await imageDigest(join(dir, 'system.img')),
        sourceSha256: await imageDigest(join(src, 'system.img')),
        verified: false,
      });
    }
    await writeFile(
      join(temp, 'manifest.json'),
      JSON.stringify({
        version: 2,
        sdkRoot: resolve(sdk),
        testImage: true,
        verifiedBootDisabled: true,
        images,
      }),
      { mode: 0o644 },
    );
    await rename(temp, root);
  } catch (e) {
    await rm(temp, { recursive: true, force: true });
    throw e;
  }
}
