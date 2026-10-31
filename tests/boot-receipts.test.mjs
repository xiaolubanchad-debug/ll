import test from 'node:test';
import assert from 'node:assert/strict';
import { verifiedBootReceipts } from '../apps/agent/dist/boot-receipts.js';
import { propertyPatch } from '../apps/agent/dist/identity-builder.js';

test('longer phone properties reuse only generated comment space, preserving file size and system facts', () => {
  const body =
    'ro.product.vendor.model=ranchu\nro.product.vendor.brand=google\nro.product.vendor.manufacturer=Google\nro.build.version.sdk=31\nro.build.fingerprint=original\n';
  const original = '# Copyright original owner\n# begin common generated build properties\n' + body;
  const result = propertyPatch(original, '21081111RG');
  assert.equal(Buffer.byteLength(result.text), Buffer.byteLength(original));
  assert.ok(result.text.includes('ro.product.vendor.model=21081111RG\n'));
  for (const fact of [
    '# Copyright original owner',
    'ro.build.version.sdk=31',
    'ro.build.fingerprint=original',
  ])
    assert.ok(result.text.includes(fact));
  assert.throws(() => propertyPatch(body, '21081111RG'), /IDENTITY_PROPERTY_SPACE/);
});

test('sealed boot receipt reuse binds all models, real APIs, digests, ABI and SDK', () => {
  const sdk = '/opt/apk-platform/toolchains/' + 'a'.repeat(64) + '/android';
  const images = Array.from({ length: 33 }, (_, i) => ({
    id: 'image-' + i,
    model: 'Model ' + i,
    apiLevel: i < 3 ? undefined : 29 + (i % 8),
    sha256: i.toString(16).padStart(64, '0'),
    vendorSha256: i < 3 ? undefined : 'b'.repeat(64),
    systemDir: '/unused',
  }));
  const proof = {
    version: 1,
    sdkRoot: sdk,
    images: images.map((i) => ({
      ...i,
      apiLevel: i.apiLevel ?? 35,
      supportedAbis: ['x86_64', 'arm64-v8a'],
    })),
  };
  assert.equal(verifiedBootReceipts(proof, sdk, images).size, 33);
  for (const change of [
    (p) => (p.sdkRoot += '/other'),
    (p) => p.images.pop(),
    (p) => p.images.push(p.images[0]),
    (p) => (p.images[32].id = p.images[0].id),
    (p) => (p.images[0].model = 'Other'),
    (p) => (p.images[3].apiLevel = 99),
    (p) => (p.images[4].sha256 = 'f'.repeat(64)),
    (p) => (p.images[4].vendorSha256 = 'f'.repeat(64)),
    (p) => delete p.images[4].vendorSha256,
    (p) => (p.images[5].supportedAbis = []),
    (p) => (p.images[6].supportedAbis = ['x86_64', 'x86_64']),
    (p) => (p.images[7].supportedAbis = ['x86_64;bad']),
    (p) => (p.images[8] = null),
  ]) {
    const bad = structuredClone(proof);
    change(bad);
    assert.throws(() => verifiedBootReceipts(bad, sdk, images), /IDENTITY_PROOF_INVALID/);
  }
  assert.throws(() => verifiedBootReceipts(null, sdk, images), /IDENTITY_PROOF_INVALID/);
  const changedAbi = structuredClone(images);
  changedAbi[0].supportedAbis = ['x86'];
  assert.throws(() => verifiedBootReceipts(proof, sdk, changedAbi), /IDENTITY_PROOF_INVALID/);
});
