import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { schemaIssues } from '@apk/contracts';

test('download targets show distinct Chinese reasons, retain legacy uncertainty and describe download phase', async () => {
  const id = randomUUID(),
    codes = [
      'DOWNLOAD_NO_FILE',
      'DOWNLOAD_CONTROL_UNCONFIRMED',
      'DOWNLOAD_TRANSFER_TIMEOUT',
      'APK_INVALID_NOT_ZIP',
      'APK_INVALID_CRC',
      'APK_INVALID',
    ],
    reasons = [
      '等待结束，未收到浏览器下载文件',
      '下载控件触屏操作未确认',
      '文件传输超时，未完成保存',
      '下载文件不是可读取的 ZIP/APK',
      'APK 内容校验不一致',
      'APK 校验未通过（旧记录未细分）',
    ];
  const summary = {
    run: {
      id,
      nodeName: 'Owned node',
      configName: 'Owned download diagnostics',
      purpose: 'DOWNLOAD',
      status: 'FAILED',
      createdAt: '2026-11-02T09:00:00.000Z',
      successes: 0,
      successTarget: 0,
      attemptsStarted: 0,
      attemptLimit: 0,
      errorCode: null,
    },
    nodeId: randomUUID(),
    configVersion: 1,
    releaseId: randomUUID(),
    finishedAt: '2026-11-02T09:10:00.000Z',
    counts: {
      SUCCESS: 0,
      REJECTED: 0,
      ERROR: 6,
      ADAPTATION: 0,
      UNKNOWN: 0,
      SKIPPED: 0,
      STOPPED: 0,
      PENDING: 0,
    },
    taskCount: 6,
    cleanup: 'CONFIRMED',
    activeTask: null,
    automaticIdentityCount: 0,
    executionKind: 'DOWNLOAD_ONLY',
  };
  assert.deepEqual(schemaIssues('RunSummaryView', summary), []);
  const preview = resolve('.tmp/download-labels-' + randomUUID() + '.mjs');
  await writeFile(
    preview,
    "import{createApp}from'vue';import{ElButton,ElAlert}from'element-plus';import 'element-plus/dist/index.css';import '/src/style.css';import View from '/src/RunDetail.vue';createApp(View,{runId:" +
      JSON.stringify(id) +
      "}).use(ElButton).use(ElAlert).mount('#app');",
  );
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage(),
      errors = [],
      writes = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/v1/**', (r) => {
      if (r.request().method() !== 'GET') writes.push(r.request().url());
      const p = new URL(r.request().url()).pathname;
      if (p.endsWith('/summary')) return r.fulfill({ json: summary });
      if (p.endsWith('/tasks'))
        return r.fulfill({
          json: {
            items: codes.map((errorCode, i) => ({
              id: randomUUID(),
              position: i,
              label: 'Owned target ' + (i + 1),
              status: 'FAILED',
              errorCode,
              apk: null,
              registrationStartedAt: null,
            })),
            nextCursor: null,
          },
        });
      return r.fulfill({ status: 503, json: { error: { message: 'Fixture boundary' } } });
    });
    await page.route('**/__download-labels', (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/@fs/${preview.replaceAll('\\', '/')}"></script>`,
      }),
    );
    await page.goto(process.env.APP_ORIGIN + '/__download-labels#/runs/' + id + '?view=targets');
    for (const reason of reasons)
      await expect(page.getByText(reason, { exact: true })).toBeVisible();
    await expect(page.getByText('下载阶段', { exact: true })).toHaveCount(6);
    await expect(page.getByText('尚未进入注册', { exact: true })).toHaveCount(0);
    assert.equal(writes.length, 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(preview, { force: true });
  }
});
