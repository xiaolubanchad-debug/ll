import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { executionOSSupported } from '@apk/contracts';
import { parseInspection } from '../apps/deploy-worker/dist/worker.js';
const executable = process.argv[2];
if (process.platform !== 'linux' || !executable) throw Error('LINUX_AND_ANSIBLE_REQUIRED');
const matrix = JSON.parse(await readFile('contracts/fixtures/execution-platforms.json', 'utf8'));
const base = resolve('.tmp');
await mkdir(base, { recursive: true });
const dir = await mkdtemp(join(base, 'platform-matrix-'));
try {
  const book = join(dir, 'check.yml');
  await writeFile(
    book,
    '- hosts: localhost\n  gather_facts: false\n  tasks:\n    - ansible.builtin.import_tasks: ' +
      JSON.stringify(resolve('deploy/ansible/tasks/platform-check.yml')) +
      '\n',
  );
  for (const row of matrix) {
    const { distribution, version, arch, errors } = row;
    assert.equal(executionOSSupported(distribution, version), !errors.includes('UNSUPPORTED_OS'));
    const report = parseInspection(
      `UBUNTU=${distribution}:${version}\nARCH=${arch}\nMEMORY=32768000\nDISK=53687091200\nKVM=1\nSUDO=1\nMARKER=0\n`,
    );
    assert.deepEqual(report.errors, errors);
    let failed = false;
    try {
      execFileSync(
        executable,
        [
          '-i',
          'localhost,',
          '-c',
          'local',
          book,
          '--extra-vars',
          JSON.stringify({
            ansible_facts: {
              distribution: distribution === 'ubuntu' ? 'Ubuntu' : 'Debian',
              distribution_version: version,
              architecture: arch,
            },
          }),
        ],
        { stdio: 'pipe', timeout: 30000 },
      );
    } catch (error) {
      if (!error.status) throw error;
      failed = true;
      assert.ok(error.stdout.toString().includes(errors[0]));
    }
    assert.equal(failed, errors.length > 0, `${distribution}:${version}/${arch}`);
    console.log(`PASS platform ${distribution}:${version}/${arch}`);
  }
} finally {
  const target = resolve(dir);
  if (target.startsWith(base + sep)) await rm(target, { recursive: true, force: true });
}
