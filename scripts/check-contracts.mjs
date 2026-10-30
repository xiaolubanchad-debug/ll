import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {
  configurationIssues,
  agentIssues,
  schemaIssues,
  registrationFlowFor,
} from '../packages/contracts/dist/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
// Conditional required fields are declared in their enclosing object schemas.
addFormats(ajv);
const configCheck = ajv.compile(read('contracts/config.schema.json'));
const agentCheck = ajv.compile(read('contracts/agent.schema.json'));
const config = read('contracts/fixtures/config.valid.json');
const messages = read('contracts/fixtures/agent.valid.json');
let passed = 0;
for (const userAgent of [
  'Mozilla/5.0 (iPhone) Mobile Safari/605.1',
  'Mozilla/5.0 (Windows NT 10.0) Chrome/149.0',
  'Android Mobile Chrome/149.0\nInjected: value',
])
  test('1.9 rejects non-Android browser ' + JSON.stringify(userAgent), () =>
    assert.ok(
      configurationIssues({ ...config, source: { ...config.source, browserUserAgent: userAgent } })
        .length,
    ),
  );
const browserEvent = {
  eventId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  sequence: 1,
  occurredAt: '2026-10-29T00:00:00Z',
  type: 'BROWSER_ENVIRONMENT',
  payload: {
    role: 'LANDING',
    platform: 'Android',
    mobile: true,
    touch: true,
    width: 412,
    height: 915,
    userAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/149.0.0.0 Mobile Safari/537.36',
    scope: 'EMULATED_BROWSER',
  },
};
const notes = {
  kind: 'events',
  protocolVersion: '1.0',
  nodeId: '22222222-2222-4222-8222-222222222222',
  deliveryId: '33333333-3333-4333-8333-333333333333',
  fence: 1,
  events: [browserEvent],
};
test('1.9 Android browser evidence accepted', () => assert.deepEqual(agentIssues(notes), []));
test('1.9 desktop client hint rejected', () =>
  assert.ok(
    agentIssues({
      ...notes,
      events: [{ ...browserEvent, payload: { ...browserEvent.payload, mobile: false } }],
    }).length,
  ));
test('1.9 raw browser cookie rejected', () =>
  assert.ok(
    agentIssues({
      ...notes,
      events: [{ ...browserEvent, payload: { ...browserEvent.payload, cookie: 'forbidden' } }],
    }).length,
  ));
const obstruction = {
  ...browserEvent,
  type: 'APP_OBSTRUCTION',
  taskId: '44444444-4444-4444-8444-444444444444',
  payload: { action: 'CLOSE_AD', method: 'CONTROLS', index: 1 },
};
test('1.9 bounded ad closure accepted', () =>
  assert.deepEqual(agentIssues({ ...notes, events: [obstruction] }), []));
test('1.9 unbounded ad closure rejected', () =>
  assert.ok(
    agentIssues({
      ...notes,
      events: [{ ...obstruction, payload: { ...obstruction.payload, index: 13 } }],
    }).length,
  ));
test('1.9 purchase cannot be recorded as closure', () =>
  assert.ok(
    agentIssues({
      ...notes,
      events: [{ ...obstruction, payload: { ...obstruction.payload, action: 'BUY' } }],
    }).length,
  ));
const v18 = read('contracts/fixtures/v18.valid.json');
for (const phase of ['DETECTED', 'WAITING', 'ACTION_SENT', 'CLEARED', 'UNCHANGED', 'UNVERIFIED'])
  test('1.11 bounded obstruction phase ' + phase, () =>
    assert.deepEqual(
      agentIssues({
        ...notes,
        events: [{ ...obstruction, payload: { ...obstruction.payload, phase } }],
      }),
      [],
    ),
  );
test('1.11 icon action requires phase', () =>
  assert.ok(
    agentIssues({
      ...notes,
      events: [{ ...obstruction, payload: { ...obstruction.payload, method: 'ICON' } }],
    }).length,
  ));
test('1.11 countdown cannot claim cleared', () =>
  assert.ok(
    agentIssues({
      ...notes,
      events: [
        {
          ...obstruction,
          payload: { ...obstruction.payload, action: 'WAIT_SPLASH', phase: 'CLEARED' },
        },
      ],
    }).length,
  ));
for (const value of [
  {},
  { confirmationTimeoutMs: 3000, splashTimeoutMs: 15000, iconRecognition: true },
])
  test('1.11 startup policy accepts bounded defaults', () =>
    assert.deepEqual(schemaIssues('StartupPolicy', value), []));
for (const value of [
  { confirmationTimeoutMs: 150 },
  { maxActions: 13 },
  { splashTimeoutMs: 999999 },
  { screenshot: 'private' },
  { iconRecognition: 'yes' },
])
  test('1.11 startup policy rejects unbounded or raw settings', () =>
    assert.ok(schemaIssues('StartupPolicy', value).length));
for (const [name, value] of [
  ['TaskPlanInput', v18.task],
  ['TaskControlInput', v18.control],
  ['TaskControlInput', { action: 'RETRY_DOWNLOAD' }],
  ['MaintenanceInput', v18.maintenance],
])
  test('1.8 valid ' + name, () => assert.deepEqual(schemaIssues(name, value), []));
for (const [name, value] of [
  ['TaskControlInput', { action: 'FORCE_RETRY' }],
  ['TaskPlanInput', { ...v18.task, sshPassword: 'forbidden' }],
  ['MaintenanceInput', { ...v18.maintenance, items: [] }],
  ['MaintenanceInput', { action: 'DELETE', items: [{ ...v18.maintenance.items[0], revision: 0 }] }],
  ['TaskPlanQuery', { limit: '101' }],
  ['MaintenanceQuery', { kind: 'ANY_TABLE' }],
])
  test('1.8 rejects ' + name, () => assert.ok(schemaIssues(name, value).length));
for (const [name, value] of Object.entries(read('contracts/fixtures/v17.valid.json')))
  test('1.7 valid ' + name, () => assert.deepEqual(schemaIssues(name, value), []));
for (const [name, value] of [
  ['ResultsQuery', { from: '2026-10-29', limit: '101' }],
  ['ResultsQuery', { category: 'ASSUME_SUCCESS' }],
  ['ResultsQuery', { username: 'private-account' }],
  ['ResultsQuery', { q: 'line\nbreak' }],
  ['TimelineQuery', { afterSequence: '1', beforeSequence: '2' }],
  ['TimelineQuery', { afterSequence: '-1' }],
  ['AssetQuery', { url: 'http://untrusted.example' }],
])
  test('1.7 rejects ' + JSON.stringify(value), () => assert.ok(schemaIssues(name, value).length));
const v15Examples = read('contracts/fixtures/v15.valid.json');
const v16Examples = read('contracts/fixtures/v16.valid.json');
for (const [name, value] of Object.entries(v16Examples))
  test('1.6 valid ' + name, () => assert.deepEqual(schemaIssues(name, value), []));
test('1.6 embedded recognition settings match the versioned schema', () =>
  assert.deepEqual(
    read('contracts/config.schema.json').properties.execution.properties.autoRegistration,
    read('contracts/v16.schema.json').$defs.AutoRegistration,
  ));
test('1.6 excessive navigation is rejected', () =>
  assert.ok(
    schemaIssues('AutoRegistration', { ...v16Examples.AutoRegistration, maxNavigationSteps: 13 })
      .length,
  ));
test('1.6 unbounded discovery time is rejected', () =>
  assert.ok(
    schemaIssues('AutoRegistration', { ...v16Examples.AutoRegistration, timeoutMs: 90001 }).length,
  ));
test('1.6 arbitrary visual service endpoint is rejected', () =>
  assert.ok(
    schemaIssues('AutoRegistration', {
      ...v16Examples.AutoRegistration,
      url: 'https://untrusted.example.test',
    }).length,
  ));
test('1.6 account text cannot enter recognition metadata', () =>
  assert.ok(
    schemaIssues('RegistrationRecognition', {
      ...v16Examples.RegistrationRecognition,
      username: 'real-account',
    }).length,
  ));
test('1.6 learned recipes cannot contain execution commands', () =>
  assert.ok(
    schemaIssues('LearnedRegistrationTemplate', {
      ...v16Examples.LearnedRegistrationTemplate,
      navigation: [{ ...v16Examples.LearnedRegistrationTemplate.navigation[0], role: 'EXEC' }],
    }).length,
  ));
test('1.6 automatic recognition requires full mode', () => {
  const c = structuredClone(config);
  c.execution.mode = 'DOWNLOAD_ONLY';
  delete c.execution.proxySecretVersionId;
  c.execution.autoRegistration = structuredClone(v16Examples.AutoRegistration);
  assert.ok(configurationIssues(c).length);
});
test('1.6 automatic recognition does not require a manual flow', () => {
  const c = structuredClone(config);
  c.execution.autoRegistration = structuredClone(v16Examples.AutoRegistration);
  c.registrationFlows = [];
  assert.deepEqual(configurationIssues(c), []);
});
test('1.6 capability allows four declared features', () => {
  const check = ajv.compile(
    read('contracts/p1.schema.json').$defs.ReleaseInput.properties.features,
  );
  assert.ok(check(['DOWNLOAD_V1', 'REGISTRATION_V1', 'DAILY_V1', 'AUTO_REGISTRATION_V1']));
  assert.equal(check(['DOWNLOAD_V1', 'ARBITRARY_CODE']), false);
});
test('1.6 adaptation stop is an allowed terminal event', () => {
  const input = structuredClone(messages.find((m) => m.kind === 'events'));
  input.events = [
    {
      ...input.events[0],
      type: 'RUN_FINISHED',
      payload: { status: 'FAILED', errorCode: 'AUTO_ADAPTATION_REQUIRED' },
    },
  ];
  delete input.events[0].taskId;
  assert.deepEqual(agentIssues(input), []);
});
for (const [name, value] of Object.entries(v15Examples)) {
  test('1.5 valid ' + name, () => assert.deepEqual(schemaIssues(name, value), []));
}
test('1.5 capability list accepts three declared capabilities', () => {
  const validate = ajv.compile(
    read('contracts/p1.schema.json').$defs.ReleaseInput.properties.features,
  );
  assert.ok(validate(['DOWNLOAD_V1', 'REGISTRATION_V1', 'DAILY_V1']));
  assert.equal(validate(['DOWNLOAD_V1', 'ARBITRARY_CODE']), false);
});
test('1.5 invalid local time rejected', () =>
  assert.ok(schemaIssues('ScheduleInput', { ...v15Examples.ScheduleInput, time: '24:05' }).length));
test('1.5 zero attempt limit rejected', () =>
  assert.ok(
    schemaIssues('ScheduleInput', { ...v15Examples.ScheduleInput, attemptLimit: 0 }).length,
  ));
test('1.5 plaintext schedule secret rejected', () =>
  assert.ok(
    schemaIssues('ScheduleInput', { ...v15Examples.ScheduleInput, proxyPassword: 'forbidden' })
      .length,
  ));
test('1.5 arbitrary execution purpose rejected', () =>
  assert.ok(
    schemaIssues('DailyExecutionPlan', { ...v15Examples.DailyExecutionPlan, purpose: 'EXEC_SHELL' })
      .length,
  ));

function semanticConfig(value) {
  assert.deepEqual(configurationIssues(value), []);
}

function semanticAgent(value) {
  assert.deepEqual(agentIssues(value), []);
}

function valid(check, semantic, value) {
  assert.ok(check(value), JSON.stringify(check.errors));
  semantic(value);
}

function test(name, fn) {
  try {
    fn();
    passed++;
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

function reject(name, original, mutation, check, semantic) {
  test(name, () => {
    const value = structuredClone(original);
    mutation(value);
    assert.throws(() => valid(check, semantic, value));
  });
}

test('full config example', () => valid(configCheck, semanticConfig, config));
test('download-only config without proxy', () => {
  const value = structuredClone(config);
  value.execution.mode = 'DOWNLOAD_ONLY';
  delete value.execution.proxySecretVersionId;
  value.registrationFlows = [];
  valid(configCheck, semanticConfig, value);
});
for (const message of messages)
  test(`agent ${message.kind}`, () => valid(agentCheck, semanticAgent, message));

const configReject = (name, fn) => reject(name, config, fn, configCheck, semanticConfig);
test('1.5 entry template supports changing package names', () => {
  const c = structuredClone(config);
  c.registrationFlows[0].entryId = '2692';
  c.registrationFlows[0].packageName = '*';
  c.registrationFlows[0].activity = '@launcher';
  valid(configCheck, semanticConfig, c);
  assert.ok(registrationFlowFor(c, 'com.example.today', '2692') === undefined); // Fixture stays disabled until explicitly enabled.
  c.registrationFlows[0].enabled = true;
  assert.ok(registrationFlowFor(c, 'com.example.today', '2692'));
  assert.ok(registrationFlowFor(c, 'com.example.tomorrow', '2692'));
  assert.equal(registrationFlowFor(c, 'com.example.today', 'other'), undefined);
});
configReject('1.5 unscoped package wildcard rejected', (c) => {
  c.registrationFlows[0].packageName = '*';
});
configReject('1.5 duplicate entry templates rejected', (c) => {
  c.registrationFlows[0].entryId = '2692';
  const second = structuredClone(c.registrationFlows[0]);
  second.packageName = 'com.example.other';
  c.registrationFlows.push(second);
});
configReject('full mode requires proxy reference', (v) => delete v.execution.proxySecretVersionId);
configReject('plaintext proxy password forbidden', (v) => {
  v.execution.proxyPassword = 'example-only';
});
configReject('unsupported config version rejected', (v) => {
  v.schemaVersion = '2.0';
});
configReject('URL credentials rejected', (v) => {
  v.source.url = 'https://user:example@downloads.example.test/';
});
configReject('file URL rejected', (v) => {
  v.source.url = 'file:///etc/passwd';
});
configReject('unbounded targets rejected', (v) => {
  v.download.maxTargets = 100000;
});
configReject('duplicate device profiles rejected', (v) => {
  v.execution.deviceProfiles.push(v.execution.deviceProfiles[0]);
});
configReject('duplicate package flows rejected', (v) => {
  v.registrationFlows.push(v.registrationFlows[0]);
});
configReject('submit must exist', (v) => {
  v.registrationFlows[0].steps.pop();
});
configReject('submit cannot repeat', (v) => {
  v.registrationFlows[0].steps.push(v.registrationFlows[0].steps.at(-1));
});
configReject('submit cannot be optional', (v) => {
  v.registrationFlows[0].steps.at(-1).optional = true;
});
configReject('input cannot embed credentials', (v) => {
  v.registrationFlows[0].steps[1].text = 'actual-password';
});
configReject('arbitrary code action forbidden', (v) => {
  v.registrationFlows[0].steps[0].action = 'shell';
});
configReject('mutating step after submit forbidden', (v) => {
  v.registrationFlows[0].steps.push(v.registrationFlows[0].steps[0]);
});

const delivery = messages.find((m) => m.kind === 'delivery');
const events = messages.find((m) => m.kind === 'events');
const heartbeat = messages.find((m) => m.kind === 'heartbeat');
const account = messages.find((m) => m.kind === 'account');
reject(
  'username must be 6-10 ASCII letters',
  account,
  (v) => {
    v.username = 'user123';
  },
  agentCheck,
  semanticAgent,
);
reject(
  'password needs letters and digits',
  account,
  (v) => {
    v.password = 'lettersOnly';
  },
  agentCheck,
  semanticAgent,
);
reject(
  'password length is bounded',
  account,
  (v) => {
    v.password = 'TooLongExample123';
  },
  agentCheck,
  semanticAgent,
);
reject(
  'unsupported node protocol rejected',
  heartbeat,
  (v) => {
    v.protocolVersion = '2.0';
  },
  agentCheck,
  semanticAgent,
);
reject(
  'negative disk rejected',
  heartbeat,
  (v) => {
    v.capabilities.freeDiskBytes = -1;
  },
  agentCheck,
  semanticAgent,
);
reject(
  'fence zero rejected',
  delivery,
  (v) => {
    v.fence = 0;
  },
  agentCheck,
  semanticAgent,
);
reject(
  'lease must follow ACK deadline',
  delivery,
  (v) => {
    v.leaseExpiresAt = v.issuedAt;
  },
  agentCheck,
  semanticAgent,
);
reject(
  'duplicate event ID rejected',
  events,
  (v) => {
    v.events[1].eventId = v.events[0].eventId;
  },
  agentCheck,
  semanticAgent,
);
reject(
  'nonmonotonic event sequence rejected',
  events,
  (v) => {
    v.events[1].sequence = 1;
  },
  agentCheck,
  semanticAgent,
);
reject(
  'cross-run event batch rejected',
  events,
  (v) => {
    v.events[1].runId = v.nodeId;
  },
  agentCheck,
  semanticAgent,
);
reject(
  'unknown event type rejected',
  events,
  (v) => {
    v.events[0].type = 'EXEC_SHELL';
  },
  agentCheck,
  semanticAgent,
);
reject(
  'task result needs task ID',
  events,
  (v) => {
    delete v.events[1].taskId;
  },
  agentCheck,
  semanticAgent,
);
reject(
  'credentials cannot enter task result',
  events,
  (v) => {
    v.events[1].payload.password = 'example';
  },
  agentCheck,
  semanticAgent,
);
reject(
  'success must have proof',
  events,
  (v) => {
    v.events[1].payload.status = 'SUCCEEDED';
  },
  agentCheck,
  semanticAgent,
);
reject(
  'App UI proof needs screenshot and account reference',
  events,
  (v) => {
    v.events[1].payload.status = 'SUCCEEDED';
    v.events[1].payload.proof = 'APP_UI';
  },
  agentCheck,
  semanticAgent,
);

const p1 = read('contracts/fixtures/p1.valid.json');
for (const [name, value] of Object.entries(p1))
  test('P1 valid ' + name, () => assert.deepEqual(schemaIssues(name, value), []));
const p1Reject = (name, type, mutate) =>
  test('P1 ' + name, () => {
    const value = structuredClone(p1[type]);
    mutate(value);
    assert.ok(schemaIssues(type, value).length);
  });
p1Reject('host cannot contain shell syntax', 'NodeInput', (v) => {
  v.host = 'host;id';
});
p1Reject('SSH user cannot contain options', 'NodeInput', (v) => {
  v.username = '-oProxyCommand=id';
});
p1Reject('unknown node fields rejected', 'NodeInput', (v) => {
  v.command = 'id';
});
p1Reject('port range checked', 'NodeInput', (v) => {
  v.port = 65536;
});
p1Reject('wrong secret variant rejected', 'SecretInput', (v) => {
  v.type = 'SSH_KEY';
});
p1Reject('plaintext secret cannot enter node', 'NodeInput', (v) => {
  v.password = 'fixture';
});
p1Reject('license consent required', 'DeploymentInput', (v) => {
  v.licenseAccepted = false;
});
p1Reject('fingerprint format required', 'HostKeyInput', (v) => {
  v.expectedFingerprint = 'skip';
});
p1Reject('negative health disk rejected', 'HealthReport', (v) => {
  v.freeDiskBytes = -1;
});
p1Reject('arbitrary health details rejected', 'HealthReport', (v) => {
  v.password = 'fixture';
});
test('P1 heartbeat health shape matches shared report', () =>
  assert.deepEqual(
    read('contracts/agent.schema.json').$defs.heartbeat.properties.report,
    read('contracts/p1.schema.json').$defs.HealthReport,
  ));

const p2 = read('contracts/fixtures/p2.valid.json');
for (const { distribution, version, errors } of read('contracts/fixtures/execution-platforms.json'))
  test(`Execution OS ${distribution}:${version}`, () => {
    assert.equal(
      schemaIssues('ExecutionOS', { distribution, version }).length === 0,
      !errors.includes('UNSUPPORTED_OS'),
    );
  });
for (const [name, value] of Object.entries(p2))
  test('P2 valid ' + name, () => assert.deepEqual(schemaIssues(name, value), []));
for (const [label, type, mutate] of [
  [
    'unknown run field',
    'RunInput',
    (v) => {
      v.command = 'shell';
    },
  ],
  [
    'missing fixed config',
    'RunInput',
    (v) => {
      delete v.configVersionId;
    },
  ],
  [
    'invalid fence',
    'DeliveryConfigInput',
    (v) => {
      v.fence = 0;
    },
  ],
  [
    'unexpected plaintext secret',
    'DeliveryConfigInput',
    (v) => {
      v.password = 'fixture';
    },
  ],
  [
    'APK package format',
    'ApkMetadata',
    (v) => {
      v.packageName = '../apk';
    },
  ],
  [
    'APK size bounded',
    'ApkMetadata',
    (v) => {
      v.size = 536870913;
    },
  ],
  [
    'node reconcile cannot skip cleanup field',
    'AgentReconcileInput',
    (v) => {
      delete v.cleanupComplete;
    },
  ],
])
  test('P2 ' + label, () => {
    const value = structuredClone(p2[type]);
    mutate(value);
    assert.ok(schemaIssues(type, value).length);
  });
configReject('host egress bypass not a configuration field', (v) => {
  v.source.allowPrivateNetwork = true;
});
configReject('APK size cannot be unbounded', (v) => {
  v.download.maxApkBytes = 2 ** 40;
});
test('P2 inline APK metadata matches shared contract', () =>
  assert.deepEqual(
    read('contracts/agent.schema.json').$defs.taskStage.properties.apk,
    read('contracts/p2.schema.json').$defs.ApkMetadata,
  ));

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['.git', '.venv', '.venv-deploy', '.tmp', 'node_modules', 'archive'].includes(entry.name))
      return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? markdownFiles(full) : full.endsWith('.md') ? [full] : [];
  });
}
test('all local Markdown links resolve', () => {
  for (const file of markdownFiles(root)) {
    const body = fs.readFileSync(file, 'utf8');
    for (const match of body.matchAll(/\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const target = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      assert.ok(
        fs.existsSync(path.resolve(path.dirname(file), target)),
        `${file}: missing ${target}`,
      );
    }
  }
});

const p3 = read('contracts/fixtures/p3.valid.json');
for (const [type, value] of Object.entries(p3))
  test('P3 valid ' + type, () => assert.deepEqual(schemaIssues(type, value), []));
for (const [label, type, mutate] of [
  [
    'unmasked screenshot rejected',
    'ArtifactInput',
    (v) => {
      v.redaction = 'NONE';
    },
  ],
  [
    'artifact cannot contain arbitrary path',
    'ArtifactInput',
    (v) => {
      v.path = '/tmp/private';
    },
  ],
  [
    'invalid screenshot digest',
    'ArtifactInput',
    (v) => {
      v.sha256 = 'x';
    },
  ],
  [
    'manual unknown cannot release node',
    'TaskReconcileInput',
    (v) => {
      v.outcome = 'UNKNOWN';
    },
  ],
  [
    'manual review needs explanation',
    'TaskReconcileInput',
    (v) => {
      v.reason = 'ok';
    },
  ],
  [
    'account view reason required',
    'AccountViewInput',
    (v) => {
      delete v.reason;
    },
  ],
])
  test('P3 ' + label, () => {
    const value = structuredClone(p3[type]);
    mutate(value);
    assert.ok(schemaIssues(type, value).length);
  });
test('P3 explicit failure locator accepted', () => {
  const value = structuredClone(config);
  value.registrationFlows[0].failure = structuredClone(value.registrationFlows[0].success);
  semanticConfig(value);
});
configReject('UiAutomator cannot perform hidden clicks', (v) => {
  v.registrationFlows[0].steps[0].locator = {
    by: 'androidUiAutomator',
    value: 'new UiScrollable(new UiSelector()).scrollIntoView(new UiSelector().text("Submit"))',
  };
});
configReject('P3 back after submit is not read-only', (v) => {
  v.registrationFlows[0].steps.push({ action: 'back', timeoutMs: 1000, optional: false });
});
test('P3 immutable UiSelector accepted', () => {
  const value = structuredClone(config);
  value.registrationFlows[0].steps[0].locator = {
    by: 'androidUiAutomator',
    value: 'new UiSelector().resourceId("com.example:id/register").enabled(true)',
  };
  semanticConfig(value);
});
for (const errorCode of ['NAVIGATION_SITE', 'APP_NAVIGATION_ONLY', 'APP_AUTO_IDENTITY']) {
  const payload = {
    status: 'SKIPPED',
    proof: 'NONE',
    artifactIds: [],
    errorCode,
    ...(errorCode === 'APP_AUTO_IDENTITY'
      ? {
          recognition: {
            source: 'CONTROLS',
            navigationSteps: 1,
            cache: 'MISS',
            learned: false,
            needsAdaptation: false,
            automaticIdentity: {
              kind: 'GUEST',
              identifierHash: 'a'.repeat(64),
              scope: 'APP_UI_ONLY',
            },
          },
        }
      : {}),
  };
  const event = {
    ...browserEvent,
    taskId: '44444444-4444-4444-8444-444444444444',
    type: 'TASK_FINISHED',
    payload,
  };
  test('1.9.2 bounded skip ' + errorCode, () =>
    assert.deepEqual(agentIssues({ ...notes, events: [event] }), []),
  );
  test('1.9.2 skip cannot count as success ' + errorCode, () =>
    assert.ok(
      agentIssues({
        ...notes,
        events: [
          { ...event, payload: { ...payload, status: 'SUCCEEDED', proof: 'FILE_VALIDATION' } },
        ],
      }).length,
    ),
  );
  test('1.9.2 skip cannot carry account ' + errorCode, () =>
    assert.ok(
      agentIssues({
        ...notes,
        events: [
          { ...event, payload: { ...payload, accountRef: '55555555-5555-4555-8555-555555555555' } },
        ],
      }).length,
    ),
  );
}
for (const isolation of [undefined, true])
  test('1.10 default isolation ' + String(isolation), () => {
    const c = structuredClone(config);
    if (isolation === undefined) delete c.execution.contentIsolation;
    else c.execution.contentIsolation = isolation;
    assert.deepEqual(configurationIssues(c), []);
  });
test('1.10 cannot disable isolation', () =>
  assert.ok(
    configurationIssues({ ...config, execution: { ...config.execution, contentIsolation: false } })
      .length,
  ));
for (const patch of [
  { image: 'data:image/png;base64,abc' },
  { stage: 'DISCOVERY' },
  { controls: [{ role: 'BODY', rect: { x: 0, y: 0, width: 10, height: 10 } }] },
])
  test('1.10 rejects raw or misleading functional evidence ' + JSON.stringify(patch), () =>
    assert.ok(schemaIssues('FunctionalEvidence', { ...p3.FunctionalEvidence, ...patch }).length),
  );
test('1.10 legacy image upload disabled', () =>
  assert.ok(
    schemaIssues('ArtifactInput', {
      ...p3.ArtifactInput,
      kind: 'screenshot',
      redaction: 'CREDENTIAL_MASKED',
    }).length,
  ));
const overlayIssues = (payload) =>
  agentIssues({
    ...notes,
    events: [
      {
        ...browserEvent,
        taskId: '44444444-4444-4444-8444-444444444444',
        type: 'APP_OBSTRUCTION',
        payload,
      },
    ],
  });
test('1.11.1 overlay transition is a readonly waiting event', () =>
  assert.deepEqual(
    overlayIssues({
      action: 'WAIT_OVERLAY',
      method: 'CONTROLS',
      index: 1,
      phase: 'WAITING',
    }),
    [],
  ));
for (const phase of ['ACTION_SENT', 'CLEARED', 'UNCHANGED', undefined])
  test('1.11.1 overlay cannot mutate ' + String(phase), () =>
    assert.ok(
      overlayIssues({
        action: 'WAIT_OVERLAY',
        method: 'CONTROLS',
        index: 1,
        ...(phase ? { phase } : {}),
      }).length,
    ),
  );
test('1.11.1 native notice Back is phase-bound', () =>
  assert.deepEqual(
    overlayIssues({ action: 'CLOSE_POPUP', method: 'BACK', index: 1, phase: 'DETECTED' }),
    [],
  ));
for (const payload of [
  { action: 'CLOSE_POPUP', method: 'BACK', index: 1 },
  { action: 'SKIP_AD', method: 'BACK', index: 1, phase: 'ACTION_SENT' },
])
  test('1.11.1 invalid notice Back ' + JSON.stringify(payload), () =>
    assert.ok(overlayIssues(payload).length),
  );
test('1.11.1 startup recovery is a phase-bound native control action', () =>
  assert.deepEqual(
    overlayIssues({ action: 'RETRY_LOAD', method: 'CONTROLS', index: 1, phase: 'ACTION_SENT' }),
    [],
  ));
for (const payload of [
  { action: 'RETRY_LOAD', method: 'CONTROLS', index: 1 },
  { action: 'RETRY_LOAD', method: 'BACK', index: 1, phase: 'ACTION_SENT' },
  { action: 'RETRY_LOAD', method: 'ICON', index: 1, phase: 'ACTION_SENT' },
])
  test('1.11.1 invalid startup recovery ' + JSON.stringify(payload), () =>
    assert.ok(overlayIssues(payload).length),
  );
test('1.11.2 credential observation is an unsubmitted adaptation result', () =>
  assert.deepEqual(
    agentIssues({
      ...notes,
      events: [
        {
          ...browserEvent,
          taskId: '44444444-4444-4444-8444-444444444444',
          type: 'TASK_FINISHED',
          payload: {
            status: 'FAILED',
            proof: 'NONE',
            artifactIds: [],
            errorCode: 'AUTO_ACCOUNT_CREDENTIALS',
          },
        },
      ],
    }),
    [],
  ));
process.stdout.write(
  `${passed} contract checks passed${process.exitCode ? '; failures present' : ''}.\n`,
);
