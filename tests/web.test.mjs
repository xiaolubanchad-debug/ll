import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { configurationIssues } from '@apk/contracts';

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
    await expect(page.getByRole('heading', { name: '服务器', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '工作台', exact: false }).first().click();
    await expect(
      page.getByRole('heading', { name: '当前执行与待处理', exact: true }),
    ).toBeVisible();
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
    await expect(
      page
        .getByRole('row', { name: '浏览器测试节点', exact: true })
        .getByText('203.0.113.12:22 · ubuntu', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '一键部署', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '探测主机指纹', exact: true }).click();
    await expect(page.getByRole('cell', { name: '等待 Worker', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '编辑资料', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '停止部署', exact: true }).click();
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
    await page.getByText('历史与高级设置', { exact: true }).click();
    await page.getByRole('button', { name: '任务方案', exact: false }).first().click();
    await expect(page.getByLabel('完整配置 JSON', { exact: true })).not.toBeVisible();
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
    await expect(page.getByRole('button', { name: '用此版本编辑', exact: true })).toHaveCount(1);
    await page.getByLabel('网站 URL').fill('https://second.example.test/');
    await page.getByRole('button', { name: '保存草稿为新版本', exact: true }).click();
    await expect(page.getByRole('button', { name: '用此版本编辑', exact: true })).toHaveCount(2);
    await page.getByRole('button', { name: '用此版本编辑', exact: true }).last().click();
    await expect(page.getByLabel('网站 URL')).toHaveValue('https://downloads.example.test/');
    await page.screenshot({
      path: path.join(process.env.P0_SCREENSHOT_DIR, 'p2-configs.png'),
      fullPage: true,
    });
    await page.getByText('快速新增代理（可选）', { exact: true }).click();
    await page.getByLabel('代理地址', { exact: true }).fill('proxy.example.test');
    await page.getByLabel('代理用户名', { exact: true }).fill('FixtureUser');
    await page.getByLabel('代理密码', { exact: true }).fill('FixtureProxyPassword123');
    await expect(page.getByLabel('端口', { exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: '加密保存代理', exact: true })).toBeDisabled();
    await page.getByLabel('端口', { exact: true }).fill('10000');
    const savedProxyRequest = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/secrets/versions'),
    );
    await page.getByRole('button', { name: '加密保存代理', exact: true }).click();
    assert.equal((await savedProxyRequest).postDataJSON().secretValue.port, 10000);
    await expect(page.getByText('代理已加密保存，可将引用应用到草稿')).toBeVisible();
    await expect(page.getByLabel('代理密码', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: '将代理应用到当前草稿', exact: true }).click();
    const proxyDraft = JSON.parse(
      await page.getByLabel('完整配置 JSON', { exact: true }).inputValue(),
    );
    assert.equal(proxyDraft.execution.mode, 'FULL');
    assert.deepEqual(configurationIssues(proxyDraft), []);
    assert.equal(proxyDraft.execution.appOpen.dwellMs, 10000);
    assert.equal(proxyDraft.execution.appOpen.concurrency, 1);
    assert.deepEqual(proxyDraft.registrationFlows, []);
    assert.equal(proxyDraft.execution.autoRegistration, undefined);
    assert.match(proxyDraft.execution.proxySecretVersionId, /^[a-f0-9-]{36}$/);
    assert.ok(!JSON.stringify(proxyDraft).includes('FixtureProxyPassword123'));
    await expect(page.getByText('自动寻找各 APP 的注册入口', { exact: true })).toHaveCount(0);
    await expect(page.getByText('添加基础注册流程', { exact: true })).toHaveCount(0);
    assert.ok(
      !(await page.evaluate(() =>
        JSON.stringify({ ...window.localStorage, ...window.sessionStorage }).includes(
          'FixtureProxyPassword123',
        ),
      )),
    );
    await page.getByRole('button', { name: '保存草稿为新版本', exact: true }).click();
    await expect(page.getByRole('button', { name: '用此版本编辑', exact: true })).toHaveCount(3);
    if (!(await page.getByRole('button', { name: '执行历史', exact: false }).first().isVisible()))
      await page.getByText('历史与高级设置', { exact: true }).click();
    await page.getByRole('button', { name: '执行历史', exact: false }).first().click();
    await page.getByRole('button', { name: '历史兼容工具', exact: true }).click();
    await page.getByRole('tab', { name: '新建执行', exact: true }).click();
    await expect(page.getByRole('heading', { name: '开始测试任务', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '开始下载', exact: true })).toBeDisabled();
    await page.getByLabel('任务配置', { exact: true }).selectOption({ label: '浏览器配置版本' });
    await expect(
      page
        .getByLabel('固定配置版本', { exact: true })
        .getByRole('option', { name: '版本 3', exact: true }),
    ).toHaveCount(1);
    await page.getByLabel('固定配置版本', { exact: true }).selectOption({ label: '版本 3' });
    await page.getByRole('tab', { name: '每日计划', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '每日下载与注册计划', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('每日下载时间（北京时间）', { exact: true })).toHaveValue('00:05');
    await expect(page.getByLabel('开启每日计划', { exact: true })).not.toBeChecked();
    await page.getByLabel('开启每日计划', { exact: true }).check();
    await expect(page.getByLabel('开启每日计划', { exact: true })).toBeChecked();
    await page.getByLabel('开启每日计划', { exact: true }).uncheck();
    await page.getByRole('tab', { name: '新建执行', exact: true }).click();
    await page.getByLabel('执行内容', { exact: true }).selectOption('REGISTER');
    await expect(page.getByRole('button', { name: '开始 APP 测试', exact: true })).toBeDisabled();
    await page.getByLabel('执行内容', { exact: true }).selectOption('LEGACY');
    await expect(page.getByRole('button', { name: '开始 APP 测试', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '系统设置', exact: false }).first().click();
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
