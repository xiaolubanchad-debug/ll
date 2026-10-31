import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dailySupported,
  autoRegistrationSupported,
  appOpenSupported,
  parallelAppOpenSupported,
  ownedTestSupported,
  identitySupported,
  requiredAgentProtocolsReady,
} from '@apk/contracts';

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
