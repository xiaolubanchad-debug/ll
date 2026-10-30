import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

test('test data shows observed identities and reveals credentials only after an explicit audited action', async () => {
  const preview = resolve('.tmp/test-data-preview-' + randomUUID() + '.mjs');
  await writeFile(
    preview,
    "import {createApp} from 'vue';import {ElAlert,ElButton,ElInput,ElInputNumber,ElTable,ElTableColumn} from 'element-plus';import 'element-plus/dist/index.css';import View from '/src/TestData.vue';createApp(View).use(ElAlert).use(ElButton).use(ElInput).use(ElInputNumber).use(ElTable).use(ElTableColumn).mount('#app');",
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(),
      errors = [],
      requests = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/v1/test-data?*', (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: 'owned-record',
              nodeName: '自有测试服务器',
              runId: randomUUID(),
              position: 1,
              username: 'cesampleaa',
              sourceIp: '198.51.100.114',
              androidIdHash: 'a'.repeat(64),
              model: 'QA-Mobile-0001',
              profileId: 'qa-model-01',
              apiLevel: 35,
              userAgent: 'ApkPlatformTest/1.0 (Owned)',
              modelMatched: true,
              uaMatched: true,
              createdAt: new Date().toISOString(),
            },
          ],
          nextCursor: null,
        },
      }),
    );
    await page.route('**/api/v1/test-client/info', (route) =>
      route.fulfill({ json: { ready: true, downloadUrl: '/owned-test.apk' } }),
    );
    await page.route('**/api/v1/nodes?*', (route) => route.fulfill({ json: { items: [] } }));
    await page.route('**/api/v1/test-data/owned-record/credentials', (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        json: { username: 'cesampleaa', password: 'Fixture123', androidId: '1234abcd' },
      });
    });
    await page.route('**/__owned-test-data', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/@fs/${preview.replaceAll('\\', '/')}"></script>`,
      }),
    );
    await page.goto(process.env.APP_ORIGIN + '/__owned-test-data');
    await expect(page.getByRole('combobox', { name: '筛选服务器' })).toBeVisible();
    await expect(page.getByText('198.51.100.114', { exact: true })).toBeVisible();
    await expect(page.getByText('QA-Mobile-0001', { exact: false })).toBeVisible();
    assert.equal(requests.length, 0);
    assert.equal((await page.locator('body').innerText()).includes('Fixture123'), false);
    await page.getByRole('button', { name: '查看密码和设备 ID' }).click();
    await expect(page.getByText('Fixture123', { exact: true })).toBeVisible();
    assert.equal(requests.length, 1);
    assert.ok(requests[0].reason);
    await page.getByRole('button', { name: 'Close this dialog' }).click();
    await expect(page.getByText('Fixture123', { exact: true })).toHaveCount(0);
    assert.equal(await page.locator('img,video,audio,iframe').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(preview, { force: true });
  }
});
