import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { configurationIssues } from '@apk/contracts';

test('task wizard saves random apps per device and ten-app source with production component registration', async () => {
  const preview = resolve('.tmp/device-wizard-' + randomUUID() + '.mjs');
  await writeFile(
    preview,
    "import {createApp} from 'vue';import {ElAlert,ElButton,ElInput,ElInputNumber,ElTable,ElTableColumn} from 'element-plus';import 'element-plus/dist/index.css';import View from '/src/TaskWizard.vue';createApp(View,{ownedTest:true}).use(ElAlert).use(ElButton).use(ElInput).use(ElInputNumber).use(ElTable).use(ElTableColumn).mount('#app');",
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(),
      errors = [],
      saved = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/v1/nodes?*', (r) =>
      r.fulfill({
        json: {
          items: [
            {
              id: randomUUID(),
              name: '测试节点',
              connection: 'ONLINE',
              deploymentStatus: 'INSTALLED',
            },
          ],
          nextCursor: null,
        },
      }),
    );
    await page.route('**/api/v1/configs?*', (r) =>
      r.fulfill({ json: { items: [], nextCursor: null } }),
    );
    await page.route('**/api/v1/secrets?*', (r) =>
      r.fulfill({
        json: {
          items: [{ id: randomUUID(), name: '测试代理引用', type: 'HTTP_PROXY', revokedAt: null }],
          nextCursor: null,
        },
      }),
    );
    await page.route('**/api/v1/test-client/info', (r) =>
      r.fulfill({
        json: {
          ready: true,
          suiteReady: true,
          suiteCount: 10,
          suiteSourcePageUrl: 'https://example.com/api/v1/test-client?suite=1',
        },
      }),
    );
    await page.route('**/api/v1/task-plans', (r) => {
      saved.push(r.request().postDataJSON());
      return r.fulfill({ json: { id: randomUUID() } });
    });
    await page.route('**/__device-wizard', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/@fs/${preview.replaceAll('\\', '/')}"></script>`,
      }),
    );
    await page.goto(process.env.APP_ORIGIN + '/__device-wizard');
    await expect(page.locator('#task-url')).toHaveValue(
      'https://example.com/api/v1/test-client?suite=1',
    );
    await expect(page.locator('#task-xpath')).toHaveValue("//a[@class='test-apk']");
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.getByLabel('每台新模拟器依次测试多个不同 APP')).toBeChecked();
    await page.getByRole('spinbutton').nth(0).fill('2');
    await page.getByRole('spinbutton').nth(1).fill('4');
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '保存任务' }).click();
    await expect.poll(() => saved.length).toBe(1);
    assert.deepEqual(saved[0].configuration.execution.appOpen.appsPerDevice, { min: 2, max: 4 });
    assert.equal(saved[0].configuration.execution.appOpen.concurrency, 1);
    assert.equal(saved[0].configuration.execution.contentIsolation, true);
    assert.deepEqual(configurationIssues(saved[0].configuration), []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(preview, { force: true });
  }
});
