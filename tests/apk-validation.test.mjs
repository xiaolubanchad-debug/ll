import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { inspectApk, ApkValidationError } from '../packages/automation/dist/apk.js';
import { fixtureApk, zip } from './p2-fixtures.mjs';

// Owned binary-XML structure fixture, not an installable application.
function manifest({ rawIntegers = true, preview = false, packageName = 'com.example.owned' } = {}) {
  const strings = [
    'manifest',
    'package',
    'versionName',
    'versionCode',
    'uses-sdk',
    'minSdkVersion',
    packageName,
    '1.2.3',
    '29',
    '12',
    'Preview',
  ];
  const chunks = strings.map((s) =>
      Buffer.concat([
        Buffer.from([s.length, Buffer.byteLength(s)]),
        Buffer.from(s),
        Buffer.alloc(1),
      ]),
    ),
    data = Buffer.concat(chunks);
  const pool = Buffer.alloc(Math.ceil((28 + 4 * strings.length + data.length) / 4) * 4);
  pool.writeUInt16LE(1);
  pool.writeUInt16LE(28, 2);
  pool.writeUInt32LE(pool.length, 4);
  pool.writeUInt32LE(strings.length, 8);
  pool.writeUInt32LE(0x100, 16);
  pool.writeUInt32LE(28 + 4 * strings.length, 20);
  let offset = 0;
  chunks.forEach((b, i) => {
    pool.writeUInt32LE(offset, 28 + i * 4);
    offset += b.length;
  });
  data.copy(pool, 28 + 4 * strings.length);
  const attribute = (key, kind, value, raw = 0xffffffff) => {
    const a = Buffer.alloc(20);
    a.writeUInt32LE(0xffffffff);
    a.writeUInt32LE(key, 4);
    a.writeUInt32LE(raw, 8);
    a.writeUInt16LE(8, 12);
    a[15] = kind;
    a.writeUInt32LE(value, 16);
    return a;
  };
  const start = (name, attrs) => {
    const b = Buffer.alloc(36);
    b.writeUInt16LE(0x102);
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(36 + 20 * attrs.length, 4);
    b.writeUInt32LE(0xffffffff, 12);
    b.writeUInt32LE(0xffffffff, 16);
    b.writeUInt32LE(name, 20);
    b.writeUInt16LE(20, 24);
    b.writeUInt16LE(20, 26);
    b.writeUInt16LE(attrs.length, 28);
    return Buffer.concat([b, ...attrs]);
  };
  const end = (name) => {
    const b = Buffer.alloc(24);
    b.writeUInt16LE(0x103);
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(24, 4);
    b.writeUInt32LE(0xffffffff, 12);
    b.writeUInt32LE(0xffffffff, 16);
    b.writeUInt32LE(name, 20);
    return b;
  };
  const body = Buffer.concat([
      pool,
      start(0, [
        attribute(1, 3, 6, 6),
        attribute(2, 3, 7, 7),
        attribute(3, 0x10, 12, rawIntegers ? 9 : 0xffffffff),
      ]),
      start(4, [attribute(5, preview ? 3 : 0x10, preview ? 10 : 29, rawIntegers ? 8 : 0xffffffff)]),
      end(4),
      end(0),
    ]),
    header = Buffer.alloc(8);
  header.writeUInt16LE(3);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}
test('typed integer attributes take priority over raw text without loosening APK integrity checks', async (t) => {
  const dir = await mkdtemp(resolve('.tmp/apk-validation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'owned.apk'),
    signal = new AbortController().signal;
  async function inspect(bytes) {
    await writeFile(file, bytes);
    return inspectApk(file, 268435456, '2026-11-02', signal);
  }
  for (const rawIntegers of [false, true]) {
    const apk = await inspect(zip([['AndroidManifest.xml', manifest({ rawIntegers })]]));
    assert.equal(apk.minSdkVersion, 29);
    assert.equal(apk.versionCode, 12);
    assert.equal(apk.packageName, 'com.example.owned');
  }
  const brokenCrc = fixtureApk();
  brokenCrc[30 + Buffer.byteLength('AndroidManifest.xml') + 10] ^= 1;
  for (const [reason, bytes] of [
    ['TOO_SMALL', Buffer.from('invalid')],
    ['NOT_ZIP', Buffer.from('<html>' + 'owned error page '.repeat(5) + '</html>')],
    ['ZIP_STRUCTURE', fixtureApk().subarray(0, 80)],
    ['CRC', brokenCrc],
    ['MANIFEST_MISSING', zip([['classes.dex', Buffer.alloc(200)]])],
    [
      'ZIP_POLICY',
      zip([
        ['AndroidManifest.xml', manifest()],
        ['AndroidManifest.xml', manifest()],
      ]),
    ],
    ['MANIFEST_FORMAT', zip([['AndroidManifest.xml', Buffer.alloc(100)]])],
    ['MANIFEST_METADATA', zip([['AndroidManifest.xml', manifest({ preview: true })]])],
    [
      'MANIFEST_METADATA',
      zip([['AndroidManifest.xml', manifest({ packageName: 'invalid package' })]]),
    ],
  ])
    await assert.rejects(
      inspect(bytes),
      (e) => e instanceof ApkValidationError && e.code === 'APK_INVALID' && e.reason === reason,
      reason,
    );
});
