import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ApkCache, inspectApk } from '@apk/automation';
import { schemaIssues } from '@apk/contracts';
import type { ManualApkImportInput, ManualApkImportReceipt } from '@apk/contracts';

// Only signed deployment tooling calls this function; it never installs or launches an APK.
export async function importCachedApk(
  input: ManualApkImportInput,
  file: string,
  cacheRoot: string,
) {
  if (schemaIssues('ManualApkImportInput', input).length) throw Error('APK_IMPORT_INVALID');
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  if (input.cacheDay !== day) throw Error('APK_IMPORT_EXPIRED');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('APK_IMPORT_INVALID');
  const actual = await inspectApk(
    file,
    input.maxBytes,
    input.cacheDay,
    AbortSignal.timeout(120000),
  );
  const stable = (value: unknown): string =>
    JSON.stringify(Object.entries(value as object).sort(([a], [b]) => a.localeCompare(b)));
  if (stable(actual) !== stable(input.apk)) throw Error('APK_IMPORT_INVALID');
  const cache = await ApkCache.open(cacheRoot);
  try {
    await cache.put(input.nodeId, input.cacheDay, input.targetKey, file, actual);
    cache.releasePins();
    const confirmed = await cache.get(
      input.nodeId,
      input.cacheDay,
      input.targetKey,
      input.maxBytes,
      AbortSignal.timeout(120000),
    );
    if (!confirmed || stable(confirmed) !== stable(actual)) throw Error('APK_IMPORT_INVALID');
    const receipt: ManualApkImportReceipt = {
      id: input.id,
      status: 'CACHED',
      cacheKey: cache.key(input.nodeId, input.cacheDay, input.targetKey),
      apk: confirmed,
    };
    return receipt;
  } finally {
    cache.close();
  }
}
export async function importFromJob(path: string) {
  if (!/^\/var\/lib\/apk-platform\/manual-import\/[a-f0-9-]{36}\/input\.json$/.test(path))
    throw Error('APK_IMPORT_INVALID');
  for (const candidate of [path, path.slice(0, path.lastIndexOf('/'))]) {
    if ((await lstat(candidate)).isSymbolicLink()) throw Error('APK_IMPORT_INVALID');
  }
  const input = JSON.parse(await readFile(path, 'utf8'));
  return importCachedApk(
    input,
    join(path, '..', 'payload.apk'),
    '/var/lib/apk-platform/execution/downloads/cache',
  );
}
