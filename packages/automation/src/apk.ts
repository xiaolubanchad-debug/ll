import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import type { ApkMetadata } from '@apk/contracts';
import { DownloadError } from './common.js';
const table = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc(data: Buffer, current = 0xffffffff) {
  for (const b of data) current = table[(current ^ b) & 255] ^ (current >>> 8);
  return current >>> 0;
}
function manifest(bytes: Buffer) {
  const fail = () => {
    throw new DownloadError('APK_INVALID');
  };
  const u16 = (p: number) => {
    if (p < 0 || p + 2 > bytes.length) return fail();
    return bytes.readUInt16LE(p);
  };
  const u32 = (p: number) => {
    if (p < 0 || p + 4 > bytes.length) return fail();
    return bytes.readUInt32LE(p);
  };
  if (u16(0) !== 3 || u32(4) !== bytes.length) fail();
  let strings: string[] = [];
  for (let at = u16(2); at < bytes.length; ) {
    const type = u16(at),
      header = u16(at + 2),
      size = u32(at + 4),
      end = at + size;
    if (header < 8 || size < header || end > bytes.length) fail();
    if (type === 1) {
      const count = u32(at + 8),
        flags = u32(at + 16),
        start = at + u32(at + 20);
      if (count > 100000 || header < 28 || at + header + count * 4 > end) fail();
      strings = [];
      for (let i = 0; i < count; i++) {
        let p = start + u32(at + header + i * 4);
        if (p < start || p >= end) fail();
        if (flags & 0x100) {
          const len = () => {
            const n = bytes[p++];
            if (n === undefined || p > end) fail();
            return n & 128 ? ((n & 127) << 8) | bytes[p++] : n;
          };
          len();
          const n = len();
          if (p + n >= end || bytes[p + n] !== 0) fail();
          strings.push(bytes.subarray(p, p + n).toString('utf8'));
        } else {
          let n = u16(p);
          p += 2;
          if (n & 0x8000) {
            n = ((n & 0x7fff) << 16) | u16(p);
            p += 2;
          }
          if (p + n * 2 + 2 > end || u16(p + n * 2) !== 0) fail();
          strings.push(bytes.subarray(p, p + n * 2).toString('utf16le'));
        }
      }
    }
    if (type === 0x102 && strings[u32(at + 20)] === 'manifest') {
      const count = u16(at + 28),
        stride = u16(at + 26),
        start = at + 16 + u16(at + 24);
      if (stride < 20 || count > 1000 || start + stride * count > end) fail();
      const result: Record<string, string | number> = {};
      for (let i = 0; i < count; i++) {
        const p = start + i * stride,
          key = strings[u32(p + 4)],
          raw = u32(p + 8),
          kind = bytes[p + 15],
          data = u32(p + 16);
        if (['package', 'versionName', 'versionCode'].includes(key)) {
          if (raw !== 0xffffffff) result[key] = strings[raw];
          else if (kind === 3) result[key] = strings[data];
          else if (kind === 0x10 || kind === 0x11) result[key] = data;
        }
      }
      if (
        typeof result.package !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(result.package) ||
        result.package.length > 256
      )
        fail();
      return {
        packageName: result.package as string,
        versionName:
          typeof result.versionName === 'string' ? result.versionName.slice(0, 256) : null,
        versionCode: typeof result.versionCode === 'number' ? result.versionCode : null,
      };
    }
    at = end;
  }
  return fail();
}
export async function inspectApk(
  file: string,
  maxBytes: number,
  day: string,
  signal: AbortSignal,
): Promise<ApkMetadata> {
  const info = await stat(file);
  if (!info.isFile() || info.size < 32 || info.size > maxBytes)
    throw new DownloadError(info.size > maxBytes ? 'APK_TOO_LARGE' : 'APK_INVALID');
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file, { signal })) hash.update(bytes);
  const zip = await new Promise<ZipFile>((ok, no) =>
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => (error || !zip ? no(new DownloadError('APK_INVALID')) : ok(zip)),
    ),
  );
  try {
    return await new Promise<ApkMetadata>((ok, no) => {
      let total = 0,
        count = 0,
        axml: Buffer | undefined;
      const names = new Set<string>(),
        abis = new Set<string>();
      const fail = () => {
        zip.close();
        no(new DownloadError(signal.aborted ? 'CANCELLED' : 'APK_INVALID'));
      };
      const abort = () => fail();
      signal.addEventListener('abort', abort, { once: true });
      zip.once('close', () => signal.removeEventListener('abort', abort));
      zip.once('error', fail);
      zip.on('entry', (entry: Entry) => {
        count++;
        total += entry.uncompressedSize;
        const name = entry.fileName;
        if (
          count > 20000 ||
          total > Math.max(maxBytes * 4, 16 * 1024 * 1024) ||
          total > 1024 ** 3 ||
          names.has(name) ||
          name.startsWith('/') ||
          name.split('/').some((s) => s === '..') ||
          entry.generalPurposeBitFlag & 1 ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
        ) {
          fail();
          return;
        }
        names.add(name);
        const abi = name.match(/^lib\/([A-Za-z0-9_-]{1,40})\/[^/]+\.so$/)?.[1];
        if (abi) abis.add(abi);
        if (name.endsWith('/')) {
          zip.readEntry();
          return;
        }
        if (name === 'AndroidManifest.xml' && entry.uncompressedSize > 4 * 1024 * 1024) {
          fail();
          return;
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) {
            fail();
            return;
          }
          let sum = 0xffffffff;
          const chunks: Buffer[] = [];
          stream.on('data', (b: Buffer) => {
            sum = crc(b, sum);
            if (name === 'AndroidManifest.xml') chunks.push(b);
            if (signal.aborted) {
              stream.destroy();
              fail();
            }
          });
          stream.once('error', fail);
          stream.once('end', () => {
            if ((sum ^ 0xffffffff) >>> 0 !== entry.crc32) {
              fail();
              return;
            }
            if (name === 'AndroidManifest.xml') axml = Buffer.concat(chunks);
            zip.readEntry();
          });
        });
      });
      zip.once('end', () => {
        try {
          if (!axml) throw new DownloadError('APK_INVALID');
          ok({
            ...manifest(axml),
            abis: [...abis].sort(),
            size: info.size,
            apkSha256: hash.digest('hex'),
            cacheDay: day,
          });
        } catch {
          fail();
        }
      });
      if (signal.aborted) fail();
      else zip.readEntry();
    });
  } finally {
    zip.close();
  }
}
