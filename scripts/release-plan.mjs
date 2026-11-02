import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
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
    if (/^apps\/web\//.test(f)) {
      modules.add('web');
      tests.add('web');
      tests.add('server-console-web');
    } else if (/^apps\/control-api\//.test(f)) {
      ['api', 'tools'].forEach((x) => modules.add(x));
      full = true;
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
      full = true;
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
