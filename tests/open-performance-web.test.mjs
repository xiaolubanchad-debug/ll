import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';

test('timeline displays measured step durations and keeps old events without invented timings', async () => {
  const preview = resolve('.tmp/open-timings-preview-' + randomUUID() + '.mjs');
  await writeFile(
    preview,
    "import {createApp} from 'vue';import View from '/src/TimelineViewer.vue';createApp(View,{runId:'owned-performance'}).mount('#app');",
  );
  const openTimings = JSON.parse(
    await readFile('contracts/fixtures/open-timings.valid.json', 'utf8'),
  );
  const event = {
    id: randomUUID(),
    sequence: 1,
    taskId: null,
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    type: 'TASK_FINISHED',
    stage: null,
    title: 'APP 启动停留 10 秒并清理完成',
    errorCode: null,
    recordedForReview: false,
    applied: true,
  };
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/v1/runs/owned-performance/timeline?*', (route) =>
      route.fulfill({
        json: {
          items: [
            { ...event, openTimings },
            { ...event, id: randomUUID(), sequence: 2 },
          ],
          hasEarlier: false,
          hasLater: false,
          firstSequence: 1,
          lastSequence: 2,
        },
      }),
    );
    await page.route('**/__owned-open-timings', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/@fs/${preview.replaceAll('\\', '/')}"></script>`,
      }),
    );
    await page.goto(process.env.APP_ORIGIN + '/__owned-open-timings');
    const details = page.locator('details.step-timings');
    await expect(details).toHaveCount(1);
    await details.locator('summary').click();
    await expect(details.getByText('代理检查', { exact: true })).toBeVisible();
    await expect(details.getByText('安卓冷启动', { exact: true })).toBeVisible();
    await expect(details.getByText('3.00 秒', { exact: true })).toBeVisible();
    await expect(details.getByText('准备步骤可能重叠', { exact: false })).toBeVisible();
    assert.equal(await page.locator('img,video,audio,iframe').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(preview, { force: true });
  }
});
