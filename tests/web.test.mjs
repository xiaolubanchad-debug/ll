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
    await page.getByRole('button', { name: '添加服务器', exact: true }).click();
    await page.getByLabel('服务器名称', { exact: true }).fill('浏览器测试节点');
    await page.getByLabel('IP 或域名', { exact: true }).fill('host;unsafe');
    await page.getByLabel('连接方式', { exact: true }).selectOption('SSH_PASSWORD');
    await page.getByLabel('SSH 密码', { exact: true }).fill('FixtureOnlySshPassword123');
    await page.getByRole('button', { name: '保存服务器', exact: true }).click();
    await expect(page.getByText('请检查服务器名称、地址、端口和 SSH 用户名')).toBeVisible();
    await page.getByLabel('IP 或域名', { exact: true }).fill('203.0.113.12');
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/nodes') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '保存服务器', exact: true }).click();
    const savedResponse = await saved;
    assert.equal(savedResponse.status(), 201, JSON.stringify(await savedResponse.json()));
    await expect(page.getByText('服务器资料已保存，凭据不会回显')).toBeVisible();
    await expect(page.getByRole('cell', { name: '203.0.113.12', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '一键部署', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '探测主机指纹', exact: true }).click();
    await expect(page.getByRole('cell', { name: '等待 Worker', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑资料', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByRole('cell', { name: '已停止', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑资料', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '步骤', exact: true }).click();
    await expect(page.locator('.operation-events')).toContainText('已停止');
    await page.screenshot({
      path: path.join(process.env.P0_SCREENSHOT_DIR, 'p1-servers.png'),
      fullPage: true,
    });
    assert.ok(
      !(await page.evaluate(() => JSON.stringify(window.localStorage))).includes(
        'FixtureOnlySshPassword123',
      ),
    );
    await page.getByText('归档服务器', { exact: true }).click();
    await page.getByRole('button', { name: '确认归档服务器', exact: true }).click();
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
    await page.getByLabel('配置名称', { exact: true }).fill('浏览器配置版本');
    await page.getByRole('button', { name: '新建配置', exact: true }).click();
    await expect(page.getByText('配置已建立，可保存当前草稿为第一个版本')).toBeVisible();
    await page.getByRole('button', { name: '保存草稿为新版本', exact: true }).click();
    await expect(page.getByText('已保存不可变版本，运行中的任务不会改变')).toBeVisible();
    await expect(page.getByRole('button', { name: '载入版本', exact: true })).toHaveCount(1);
    await page.getByLabel('网站 URL').fill('https://second.example.test/');
    await page.getByRole('button', { name: '保存草稿为新版本', exact: true }).click();
    await expect(page.getByRole('button', { name: '载入版本', exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: '载入版本', exact: true }).last().click();
    await expect(page.getByLabel('网站 URL')).toHaveValue('https://downloads.example.test/');
    await page.screenshot({
      path: path.join(process.env.P0_SCREENSHOT_DIR, 'p2-configs.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '测试任务', exact: false }).first().click();
    await expect(page.getByRole('heading', { name: '开始下载任务', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始下载', exact: true })).toBeDisabled();
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
