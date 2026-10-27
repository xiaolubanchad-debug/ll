import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir, rename, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function provisionWorkerRole(db, role, password, schema = 'public') {
  if (
    !/^apk_worker(?:_[a-z0-9_]{1,32})?$/.test(role) ||
    !/^\w{1,63}$/.test(schema) ||
    !/^[a-f0-9]{48}$/.test(password)
  )
    throw Error('ROLE_INPUT_INVALID');
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await tx.$executeRawUnsafe(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    for (const table of [
      'Node',
      'NodeSlot',
      'Run',
      'SecretVersion',
      'Release',
      'Deployment',
      'DeploymentEvent',
      'Enrollment',
      'AgentCredential',
    ])
      await tx.$executeRawUnsafe(`GRANT SELECT ON "${schema}"."${table}" TO "${role}"`);
    for (const [table, columns] of [
      ['Node', '"deploymentStatus","lastSeenAt"'],
      ['NodeSlot', '"operationId","quarantined"'],
      [
        'Deployment',
        '"status","workerId","fence","leaseExpiresAt","result","errorCode","finishedAt"',
      ],
      ['AgentCredential', '"revokedAt"'],
    ])
      await tx.$executeRawUnsafe(
        `GRANT UPDATE (${columns}) ON "${schema}"."${table}" TO "${role}"`,
      );
    for (const table of ['DeploymentEvent', 'Enrollment'])
      await tx.$executeRawUnsafe(`GRANT INSERT ON "${schema}"."${table}" TO "${role}"`);
  });
}
async function main() {
  const file = resolve('data/keys/worker-url.env');
  if (await readFile(file).catch(() => null)) throw Error('WORKER_CONFIG_EXISTS');
  const url = new URL(process.env.DATABASE_URL ?? '');
  const role = 'apk_worker',
    password = randomBytes(24).toString('hex');
  const db = new PrismaClient();
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  const pending = file + '.pending';
  url.username = role;
  url.password = password;
  await writeFile(pending, 'WORKER_DATABASE_URL=' + url.href + '\n', { flag: 'wx', mode: 0o600 });
  try {
    await provisionWorkerRole(db, role, password, url.searchParams.get('schema') ?? 'public');
    await rename(pending, file);
    console.log('已创建受限 Worker 数据库角色；连接保存在受保护的 data/keys/worker-url.env');
  } finally {
    await db.$disconnect();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Worker 数据库配置失败，未覆盖已有角色或连接文件；请检查数据库权限与准备步骤');
    process.exitCode = 1;
  });
