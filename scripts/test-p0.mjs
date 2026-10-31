import { randomBytes, randomUUID, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { PrismaClient } from '@prisma/client';
import EmbeddedPostgres from 'embedded-postgres';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = path.join(root, '.tmp');
await mkdir(temp, { recursive: true });
const dir = await mkdtemp(path.join(temp, 'p0-'));
process.env.TEMP = dir;
process.env.TMP = dir;
const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const children = [];
let pg, baseDb, db;
const schema = 'p0_' + randomUUID().replaceAll('-', '');
let schemaCreated = false;
const run = (args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`测试子进程失败：${args[0]} (${code})`)),
    );
  });
async function start(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  child.on('error', () => {});
  let output = '';
  child.stdout.on('data', (b) => {
    output += b.toString();
  });
  child.stderr.on('data', (b) => {
    output += b.toString();
  });
  return { child, getOutput: () => output };
}
async function waitFor(url, proc) {
  for (let i = 0; i < 100; i++) {
    if (proc.child.exitCode !== null)
      throw new Error('测试服务启动失败：' + proc.getOutput().slice(-1000));
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* server is starting */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('测试服务启动超时');
}
try {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    let pgOutput = '';
    const pgPort = await freePort(),
      pgPassword = randomBytes(24).toString('hex');
    pg = new EmbeddedPostgres({
      databaseDir: path.join(dir, 'postgres'),
      port: pgPort,
      user: 'p0test',
      password: pgPassword,
      persistent: true,
      authMethod: 'scram-sha-256',
      postgresFlags: ['-h', '127.0.0.1'],
      onLog: (m) => {
        pgOutput += String(m);
      },
      onError: (m) => {
        pgOutput += String(m);
      },
    });
    try {
      await pg.initialise();
      await pg.start();
      await pg.createDatabase('apk_test_p0');
    } catch (error) {
      await writeFile(path.join(dir, 'postgres-error.log'), pgOutput);
      throw error;
    }
    url = `postgresql://p0test:${pgPassword}@127.0.0.1:${pgPort}/apk_test_p0`;
  }
  baseDb = new PrismaClient({ datasources: { db: { url } }, log: [] });
  await baseDb.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  schemaCreated = true;
  const isolated = new URL(url);
  isolated.searchParams.set('schema', schema);
  const env = {
    ...process.env,
    DATABASE_URL: isolated.href,
    NODE_ENV: 'test',
    COOKIE_SECURE: 'false',
    TRUST_PROXY_HOPS: '0',
    HOST: '127.0.0.1',
    PORT: String(await freePort()),
    APP_ORIGIN: `http://127.0.0.1:${await freePort()}`,
    SESSION_CSRF_KEY: randomBytes(32).toString('base64'),
    P0_TEST_PASSWORD: randomBytes(20).toString('base64url'),
    MASTER_KEY_FILE: join(dir, 'master.key'),
    RELEASE_PUBLIC_KEY_FILE: join(dir, 'release-public.key'),
    RELEASE_DIR: join(dir, 'releases'),
    P1_TEST_DIR: dir,
    ARTIFACT_DIR: join(dir, 'artifacts'),
  };
  const keys = generateKeyPairSync('ed25519');
  await writeFile(env.MASTER_KEY_FILE, randomBytes(32), { mode: 0o600 });
  await writeFile(
    env.RELEASE_PUBLIC_KEY_FILE,
    keys.publicKey.export({ type: 'spki', format: 'pem' }),
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, 'release-private.key'),
    keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    { mode: 0o600 },
  );
  await mkdir(env.RELEASE_DIR);
  await run(
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--schema',
      'apps/control-api/prisma/schema.prisma',
    ],
    env,
  );
  await run(
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--schema',
      'apps/control-api/prisma/schema.prisma',
    ],
    env,
  );
  db = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
    log: [],
  });
  const version = await db.$queryRawUnsafe('SHOW server_version');
  console.log('Real PostgreSQL version:', version[0].server_version);
  await run(['--test', '--test-concurrency=1', 'tests/agent-compatibility.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/agent-startup.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/boot-receipts.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/identity-layout.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/boot-process.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/sdk-archive.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/api.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/p1.test.mjs'], env);
  await run(['--test', '--test-reporter=tap', '--test-concurrency=1', 'tests/p2.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/mobile-download.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/download-discovery.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v15-download.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v15-entry.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/proxy-probe.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/owned-client-network.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/registration-discovery.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/app-obstructions.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/app-readiness.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v192.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v110.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v110-api.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v111-api.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v1111.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v1112.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/app-open.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/open-performance.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/test-data.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/app-open-api.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/device-sessions.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/device-sessions-api.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/concurrent-open.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/concurrent-open-api.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/p3.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v17.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/server-console-api.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v18.test.mjs'], env);
  await run(['--test', '--test-concurrency=1', 'tests/v181.test.mjs'], env);
  const { initializeAdmin } = await import('../apps/control-api/dist/admin.js');
  const { passwordHash } = await import('../apps/control-api/dist/auth.js');
  const admin = await db.admin.findFirst();
  if (admin)
    await db.admin.update({
      where: { id: admin.id },
      data: {
        passwordHash: await passwordHash(env.P0_TEST_PASSWORD),
        credentialVersion: { increment: 1 },
      },
    });
  else await initializeAdmin(db, 'p0admin', env.P0_TEST_PASSWORD);
  const api = await start(['apps/control-api/dist/main.js'], env);
  await waitFor(`http://127.0.0.1:${env.PORT}/api/v1/health/live`, api);
  const ui = await start(
    [
      'node_modules/vite/bin/vite.js',
      'apps/web',
      '--config',
      'apps/web/vite.config.ts',
      '--port',
      new URL(env.APP_ORIGIN).port,
    ],
    { ...env, API_PROXY_URL: `http://127.0.0.1:${env.PORT}` },
  );
  await waitFor(env.APP_ORIGIN, ui);
  await run(['--test', 'tests/web.test.mjs'], {
    ...env,
    P0_SCREENSHOT_DIR: dir,
  });
  await run(['--test', 'tests/v110-web.test.mjs'], {
    ...env,
    P0_SCREENSHOT_DIR: dir,
  });
  await run(['--test', 'tests/open-performance-web.test.mjs'], env);
  await run(['--test', 'tests/test-data-web.test.mjs'], env);
  await run(['--test', 'tests/device-sessions-web.test.mjs'], env);
  await run(['--test', 'tests/server-console-web.test.mjs'], { ...env, P0_SCREENSHOT_DIR: dir });
  console.log(
    'P0–P3 integration and browser tests passed (real PostgreSQL, SQLite and Chromium; EC2 installer and Appium boundary simulated here, real Android verified separately).',
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : 'P0 tests failed');
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
  }
  await db?.$disconnect();
  if (baseDb && schemaCreated)
    await baseDb.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`).catch(() => {});
  await baseDb?.$disconnect();
  await pg?.stop();
}
// embedded-postgres installs a beforeExit hook with a hardcoded zero exit code.
// Cleanup is already awaited; preserve test failures for CI explicitly.
process.exit(process.exitCode ?? 0);
