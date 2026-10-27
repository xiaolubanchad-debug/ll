import { generateKeyPairSync, randomBytes, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const dir = resolve('data/keys');
await mkdir(dir, { recursive: true, mode: 0o700 });
async function optional(file) {
  try {
    return await readFile(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
let privateBytes = await optional(join(dir, 'release-private.key'));
const publicBytes = await optional(join(dir, 'release-public.key'));
if (!privateBytes && publicBytes) throw Error('RELEASE_PRIVATE_KEY_MISSING');
if (!privateBytes) {
  privateBytes = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(join(dir, 'release-private.key'), privateBytes, { flag: 'wx', mode: 0o600 });
}
const expectedPublic = createPublicKey(createPrivateKey(privateBytes)).export({
  type: 'spki',
  format: 'pem',
});
if (publicBytes && publicBytes.toString() !== expectedPublic)
  throw Error('RELEASE_KEY_PAIR_MISMATCH');
if (!publicBytes)
  await writeFile(join(dir, 'release-public.key'), expectedPublic, { flag: 'wx', mode: 0o600 });
const master = await optional(join(dir, 'master.key'));
if (master && master.length !== 32) throw Error('MASTER_KEY_INVALID');
if (!master) await writeFile(join(dir, 'master.key'), randomBytes(32), { flag: 'wx', mode: 0o600 });
const existing = await readFile('.env', 'utf8').catch(() => '');
const values = {
  MASTER_KEY_FILE: join(dir, 'master.key'),
  RELEASE_PRIVATE_KEY_FILE: join(dir, 'release-private.key'),
  RELEASE_PUBLIC_KEY_FILE: join(dir, 'release-public.key'),
  RELEASE_DIR: resolve('data/releases'),
  CONTROL_PLANE_URL: '',
};
const extra = Object.entries(values)
  .filter(([k]) => !new RegExp('^' + k + '=', 'm').test(existing))
  .map(([k, v]) => `${k}=${v.replaceAll('\\', '/')}`)
  .join('\n');
if (extra) await writeFile('.env', existing + '\n' + extra + '\n', { mode: 0o600 });
process.loadEnvFile('.env');
const workerFields = [
  'MASTER_KEY_FILE',
  'RELEASE_PUBLIC_KEY_FILE',
  'RELEASE_DIR',
  'CONTROL_PLANE_URL',
];
await writeFile(
  join(dir, 'worker.env'),
  workerFields.map((key) => key + '=' + JSON.stringify(process.env[key] ?? '')).join('\n') + '\n',
  { mode: 0o600 },
);
console.log('部署密钥已准备；请配置 CONTROL_PLANE_URL 与独立 Worker 数据库连接。');
