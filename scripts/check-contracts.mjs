import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { configurationIssues, agentIssues } from '../packages/contracts/dist/index.js';

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

function markdownFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['.git', '.venv', '.tmp', 'node_modules', 'archive'].includes(entry.name)) return [];
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
process.stdout.write(
  `${passed} contract checks passed${process.exitCode ? '; failures present' : ''}.\n`,
);
