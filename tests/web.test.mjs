import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

test('browser login, config checks, refresh, password change and logout', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(process.env.APP_ORIGIN);
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    await page.getByLabel('用户名', { exact: true }).fill('p0admin');
    await page.getByLabel('密码', { exact: true }).fill('incorrect');
    await page.getByRole('button', { name: '登录中台' }).click();
    await expect(page.getByText('用户名或密码不正确')).toBeVisible();
    await page.getByLabel('密码', { exact: true }).fill(process.env.P0_TEST_PASSWORD);
    await page.getByRole('button', { name: '登录中台' }).click();
    await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: '登录成功', exact: true }).first()).toBeVisible();
    await page.screenshot({
      path: path.join(process.env.P0_SCREENSHOT_DIR, 'p0-desktop.png'),
      fullPage: true,
    });
    await page.reload();
    await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '服务器', exact: false }).first().click();
    await expect(page.getByText('尚未接入服务器')).toBeVisible();
    await page.getByRole('button', { name: '配置校验', exact: false }).first().click();
    let validateRequests = 0;
    page.on('request', (r) => {
      if (r.url().includes('/configs/validate')) validateRequests++;
    });
    await page.getByLabel('网站 URL').fill('file:///etc/passwd');
    await page.getByRole('button', { name: '校验配置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('校验未通过');
    assert.equal(validateRequests, 0);
    await page.getByLabel('网站 URL').fill('https://downloads.example.test/');
    await page.getByRole('button', { name: '校验配置', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('前端与服务端校验通过');
    assert.equal(validateRequests, 1);
    await page.getByRole('button', { name: '账户安全', exact: false }).first().click();
    await page.getByLabel('当前密码', { exact: true }).fill(process.env.P0_TEST_PASSWORD);
    await page.getByLabel('新密码', { exact: true }).fill('BrowserChangedPassword123');
    await page.getByLabel('确认新密码', { exact: true }).fill('BrowserChangedPassword123');
    await page.getByRole('button', { name: '更新密码' }).click();
    await expect(page.getByText('密码已修改，其他登录会话已退出')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: '工作台', exact: false }).first().click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({
      path: path.join(process.env.P0_SCREENSHOT_DIR, 'p0-mobile.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
  }
});
