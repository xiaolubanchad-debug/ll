import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
const password = randomBytes(24).toString('hex');
const env = `NODE_ENV=development\nAPP_ORIGIN=http://127.0.0.1:5173\nHOST=127.0.0.1\nPORT=3000\nCOOKIE_SECURE=false\nTRUST_PROXY_HOPS=0\nSESSION_CSRF_KEY=${randomBytes(32).toString('base64')}\nDATABASE_URL=postgresql://apk:${password}@127.0.0.1:5432/apk\nPOSTGRES_PASSWORD=${password}\n`;
try {
  await writeFile(new URL('../.env', import.meta.url), env, { flag: 'wx', mode: 0o600 });
  console.log('已生成本地 .env。未生成管理员或默认密码。');
} catch (error) {
  if (error.code === 'EEXIST') {
    console.error('.env 已存在，未覆盖');
    process.exitCode = 1;
  } else throw error;
}
