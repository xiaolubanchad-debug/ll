import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { releasePlan } from './release-plan.mjs';
const plan = releasePlan(process.argv[2]);
if (execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
  throw Error('SOURCE_DIRTY');
const startedAt = new Date().toISOString(),
  checks = [];
const run = (args) => {
  execFileSync(process.execPath, args, { stdio: 'inherit', windowsHide: true });
  checks.push(args);
};
if (!process.env.npm_execpath) throw Error('RUN_WITH_NPM');
for (const command of ['db:generate', 'check:contracts', 'lint', 'typecheck'])
  run([process.env.npm_execpath, 'run', command]);
if (plan.modules.length) run(['scripts/build-target.mjs', ...plan.modules]);
if (plan.tests.length) {
  if (!plan.modules.includes('tools') && !plan.modules.includes('api'))
    run(['scripts/build-target.mjs', 'api']);
  run([
    'scripts/test-p0.mjs',
    ...(plan.tests.includes('ALL') ? [] : ['--only', plan.tests.join(',')]),
  ]);
}
const receipt = {
  version: 1,
  from: plan.from,
  to: plan.to,
  planSha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
  startedAt,
  finishedAt: new Date().toISOString(),
  checks,
  passed: true,
};
await writeFile('.tmp/release-verification.json', JSON.stringify(receipt, null, 2) + '\n', {
  mode: 0o600,
});
console.log('RELEASE_VERIFIED ' + plan.to);
