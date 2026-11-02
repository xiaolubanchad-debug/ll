import { execFileSync } from 'node:child_process';
import { mkdir, chmod, rename, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('ROOT_REQUIRED');
const cwd = '/opt/apk-hub/ops';
const config = JSON.parse(
  execFileSync('docker', ['compose', 'config', '--format', 'json'], { cwd, encoding: 'utf8' }),
);
const image = config.services.api.build.args.NODE_IMAGE;
if (!/^[a-z0-9./:-]+@sha256:[a-f0-9]{64}$/.test(image)) throw Error('PINNED_BASE_REQUIRED');
const expected = execFileSync(
  'docker',
  ['run', '--rm', '--network', 'none', '--entrypoint', 'sha256sum', image, '/usr/local/bin/node'],
  { encoding: 'utf8' },
).split(/\s/)[0];
await mkdir(cwd + '/runtime', { recursive: true, mode: 0o755 });
const id = execFileSync('docker', ['create', '--entrypoint', '/bin/true', image], {
  encoding: 'utf8',
}).trim();
if (!/^[a-f0-9]{64}$/.test(id)) throw Error('CONTAINER_INVALID');
try {
  execFileSync('docker', ['cp', id + ':/usr/local/bin/node', cwd + '/runtime/node.pending']);
  const actual = createHash('sha256')
    .update(await readFile(cwd + '/runtime/node.pending'))
    .digest('hex');
  if (actual !== expected) throw Error('RUNTIME_HASH_MISMATCH');
  await chmod(cwd + '/runtime/node.pending', 0o755);
  await rename(cwd + '/runtime/node.pending', cwd + '/runtime/node');
  const version = execFileSync(cwd + '/runtime/node', ['--version'], { encoding: 'utf8' }).trim();
  if (!version.startsWith('v24.')) throw Error('NODE24_REQUIRED');
  console.log(JSON.stringify({ version, sha256: actual }));
} finally {
  execFileSync('docker', ['rm', id], { stdio: 'ignore' });
}
