import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import { canonical, digest, validManifest } from '@apk/platform';
import {
  agentProtocolsForVersion,
  cachedApkSelectionSupported,
  dailySupported,
  deviceSessionsSupported,
  autoRegistrationSupported,
  appOpenSupported,
  parallelAppOpenSupported,
  ownedTestSupported,
  identitySupported,
  requiredAgentProtocolsReady,
} from '@apk/contracts';

test('the actual publisher version and capability list pass manifest and runtime gates', async () => {
  const schema = JSON.parse(await readFile('contracts/p1.schema.json', 'utf8'));
  const publisher = await readFile('scripts/release-agent.mjs', 'utf8');
  const body = publisher.match(/features:\s*\[([\s\S]*?)\]/)[1];
  const features = [...body.matchAll(/'([A-Z_0-9]+)'/g)].map((m) => m[1]);
  const validate = new Ajv2020().compile(schema.$defs.ReleaseInput.properties.features);
  assert.equal(features.length, 17);
  assert.ok(features.includes('XPATH_OBSERVATION_V1'));
  assert.equal(validate(features), true, JSON.stringify(validate.errors));
  assert.equal(validate([...features, 'UNRECOGNIZED_FEATURE']), false);
  assert.equal(validate([...features.slice(0, -1), features[0]]), false);

  const agentVersion = publisher.match(/agentVersion:\s*'([0-9.]+)'/)[1];
  const sha256 = 'a'.repeat(64);
  const toolchain = {
    nodeVersion: '24.18.0',
    nodeUrl: 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz',
    nodeSha256: sha256,
    playwrightVersion: '1.56.1',
    appiumVersion: '3.9.0',
    uiautomator2Version: '8.7.2',
    npmLockSha256: sha256,
    systemImage: 'system-images;android-35;google_apis;x86_64',
    archives: ['cmdlineTools', 'emulator', 'platformTools', 'systemImage'].map((role) => ({
      role,
      url: `https://dl.google.com/android/repository/${role}.zip`,
      checksum: 'sha256:' + sha256,
      revision: '1.0.0',
    })),
    extraSystemImages: [34, 36].map((apiLevel) => ({
      role: 'systemImage',
      apiLevel,
      url: `https://dl.google.com/android/repository/sys-img/google_apis/fixture-${apiLevel}.zip`,
      checksum: 'sha256:' + sha256,
      revision: '1.0.0',
    })),
  };
  const recipeSha256 = 'b'.repeat(64);
  const manifest = {
    id: randomUUID(),
    gitCommit: 'c'.repeat(40),
    agentVersion,
    protocolVersion: '1.0',
    features,
    artifactName: 'agent-' + sha256 + '.tgz',
    sha256,
    playbookSha256: sha256,
    toolchain,
    environment: {
      version: 1,
      recipeSha256,
      fingerprint: digest(canonical({ version: 1, toolchain, recipeSha256 })),
    },
    signature: Buffer.alloc(64).toString('base64'),
  };
  assert.equal(validManifest(manifest).agentVersion, agentVersion);
  const legacyToolchain = {
    ...toolchain,
    extraSystemImages: [
      ...toolchain.extraSystemImages,
      ...[29, 31, 33].map((apiLevel) => ({ ...toolchain.extraSystemImages[0], apiLevel })),
    ],
  };
  const legacy = {
    ...manifest,
    agentVersion: '0.17.7',
    toolchain: legacyToolchain,
    environment: {
      ...manifest.environment,
      fingerprint: digest(canonical({ version: 1, toolchain: legacyToolchain, recipeSha256 })),
    },
  };
  assert.equal(validManifest(legacy).agentVersion, '0.17.7');
  assert.throws(() => validManifest({ ...legacy, agentVersion }), /多版本系统镜像/);
  assert.deepEqual(agentProtocolsForVersion(agentVersion), { download: true, registration: true });
  assert.equal(cachedApkSelectionSupported(features, agentVersion), true);
  assert.equal(deviceSessionsSupported(features, agentVersion), true);
  assert.throws(() => validManifest({ ...manifest, agentVersion: '0.17.99' }), /XPath/);
  assert.throws(
    () =>
      validManifest({ ...manifest, environment: { ...manifest.environment, fingerprint: sha256 } }),
    /环境摘要/,
  );
});

test('signed 0.12 releases retain all managed-task gates, while missing features and unknown versions fail closed', () => {
  const gates = [
    [dailySupported, 'DAILY_V1'],
    [autoRegistrationSupported, 'AUTO_REGISTRATION_V1'],
    [appOpenSupported, 'APP_OPEN_V1'],
    [parallelAppOpenSupported, 'APP_OPEN_PARALLEL_V1'],
    [ownedTestSupported, 'OWNED_TEST_CLIENT_V1'],
    [identitySupported, 'DEVICE_VARIANTS_V1'],
  ];
  for (const [supported, feature] of gates) {
    for (const version of [
      '0.12.0',
      '0.12.1',
      '0.12.2',
      '0.12.3',
      '0.13.0',
      '0.13.1',
      '0.13.2',
      '0.13.3',
      '0.14.0',
      '0.14.1',
    ]) {
      assert.equal(supported([feature], version), true, feature + ':' + version);
      assert.equal(supported([], version), false);
    }
    for (const version of [null, undefined, '', '0.12.4', '1.0.0', '0.12.2-unverified'])
      assert.equal(supported([feature], version), false);
  }
  assert.equal(dailySupported(['DAILY_V1'], '0.5.0'), true);
  assert.equal(autoRegistrationSupported(['AUTO_REGISTRATION_V1'], '0.5.0'), false);
  assert.equal(autoRegistrationSupported(['AUTO_REGISTRATION_V1'], '0.6.0'), true);
  assert.equal(requiredAgentProtocolsReady([], {}), true);
  assert.equal(requiredAgentProtocolsReady(undefined, {}), true);
  const execution = ['DOWNLOAD_V1', 'REGISTRATION_V1'];
  assert.equal(requiredAgentProtocolsReady(execution, {}), false);
  assert.equal(requiredAgentProtocolsReady(execution, { downloadProtocol: '1.0' }), false);
  assert.equal(
    requiredAgentProtocolsReady(execution, {
      downloadProtocol: '1.0',
      registrationProtocol: '1.0',
    }),
    true,
  );
});
