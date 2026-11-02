import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { configurationIssues, schemaIssues } from '@apk/contracts';

test('server wizard exposes independent download cap, >10 apps, >800 opens and explicitly applied AUTO/MANUAL quota', async () => {
  const preview = resolve('.tmp/capacity-wizard-' + randomUUID() + '.mjs'),
    nodeId = randomUUID(),
    proxy = randomUUID();
  await writeFile(
    preview,
    "import{createApp}from'vue';import{ElAlert,ElButton,ElInput,ElInputNumber,ElTable,ElTableColumn}from'element-plus';import 'element-plus/dist/index.css';import '/src/style.css';import View from '/src/TaskWizard.vue';createApp(View,{compact:true,fixedNodeId:" +
      JSON.stringify(nodeId) +
      "}).use(ElAlert).use(ElButton).use(ElInput).use(ElInputNumber).use(ElTable).use(ElTableColumn).mount('#app');",
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1100 } }),
      errors = [],
      writes = [],
      queries = [];
    let manual = null,
      version = 1;
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/v1/**', async (r) => {
      const req = r.request(),
        u = new URL(req.url()),
        p = u.pathname.slice('/api/v1'.length);
      if (req.method() === 'GET') {
        if (p === '/nodes')
          return r.fulfill({
            json: {
              items: [
                {
                  id: nodeId,
                  name: 'Capacity EC2',
                  agentVersion: '0.14.0',
                  connection: 'ONLINE',
                  deploymentStatus: 'INSTALLED',
                },
              ],
              nextCursor: null,
            },
          });
        if (p === '/configs') return r.fulfill({ json: { items: [], nextCursor: null } });
        if (p === '/secrets')
          return r.fulfill({
            json: {
              items: [
                { id: proxy, name: 'Owned proxy fixture', type: 'HTTP_PROXY', revokedAt: null },
              ],
              nextCursor: null,
            },
          });
        if (p.endsWith('/execution-capacity')) {
          const min = Number(u.searchParams.get('appsPerDeviceMin')),
            recommended = min >= 8 ? 1900 : 500;
          queries.push(min);
          return r.fulfill({
            json: {
              nodeId,
              version,
              day: '2026-11-02',
              supported: true,
              mode: manual === null ? 'AUTO' : 'MANUAL',
              manualLimit: manual,
              recommendedLimit: recommended,
              limit: manual ?? recommended,
              used: 20,
              remaining: (manual ?? recommended) - 20,
              frozen: false,
              sampleRuns: 3,
              sampleApps: 60,
              sampleScope: 'OWNED_TEST_ONLY',
              deviceSetupMs: 88223,
              appMs: 22147,
              appsPerDeviceMin: min,
              reservePercent: 25,
              remainingTimeEstimate: 500,
              admissionDeadline: '2026-11-02T15:55:00.000Z',
            },
          });
        }
        return r.fulfill({ status: 503, json: { error: { message: 'Fixture read unavailable' } } });
      }
      const body = req.postDataJSON();
      writes.push({ path: p, method: req.method(), body, headers: req.headers() });
      if (p.endsWith('/execution-capacity')) {
        manual = body.dailyLimit;
        version++;
        return r.fulfill({ json: {} });
      }
      if (p === '/task-plans') return r.fulfill({ json: { id: randomUUID() } });
      return r.fulfill({ status: 422, json: { error: { message: 'Unexpected write' } } });
    });
    await page.route('**/__capacity-wizard', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/@fs/${preview.replaceAll('\\', '/')}"></script>`,
      }),
    );
    await page.goto(process.env.APP_ORIGIN + '/__capacity-wizard');
    await page.locator('#task-name').fill('容量配置');
    await page.locator('#task-url').fill('https://example.test/');
    await page.locator('#task-download-limit').fill('100');
    await page.locator('#task-proxy').selectOption(proxy);
    await page.getByLabel('每台新模拟器依次测试多个不同 APP').check();
    await page.getByRole('spinbutton', { name: '每台最少安装数量' }).fill('8');
    await page.getByRole('spinbutton', { name: '每台最多安装数量' }).fill('37');
    await expect(page.getByText('自动建议', { exact: false })).toContainText('1900');
    assert.ok(queries.includes(8));
    assert.equal(writes.length, 0);
    await page.getByLabel('每日额度方式').selectOption('MANUAL');
    await page.getByLabel('手动每日额度').fill('8641');
    await page.getByRole('button', { name: '应用服务器额度' }).click();
    await expect(page.getByText('请填写 1–8640 的整数额度', { exact: true })).toBeVisible();
    assert.equal(writes.length, 0);
    await page.getByLabel('手动每日额度').fill('2500');
    assert.equal(writes.length, 0);
    await page.getByRole('button', { name: '应用服务器额度' }).click();
    await expect.poll(() => writes.length).toBe(1);
    assert.equal(writes[0].method, 'PUT');
    assert.deepEqual(writes[0].body, { dailyLimit: 2500 });
    assert.equal(writes[0].headers['if-match'], '1');
    assert.ok(writes[0].headers['idempotency-key']);
    await expect(page.getByText('服务器额度设置已保存', { exact: false })).toBeVisible();
    await page.locator('#task-target').fill('2000');
    await page.locator('#task-limit').fill('2200');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => writes.filter((w) => w.path === '/task-plans').length).toBe(1);
    const saved = writes.find((w) => w.path === '/task-plans').body;
    assert.equal(saved.successTarget, 2000);
    assert.equal(saved.attemptLimit, 2200);
    assert.equal(saved.configuration.download.maxTargets, 100);
    assert.deepEqual(saved.configuration.execution.appOpen.appsPerDevice, { min: 8, max: 37 });
    assert.deepEqual(configurationIssues(saved.configuration), []);
    assert.deepEqual(schemaIssues('TaskPlanInput', saved), []);
    assert.equal(
      writes.some((w) => w.path.endsWith('/control')),
      false,
    );
    await page.getByLabel('每日额度方式').selectOption('AUTO');
    await page.getByRole('button', { name: '应用服务器额度' }).click();
    await expect.poll(() => writes.length).toBe(3);
    assert.deepEqual(writes[2].body, { dailyLimit: null });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(preview, { force: true });
  }
});
