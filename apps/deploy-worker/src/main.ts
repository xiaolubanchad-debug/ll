import { PrismaClient } from '@prisma/client';
import { masterKey } from '@apk/platform';
import { Worker } from './worker.js';
import { AnsibleRunner } from './runner.js';
if (process.platform !== 'linux') {
  console.error('部署 Worker 需运行在 Linux；本地模拟测试不执行真实安装');
  process.exitCode = 1;
} else {
  const db = new PrismaClient({
    datasources: {
      db: {
        url: process.env.WORKER_DATABASE_URL ?? 'postgresql://invalid:invalid@127.0.0.1:1/invalid',
      },
    },
  });
  const abort = new AbortController();
  process.on('SIGTERM', () => abort.abort());
  process.on('SIGINT', () => abort.abort());
  try {
    if (!process.env.WORKER_DATABASE_URL) throw Error('WORKER_DATABASE_URL_REQUIRED');
    masterKey();
    const worker = new Worker(db, new AnsibleRunner());
    while (!abort.signal.aborted) {
      const worked = await worker.once(abort.signal);
      if (!worked) await new Promise((r) => setTimeout(r, 1000));
    }
  } catch {
    console.error('部署 Worker 无法继续，请检查数据库、密钥和部署工具');
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}
