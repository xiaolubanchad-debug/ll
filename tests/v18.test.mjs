import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { chromium, expect } from '@playwright/test';
import { createServer as createVite } from 'vite';
import { createApp } from '../apps/control-api/dist/app.js';
import { passwordHash } from '../apps/control-api/dist/auth.js';
import { initializeAdmin } from '../apps/control-api/dist/admin.js';
import {
  saveTaskPlan,
  controlTaskPlan,
  taskPlanDetail,
  tickTaskPlans,
  createSecret,
  createRun,
  saveConfiguration,
  maintenanceList,
  maintenanceAction,
  digest,
} from '@apk/platform';
const db = new PrismaClient(),
  now = new Date(),
  day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
let app, vite, browser, base, cookie, csrf, admin, node, release, proxy, task;
const requestId = 'v18-owned-acceptance',
  key = () => randomUUID();
async function call(path, method = 'GET', body, version, requestKey = key(), auth = true) {
  const r = await fetch(base + '/api/v1' + path, {
    method,
    headers: {
      ...(auth ? { cookie } : {}),
      ...(method !== 'GET'
        ? {
            origin: process.env.APP_ORIGIN,
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            'Idempotency-Key': requestKey,
            ...(version ? { 'If-Match': String(version) } : {}),
          }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
async function control(action, id = task.id) {
  const d = await taskPlanDetail(db, id);
  return controlTaskPlan(db, id, { action }, d.task.version, admin.id, requestId, key(), now);
}
async function finish(id, status = 'SUCCEEDED', extra = {}) {
  await db.run.update({ where: { id }, data: { status, finishedAt: new Date(), ...extra } });
  await db.nodeSlot.update({
    where: { nodeId: node.id },
    data: { runId: null, operationId: null, quarantined: false },
  });
  await db.node.update({ where: { id: node.id }, data: { lastSeenAt: new Date() } });
}
async function cycle() {
  return db.managedCycle.findFirstOrThrow({
    where: { taskId: task.id },
    orderBy: { createdAt: 'desc' },
    include: { runs: { orderBy: { createdAt: 'asc' } } },
  });
}
async function ticks(n = 1) {
  for (let i = 0; i < n; i++) await tickTaskPlans(db, now);
}
test('1.8 managed tasks: real PostgreSQL, persistent orchestration and browser controls', async (t) => {
  try {
    if (!(await db.admin.findFirst()))
      await initializeAdmin(db, 'p0admin', process.env.P0_TEST_PASSWORD);
    admin = await db.admin.findFirstOrThrow();
    await db.admin.update({
      where: { id: admin.id },
      data: { passwordHash: await passwordHash(process.env.P0_TEST_PASSWORD) },
    });
    await db.loginBucket.deleteMany();
    release = await db.release.create({
      data: {
        id: randomUUID(),
        sha256: digest(randomUUID()),
        artifactName: 'agent-' + digest(randomUUID()) + '.tgz',
        manifest: {
          agentVersion: '0.12.3',
          features: [
            'DOWNLOAD_V1',
            'REGISTRATION_V1',
            'DAILY_V1',
            'AUTO_REGISTRATION_V1',
            'CONTENT_ISOLATION_V1',
          ],
          toolchain: { systemImage: 'system-images;android-35;google_apis;x86_64' },
        },
      },
    });
    node = await db.node.create({
      data: {
        name: '1.8 自有测试服务器',
        host: '192.0.2.181',
        lastSeenAt: new Date(),
        agentVersion: '0.12.3',
        agentReleaseId: release.id,
        deploymentStatus: 'INSTALLED',
        downloadProtocol: '1.0',
        registrationProtocol: '1.0',
        health: { download: true, android: true, kvm: true },
        slot: { create: {} },
      },
    });
    proxy = await createSecret(
      db,
      {
        type: 'HTTP_PROXY',
        name: '1.8 自有测试代理',
        secretValue: {
          host: 'proxy.example.test',
          port: 10000,
          username: 'owned-fixture',
          password: 'OwnedFixturePassword123',
        },
      },
      admin.id,
      requestId,
    );
    const fixture = JSON.parse(await readFile('contracts/fixtures/v18.valid.json', 'utf8'));
    const input = {
      ...fixture.task,
      nodeId: node.id,
      name: '1.8 自有任务',
      successTarget: 3,
      attemptLimit: 8,
    };
    input.configuration.execution.proxySecretVersionId = proxy.id;
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const login = await fetch(base + '/api/v1/auth/login', {
      method: 'POST',
      headers: { origin: process.env.APP_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'p0admin', password: process.env.P0_TEST_PASSWORD }),
    });
    assert.equal(login.status, 200);
    cookie = login.headers.get('set-cookie').split(';')[0];
    csrf = (await login.json()).csrfToken;
    await t.test(
      'single save builds an immutable configuration and leaves the task stopped',
      async () => {
        const idem = key();
        const results = await Promise.all([
          call('/task-plans', 'POST', input, undefined, idem),
          call('/task-plans', 'POST', input, undefined, idem),
        ]);
        assert.ok(results.every((r) => r.status === 201));
        task = results[0].data;
        assert.equal(task.id, results[1].data.id);
        assert.equal(task.enabled, false);
        assert.deepEqual(task.readiness, []);
        assert.equal(await db.managedCycle.count({ where: { taskId: task.id } }), 0);
        assert.ok(!JSON.stringify(task).includes('OwnedFixturePassword123'));
        assert.equal(
          (await call('/task-plans', 'GET', undefined, undefined, undefined, false)).status,
          401,
        );
        assert.equal(
          (await call('/task-plans', 'POST', { ...input, attemptLimit: 2 })).status,
          422,
        );
        assert.equal((await call('/maintenance/items?kind=ANY_TABLE')).status, 422);
      },
    );
    await t.test(
      'repeated start and concurrent scheduler ticks create one proxy check',
      async () => {
        const idem = key();
        const starts = await Promise.all([
          call(
            '/task-plans/' + task.id + '/control',
            'POST',
            { action: 'START' },
            task.version,
            idem,
          ),
          call(
            '/task-plans/' + task.id + '/control',
            'POST',
            { action: 'START' },
            task.version,
            idem,
          ),
        ]);
        assert.ok(starts.every((r) => r.status === 200));
        await Promise.all([ticks(), ticks(), ticks()]);
        const c = await cycle();
        assert.equal(c.runs.length, 1);
        assert.equal(c.runs[0].purpose, 'PROXY_CHECK');
        assert.equal(c.status, 'CHECKING_PROXY');
        await assert.rejects(
          createRun(
            db,
            {
              nodeId: node.id,
              configVersionId: c.configVersionId,
              releaseId: release.id,
              purpose: 'DOWNLOAD',
            },
            admin.id,
            requestId,
            key(),
          ),
          (e) => e.code === 'NODE_BUSY',
        );
      },
    );
    await t.test('proxy failure never creates an APK or registration run', async () => {
      const c = await cycle();
      await finish(c.proxyRunId, 'FAILED', { errorCode: 'PROXY_CHECK_FAILED' });
      await ticks();
      assert.equal((await cycle()).status, 'FAILED');
      assert.equal(
        await db.run.count({
          where: { taskCycleId: c.id, purpose: { in: ['DOWNLOAD', 'REGISTER'] } },
        }),
        0,
      );
      await control('START');
      await ticks();
      const resumed = await cycle();
      assert.notEqual(resumed.proxyRunId, c.proxyRunId);
      await finish(resumed.proxyRunId);
      await ticks();
    });
    let downloadId, registerId;
    await t.test(
      'download and registration are linked without a browser choosing batch IDs',
      async () => {
        const c = await cycle();
        downloadId = c.downloadRunId;
        assert.ok(downloadId);
        const apk = {
          ...JSON.parse(await readFile('contracts/fixtures/p2.valid.json', 'utf8')).ApkMetadata,
          cacheDay: day,
        };
        await db.task.create({
          data: {
            id: randomUUID(),
            runId: downloadId,
            targetKey: digest('v18-owned-target'),
            entryId: 'v18-entry',
            label: 'Owned fixture',
            sourceUrl: 'https://downloads.example.test/owned.apk',
            position: 0,
            status: 'SUCCEEDED',
            proof: 'FILE_VALIDATION',
            apk,
          },
        });
        await finish(downloadId);
        await Promise.all([ticks(), ticks()]);
        const updated = await cycle();
        const registers = updated.runs.filter((r) => r.purpose === 'REGISTER');
        assert.equal(registers.length, 1);
        registerId = registers[0].id;
        assert.equal(registers[0].sourceDownloadId, downloadId);
        assert.equal(registers[0].successTarget, 3);
        assert.equal(registers[0].attemptLimit, 8);
        assert.equal((await taskPlanDetail(db, task.id)).task.latestCycle.apkCount, 1);
      },
    );
    await t.test(
      'stop is durable; a queued phase stops with no successor or duplicate download',
      async () => {
        await controlTaskPlan(db, task.id, { action: 'STOP' }, 1, admin.id, requestId, key(), now);
        assert.equal((await cycle()).status, 'STOPPING');
        assert.equal(
          (await db.run.findUniqueOrThrow({ where: { id: registerId } })).status,
          'CANCELLED',
        );
        assert.equal(
          (await db.managedTask.findUniqueOrThrow({ where: { id: task.id } })).enabled,
          false,
        );
        await Promise.all([ticks(), ticks()]);
        assert.equal(
          (await db.run.findUniqueOrThrow({ where: { id: registerId } })).status,
          'CANCELLED',
        );
        assert.equal((await cycle()).status, 'STOPPED');
        await ticks(2);
        assert.equal(await db.run.count({ where: { nodeId: node.id, purpose: 'DOWNLOAD' } }), 1);
      },
    );
    await t.test(
      'resume retains global successes and attempts and never replays a submitted run',
      async () => {
        await db.run.update({
          where: { id: registerId },
          data: { successes: 1, attemptsStarted: 2 },
        });
        await control('START');
        await ticks();
        const c = await cycle();
        await finish(c.proxyRunId);
        await ticks();
        const latest = (await cycle()).runs.filter((r) => r.purpose === 'REGISTER').at(-1);
        assert.notEqual(latest.id, registerId);
        assert.equal(latest.successTarget, 2);
        assert.equal(latest.attemptLimit, 6);
        assert.equal(latest.sourceDownloadId, downloadId);
        await finish(latest.id, 'NEEDS_REVIEW', {
          attemptsStarted: 1,
          errorCode: 'REGISTRATION_UNKNOWN',
        });
        await db.nodeSlot.update({
          where: { nodeId: node.id },
          data: { quarantined: true, runId: latest.id },
        });
        await ticks();
        assert.equal((await cycle()).status, 'NEEDS_REVIEW');
        await assert.rejects(control('START'), (e) =>
          ['NODE_QUARANTINED', 'NODE_BUSY', 'REVIEW_REQUIRED'].includes(e.code),
        );
        const before = await db.run.count({ where: { nodeId: node.id } });
        await ticks(2);
        assert.equal(await db.run.count({ where: { nodeId: node.id } }), before);
        await db.run.update({ where: { id: latest.id }, data: { reviewResolvedAt: new Date() } });
        await db.nodeSlot.update({
          where: { nodeId: node.id },
          data: { quarantined: false, runId: null },
        });
        await control('STOP');
        await ticks();
        assert.equal((await cycle()).status, 'STOPPED');
      },
    );
    await t.test(
      'resume adopts the edited registration settings and rejects stale generations',
      async () => {
        const d = await taskPlanDetail(db, task.id);
        const changed = {
          ...input,
          configId: task.configId,
          configuration: {
            ...d.configuration,
            execution: {
              ...d.configuration.execution,
              autoRegistration: {
                ...d.configuration.execution.autoRegistration,
                maxNavigationSteps: 9,
              },
            },
          },
        };
        const saved = await saveTaskPlan(
          db,
          changed,
          admin.id,
          requestId,
          key(),
          task.id,
          d.task.version,
        );
        await control('START');
        const c = await cycle();
        assert.equal(c.configVersionId, saved.currentVersionId);
        const common = {
          nodeId: node.id,
          configVersionId: c.configVersionId,
          releaseId: release.id,
          purpose: 'PROXY_CHECK',
          proxySecretVersionId: proxy.id,
        };
        await assert.rejects(
          createRun(db, common, admin.id, requestId, key(), now, undefined, c.id, c.generation - 1),
          (e) => e.code === 'TASK_CHANGED',
        );
        await control('STOP');
        await assert.rejects(
          createRun(db, common, admin.id, requestId, key(), now, undefined, c.id, c.generation),
          (e) => e.code === 'TASK_STOPPED',
        );
        await ticks();
        assert.equal((await cycle()).status, 'STOPPED');
      },
    );
    await t.test(
      'dispatched stop keeps the node reserved until a cleanup receipt arrives',
      async () => {
        await control('START');
        await ticks();
        const c = await cycle(),
          slot = await db.nodeSlot.findUniqueOrThrow({ where: { nodeId: node.id } });
        await db.delivery.create({
          data: {
            runId: c.proxyRunId,
            bootId: randomUUID(),
            fence: slot.fence,
            ackDeadline: new Date(Date.now() + 120000),
            leaseExpiresAt: new Date(Date.now() + 120000),
            acceptedAt: new Date(),
          },
        });
        await db.run.update({ where: { id: c.proxyRunId }, data: { status: 'RUNNING' } });
        await control('STOP');
        await ticks();
        assert.equal((await cycle()).status, 'STOPPING');
        assert.equal(
          (await db.nodeSlot.findUniqueOrThrow({ where: { nodeId: node.id } })).runId,
          c.proxyRunId,
        );
        await db.node.update({ where: { id: node.id }, data: { lastSeenAt: new Date(0) } });
        await ticks();
        assert.equal((await cycle()).status, 'STOPPING');
        await finish(c.proxyRunId, 'CANCELLED', { cleanupConfirmedAt: new Date() });
        await ticks();
        assert.equal((await cycle()).status, 'STOPPED');
      },
    );
    await t.test(
      'editing source defers download rules and all rounds share the daily APK',
      async () => {
        let d = await taskPlanDetail(db, task.id);
        const changed = {
          ...input,
          configId: task.configId,
          name: input.name,
          configuration: {
            ...d.configuration,
            source: { ...d.configuration.source, url: 'https://new-source.example.test/' },
          },
        };
        await saveTaskPlan(db, changed, admin.id, requestId, key(), task.id, d.task.version);
        await control('NEW_ROUND');
        const c = await cycle();
        assert.equal(c.deferredDownloadRules, true);
        const effective = await db.configVersion.findUniqueOrThrow({
          where: { id: c.configVersionId },
        });
        assert.equal(effective.body.source.url, input.configuration.source.url);
        await ticks();
        await finish((await cycle()).proxyRunId);
        await ticks();
        await ticks();
        assert.equal((await cycle()).downloadRunId, downloadId);
        assert.equal(await db.run.count({ where: { nodeId: node.id, purpose: 'DOWNLOAD' } }), 1);
        await control('STOP');
        await ticks();
      },
    );
    await t.test('a completed quota never becomes an extra round on repeated start', async () => {
      const c = await cycle(),
        registered = c.runs.filter((r) => r.purpose === 'REGISTER').at(-1);
      await finish(registered.id, 'SUCCEEDED', {
        successes: c.successTarget,
        attemptsStarted: c.successTarget,
      });
      const before = await db.run.count({ where: { nodeId: node.id } }),
        rounds = await db.managedCycle.count({ where: { taskId: task.id } });
      const result = await control('START');
      assert.equal(result.enabled, false);
      await ticks();
      assert.equal(await db.run.count({ where: { nodeId: node.id } }), before);
      assert.equal(await db.managedCycle.count({ where: { taskId: task.id } }), rounds);
    });
    await t.test(
      'unused versions delete, referenced versions archive, and bulk stale deletion rolls back',
      async () => {
        const d = await taskPlanDetail(db, task.id);
        const old = await db.configVersion.findFirstOrThrow({
          where: { configId: task.configId, id: { not: d.task.currentVersionId } },
          orderBy: { createdAt: 'asc' },
        });
        const list = await maintenanceList(db, { kind: 'CONFIG_VERSION', configId: task.configId });
        const used = list.items.find((r) => r.id === old.id);
        assert.equal(used.canDelete, false);
        await assert.rejects(
          maintenanceAction(
            db,
            {
              action: 'DELETE',
              items: [{ id: used.id, kind: 'CONFIG_VERSION', revision: used.revision }],
            },
            admin.id,
            requestId,
            key(),
          ),
          (e) => e.code === 'VERSION_REFERENCED',
        );
        await maintenanceAction(
          db,
          {
            action: 'ARCHIVE',
            items: [{ id: used.id, kind: 'CONFIG_VERSION', revision: used.revision }],
          },
          admin.id,
          requestId,
          key(),
        );
        assert.ok(
          !(await call('/configs/' + task.configId + '/versions')).data.items.some(
            (v) => v.id === used.id,
          ),
        );
        assert.equal(
          (await call('/configs/' + task.configId + '/versions/' + used.id)).status,
          200,
        );
        await assert.rejects(
          createRun(
            db,
            {
              nodeId: node.id,
              configVersionId: used.id,
              releaseId: release.id,
              purpose: 'DOWNLOAD',
            },
            admin.id,
            requestId,
            key(),
          ),
          (e) => e.code === 'VERSION_ARCHIVED',
        );
        const free = await saveConfiguration(
          db,
          task.configId,
          input.configuration,
          (await db.configuration.findUniqueOrThrow({ where: { id: task.configId } })).version,
          admin.id,
          requestId,
          key(),
        );
        await assert.rejects(
          maintenanceAction(
            db,
            {
              action: 'DELETE',
              items: [
                { id: free.id, kind: 'CONFIG_VERSION', revision: 1 },
                { id: d.task.currentVersionId, kind: 'CONFIG_VERSION', revision: 999 },
              ],
            },
            admin.id,
            requestId,
            key(),
          ),
          (e) => e.code === 'STALE_VERSION',
        );
        assert.ok(await db.configVersion.findUnique({ where: { id: free.id } }));
        await maintenanceAction(
          db,
          { action: 'DELETE', items: [{ id: free.id, kind: 'CONFIG_VERSION', revision: 1 }] },
          admin.id,
          requestId,
          key(),
        );
        assert.equal(await db.configVersion.findUnique({ where: { id: free.id } }), null);
        const r = (await maintenanceList(db, { kind: 'RELEASE' })).items.find(
          (r) => r.id === release.id,
        );
        assert.equal(r.canDelete, false);
      },
    );
    await t.test(
      'daily scheduling survives a new scheduler instance and stop prevents future days',
      async () => {
        const d = await taskPlanDetail(db, task.id);
        await saveTaskPlan(
          db,
          { ...input, configId: task.configId, automatic: true },
          admin.id,
          requestId,
          key(),
          task.id,
          d.task.version,
        );
        await control('START');
        await ticks();
        const c = await cycle();
        if (c.proxyRunId) {
          const r = await db.run.findUniqueOrThrow({ where: { id: c.proxyRunId } });
          if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(r.status)) await finish(r.id);
        }
        const boundary = new Date(new Date(day + 'T00:05:00+08:00').getTime() + 86400000);
        await tickTaskPlans(db, new Date(boundary.getTime() - 1000));
        assert.equal(
          await db.managedCycle.count({ where: { taskId: task.id, day: { not: day } } }),
          0,
        );
        await Promise.all([tickTaskPlans(db, boundary), tickTaskPlans(db, boundary)]);
        assert.equal(
          await db.managedCycle.count({ where: { taskId: task.id, day: { not: day } } }),
          1,
        );
        await control('STOP');
        await tickTaskPlans(db, boundary);
        const future = new Date(boundary.getTime() + 86400000);
        await tickTaskPlans(db, future);
        assert.equal(
          await db.managedCycle.count({ where: { taskId: task.id, day: { not: day } } }),
          1,
        );
      },
    );
    await t.test(
      'browser creates a task in three steps and exposes clear start, stop and history actions',
      async () => {
        vite = await createVite({
          configFile: 'apps/web/vite.config.ts',
          root: 'apps/web',
          server: {
            port: Number(new URL(process.env.APP_ORIGIN).port),
            host: '127.0.0.1',
            strictPort: true,
            proxy: { '/api': { target: base } },
          },
        });
        await vite.listen();
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
          errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(process.env.APP_ORIGIN + '/#/tasks');
        await page.getByLabel('用户名', { exact: true }).fill('p0admin');
        await page.getByLabel('密码', { exact: true }).fill(process.env.P0_TEST_PASSWORD);
        await page.getByRole('button', { name: '登录中台', exact: true }).click();
        await page.getByRole('button', { name: '新建任务', exact: true }).click();
        await page.getByLabel('任务名称', { exact: true }).fill('1.8 浏览器自有任务');
        await page
          .getByLabel('网站 URL', { exact: true })
          .fill('https://owned-browser.example.test/');
        await page.getByRole('button', { name: '下一步', exact: true }).click();
        await page.getByLabel('执行服务器', { exact: true }).selectOption(node.id);
        await page.getByLabel('APP 网络代理', { exact: true }).selectOption(proxy.id);
        await expect(page.getByLabel('同时执行轮数', { exact: true })).toBeDisabled();
        await expect(page.getByLabel('同时执行轮数', { exact: true })).toHaveValue('1');
        await page.getByRole('button', { name: '下一步', exact: true }).click();
        await page.getByLabel('所有 APK 合计完成轮数', { exact: true }).fill('5');
        await page.getByLabel('总尝试上限', { exact: true }).fill('15');
        await page.getByRole('button', { name: '保存任务', exact: true }).click();
        await expect(
          page.getByRole('heading', { name: '1.8 浏览器自有任务', exact: true }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: '开始任务', exact: true })).toBeDisabled();
        await expect(page.locator('.readiness-list')).toContainText('启动停留需要 Agent 0.10.0');
        await db.node.update({
          where: { id: node.id },
          data: { agentVersion: '0.11.0', lastSeenAt: new Date() },
        });
        await db.release.update({
          where: { id: release.id },
          data: {
            manifest: {
              ...release.manifest,
              agentVersion: '0.11.0',
              features: [...release.manifest.features, 'APP_OPEN_V1', 'APP_OPEN_PARALLEL_V1'],
            },
          },
        });
        await page.getByRole('button', { name: '刷新', exact: true }).click();
        await expect(page.getByRole('button', { name: '开始任务', exact: true })).toBeEnabled();
        await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeDisabled();
        await page.getByRole('button', { name: '开始任务', exact: true }).click();
        await expect(page.getByRole('button', { name: '停止任务', exact: true })).toBeEnabled();
        await page.getByRole('button', { name: '停止任务', exact: true }).click();
        await expect(
          page.locator('.managed-task-card .phase-tag').filter({ hasText: '等待停止与清理' }),
        ).toBeVisible();
        const browserTask = await db.managedTask.findFirstOrThrow({
          where: { name: '1.8 浏览器自有任务' },
        });
        const browserConfig = await db.configVersion.findUniqueOrThrow({
          where: { id: browserTask.currentVersionId },
        });
        assert.deepEqual(browserConfig.body.execution.appOpen, { dwellMs: 10000, concurrency: 1 });
        assert.equal(browserConfig.body.execution.autoRegistration, undefined);
        assert.deepEqual(browserConfig.body.registrationFlows, []);
        const freeVersion = await saveConfiguration(
          db,
          browserTask.configId,
          input.configuration,
          (await db.configuration.findUniqueOrThrow({ where: { id: browserTask.configId } }))
            .version,
          admin.id,
          requestId,
          key(),
        );
        await page.getByRole('button', { name: '刷新历史', exact: true }).click();
        const freeRow = page
          .locator('.history-manager tbody tr')
          .filter({ hasText: '版本 ' + freeVersion.version });
        await expect(freeRow.getByRole('button', { name: '删除', exact: true })).toBeEnabled();
        await freeRow.getByRole('button', { name: '删除', exact: true }).click();
        await page.getByRole('button', { name: '确认删除', exact: true }).click();
        await expect(freeRow).toHaveCount(0);
        await expect(page.getByRole('button', { name: '开始任务', exact: true })).toBeDisabled();
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: join(process.env.P1_TEST_DIR, 'v18-task-center.png'),
          fullPage: true,
        });
        await page.reload();
        await expect(
          page.getByRole('heading', { name: '1.8 浏览器自有任务', exact: true }),
        ).toBeVisible();
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        );
        await page.screenshot({
          path: join(process.env.P1_TEST_DIR, 'v18-task-mobile.png'),
          fullPage: true,
        });
        assert.deepEqual(errors, []);
        assert.ok(!(await page.locator('body').innerText()).includes('OwnedFixturePassword123'));
      },
    );
  } finally {
    await browser?.close();
    await vite?.close();
    await app?.close();
    if (node) {
      const tasks = await db.managedTask.findMany({ where: { nodeId: node.id } }),
        configIds = tasks.map((t) => t.configId);
      await db.nodeSlot.deleteMany({ where: { nodeId: node.id } });
      await db.task.deleteMany({ where: { run: { nodeId: node.id } } });
      await db.delivery.deleteMany({ where: { run: { nodeId: node.id } } });
      await db.run.deleteMany({ where: { nodeId: node.id } });
      await db.managedCycle.deleteMany({ where: { taskId: { in: tasks.map((t) => t.id) } } });
      await db.managedTask.deleteMany({ where: { nodeId: node.id } });
      await db.configVersion.deleteMany({ where: { configId: { in: configIds } } });
      await db.configuration.deleteMany({ where: { id: { in: configIds } } });
      await db.node.delete({ where: { id: node.id } });
    }
    if (release) await db.release.delete({ where: { id: release.id } });
    if (proxy) await db.secretVersion.delete({ where: { id: proxy.id } });
    await db.$disconnect();
  }
});
