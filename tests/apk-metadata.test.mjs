import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  readApkMetadata,
  inspectApk,
  verifyFileTransfer,
} from '../packages/automation/dist/apk.js';
import { ApkCache } from '../packages/automation/dist/cache.js';
import { fixtureApk } from './p2-fixtures.mjs';
const crc = (b) => {
  let c = 0xffffffff;
  for (const n of b) {
    c ^= n;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};
function zip(entries) {
  let offset = 0;
  const local = [],
    central = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name),
      data = entry.data,
      compressed = deflateRawSync(data),
      sum = entry.crc ?? crc(data),
      h = Buffer.alloc(30),
      c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(sum, 14);
    h.writeUInt32LE(compressed.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(name.length, 26);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(sum, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    local.push(h, name, compressed);
    central.push(c, name);
    offset += h.length + name.length + compressed.length;
  }
  const cd = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
const original = fixtureApk('com.example.ownedmetadata'),
  nameLen = original.readUInt16LE(26),
  xml = original.subarray(30 + nameLen, 30 + nameLen + original.readUInt32LE(18));
function inflatedPool() {
  const poolSize = xml.readUInt32LE(12),
    padding = Buffer.alloc(8 * 1024 * 1024),
    b = Buffer.concat([xml.subarray(0, 8 + poolSize), padding, xml.subarray(8 + poolSize)]);
  b.writeUInt32LE(b.length, 4);
  b.writeUInt32LE(poolSize + padding.length, 12);
  return b;
}
function prefixedPadding() {
  const padding = Buffer.alloc(8 * 1024 * 1024 + 8);
  padding.writeUInt16LE(0x4321);
  padding.writeUInt16LE(8, 2);
  padding.writeUInt32LE(padding.length, 4);
  const b = Buffer.concat([xml.subarray(0, 8), padding, xml.subarray(8)]);
  b.writeUInt32LE(b.length, 4);
  return b;
}

test('metadata-only accepts inflated manifests, unrelated malformed names and incorrect CRC without extracting APK entries', async (t) => {
  const dir = await mkdtemp(resolve('.tmp/apk-metadata-')),
    before = await readdir(join(tmpdir(), 'apk-metadata')).catch(() => []),
    signal = AbortSignal.timeout(60000),
    day = '2026-11-02';
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cases = [
    ['normal', original],
    ['inflated-pool', zip([{ name: 'AndroidManifest.xml', data: inflatedPool() }])],
    ['padding-before-pool', zip([{ name: 'AndroidManifest.xml', data: prefixedPadding() }])],
    [
      'unrelated-paths',
      zip([
        { name: '/AndroidManifest.xml///.xml', data: Buffer.from('owned decoy') },
        { name: 'AndroidManifest.xml/\\.xml', data: Buffer.from('owned decoy') },
        { name: 'AndroidManifest.xml', data: xml },
      ]),
    ],
    [
      'wrong-crc',
      zip([
        { name: 'AndroidManifest.xml', data: xml, crc: 0 },
        { name: 'assets/owned.txt', data: Buffer.from('owned fixture'), crc: 0 },
      ]),
    ],
  ];
  for (const [name, bytes] of cases)
    await t.test(name, async () => {
      const path = join(dir, name + '.apk');
      await writeFile(path, bytes);
      const metadata = await readApkMetadata(path, 536870912, day, signal);
      assert.equal(metadata.packageName, 'com.example.ownedmetadata');
      assert.equal(metadata.minSdkVersion, 1);
      assert.equal(metadata.validationPolicy, 'ANDROID_INSTALL');
      assert.equal(metadata.apkSha256, createHash('sha256').update(bytes).digest('hex'));
      if (name !== 'normal') await assert.rejects(inspectApk(path, 536870912, day, signal));
      await verifyFileTransfer(path, metadata, 536870912, signal);
    });
  assert.deepEqual((await readdir(join(tmpdir(), 'apk-metadata'))).sort(), before.sort());
  assert.equal((await readdir(dir)).filter((n) => !n.endsWith('.apk')).length, 0);
});

test('cache confirms transferred bytes, retains metadata policy and reports unreadable metadata separately', async (t) => {
  const dir = await mkdtemp(resolve('.tmp/apk-metadata-cache-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'owned.apk'),
    day = '2026-11-02',
    signal = AbortSignal.timeout(30000),
    bytes = zip([{ name: 'AndroidManifest.xml', data: xml, crc: 0 }]);
  await writeFile(path, bytes);
  const metadata = await readApkMetadata(path, 536870912, day, signal),
    cache = await ApkCache.open(join(dir, 'cache'));
  try {
    await cache.put('owned-node', day, 'owned-target', path, metadata);
    assert.deepEqual(
      await cache.get('owned-node', day, 'owned-target', 536870912, signal),
      metadata,
    );
    const cachePath = cache.path(cache.key('owned-node', day, 'owned-target')),
      changed = await readFile(cachePath);
    changed[changed.length - 1] ^= 1;
    await writeFile(cachePath, changed);
    await assert.rejects(
      verifyFileTransfer(cachePath, metadata, 536870912, signal),
      (e) => e.code === 'FILE_TRANSFER_MISMATCH',
    );
    assert.equal(await cache.get('owned-node', day, 'owned-target', 536870912, signal), null);
  } finally {
    cache.close();
  }
  await writeFile(path, 'owned non-APK sample');
  await assert.rejects(
    readApkMetadata(path, 536870912, day, signal),
    (e) => e.code === 'APK_METADATA_UNREADABLE',
  );
  await assert.rejects(readApkMetadata(path, 1, day, signal), (e) => e.code === 'APK_TOO_LARGE');
  await assert.rejects(
    readApkMetadata(path, 536870912, day, AbortSignal.abort()),
    (e) => e.code === 'CANCELLED',
  );
});

test('APK acceptance reaches Android installation and retains its actual rejection without a CRC gate', async (t) => {
  const { openApk } = await import('../packages/automation/dist/app-open.js'),
    { RegistrationError } = await import('../packages/automation/dist/registration-types.js');
  const dir = await mkdtemp(resolve('.tmp/apk-install-decides-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'owned.apk'),
    day = '2026-11-02';
  await writeFile(file, zip([{ name: 'AndroidManifest.xml', data: xml, crc: 0 }]));
  const signal = AbortSignal.timeout(30000),
    apk = await readApkMetadata(file, 536870912, day, signal),
    config = JSON.parse(await readFile('contracts/fixtures/config.app-open.valid.json', 'utf8'));
  let installs = 0,
    closed = false;
  const stages = [];
  const result = await openApk(
    config,
    { taskId: '11111111-1111-4111-8111-111111111111' },
    apk,
    file,
    0,
    signal,
    async (e) => {
      if (e.type === 'TASK_STAGE') stages.push(e.payload.stage);
    },
    {
      root: dir,
      sdkRoot: dir,
      toolsRoot: dir,
      proxy: { host: 'proxy.example.test', port: 10000, username: 'owned', password: 'owned' },
      beforeAction() {},
      resources: async () => {},
      androidFactory: async () => ({
        supportedAbis: [],
        observation: { profileId: 'owned' },
        install: async (path) => {
          installs++;
          assert.equal(path, file);
          throw new RegistrationError('APK_INSTALL_FAILED');
        },
        launch: async () => {
          throw Error('must not launch after failed install');
        },
        close: async () => {
          closed = true;
          return true;
        },
      }),
    },
  );
  assert.equal(installs, 1);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.errorCode, 'APK_INSTALL_FAILED');
  assert.equal(closed, true);
  assert.ok(stages.includes('INSTALLING'));
  assert.ok(!stages.includes('LAUNCHING'));
});
