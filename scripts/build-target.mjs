import { execFileSync } from 'node:child_process';
const groups = {
  api: ['contracts', 'platform', 'control-api'],
  worker: ['contracts', 'platform', 'deploy-worker'],
  web: ['contracts', 'web'],
  agent: ['contracts', 'automation', 'agent'],
  tools: ['contracts', 'platform', 'automation', 'control-api', 'deploy-worker', 'agent'],
};
const targets = process.argv.slice(2);
if (!targets.length || targets.some((x) => !groups[x]) || !process.env.npm_execpath)
  throw Error('BUILD_TARGET_INVALID');
const needed = new Set(targets.flatMap((x) => groups[x]));
const selected = [
  'contracts',
  'platform',
  'automation',
  'control-api',
  'deploy-worker',
  'agent',
  'web',
].filter((x) => needed.has(x));
for (const name of selected)
  execFileSync(process.execPath, [process.env.npm_execpath, 'run', 'build', '-w', '@apk/' + name], {
    stdio: 'inherit',
    windowsHide: true,
  });
