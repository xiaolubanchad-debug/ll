import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
test('functional evidence is an explicitly labelled diagram with no original media', async () => {
  const preview = resolve('.tmp/v110-preview-' + randomUUID() + '.mjs');
  const value = {
    schemaVersion: '1.0',
    kind: 'FUNCTIONAL_EVIDENCE',
    stage: 'DISCOVERY',
    outcome: 'UNVERIFIED',
    verification: 'NO_SUBMISSION',
    sourceDigest: 'a'.repeat(64),
    controls: [
      { role: 'USERNAME', rect: { x: 20, y: 20, width: 300, height: 50 } },
      { role: 'PASSWORD', rect: { x: 20, y: 100, width: 300, height: 50 } },
      { role: 'REGISTER', rect: { x: 20, y: 180, width: 300, height: 50 } },
    ],
  };
  await writeFile(
    preview,
    `import {createApp} from 'vue';import View from '/src/FunctionalEvidenceView.vue';createApp(View,{evidence:${JSON.stringify(value)}}).mount('#app');`,
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 800 } }),
      errors = [],
      requests = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => requests.push(r.url()));
    await page.route('**/__owned-v110-preview', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/@fs/${preview.replaceAll('\\', '/')}"></script>`,
      }),
    );
    await page.goto(process.env.APP_ORIGIN + '/__owned-v110-preview');
    await expect(page.getByText('功能结构示意 · 非原始 APP 画面')).toBeVisible();
    await expect(page.getByText('用户名输入框')).toBeVisible();
    await expect(page.getByText('密码输入框')).toBeVisible();
    assert.equal(await page.locator('svg rect').count(), 3);
    assert.equal(await page.locator('img,video,audio,iframe').count(), 0);
    assert.ok(!requests.some((url) => url.includes('/artifacts/') || url.startsWith('data:')));
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: join(process.env.P0_SCREENSHOT_DIR, 'v110-functional-diagram.png'),
    });
  } finally {
    await browser.close();
    await rm(preview, { force: true });
  }
});
