import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { resolve, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { renderInventory } from '../apps/deploy-worker/dist/runner.js';
if (process.platform !== 'linux') throw Error('LINUX_REQUIRED');
const executable = process.argv[2];
if (!executable) throw Error('ANSIBLE_PLAYBOOK_REQUIRED');
const base = resolve('.tmp');
await mkdir(base, { recursive: true });
const dir = await mkdtemp(join(base, 'ansible-literals-'));
try {
  const literal = '{{ 2 + 2 }}\nquotes: "test" $() ` ; \\';
  const inventory = join(dir, 'hosts.yml');
  await writeFile(
    inventory,
    renderInventory({
      ansible_connection: 'local',
      ansible_password: literal,
      ansible_become_password: literal,
    }),
    { mode: 0o600 },
  );
  const playbook = join(dir, 'check.yml');
  await writeFile(
    playbook,
    '- hosts: target\n  gather_facts: false\n  vars:\n    expected: !unsafe ' +
      JSON.stringify(literal) +
      '\n  tasks:\n    - ansible.builtin.assert:\n        that:\n          - ansible_password == expected\n          - ansible_become_password == expected\n      no_log: true\n',
    { mode: 0o600 },
  );
  execFileSync(executable, ['-i', inventory, playbook], { stdio: 'pipe', timeout: 30000 });
  console.log('Ansible preserved literal SSH and sudo credentials.');
  const unit = join(dir, 'apk-agent.service');
  await writeFile(
    playbook,
    '- hosts: target\n  gather_facts: false\n  tasks:\n    - ansible.builtin.template:\n        src: ' +
      JSON.stringify(resolve('deploy/ansible/templates/apk-agent.service.j2')) +
      '\n        dest: ' +
      JSON.stringify(unit) +
      '\n',
  );
  for (const [agentVersion, enabled] of [
    ['0.2.0', false],
    ['0.3.4', true],
    ['9.9.9', true],
    ['0.3.4', undefined],
  ]) {
    const variables = join(dir, 'unit-vars.json');
    await writeFile(
      variables,
      JSON.stringify({
        deployment_id: 'owned-fixture-deployment',
        agent_config: {
          agentVersion,
          sdkRoot: '/owned-fixture/sdk',
          toolsRoot: '/owned-fixture/tools',
        },
        ...(enabled === undefined ? {} : { download_enabled: enabled }),
      }),
      { mode: 0o600 },
    );
    if (enabled === undefined) {
      assert.throws(() =>
        execFileSync(executable, ['-i', inventory, playbook, '--extra-vars', '@' + variables], {
          stdio: 'pipe',
          timeout: 30000,
        }),
      );
      continue;
    }
    execFileSync(executable, ['-i', inventory, playbook, '--extra-vars', '@' + variables], {
      stdio: 'pipe',
      timeout: 30000,
    });
    const text = await readFile(unit, 'utf8');
    const prestart = text.split('\n').filter((line) => line.startsWith('ExecStartPre='));
    assert.deepEqual(
      prestart,
      enabled
        ? [
            'ExecStartPre=+/opt/apk-platform/runtime/node/bin/node /opt/apk-platform/current/egress.js',
          ]
        : [],
    );
    assert.ok(text.includes('User=apk-runner\n'));
  }
  console.log(
    'Ansible Agent unit enables fixed egress preparation by capability; missing switch is rejected.',
  );
} finally {
  const target = resolve(dir);
  if (target.startsWith(base + sep)) await rm(target, { recursive: true, force: true });
}
