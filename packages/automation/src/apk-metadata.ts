import { constants } from 'node:fs';
import { open, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createInflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { ApkMetadata } from '@apk/contracts';
import { DownloadError } from './common.js';

const unreadable = () => new DownloadError('APK_METADATA_UNREADABLE');
const MAX_DIRECTORY = 32 * 1024 * 1024;
const MAX_MANIFEST = 256 * 1024 * 1024;
async function bytes(file: FileHandle, at: number, count: number, end: number) {
  if (
    !Number.isSafeInteger(at) ||
    !Number.isSafeInteger(count) ||
    at < 0 ||
    count < 0 ||
    at + count > end
  )
    throw unreadable();
  const out = Buffer.alloc(count);
  let read = 0;
  while (read < count) {
    const result = await file.read(out, read, count - read, at + read);
    if (!result.bytesRead) throw unreadable();
    read += result.bytesRead;
  }
  return out;
}
function u64(b: Buffer, at: number) {
  const n = Number(b.readBigUInt64LE(at));
  if (!Number.isSafeInteger(n) || n < 0) throw unreadable();
  return n;
}
type Entry = { offset: number; compressed: number; method: number };
async function directory(file: FileHandle, size: number, signal: AbortSignal) {
  const tail = await bytes(file, Math.max(0, size - 131072), Math.min(size, 131072), size);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) {
      end = i;
      break;
    }
  }
  if (end < 0) throw unreadable();
  let length = tail.readUInt32LE(end + 12),
    offset = tail.readUInt32LE(end + 16);
  if (length === 0xffffffff || offset === 0xffffffff) {
    const absolute = size - tail.length + end;
    const locator = await bytes(file, absolute - 20, 20, size);
    if (locator.readUInt32LE(0) !== 0x07064b50) throw unreadable();
    const record = await bytes(file, u64(locator, 8), 56, size);
    if (record.readUInt32LE(0) !== 0x06064b50) throw unreadable();
    length = u64(record, 40);
    offset = u64(record, 48);
  }
  if (length > MAX_DIRECTORY) throw unreadable();
  const records = await bytes(file, offset, length, size),
    abis = new Set<string>();
  const known = new Set([
    'armeabi',
    'armeabi-v7a',
    'arm64-v8a',
    'x86',
    'x86_64',
    'mips',
    'mips64',
    'riscv64',
  ]);
  let manifest: Entry | undefined;
  for (let at = 0; at + 46 <= records.length; ) {
    signal.throwIfAborted();
    if (records.readUInt32LE(at) !== 0x02014b50) break;
    const n = records.readUInt16LE(at + 28),
      extra = records.readUInt16LE(at + 30),
      comment = records.readUInt16LE(at + 32),
      next = at + 46 + n + extra + comment;
    if (next > records.length) throw unreadable();
    const name = records.subarray(at + 46, at + 46 + n).toString('utf8');
    const abi = /^lib\/([^/]+)\/[^/]+\.so$/.exec(name)?.[1];
    if (abi && known.has(abi)) abis.add(abi);
    if (name === 'AndroidManifest.xml' && !manifest) {
      let compressed = records.readUInt32LE(at + 20),
        uncompressed = records.readUInt32LE(at + 24),
        local = records.readUInt32LE(at + 42);
      const extras = records.subarray(at + 46 + n, at + 46 + n + extra);
      for (let p = 0; p + 4 <= extras.length; ) {
        const id = extras.readUInt16LE(p),
          len = extras.readUInt16LE(p + 2),
          stop = p + 4 + len;
        if (stop > extras.length) throw unreadable();
        if (id === 1) {
          let q = p + 4;
          if (uncompressed === 0xffffffff) {
            uncompressed = u64(extras, q);
            q += 8;
          }
          if (compressed === 0xffffffff) {
            compressed = u64(extras, q);
            q += 8;
          }
          if (local === 0xffffffff) local = u64(extras, q);
        }
        p = stop;
      }
      manifest = { offset: local, compressed, method: records.readUInt16LE(at + 10) };
    }
    // Other names are metadata only. Never extract an archive entry to its name.
    at = next;
  }
  if (!manifest) throw unreadable();
  return { manifest, abis: [...abis].sort() };
}
async function manifestInfo(file: FileHandle, size: number, signal: AbortSignal) {
  const root = await bytes(file, 0, 8, size);
  if (root.readUInt16LE(0) !== 3) throw unreadable();
  let pool: { start: number; end: number; offsets: Buffer; utf8: boolean } | undefined;
  const strings = new Map<number, string>();
  const string = async (index: number) => {
    if (strings.has(index)) return strings.get(index)!;
    if (!pool || index < 0 || index >= pool.offsets.length / 4) return '';
    let at = pool.start + pool.offsets.readUInt32LE(index * 4),
      n: number;
    if (pool.utf8) {
      const length = async () => {
        const b = await bytes(file, at, 1, pool!.end);
        at++;
        if (b[0] & 128) {
          const more = await bytes(file, at, 1, pool!.end);
          at++;
          return ((b[0] & 127) << 8) | more[0];
        }
        return b[0];
      };
      await length();
      n = await length();
      if (at + n > pool.end) throw unreadable();
      const text = (await bytes(file, at, Math.min(n, 1024), pool.end))
        .toString('utf8')
        .slice(0, 257);
      strings.set(index, text);
      return text;
    }
    const first = (await bytes(file, at, 2, pool.end)).readUInt16LE();
    at += 2;
    n = first;
    if (first & 0x8000) {
      n = (first & 0x7fff) * 65536 + (await bytes(file, at, 2, pool.end)).readUInt16LE();
      at += 2;
    }
    if (at + n * 2 > pool.end) throw unreadable();
    const text = (await bytes(file, at, Math.min(n, 257) * 2, pool.end)).toString('utf16le');
    strings.set(index, text);
    return text;
  };
  let result:
    | { packageName: string; versionName: string | null; versionCode: number | null }
    | undefined;
  let minSdkVersion = 1;
  const finish = () => {
    if (!result) throw unreadable();
    return { ...result, minSdkVersion };
  };
  let chunks = 0;
  for (let at = root.readUInt16LE(2); at + 8 <= size; ) {
    signal.throwIfAborted();
    if (++chunks > 100000) throw unreadable();
    const h = await bytes(file, at, 8, size),
      type = h.readUInt16LE(0),
      header = h.readUInt16LE(2),
      length = h.readUInt32LE(4),
      end = at + length;
    if (header < 8 || length < header || end > size) throw unreadable();
    if (type === 1) {
      const h = await bytes(file, at, 28, end),
        count = h.readUInt32LE(8);
      if (count > 1000000 || header < 28 || at + header + count * 4 > end) throw unreadable();
      pool = {
        start: at + h.readUInt32LE(20),
        end,
        offsets: await bytes(file, at + header, count * 4, end),
        utf8: !!(h.readUInt32LE(16) & 0x100),
      };
      strings.clear();
    }
    if (type === 0x102) {
      const h = await bytes(file, at, 36, end),
        tag = await string(h.readUInt32LE(20));
      if (tag === 'manifest' || tag === 'uses-sdk') {
        const count = h.readUInt16LE(28),
          stride = h.readUInt16LE(26),
          start = at + 16 + h.readUInt16LE(24),
          values: Record<string, string | number> = {};
        if (stride < 20 || count > 10000) throw unreadable();
        const attrs = await bytes(file, start, stride * count, end);
        for (let i = 0; i < count; i++) {
          const p = i * stride,
            key = await string(attrs.readUInt32LE(p + 4));
          if (!['package', 'versionName', 'versionCode', 'minSdkVersion'].includes(key)) continue;
          const kind = attrs[p + 15],
            data = attrs.readUInt32LE(p + 16),
            raw = attrs.readUInt32LE(p + 8);
          if (kind === 0x10 || kind === 0x11) values[key] = data;
          else if (kind === 3) values[key] = await string(data);
          else if (raw !== 0xffffffff) values[key] = await string(raw);
        }
        if (tag === 'manifest') {
          if (
            typeof values.package !== 'string' ||
            values.package.length > 256 ||
            !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(values.package)
          )
            throw unreadable();
          result = {
            packageName: values.package,
            versionName:
              typeof values.versionName === 'string' ? values.versionName.slice(0, 256) : null,
            versionCode: typeof values.versionCode === 'number' ? values.versionCode : null,
          };
        } else {
          minSdkVersion = Number(values.minSdkVersion ?? 1);
          if (!Number.isInteger(minSdkVersion) || minSdkVersion < 1 || minSdkVersion > 1000)
            throw unreadable();
          if (result) return finish();
        }
      }
    }
    if (type === 0x103) {
      const h = await bytes(file, at, 24, end);
      if ((await string(h.readUInt32LE(20))) === 'manifest') return finish();
    }
    at = end;
  }
  return finish();
}
/** Read only the fields needed to install/launch. This does not validate an APK. */
export async function readApkMetadata(
  path: string,
  maxBytes: number,
  day: string,
  signal: AbortSignal,
): Promise<ApkMetadata> {
  const base = resolve(tmpdir(), 'apk-metadata');
  let work: string | undefined, file: FileHandle | undefined;
  try {
    signal.throwIfAborted();
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw unreadable();
    const size = Number(before.size);
    if (size > maxBytes) throw new DownloadError('APK_TOO_LARGE');
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const { manifest, abis } = await directory(file, size, signal),
      local = await bytes(file, manifest.offset, 30, size);
    if (
      local.readUInt32LE(0) !== 0x04034b50 ||
      ![0, 8].includes(manifest.method) ||
      manifest.compressed < 1
    )
      throw unreadable();
    const start = manifest.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    if (start + manifest.compressed > size) throw unreadable();
    await mkdir(base, { recursive: true, mode: 0o700 });
    if ((await lstat(base)).isSymbolicLink()) throw unreadable();
    work = await mkdtemp(join(base, 'read-'));
    const target = join(work, 'manifest.bin');
    let total = 0;
    const source = file.createReadStream({
      start,
      end: start + manifest.compressed - 1,
      autoClose: false,
    });
    const limit = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        total += chunk.length;
        callback(total > MAX_MANIFEST ? unreadable() : null, chunk);
      },
    });
    if (manifest.method === 8)
      await pipeline(
        source,
        createInflateRaw(),
        limit,
        createWriteStream(target, { flags: 'wx', mode: 0o600 }),
        { signal },
      );
    else
      await pipeline(source, limit, createWriteStream(target, { flags: 'wx', mode: 0o600 }), {
        signal,
      });
    const xml = await open(target, 'r');
    let metadata;
    try {
      metadata = await manifestInfo(xml, total, signal);
    } finally {
      await xml.close();
    }
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({
      start: 0,
      end: size - 1,
      autoClose: false,
      signal,
    }))
      hash.update(chunk);
    const after = await lstat(path, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new DownloadError('FILE_TRANSFER_MISMATCH');
    return {
      ...metadata,
      abis,
      size,
      apkSha256: hash.digest('hex'),
      cacheDay: day,
      validationPolicy: 'ANDROID_INSTALL',
    };
  } catch (error) {
    if (signal.aborted) throw new DownloadError('CANCELLED');
    if (error instanceof DownloadError) throw error;
    throw unreadable();
  } finally {
    await file?.close().catch(() => {});
    if (work && resolve(work).startsWith(base + sep))
      await rm(work, { recursive: true, force: true });
  }
}
