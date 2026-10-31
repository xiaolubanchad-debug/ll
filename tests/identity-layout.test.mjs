import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, open, readFile, copyFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { patchImage } from '../apps/agent/dist/identity-builder.js';

const mib = 1024 * 1024;
const digest = (b) => createHash('sha256').update(b).digest('hex');

async function odmContainer(dir, direct) {
  const seed = join(dir, 'seed');
  await mkdir(join(seed, 'etc'), { recursive: true });
  await mkdir(join(seed, 'odm/etc'), { recursive: true });
  const body = [
    'ro.product.odm.model=Android SDK built for x86_64',
    'ro.product.odm.brand=google',
    'ro.product.odm.manufacturer=Google',
    'ro.product.cpu.abilist=x86_64,x86',
    'ro.build.version.sdk=29',
    '',
  ].join('\n');
  await writeFile(join(seed, 'etc/build.prop'), body);
  await writeFile(join(seed, 'odm/etc/build.prop'), body);
  const ext4 = join(dir, 'odm.ext4');
  const fd = await open(ext4, 'wx');
  await fd.truncate(4 * mib);
  await fd.close();
  execFileSync('/usr/sbin/mkfs.ext4', ['-q', '-F', '-b', '4096', '-d', seed, ext4], {
    stdio: 'ignore',
  });
  const image = join(dir, 'official-vendor.img');
  const f = await open(image, 'wx');
  try {
    await f.truncate(10 * mib);
    const gpt = Buffer.alloc(512);
    gpt.write('EFI PART');
    gpt.writeBigUInt64LE(2n, 72);
    gpt.writeUInt32LE(direct ? 1 : 2, 80);
    gpt.writeUInt32LE(128, 84);
    await f.write(gpt, 0, gpt.length, 512);
    const entries = Buffer.alloc(256);
    for (const [index, name, start, end] of direct
      ? [[0, 'vendor', 3 * mib, 7 * mib]]
      : [
          [0, 'super', 2 * mib, 10 * mib],
          [1, 'vbmeta', mib, mib + 4096],
        ]) {
      entries.writeBigUInt64LE(BigInt(start / 512), index * 128 + 32);
      entries.writeBigUInt64LE(BigInt(end / 512 - 1), index * 128 + 40);
      entries.write(name, index * 128 + 56, 'utf16le');
    }
    await f.write(entries, 0, entries.length, 1024);
    const metadata = Buffer.alloc(128 + 76);
    metadata.writeUInt32LE(0x414c5030, 0);
    metadata.writeUInt32LE(128, 8);
    metadata.writeUInt32LE(76, 44);
    metadata.writeUInt32LE(0, 80);
    metadata.writeUInt32LE(1, 84);
    metadata.writeUInt32LE(52, 88);
    metadata.writeUInt32LE(52, 92);
    metadata.writeUInt32LE(24, 100);
    metadata.write('odm', 128);
    metadata.writeUInt32LE(0, 128 + 40);
    metadata.writeUInt32LE(1, 128 + 44);
    metadata.writeBigUInt64LE(BigInt((4 * mib) / 512), 128 + 52);
    metadata.writeBigUInt64LE(BigInt(mib / 512), 128 + 52 + 12);
    await f.write(metadata, 0, metadata.length, 2 * mib + 12288);
    const avb = Buffer.alloc(256);
    avb.write('AVB0');
    await f.write(avb, 0, avb.length, mib);
    const data = await readFile(ext4);
    await f.write(data, 0, data.length, 3 * mib);
  } finally {
    await f.close();
  }
  return { image, body };
}

for (const direct of [false, true])
  test(
    'private GPT ODM patch preserves upstream, API and ABI: ' +
      (direct ? 'direct ext4' : 'logical super'),
    { skip: process.platform !== 'linux' },
    async () => {
      const base = resolve('.tmp');
      await mkdir(base, { recursive: true });
      const dir = await mkdtemp(join(base, 'odm-layout-'));
      try {
        const { image, body } = await odmContainer(dir, direct);
        const original = digest(await readFile(image));
        const target = join(dir, 'private-vendor.img');
        await copyFile(image, target);
        await patchImage(target, 'ELE-L29');
        assert.equal(
          digest(await readFile(image)),
          original,
          'upstream image must remain unchanged',
        );
        const actual = execFileSync(
          '/usr/sbin/debugfs',
          ['-R', 'cat /etc/build.prop', target + '?offset=' + 3 * mib],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        assert.equal(Buffer.byteLength(actual), Buffer.byteLength(body));
        assert.match(actual, /^ro.product.odm.model=ELE-L29$/m);
        assert.match(actual, /^ro.product.odm.brand=HUAWEI$/m);
        assert.match(actual, /^ro.product.odm.manufacturer=HUAWEI$/m);
        assert.match(actual, /^ro.product.cpu.abilist=x86_64,x86$/m);
        assert.match(actual, /^ro.build.version.sdk=29$/m);
        const nested = execFileSync(
          '/usr/sbin/debugfs',
          ['-R', 'cat /odm/etc/build.prop', target + '?offset=' + 3 * mib],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        );
        assert.match(nested, /^ro.product.odm.model=ELE-L29$/m);
        assert.match(nested, /^ro.product.cpu.abilist=x86_64,x86$/m);
        assert.equal((await readFile(target)).readUInt32BE(mib + 120), direct ? 0 : 3);
      } finally {
        assert.ok(resolve(dir).startsWith(base + sep));
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

test(
  'an unsupported image layout is rejected without changing its bytes',
  { skip: process.platform !== 'linux' },
  async () => {
    const base = resolve('.tmp');
    await mkdir(base, { recursive: true });
    const dir = await mkdtemp(join(base, 'invalid-layout-'));
    try {
      const image = join(dir, 'unknown.img');
      const data = Buffer.alloc(mib);
      await writeFile(image, data);
      await assert.rejects(patchImage(image, 'ELE-L29'), /IDENTITY_LAYOUT_UNSUPPORTED/);
      assert.equal(digest(await readFile(image)), digest(data));
    } finally {
      assert.ok(resolve(dir).startsWith(base + sep));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
