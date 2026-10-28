import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { PrismaClient } from '@prisma/client';
import { chromium, expect } from '@playwright/test';
import { createServer as createVite } from 'vite';
import { createApp } from '../apps/control-api/dist/app.js';
import { passwordHash } from '../apps/control-api/dist/auth.js';
import { DailyScheduler } from '../apps/control-api/dist/v15-controllers.js';
import { encrypt, digest } from '@apk/platform';
const db = new PrismaClient(),
  day = '2030-01-02',
  start = new Date(day + 'T02:00:00Z'),
  secret = 'OwnedOnlySensitiveValue123';
let app,
  vite,
  browser,
  base,
  cookie,
  csrf,
  proxyFixtureId,
  nodeId,
  configId,
  versionId,
  runId,
  downloadId,
  deliveryId,
  validationId,
  accountRef,
  ids = [];
async function get(path, auth = true) {
  const r = await fetch(base + '/api/v1' + path, { headers: auth ? { cookie } : {} });
  return { status: r.status, data: await r.json() };
}
const scope = (extra = {}) => new URLSearchParams({ from: day, to: day, nodeId, ...extra });
test('1.7 console acceptance: real database, long timelines and browser navigation', async (t) => {
  try {
    const admin = await db.admin.findFirstOrThrow();
    await db.admin.update({
      where: { id: admin.id },
      data: { passwordHash: await passwordHash(process.env.P0_TEST_PASSWORD) },
    });
    await db.loginBucket.deleteMany();
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
    nodeId = (
      await db.node.create({
        data: { name: '1.7 自有验收节点', host: '192.0.2.171', lastSeenAt: new Date() },
      })
    ).id;
    configId = (await db.configuration.create({ data: { name: '1.7 自有验收方案' } })).id;
    const body = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
    versionId = (
      await db.configVersion.create({
        data: { configId, version: 1, body, configHash: 'a'.repeat(64), createdBy: admin.id },
      })
    ).id;
    runId = (
      await db.run.create({
        data: {
          nodeId,
          configVersionId: versionId,
          purpose: 'REGISTER',
          status: 'PARTIAL_FAILED',
          createdAt: start,
          finishedAt: new Date(start.getTime() + 3600000),
          attemptsStarted: 141,
          attemptLimit: 200,
          successTarget: 200,
          successes: 134,
          createdBy: admin.id,
        },
      })
    ).id;
    deliveryId = (
      await db.delivery.create({
        data: {
          runId,
          bootId: randomUUID(),
          fence: 1,
          ackDeadline: new Date(),
          leaseExpiresAt: new Date(),
          appliedThroughSequence: 220,
        },
      })
    ).id;
    const apk = {
      packageName: 'com.example.ownedconsole',
      versionName: 'owned',
      versionCode: 1,
      abis: ['x86_64'],
      size: 1024,
      apkSha256: 'b'.repeat(64),
      cacheDay: day,
    };
    const variants = [
      ...Array(134).fill(['SUCCEEDED', 'APP_UI', null]),
      ['FAILED', 'APP_UI', 'REGISTRATION_REJECTED'],
      ['FAILED', 'NONE', 'APPIUM_FAILED'],
      ['FAILED', 'NONE', 'AUTO_ENTRY_NOT_FOUND'],
      ['UNKNOWN', 'NONE', 'REGISTRATION_UNKNOWN'],
      ['UNKNOWN', 'NONE', 'REGISTRATION_UNKNOWN'],
      ['CANCELLED', 'NONE', null],
      ['INSTALLING', 'NONE', null],
    ];
    const rows = variants.map(([status, proof, errorCode], i) => {
      const id = randomUUID();
      ids.push(id);
      return {
        id,
        runId,
        position: i,
        targetKey: digest('owned-v17-' + i),
        label: '验收用 APP ' + i,
        sourceUrl: 'https://owned.example.test/',
        status,
        proof,
        errorCode,
        apk,
        startedAt: new Date(start.getTime() + i * 1000),
        registrationStartedAt: new Date(start.getTime() + i * 1000),
        finishedAt: status === 'INSTALLING' ? null : new Date(start.getTime() + i * 1000 + 5000),
        lastStage: status === 'FAILED' && proof === 'NONE' ? 'INSTALLING' : 'VERIFYING',
        attemptStarted: true,
        submissionId: proof === 'APP_UI' || status === 'UNKNOWN' ? randomUUID() : null,
        recognition:
          errorCode === 'AUTO_ENTRY_NOT_FOUND'
            ? {
                source: 'CONTROLS',
                navigationSteps: 0,
                cache: 'MISS',
                learned: false,
                needsAdaptation: true,
              }
            : undefined,
      };
    });
    rows.push(
      ...Array.from({ length: 50 }, (_, i) => ({
        id: randomUUID(),
        runId,
        position: i + 141,
        targetKey: digest('unused-v17-' + i),
        label: '未执行配额',
        sourceUrl: 'https://owned.example.test/',
        status: 'SKIPPED',
        proof: 'NONE',
        errorCode: 'QUOTA_NOT_USED',
      })),
    );
    await db.task.createMany({ data: rows });
    const boundaryId = randomUUID();
    await db.task.create({
      data: {
        id: boundaryId,
        runId,
        position: 191,
        targetKey: digest(boundaryId),
        label: '前一天边界',
        sourceUrl: 'https://owned.example.test/',
        status: 'SUCCEEDED',
        proof: 'APP_UI',
        registrationStartedAt: new Date(new Date(day + 'T00:00:00+08:00').getTime() - 1),
      },
    });
    await db.taskReview.create({
      data: {
        taskId: ids[138],
        outcome: 'SUCCEEDED',
        reason: '自有记录，人工确认但保留原始未知状态',
        createdBy: admin.id,
        evidenceIds: [],
      },
    });
    accountRef = randomUUID();
    await db.accountResult.create({
      data: {
        accountRef,
        taskId: ids[0],
        deliveryId,
        fence: 1,
        contentHash: digest(secret),
        encrypted: encrypt({ username: 'ownedcase', password: secret }, 'account:' + accountRef),
      },
    });
    await db.runEvent.createMany({
      data: Array.from({ length: 221 }, (_, i) => ({
        id: randomUUID(),
        deliveryId,
        sequence: i + 1,
        contentHash: digest('owned-event-' + i),
        recordedForReview: i === 220,
        createdAt: new Date(start.getTime() + i * 1000),
        body: {
          eventId: randomUUID(),
          runId,
          taskId: ids[0],
          sequence: i + 1,
          occurredAt: new Date(start.getTime() + i * 1000).toISOString(),
          type: i === 219 ? 'TASK_FINISHED' : 'TASK_STAGE',
          payload:
            i === 219
              ? { status: 'SUCCEEDED', proof: 'APP_UI', password: secret }
              : { stage: 'REGISTERING', password: secret },
        },
      })),
    });
    downloadId = (
      await db.run.create({
        data: {
          nodeId,
          configVersionId: versionId,
          purpose: 'DOWNLOAD',
          status: 'SUCCEEDED',
          cacheDay: day,
          createdAt: start,
          finishedAt: new Date(start.getTime() + 3000),
        },
      })
    ).id;
    await db.task.create({
      data: {
        id: randomUUID(),
        runId: downloadId,
        position: 0,
        targetKey: 'f'.repeat(64),
        label: '自有下载资源',
        sourceUrl: 'https://owned.example.test/',
        status: 'SUCCEEDED',
        proof: 'FILE_VALIDATION',
        apk,
      },
    });
    validationId = (
      await db.deployment.create({
        data: {
          nodeId,
          nodeVersion: 1,
          kind: 'CHECK',
          status: 'SUCCEEDED',
          createdBy: admin.id,
          result: {
            ownedFixtureValidation: true,
            passed: true,
            cleanupComplete: true,
            cases: [
              {
                case: 'Owned fixture only',
                status: 'SUCCEEDED',
                proof: 'APP_UI',
                requests: 1,
                password: secret,
              },
            ],
          },
        },
      })
    ).id;
    await t.test(
      'all registered attempts are counted beyond page limits; date boundaries and reviews stay distinct',
      async () => {
        const r = await get('/console/overview?' + new URLSearchParams({ day, nodeId }));
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(r.data.registrations.SUCCESS, 134);
        assert.equal(r.data.registrations.UNKNOWN, 2);
        assert.equal(r.data.registrations.REJECTED, 1);
        assert.equal(r.data.registrations.ERROR, 1);
        assert.equal(r.data.registrations.ADAPTATION, 1);
        assert.equal(r.data.registrations.SKIPPED, 0);
        assert.equal(r.data.reviewedUnknown, 1);
        assert.equal(r.data.downloads.validated, 1);
        let cursor,
          all = [];
        do {
          const p = await get(
            '/registrations?' + scope({ limit: '100', ...(cursor ? { cursor } : {}) }),
          );
          assert.equal(p.status, 200, JSON.stringify(p.data));
          all.push(...p.data.items);
          cursor = p.data.nextCursor;
        } while (cursor);
        assert.equal(all.length, 141);
        assert.equal(new Set(all.map((r) => r.id)).size, 141);
        assert.ok(all.every((r) => !r.label.includes('未执行')));
        assert.ok(!JSON.stringify(all).includes(secret));
        const reviewed = await get(
          '/registrations?' + scope({ category: 'UNKNOWN', review: 'RESOLVED' }),
        );
        assert.equal(reviewed.data.items.length, 1);
        assert.equal(reviewed.data.items[0].category, 'UNKNOWN');
        assert.equal(reviewed.data.items[0].reviewOutcome, 'SUCCEEDED');
      },
    );
    await t.test(
      'filters, scoped cursors and safe output reject invalid dates and unauthorized readers',
      async () => {
        const first = await get('/registrations?' + scope({ limit: '1' }));
        assert.ok(first.data.nextCursor);
        for (const suffix of [
          'from=2030-02-30',
          'from=2030-01-03&to=2030-01-02',
          'from=2030-01-01&to=2030-03-01',
          'limit=101',
          'category=FAKE',
          'password=private',
        ])
          assert.equal((await get('/registrations?' + suffix)).status, 422, suffix);
        assert.equal(
          (
            await get(
              '/registrations?' + scope({ category: 'SUCCESS', cursor: first.data.nextCursor }),
            )
          ).status,
          422,
        );
        assert.equal(
          (await get('/registrations?' + scope({ q: 'com.example.ownedconsole' }))).data.items
            .length,
          20,
        );
        for (const path of [
          '/registrations',
          '/registrations/' + ids[0],
          '/console/overview',
          '/runs/' + runId + '/timeline',
          '/apk-assets',
          '/console/validations',
        ])
          assert.equal((await get(path, false)).status, 401, path);
        const detail = await get('/registrations/' + ids[0]);
        assert.equal(detail.status, 200);
        assert.equal(detail.data.record.hasAccount, true);
        assert.ok(!JSON.stringify(detail).includes(secret));
        assert.ok(!JSON.stringify(detail).includes('encrypted'));
      },
    );
    await t.test(
      'latest timeline, backward pages and forward continuation cover more than 100 events without secrets',
      async () => {
        const latest = await get('/runs/' + runId + '/timeline?limit=100');
        assert.equal(latest.status, 200, JSON.stringify(latest.data));
        assert.equal(latest.data.firstSequence, 122);
        assert.equal(latest.data.lastSequence, 221);
        assert.equal(latest.data.items.at(-1).recordedForReview, true);
        assert.equal(latest.data.items.at(-1).applied, false);
        assert.ok(latest.data.items.some((e) => e.title === 'APP 已确认注册成功'));
        assert.ok(!JSON.stringify(latest).includes(secret));
        const earlier = await get('/runs/' + runId + '/timeline?beforeSequence=122&limit=100');
        assert.equal(earlier.data.firstSequence, 22);
        assert.equal(earlier.data.lastSequence, 121);
        const tail = await get('/runs/' + runId + '/timeline?afterSequence=100&limit=100');
        assert.equal(tail.data.firstSequence, 101);
        assert.equal(tail.data.lastSequence, 200);
        assert.equal(tail.data.hasLater, true);
        assert.equal(
          (await get('/runs/' + runId + '/timeline?afterSequence=1&beforeSequence=3')).status,
          422,
        );
        assert.equal(
          (await get('/runs/' + runId + '/timeline?taskId=' + randomUUID())).status,
          404,
        );
        const summary = await get('/runs/' + runId + '/summary');
        assert.equal(summary.status, 200, JSON.stringify(summary.data));
        assert.equal(summary.data.taskCount, 192);
        assert.equal(summary.data.counts.SKIPPED, 50);
        const assets = await get('/apk-assets?' + new URLSearchParams({ day, nodeId }));
        assert.equal(assets.status, 200, JSON.stringify(assets.data));
        assert.equal(assets.data.items.length, 1);
        const validation = await get('/console/validations');
        assert.equal(validation.status, 200);
        assert.ok(validation.data.items.some((v) => v.id === validationId));
        assert.ok(!JSON.stringify(validation).includes(secret));
      },
    );
    await t.test(
      'history backfill uses applied receipts and excludes late or unapplied events',
      async () => {
        const rollback = new Error('OWNED_ROLLBACK');
        const sql = (
          await readFile(
            'apps/control-api/prisma/migrations/202610290001_v17/migration.sql',
            'utf8',
          )
        ).split('WITH valid_events AS')[1];
        await assert.rejects(
          db.$transaction(async (tx) => {
            const oldRun = await tx.run.create({
                data: {
                  nodeId,
                  configVersionId: versionId,
                  purpose: 'LEGACY',
                  status: 'SUCCEEDED',
                },
              }),
              taskId = randomUUID();
            const d = await tx.delivery.create({
              data: {
                runId: oldRun.id,
                bootId: randomUUID(),
                fence: 1,
                ackDeadline: new Date(),
                leaseExpiresAt: new Date(),
                appliedThroughSequence: 2,
              },
            });
            await tx.task.create({
              data: {
                id: taskId,
                runId: oldRun.id,
                position: 0,
                targetKey: digest(taskId),
                sourceUrl: 'https://owned.example.test/',
                label: '历史回填验收',
                status: 'SUCCEEDED',
                proof: 'APP_UI',
              },
            });
            await tx.runEvent.createMany({
              data: [
                ['TASK_STAGE', 'PREPARING', false],
                ['TASK_FINISHED', undefined, false],
                ['TASK_STAGE', 'VERIFYING', true],
                ['TASK_STAGE', 'LAUNCHING', false],
              ].map(([type, stage, late], i) => ({
                id: randomUUID(),
                deliveryId: d.id,
                sequence: i + 1,
                contentHash: digest(String(i)),
                createdAt: new Date(start.getTime() + i * 1000),
                recordedForReview: late,
                body: { type, taskId, payload: { stage } },
              })),
            });
            for (const statement of ('WITH valid_events AS' + sql)
              .split(';')
              .filter((s) => s.trim()))
              await tx.$executeRawUnsafe(statement);
            const row = await tx.task.findUniqueOrThrow({ where: { id: taskId } });
            assert.equal(row.registrationStartedAt.toISOString(), start.toISOString());
            assert.equal(row.lastStage, 'PREPARING');
            assert.equal(
              row.finishedAt.toISOString(),
              new Date(start.getTime() + 1000).toISOString(),
            );
            throw rollback;
          }),
          (error) => error === rollback,
        );
      },
    );
    await t.test(
      'lease expiry is checked in the background and keeps the node quarantined',
      async () => {
        const expired = await db.run.create({
          data: {
            nodeId,
            configVersionId: versionId,
            purpose: 'REGISTER',
            status: 'RUNNING',
            successTarget: 1,
            attemptLimit: 1,
          },
        });
        await db.delivery.create({
          data: {
            runId: expired.id,
            bootId: randomUUID(),
            fence: 1,
            ackDeadline: new Date(0),
            leaseExpiresAt: new Date(0),
          },
        });
        await db.nodeSlot.create({ data: { nodeId, runId: expired.id } });
        const previous = process.env.NODE_ENV,
          scheduler = new DailyScheduler(db);
        try {
          process.env.NODE_ENV = 'production';
          scheduler.onModuleInit();
        } finally {
          process.env.NODE_ENV = previous;
          await scheduler.onModuleDestroy();
        }
        const [run, slot] = await Promise.all([
          db.run.findUnique({ where: { id: expired.id } }),
          db.nodeSlot.findUnique({ where: { nodeId } }),
        ]);
        assert.equal(run.status, 'NEEDS_REVIEW');
        assert.equal(slot.quarantined, true);
        assert.equal(slot.runId, expired.id);
      },
    );
    await t.test('proxy names are saved as metadata without revealing credentials', async () => {
      const response = await fetch(base + '/api/v1/secrets/versions', {
        method: 'POST',
        headers: {
          cookie,
          origin: process.env.APP_ORIGIN,
          'x-csrf-token': csrf,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          type: 'HTTP_PROXY',
          name: '1.7 验收代理',
          secretValue: {
            host: 'proxy.example.test',
            port: 10000,
            username: 'OwnedUser',
            password: secret,
          },
        }),
      });
      const saved = await response.json();
      assert.equal(response.status, 201, JSON.stringify(saved));
      proxyFixtureId = saved.id;
      assert.equal(saved.name, '1.7 验收代理');
      assert.ok(!JSON.stringify(saved).includes(secret));
      const list = await get('/secrets?limit=100');
      assert.ok(list.data.items.some((p) => p.id === proxyFixtureId && p.name === '1.7 验收代理'));
      assert.ok(!JSON.stringify(list).includes(secret));
    });
    await t.test(
      'browser follows Chinese logs, restores filtered links and keeps credentials out of ordinary pages',
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
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
          errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(process.env.APP_ORIGIN + '/#/runs/' + runId);
        await page.getByLabel('用户名', { exact: true }).fill('p0admin');
        await page.getByLabel('密码', { exact: true }).fill(process.env.P0_TEST_PASSWORD);
        await page.getByRole('button', { name: '登录中台' }).click();
        await expect(page.getByRole('heading', { name: '执行日志', exact: true })).toBeVisible();
        await expect(page.locator('.timeline-list')).toContainText('#221');
        assert.ok(!(await page.locator('body').innerText()).includes(secret));
        await db.runEvent.create({
          data: {
            id: randomUUID(),
            deliveryId,
            sequence: 222,
            contentHash: digest('owned-event-222'),
            body: {
              type: 'TASK_STAGE',
              runId,
              taskId: ids[0],
              occurredAt: new Date().toISOString(),
              payload: { stage: 'VERIFYING', password: secret },
            },
          },
        });
        await db.delivery.update({
          where: { id: deliveryId },
          data: { appliedThroughSequence: 222 },
        });
        await expect(page.locator('.timeline-list')).toContainText('#222');
        await page.getByRole('button', { name: '加载更早日志', exact: true }).click();
        await expect(page.locator('.timeline-list')).toContainText('#22');
        await page.getByRole('button', { name: '加载更早日志', exact: true }).click();
        await expect(page.locator('.timeline-list')).toContainText('#1');
        await page.screenshot({
          path: join(process.env.P1_TEST_DIR, 'v17-run-detail.png'),
          fullPage: false,
        });
        await page.getByRole('tab', { name: '轮次与目标', exact: true }).click();
        await expect(page.locator('.data-table tbody tr')).toHaveCount(30);
        await page.getByRole('button', { name: '下一批目标', exact: true }).click();
        await expect(page.locator('.data-table tbody tr').first().locator('td').first()).toHaveText(
          '31',
        );
        await page.reload();
        await expect(page.locator('.data-table tbody tr').first().locator('td').first()).toHaveText(
          '31',
        );
        await page.getByRole('tab', { name: '执行日志', exact: true }).click();
        await expect(page.getByRole('heading', { name: '执行日志', exact: true })).toBeVisible();
        const params = scope({ category: 'UNKNOWN' });
        await page.goto(process.env.APP_ORIGIN + '/#/results?' + params);
        await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
        await page.getByRole('button', { name: '查看详情', exact: true }).first().click();
        await expect(page.getByRole('heading', { name: '注册证据', exact: true })).toBeVisible();
        await page.reload();
        await expect(page.getByRole('heading', { name: '注册证据', exact: true })).toBeVisible();
        await expect(page.getByLabel('结果', { exact: true })).toHaveValue('UNKNOWN');
        await page.goBack();
        await expect(page.locator('.data-table tbody tr')).toHaveCount(2);
        await page.screenshot({
          path: join(process.env.P1_TEST_DIR, 'v17-registration-records.png'),
          fullPage: true,
        });
        await page.goto(process.env.APP_ORIGIN + '/#/proxies');
        await expect(page.getByRole('cell', { name: '1.7 验收代理', exact: true })).toBeVisible();
        assert.ok(!(await page.locator('body').innerText()).includes(secret));
        await page.screenshot({
          path: join(process.env.P1_TEST_DIR, 'v17-proxies.png'),
          fullPage: true,
        });
        await page.goto(process.env.APP_ORIGIN + '/#/overview');
        await page.getByLabel('统计日期（北京时间）').fill(day);
        await page.getByLabel('统计日期（北京时间）').dispatchEvent('change');
        await expect(
          page.locator('.metric-card').filter({ hasText: '注册成功' }).locator('strong'),
        ).toHaveText('134');
        await expect(
          page.locator('.metric-card').filter({ hasText: '待核验' }).locator('strong'),
        ).toHaveText('1');
        await page.screenshot({
          path: join(process.env.P1_TEST_DIR, 'v17-overview.png'),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        );
        await page.screenshot({
          path: join(process.env.P1_TEST_DIR, 'v17-mobile.png'),
          fullPage: true,
        });
        assert.deepEqual(errors, []);
      },
    );
  } finally {
    await browser?.close();
    await vite?.close();
    await app?.close();
    if (nodeId) {
      await db.nodeSlot.deleteMany({ where: { nodeId } });
      await db.accountResult.deleteMany({ where: { delivery: { run: { nodeId } } } });
      await db.taskReview.deleteMany({ where: { task: { run: { nodeId } } } });
      await db.runEvent.deleteMany({ where: { delivery: { run: { nodeId } } } });
      await db.task.deleteMany({ where: { run: { nodeId } } });
      await db.delivery.deleteMany({ where: { run: { nodeId } } });
      await db.run.deleteMany({ where: { nodeId } });
      await db.deployment.deleteMany({ where: { nodeId } });
      await db.node.delete({ where: { id: nodeId } });
    }
    if (versionId) await db.configVersion.delete({ where: { id: versionId } });
    if (proxyFixtureId) await db.secretVersion.delete({ where: { id: proxyFixtureId } });
    if (configId) await db.configuration.delete({ where: { id: configId } });
    await db.$disconnect();
  }
});
