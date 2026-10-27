import { DatabaseSync } from 'node:sqlite';
import { mkdir, lstat, rename, unlink, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { ApkMetadata } from '@apk/contracts';
import { inspectApk } from './apk.js';
import { sha, DownloadError } from './common.js';
export class ApkCache {
  readonly db: DatabaseSync;
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
    this.db = new DatabaseSync(join(this.root, 'cache.sqlite'));
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, node TEXT NOT NULL, day TEXT NOT NULL, target TEXT NOT NULL, metadata TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0);',
    );
  }
  static async open(root: string) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(join(root, 'files'), { recursive: true, mode: 0o700 });
    return new ApkCache(root);
  }
  key(node: string, day: string, target: string) {
    return sha(JSON.stringify([node, day, target]));
  }
  path(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new DownloadError('CACHE_INVALID');
    return join(this.root, 'files', key + '.apk');
  }
  async get(node: string, day: string, target: string, max: number, signal: AbortSignal) {
    const key = this.key(node, day, target),
      row = this.db.prepare('SELECT metadata FROM cache WHERE key=?').get(key);
    if (!row) return null;
    try {
      const info = await lstat(this.path(key));
      if (info.isSymbolicLink()) throw new Error();
      const expected = JSON.parse(String(row.metadata)) as ApkMetadata;
      const actual = await inspectApk(this.path(key), max, day, signal);
      if (actual.apkSha256 !== expected.apkSha256 || actual.size !== expected.size)
        throw new Error();
      return actual;
    } catch (error) {
      if (signal.aborted) throw error;
      this.db.prepare('DELETE FROM cache WHERE key=?').run(key);
      await unlink(this.path(key)).catch(() => {});
      return null;
    }
  }
  async put(node: string, day: string, target: string, temp: string, metadata: ApkMetadata) {
    const key = this.key(node, day, target);
    await unlink(this.path(key)).catch(() => {});
    await rename(temp, this.path(key));
    this.db
      .prepare(
        'INSERT OR REPLACE INTO cache (key,node,day,target,metadata,active) VALUES (?,?,?,?,?,1)',
      )
      .run(key, node, day, target, JSON.stringify(metadata));
  }
  pin(node: string, day: string, target: string) {
    this.db.prepare('UPDATE cache SET active=1 WHERE key=?').run(this.key(node, day, target));
  }
  releasePins() {
    this.db.prepare('UPDATE cache SET active=0').run();
  }
  async prune(beforeDay: string) {
    const rows = this.db.prepare('SELECT key FROM cache WHERE day < ? AND active=0').all(beforeDay);
    for (const row of rows) {
      await unlink(this.path(String(row.key))).catch(() => {});
      this.db.prepare('DELETE FROM cache WHERE key=?').run(row.key);
    }
  }
  close() {
    this.db.close();
  }
}
export async function removeOwned(base: string, path: string) {
  const parent = resolve(base) + sep,
    target = resolve(path);
  if (!target.startsWith(parent)) throw new DownloadError('CLEANUP_INCOMPLETE');
  await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
