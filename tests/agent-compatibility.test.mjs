import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  dailySupported,
  autoRegistrationSupported,
  appOpenSupported,
  parallelAppOpenSupported,
  ownedTestSupported,
  identitySupported,
  requiredAgentProtocolsReady,
} from '@apk/contracts';

test('the actual publisher capability list fits the signed manifest schema while unknown and duplicate capabilities fail', async () => {
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
