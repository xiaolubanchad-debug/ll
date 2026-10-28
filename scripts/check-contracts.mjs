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
process.stdout.write(
  `${passed} contract checks passed${process.exitCode ? '; failures present' : ''}.\n`,
);
