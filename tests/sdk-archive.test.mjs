import test from 'node:test';
import assert from 'node:assert/strict';
import { sdkArchive } from '../scripts/release-agent.mjs';

const base = 'https://dl.google.com/android/repository/';
const archive = (major, channel, preview = '') =>
  `<remotePackage path="emulator"><revision><major>${major}</major><minor>0</minor><micro>1</micro>${preview}</revision>${channel}<archives><archive><host-os>linux</host-os><complete><checksum type="sha1">${'a'.repeat(40)}</checksum><url>emulator-${major}.zip</url></complete></archive></archives></remotePackage>`;

test('publishing selects a stable archive when a newer preview appears first', () => {
  const xml =
    '<sdk-repository>' +
    archive(99, '<channelRef ref="channel-2"/>') +
    archive(37, '<channelRef ref="channel-0"/>') +
    '</sdk-repository>';
  const result = sdkArchive(xml, 'emulator', 'emulator', base);
  assert.equal(result.revision, '37.0.1');
  assert.equal(result.url, base + 'emulator-37.zip');
});

test('publishing rejects preview-only metadata, including a preview revision mislabeled stable', () => {
  for (const body of [
    archive(99, '<channelRef ref="channel-2"/>'),
    archive(99, '<channelRef ref="channel-0"/>', '<preview>1</preview>'),
  ])
    assert.throws(
      () =>
        sdkArchive('<sdk-repository>' + body + '</sdk-repository>', 'emulator', 'emulator', base),
      /SDK_PACKAGE_MISSING/,
    );
});

test('older metadata without channelRef retains stable compatibility', () => {
  assert.equal(
    sdkArchive(
      '<sdk-repository>' + archive(36, '') + '</sdk-repository>',
      'emulator',
      'emulator',
      base,
    ).revision,
    '36.0.1',
  );
});
