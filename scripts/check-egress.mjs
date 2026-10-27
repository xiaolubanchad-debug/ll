import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { firewallRules } from '../apps/agent/dist/egress.js';
const rule = firewallRules(65534, ['93.184.216.34', '2606:4700:4700::1111'], 443, false);
assert.throws(() => firewallRules(0, [], 443, false));
assert.throws(() => firewallRules(65534, ['host;command'], 443, false));
assert.throws(() => firewallRules(65534, [], 99999, false));
assert.ok(rule.includes('policy accept;'));
assert.ok(
  rule
    .split('\n')
    .filter((line) => line.includes('reject'))
    .every((line) => line.includes('meta skuid 65534')),
);
assert.ok(!rule.includes('flush ruleset'));
assert.ok(!rule.includes('hook input'));
await mkdir('.tmp', { recursive: true });
await writeFile('.tmp/egress-check.nft', rule, { mode: 0o600 });
console.log('Dedicated account egress rules generated for syntax check; no rules applied.');
