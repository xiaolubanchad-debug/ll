import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
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
} finally {
  const target = resolve(dir);
  if (target.startsWith(base + sep)) await rm(target, { recursive: true, force: true });
}
