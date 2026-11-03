import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, sign } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { create as tar } from 'tar';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { PrismaClient } from '@prisma/client';
import { chromium, expect } from '@playwright/test';
import { createServer as createVite } from 'vite';
import { createApp } from '../apps/control-api/dist/app.js';
import { passwordHash } from '../apps/control-api/dist/auth.js';
import { Worker } from '../apps/deploy-worker/dist/worker.js';
import { importCachedApk } from '../apps/agent/dist/apk-import.js';
import { prepareDailyPlan } from '../packages/platform/dist/daily-plan.js';
import {
  manualDay,
  tickManualApks,
  digest,
  canonical,
  createSecret,
  claimJob,
  finishJob,
  playbookDigest,
  verifyRelease,
  receiveManualApk,
} from '@apk/platform';
import { provisionWorkerRole } from '../scripts/setup-worker-db.mjs';
import { fixtureApk } from './p2-fixtures.mjs';
import {
  manualUploadOverrides,
  manualUploadNginx,
  moduleOverrides,
} from '../scripts/hub-release-config.mjs';

test('manual APK: real authenticated upload, durable results, idle import, daily overlay and browser', async (t) => {
  const db = new PrismaClient(),
    dir = await mkdtemp(resolve('.tmp/manual-apk-')),
    day = manualDay();
  process.env.APK_UPLOAD_DIR = join(dir, 'uploads');
  let app, vite, browser, cookie, csrf, base, node, run, version, release, upload, restricted, role;
  const configId = randomUUID(),
    taskIds = [randomUUID(), randomUUID()],
    secretIds = [];
  try {
    const admin = await db.admin.findFirstOrThrow();
    await db.admin.update({
      where: { id: admin.id },
      data: { passwordHash: await passwordHash(process.env.P0_TEST_PASSWORD) },
    });
    await db.loginBucket.deleteMany();
    const ssh = await createSecret(
      db,
      { type: 'SSH_PASSWORD', secretValue: { password: 'OwnedFixtureOnly123' } },
      admin.id,
      'fixture',
    );
    secretIds.push(ssh.id);
    const proxy = await createSecret(
      db,
      {
        type: 'HTTP_PROXY',
        secretValue: {
          host: 'proxy.example.test',
          port: 10000,
          username: 'Owned',
          password: 'OwnedFixtureOnly123',
        },
      },
      admin.id,
      'fixture',
    );
    secretIds.push(proxy.id);
    node = await db.node.create({
      data: {
        name: '自有补包验收',
        host: '192.0.2.119',
        credentialVersionId: ssh.id,
        expectedFingerprint: 'SHA256:' + 'a'.repeat(43),
        hostKey: 'ssh-rsa fixture',
        deploymentStatus: 'INSTALLED',
        lastSeenAt: new Date(),
        slot: { create: {} },
      },
    });
    const config = JSON.parse(
      await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
    );
    config.execution.appOpen = { dwellMs: 10000 };
    config.execution.proxySecretVersionId = proxy.id;
    await db.configuration.create({ data: { id: configId, name: '自有补包配置' } });
    version = await db.configVersion.create({
      data: {
        configId,
        version: 1,
        body: config,
        configHash: digest(canonical(config)),
        createdBy: admin.id,
      },
    });
    run = await db.run.create({
      data: {
        nodeId: node.id,
        configVersionId: version.id,
        cacheDay: day,
        purpose: 'DOWNLOAD',
        status: 'PARTIAL_FAILED',
        createdBy: admin.id,
        finishedAt: new Date(),
      },
    });
    const bytes = fixtureApk('com.example.manualowned'),
      apkFile = join(dir, 'owned.apk');
    await writeFile(apkFile, bytes);
    const { inspectApk } = await import('../packages/automation/dist/apk.js');
    const apk = await inspectApk(apkFile, 100000, day, AbortSignal.timeout(10000));
    assert.equal(apk.minSdkVersion, 1);
    for (let i = 0; i < 2; i++)
      await db.task.create({
        data: {
          id: taskIds[i],
          runId: run.id,
          position: i,
          targetKey: digest('manual-' + i),
          label: i ? '下载失败入口' : '下载成功入口',
          sourceUrl: 'https://owned.example.test/',
          status: i ? 'FAILED' : 'SUCCEEDED',
          errorCode: i ? 'DOWNLOAD_FAILED' : null,
          ...(!i ? { apk } : {}),
        },
      });
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    process.env.CONTROL_PLANE_URL = base;
    const request = async (path, method = 'GET', body, headers = {}) => {
      const response = await fetch(base + '/api/v1' + path, {
        method,
        headers: {
          cookie,
          ...(method !== 'GET'
            ? {
                origin: process.env.APP_ORIGIN,
                'x-csrf-token': csrf,
                'content-type': 'application/json',
                'idempotency-key': randomUUID(),
              }
            : {}),
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    const login = await fetch(base + '/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: process.env.APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'p0admin', password: process.env.P0_TEST_PASSWORD }),
    });
    cookie = login.headers.get('set-cookie').split(';')[0];
    csrf = (await login.json()).csrfToken;
    const assetPath = '/apk-assets?' + new URLSearchParams({ day, nodeId: node.id });
    await t.test(
      'list contains success with SDK and failure without metadata; scoped filters',
      async () => {
        const r = await request(assetPath);
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.data.items.length, 2);
        assert.equal(r.data.items.find((x) => x.status === 'SUCCEEDED').apk.minSdkVersion, 1);
        assert.equal(r.data.items.find((x) => x.status === 'FAILED').canUpload, true);
        assert.equal((await request(assetPath + '&status=FAILED')).data.items.length, 1);
        assert.equal((await request(assetPath + '&status=SUCCESS')).data.items.length, 1);
        assert.equal((await request(assetPath + '&status=UNSAFE')).status, 422);
      },
    );
    const create = () => request('/apk-assets/' + taskIds[1] + '/uploads', 'POST', {});
    await t.test(
      'only failed latest-day source, authentication, CSRF and binary route',
      async () => {
        assert.equal(
          (await request('/apk-assets/' + taskIds[0] + '/uploads', 'POST', {})).status,
          409,
        );
        upload = (await create()).data;
        assert.equal(upload.status, 'UPLOADING');
        assert.equal((await create()).data.id, upload.id);
        assert.ok((await Promise.all([create(), create()])).every((r) => r.data.id === upload.id));
        const file = '/apk-uploads/' + upload.id + '/file';
        assert.equal(
          (
            await request(file, 'PUT', bytes, {
              'content-type': 'application/octet-stream',
              cookie: '',
            })
          ).status,
          401,
        );
        assert.equal(
          (
            await request(file, 'PUT', bytes, {
              'content-type': 'application/octet-stream',
              'x-csrf-token': 'a'.repeat(64),
            })
          ).status,
          403,
        );
        assert.equal((await request(file, 'PUT', {})).status, 400);
        assert.equal(
          (
            await request('/configs', 'POST', bytes, {
              'content-type': 'application/octet-stream',
            })
          ).status,
          400,
        );
        const invalid = await request(file, 'PUT', Buffer.alloc(0), {
          'content-type': 'application/octet-stream',
        });
        assert.equal(invalid.status, 422, JSON.stringify(invalid));
        assert.equal(invalid.data.error.code, 'FILE_TRANSFER_MISMATCH');
        await create();
        await assert.rejects(
          receiveManualApk(
            db,
            upload.id,
            Readable.from(
              (async function* () {
                yield bytes.subarray(0, 32);
                throw Error('owned interruption');
              })(),
            ),
            admin.id,
            'fixture',
          ),
          (e) => e.code === 'APK_UPLOAD_INTERRUPTED',
        );
        assert.equal(
          (await db.manualApkUpload.findUniqueOrThrow({ where: { id: upload.id } })).status,
          'FAILED',
        );
        await create();
        await db.manualApkUpload.update({ where: { id: upload.id }, data: { maxBytes: 20 } });
        const tooBig = await request(file, 'PUT', bytes, {
          'content-type': 'application/octet-stream',
        });
        assert.equal(tooBig.status, 413, JSON.stringify(tooBig));
        await create();
        const valid = await request(file, 'PUT', bytes, {
          'content-type': 'application/octet-stream',
        });
        assert.equal(valid.status, 200, JSON.stringify(valid));
        upload = valid.data;
        assert.equal(upload.status, 'QUEUED');
        assert.equal(upload.apk.packageName, undefined);
        assert.equal(upload.apk.validationPolicy, 'FILE_NAME');
        assert.throws(
          () =>
            execFileSync(process.execPath, ['scripts/hub-release-lock.mjs'], {
              timeout: 5000,
              stdio: 'pipe',
              windowsHide: true,
            }),
          (e) => e.status === 1 && String(e.stderr).includes('RELEASE_LOCK_FAILED'),
        );
        assert.equal(
          (await request(file, 'PUT', bytes, { 'content-type': 'application/octet-stream' })).data
            .status,
          'QUEUED',
        );
        assert.equal(
          (await db.task.findUniqueOrThrow({ where: { id: taskIds[1] } })).status,
          'FAILED',
        );
        assert.equal(
          (await request(assetPath + '&q=com.example.manualowned')).data.items.length,
          1,
        );
        assert.equal(
          (await request(assetPath + '&q=' + encodeURIComponent(upload.apk.fileName))).data.items
            .length,
          1,
        );
      },
    );
    await t.test(
      'busy node queues without touching a running batch; cancel retains original failure',
      async () => {
        await db.nodeSlot.update({ where: { nodeId: node.id }, data: { quarantined: true } });
        await tickManualApks(db);
        assert.equal(
          (await db.manualApkUpload.findUniqueOrThrow({ where: { id: upload.id } })).status,
          'QUEUED',
        );
        assert.equal(await db.deployment.count({ where: { nodeId: node.id } }), 0);
        const cancel = await request('/apk-uploads/' + upload.id + '/cancel', 'POST', {});
        assert.equal(cancel.data.status, 'CANCELLED');
        await db.nodeSlot.update({ where: { nodeId: node.id }, data: { quarantined: false } });
        const retry = await request('/apk-uploads/' + upload.id + '/retry', 'POST', {});
        assert.equal(retry.data.status, 'QUEUED');
        await assert.rejects(
          prepareDailyPlan(
            db,
            {
              nodeId: node.id,
              purpose: 'REGISTER',
              sourceDownloadId: run.id,
              successTarget: 1,
              attemptLimit: 1,
            },
            version,
            new Date(),
          ),
          (e) => e.code === 'APK_IMPORT_PENDING',
        );
      },
    );
    await t.test(
      'signed import tool is required; real cache receipt under restricted Worker role',
      async () => {
        const pkg = join(dir, 'signed');
        await mkdir(join(pkg, 'npm'), { recursive: true });
        for (const f of [
          'agent.js',
          'boot-check.js',
          'apk-import.js',
          'npm/package.json',
          'npm/package-lock.json',
        ])
          await writeFile(
            join(pkg, f),
            f.endsWith('.json') ? '{}' : '// signed fixture tooling; simulated runner only',
          );
        const archive = join(dir, 'fixture.tgz');
        await tar({ gzip: true, cwd: pkg, file: archive }, [
          'agent.js',
          'boot-check.js',
          'apk-import.js',
          'npm/package.json',
          'npm/package-lock.json',
        ]);
        const archiveBytes = await readFile(archive),
          sha = digest(archiveBytes),
          body = {
            id: randomUUID(),
            agentVersion: '0.16.0',
            protocolVersion: '1.0',
            gitCommit: 'a'.repeat(40),
            artifactName: 'agent-' + sha + '.tgz',
            sha256: sha,
            features: ['MANUAL_APK_IMPORT_V1', 'APK_METADATA_ONLY_V1', 'APK_FILE_ASSETS_V1'],
            playbookSha256: await playbookDigest(resolve('deploy/ansible')),
            toolchain: {
              nodeVersion: '24.18.0',
              nodeUrl: 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz',
              nodeSha256: 'b'.repeat(64),
              playwrightVersion: '1.56.1',
              appiumVersion: '3.9.0',
              uiautomator2Version: '8.7.2',
              npmLockSha256: digest('{}'),
              systemImage: 'system-images;android-35;google_apis;x86_64',
              archives: ['cmdlineTools', 'emulator', 'platformTools', 'systemImage'].map(
                (role) => ({
                  role,
                  url: 'https://dl.google.com/android/repository/' + role + '.zip',
                  checksum: 'sha1:' + 'c'.repeat(40),
                  revision: '1.0.0',
                }),
              ),
            },
          };
        await copyFile(archive, join(process.env.RELEASE_DIR, body.artifactName));
        const manifest = {
          ...body,
          signature: sign(
            null,
            Buffer.from(canonical(body)),
            await readFile(join(process.env.P1_TEST_DIR, 'release-private.key')),
          ).toString('base64'),
        };
        await verifyRelease(manifest);
        release = await db.release.create({
          data: { id: body.id, artifactName: body.artifactName, sha256: sha, manifest },
        });
        await db.node.update({
          where: { id: node.id },
          data: { agentVersion: '0.16.0', agentReleaseId: release.id },
        });
        await db.release.update({ where: { id: release.id }, data: { archivedAt: new Date() } });
        const oldTool = await db.release.create({
          data: {
            id: randomUUID(),
            artifactName: 'agent-' + digest('old-import-tool') + '.tgz',
            sha256: digest('old-import-tool'),
            manifest: { agentVersion: '0.15.0', features: ['MANUAL_APK_IMPORT_V1'] },
          },
        });
        await tickManualApks(db);
        assert.equal(
          (await db.manualApkUpload.findUniqueOrThrow({ where: { id: upload.id } })).errorCode,
          'IMPORT_TOOL_REQUIRED',
        );
        assert.equal(await db.deployment.count({ where: { manualApkId: upload.id } }), 0);
        await db.release.update({ where: { id: release.id }, data: { archivedAt: null } });
        await db.release.delete({ where: { id: oldTool.id } });
        await tickManualApks(db);
        await tickManualApks(db);
        upload = await db.manualApkUpload.findUniqueOrThrow({ where: { id: upload.id } });
        assert.equal(upload.status, 'IMPORTING');
        assert.equal(await db.deployment.count({ where: { manualApkId: upload.id } }), 1);
        role = 'apk_worker_' + randomBytes(6).toString('hex');
        const pw = randomBytes(24).toString('hex'),
          url = new URL(process.env.DATABASE_URL);
        await provisionWorkerRole(db, role, pw, url.searchParams.get('schema'));
        url.username = role;
        url.password = pw;
        restricted = new PrismaClient({ datasources: { db: { url: url.href } } });
        const runner = {
          install: () => {
            throw Error('must not deploy');
          },
          activate: () => {
            throw Error('must not enroll');
          },
          importApk: async (_ctx, input, file) => {
            const payload = join(dir, 'transfer.apk');
            await copyFile(file, payload);
            return importCachedApk(input, payload, join(dir, 'node-cache'));
          },
        };
        const report = {
          ...JSON.parse(await readFile('contracts/fixtures/p1.valid.json', 'utf8')).HealthReport,
          sudo: true,
          ownerNodeId: node.id,
        };
        await new Worker(restricted, runner, {
          inspect: async () => report,
          probe: () => {
            throw Error('unused');
          },
        }).once();
        upload = await db.manualApkUpload.findUniqueOrThrow({ where: { id: upload.id } });
        assert.equal(upload.status, 'APPLIED');
        const job = await db.deployment.findUniqueOrThrow({ where: { id: upload.operationId } });
        assert.equal(job.status, 'SUCCEEDED', JSON.stringify(job));
        assert.equal(
          job.result.cacheKey,
          digest(JSON.stringify([node.id, day, digest('manual-1')])),
        );
        assert.equal(
          (await db.node.findUniqueOrThrow({ where: { id: node.id } })).agentReleaseId,
          release.id,
        );
      },
    );
    await t.test(
      'manual asset joins subsequent plan, original run and error stay unchanged; all-failed source recovers',
      async () => {
        const input = {
          nodeId: node.id,
          purpose: 'REGISTER',
          sourceDownloadId: run.id,
          successTarget: 1,
          attemptLimit: 1,
        };
        let plan = await prepareDailyPlan(db, input, version, new Date());
        assert.equal(plan.assets.length, 2);
        await db.node.update({ where: { id: node.id }, data: { agentVersion: '0.15.0' } });
        await assert.rejects(
          prepareDailyPlan(db, input, version, new Date()),
          (e) => e.code === 'NODE_UPGRADE_REQUIRED',
        );
        await db.node.update({ where: { id: node.id }, data: { agentVersion: '0.16.0' } });
        await db.run.update({ where: { id: run.id }, data: { status: 'FAILED' } });
        await db.task.update({ where: { id: taskIds[0] }, data: { status: 'FAILED' } });
        plan = await prepareDailyPlan(db, input, version, new Date());
        assert.equal(plan.assets.length, 1);
        assert.equal(plan.assets[0].targetKey, digest('manual-1'));
        assert.equal(
          (await db.task.findUniqueOrThrow({ where: { id: taskIds[1] } })).errorCode,
          'DOWNLOAD_FAILED',
        );
        await db.run.update({ where: { id: run.id }, data: { status: 'PARTIAL_FAILED' } });
        await db.task.update({ where: { id: taskIds[0] }, data: { status: 'SUCCEEDED' } });
      },
    );
    await t.test(
      'browser shows read-only APK history and submits the exact direct link from the workbench',
      async () => {
        process.env.API_PROXY_URL = base;
        vite = await createVite({
          configFile: 'apps/web/vite.config.ts',
          root: 'apps/web',
          server: {
            port: Number(new URL(process.env.APP_ORIGIN).port),
            host: '127.0.0.1',
            strictPort: true,
          },
        });
        await vite.listen();
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
        await page.goto(process.env.APP_ORIGIN + '/#/assets?day=' + day);
        await page.getByLabel('用户名', { exact: true }).fill('p0admin');
        await page.getByLabel('密码', { exact: true }).fill(process.env.P0_TEST_PASSWORD);
        await page.getByRole('button', { name: '登录中台' }).click();
        await expect(page.getByRole('heading', { name: 'APK 下载工作台' })).toBeVisible();
        const history = page
          .locator('section')
          .filter({ has: page.getByRole('heading', { name: '历史 APK 记录' }) });
        await expect(page.locator('tbody').getByText('下载成功', { exact: true })).toBeVisible();
        await expect(page.getByText('补包已就绪', { exact: true })).toBeVisible();
        await expect(history.locator('input[type=file]')).toHaveCount(0);
        const targetKey = digest('browser-workbench');
        const selected = {
          id: randomUUID(),
          nodeId: node.id,
          nodeName: node.name,
          name: '工作台配置',
          configId: randomUUID(),
          currentVersionId: randomUUID(),
        };
        await page.route('**/api/v1/task-plans?**', (r) =>
          r.fulfill({ json: { items: [selected], nextCursor: null } }),
        );
        await page.route('**/api/v1/apk-assets/workbench?**', (r) =>
          r.fulfill({
            json: {
              releaseId: randomUUID(),
              supported: true,
              scan: null,
              items: [
                {
                  targetKey,
                  label: '浏览器测试应用',
                  sourceLocator: 'name=demo',
                  present: true,
                  url: null,
                  download: null,
                  fileName: null,
                  size: null,
                  downloadedAt: null,
                  receivedBytes: 0,
                  totalBytes: null,
                },
              ],
            },
          }),
        );
        let submitted;
        await page.route('**/api/v1/runs', (r) => {
          submitted = r.request().postDataJSON();
          return r.fulfill({ status: 202, json: { resourceId: randomUUID(), status: 'QUEUED' } });
        });
        await page.reload();
        const url = 'https://owned.example.test/fixture.apk?t=123&auth_key=test%2Bvalue&k=x+y';
        await page.getByLabel('浏览器测试应用 APK 直链').fill(url);
        await page.getByRole('button', { name: '下载', exact: true }).click();
        await expect
          .poll(() => submitted?.resourceAction)
          .toEqual({ kind: 'FETCH', targetKey, url });
        await page.screenshot({ path: join(dir, 'manual-assets.png'), fullPage: true });
        await page.route('**/api/v1/apk-assets?**', (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: '测试查询错误' } }),
          }),
        );
        await history.getByRole('button', { name: '刷新', exact: true }).click();
        await expect(page.getByText('测试查询错误', { exact: true })).toBeVisible();
        await expect(
          page.getByText('所选日期和筛选条件下暂无下载记录。', { exact: true }),
        ).toHaveCount(0);
      },
    );
    await t.test(
      'stale fence quarantines import and never reports applied; cross-day and newer source disallow uploads',
      async () => {
        await db.manualApkUpload.update({
          where: { id: upload.id },
          data: { status: 'QUEUED', operationId: null },
        });
        await tickManualApks(db);
        const workerId = randomUUID();
        const job = await claimJob(db, workerId);
        assert.equal(job.kind, 'APK_IMPORT');
        await db.deployment.update({
          where: { id: job.id },
          data: { leaseExpiresAt: new Date(0) },
        });
        await finishJob(db, job.id, workerId, job.fence, 'SUCCEEDED', 'OK', null);
        assert.equal(
          (await db.manualApkUpload.findUniqueOrThrow({ where: { id: upload.id } })).status,
          'NEEDS_REVIEW',
        );
        assert.equal(
          (await request('/apk-uploads/' + upload.id + '/retry', 'POST', {})).status,
          409,
        );
        await db.run.create({
          data: {
            nodeId: node.id,
            configVersionId: version.id,
            purpose: 'DOWNLOAD',
            cacheDay: day,
            status: 'FAILED',
          },
        });
        assert.equal((await create()).status, 409);
        await tickManualApks(db, new Date(Date.now() + 2 * 86400000));
        assert.notEqual(
          (await db.manualApkUpload.findUniqueOrThrow({ where: { id: upload.id } })).status,
          'APPLIED',
        );
      },
    );
  } finally {
    await browser?.close();
    await vite?.close();
    await app?.close();
    await restricted?.$disconnect();
    if (role) {
      await db.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await db.$executeRawUnsafe(`DROP ROLE "${role}"`);
    }
    if (node) {
      await db.nodeSlot.deleteMany({ where: { nodeId: node.id } });
      await db.deploymentEvent.deleteMany({ where: { deployment: { nodeId: node.id } } });
      await db.deployment.deleteMany({ where: { nodeId: node.id } });
      await db.manualApkUpload.deleteMany({ where: { nodeId: node.id } });
      await db.task.deleteMany({ where: { run: { nodeId: node.id } } });
      await db.run.deleteMany({ where: { nodeId: node.id } });
      await db.node.delete({ where: { id: node.id } });
    }
    if (version) await db.configVersion.delete({ where: { id: version.id } });
    await db.configuration.deleteMany({ where: { id: configId } });
    if (release) await db.release.delete({ where: { id: release.id } });
    await db.secretVersion.deleteMany({ where: { id: { in: secretIds } } });
    await db.$disconnect();
  }
});

test('upload deployment preserves persistent mounts and scopes ingress size to binary route', () => {
  const args = {
      NODE_IMAGE: 'node@sha256:' + 'a'.repeat(64),
      NGINX_IMAGE: 'nginx@sha256:' + 'b'.repeat(64),
    },
    config = {
      services: Object.fromEntries(
        ['api', 'worker', 'web', 'tools'].map((x) => [x, { image: 'old-' + x, build: { args } }]),
      ),
    };
  const overrides = manualUploadOverrides(config, { services: {} }),
    next = moduleOverrides(config, ['api'], 'a'.repeat(12), '/opt/apk-hub/source', overrides);
  assert.equal(next.services.api.volumes[0].read_only, false);
  assert.equal(next.services.worker.volumes[0].read_only, true);
  assert.equal(next.services.api.environment.APK_UPLOAD_DIR, '/var/lib/apk-hub/apk-uploads');
  assert.deepEqual(manualUploadOverrides(config, overrides), overrides);
  const source =
      'server { client_max_body_size 256k; location /api/ { proxy_pass http://api:3000; } }',
    nginx = manualUploadNginx(source);
  assert.ok(nginx.includes('client_max_body_size 256k;'));
  assert.ok(nginx.includes('client_max_body_size 512m;'));
  assert.equal(manualUploadNginx(nginx), nginx);
  assert.throws(() => manualUploadNginx(''), /NGINX_LAYOUT_INVALID/);
});
