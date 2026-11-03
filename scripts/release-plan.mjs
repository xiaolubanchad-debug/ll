import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const apiTests = {
  'admin.ts': ['api', 'web'],
  'admin-cli.ts': ['api'],
  'auth.ts': ['api', 'web', 'p1'],
  'p1-controllers.ts': ['p1', 'server-console-api'],
  'p2-controllers.ts': ['p2', 'v18'],
  'p3-controllers.ts': ['p3', 'test-data'],
  'v15-controllers.ts': ['v15-download', 'p3'],
  'v17-controllers.ts': ['v17', 'server-console-api', 'capacity-api'],
  'v18-controllers.ts': ['v18', 'v181', 'server-console-api', 'server-console-web'],
  'v114-controllers.ts': ['capacity-api', 'device-sessions-api', 'server-console-api'],
};
const platformTests = {
  'capacity.ts': ['capacity', 'capacity-api', 'capacity-web', 'server-console-api'],
  'jobs.ts': ['p1', 'server-console-api'],
  'releases.ts': ['p1', 'agent-compatibility', 'device-sessions-api'],
  'configurations.ts': ['p2', 'v18', 'v181'],
  'console.ts': ['server-console-api', 'server-console-web'],
  'task-plans.ts': ['v18', 'v181', 'server-console-api', 'server-console-web'],
  'schedules.ts': ['p3', 'v18', 'v181'],
  'open-budget.ts': ['app-open-api', 'concurrent-open-api'],
  'test-data.ts': ['test-data', 'test-data-web'],
};
export function planChanges(files) {
  const modules = new Set(),
    tests = new Set();
  let full = false,
    migrate = false;
  const all = () => {
    ['api', 'worker', 'web', 'tools', 'agent'].forEach((x) => modules.add(x));
    full = true;
  };
  for (const f of files) {
    if (/^(docs\/|README\.md$|AGENTS\.md$)/.test(f)) continue;
    if (f === 'scripts/test-p0.mjs') {
      modules.add('tools');
      ['incremental-release', 'p1', 'web'].forEach((x) => tests.add(x));
    } else if (
      /^scripts\/(release-plan|release-hub|hub-release-config|hub-release-lock|verify-release|build-target|bootstrap-hub-node)\.mjs$/.test(
        f,
      )
    ) {
      modules.add('tools');
      ['incremental-release', 'p1'].forEach((x) => tests.add(x));
    } else if (/^apps\/web\//.test(f)) {
      modules.add('web');
      tests.add('web');
      tests.add('server-console-web');
    } else if (/^apps\/control-api\//.test(f)) {
      ['api', 'tools'].forEach((x) => modules.add(x));
      const related = apiTests[f.split('/').at(-1)];
      if (related) related.forEach((x) => tests.add(x));
      else full = true;
      if (/\/prisma\/(migrations\/|schema\.prisma$)/.test(f)) {
        migrate = true;
        modules.add('worker');
      }
    } else if (/^apps\/deploy-worker\//.test(f)) {
      modules.add('worker');
      modules.add('tools');
      tests.add('p1');
    } else if (/^(apps\/agent\/|packages\/automation\/)/.test(f)) {
      modules.add('agent');
      modules.add('tools');
      if (/^apps\/agent\/src\/(health|environment|environment-entry)\.ts$/.test(f)) {
        ['incremental-release', 'agent-startup', 'agent-compatibility', 'p1'].forEach((x) =>
          tests.add(x),
        );
        continue;
      }
      if (
        /^packages\/automation\/src\/(download|mobile-browser|apk-links|source-elements|network|proxy|cache|common)\.ts$/.test(
          f,
        )
      )
        ['download-discovery', 'mobile-download', 'file-assets'].forEach((x) => tests.add(x));
      if (/^packages\/automation\/src\/(network|proxy)\.ts$/.test(f)) tests.add('proxy-probe');
      if (
        /^(apps\/agent\/src\/(tasks|store|main)|packages\/automation\/src\/(concurrent-open|device-sessions))\.ts$/.test(
          f,
        )
      )
        ['concurrent-open', 'device-sessions-api', 'stop-recovery'].forEach((x) => tests.add(x));
      [
        'p1',
        'p2',
        'p3',
        'agent-startup',
        'agent-compatibility',
        'download-diagnostics',
        'app-open',
        'device-sessions',
      ].forEach((x) => tests.add(x));
    } else if (/^packages\/platform\//.test(f)) {
      ['api', 'worker', 'tools'].forEach((x) => modules.add(x));
      const related = platformTests[f.split('/').at(-1)];
      if (related) related.forEach((x) => tests.add(x));
      else full = true;
    } else if (/^deploy\/ansible\//.test(f)) {
      ['agent', 'worker', 'tools'].forEach((x) => modules.add(x));
      tests.add('p1');
    } else if (/^tests\/[a-z0-9-]+\.test\.mjs$/.test(f)) tests.add(f.slice(6, -9));
    else all();
  }
  return {
    version: 1,
    modules: [...modules].sort(),
    migrate,
    tests: full ? ['ALL'] : [...tests].sort(),
  };
}
export function releasePlan(
  from,
  to = 'HEAD',
  cwd = fileURLToPath(new URL('../', import.meta.url)),
) {
  const commit = (ref) => {
    if (!/^(HEAD|[a-f0-9]{7,40})$/.test(ref)) throw Error('COMMIT_REQUIRED');
    const sha = execFileSync('git', ['rev-parse', '--verify', ref + '^{commit}'], {
      cwd,
      encoding: 'utf8',
    }).trim();
    if (!/^[a-f0-9]{40}$/.test(sha)) throw Error('COMMIT_REQUIRED');
    return sha;
  };
  const base = commit(from),
    target = commit(to);
  const files = execFileSync('git', ['diff', '--name-only', '--no-renames', base, target, '--'], {
    cwd,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  return { ...planChanges(files), from: base, to: target, files };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(releasePlan(process.argv[2], process.argv[3]), null, 2));
}
