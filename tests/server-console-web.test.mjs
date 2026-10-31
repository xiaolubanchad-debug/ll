import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { configurationIssues, schemaIssues } from '@apk/contracts';

async function fixture(run) {
  const browser = await chromium.launch({ headless: true }),
    preview = resolve('.tmp/server-console-' + randomUUID() + '.mjs');
  await writeFile(
    preview,
    "import{createApp}from'vue';import{ElAlert,ElButton,ElInput,ElInputNumber,ElTable,ElTableColumn}from'element-plus';import 'element-plus/dist/index.css';import '/src/style.css';import View from '/src/ServerManager.vue';createApp(View).use(ElAlert).use(ElButton).use(ElInput).use(ElInputNumber).use(ElTable).use(ElTableColumn).mount('#app');",
  );
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } }),
    errors = [],
    writes = [],
    requests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const nodeId = randomUUID(),
    secondId = randomUUID(),
    proxy = randomUUID(),
    configId = randomUUID(),
    runA = randomUUID(),
    runB = randomUUID(),
    opId = randomUUID(),
    releaseId = randomUUID();
  const node = {
    id: nodeId,
    name: 'EC2-A',
    host: '192.0.2.10',
    port: 22,
    username: 'ubuntu',
    version: 1,
    agentVersion: '0.13.3',
    agentReleaseId: releaseId,
    connection: 'ONLINE',
    occupancy: 'IDLE',
    deploymentStatus: 'INSTALLED',
    expectedFingerprint: 'SHA256:' + 'A'.repeat(43),
    health: { android: true, memoryKiB: 16777216 },
    activeRunId: null,
    activeOperationId: null,
    activeStopRequested: false,
  };
  const second = { ...node, id: secondId, name: 'EC2-B', host: '192.0.2.11' };
  const config = JSON.parse(
    await readFile('contracts/fixtures/config.concurrent-open.valid.json', 'utf8'),
  );
  config.execution.proxySecretVersionId = proxy;
  config.execution.appOpen.concurrency = 1;
  config.execution.appOpen.appsPerDevice = { min: 3, max: 5 };
  function task(name, id = randomUUID(), nid = nodeId) {
    return {
      id,
      name,
      nodeId: nid,
      nodeName: 'EC2-A',
      version: 1,
      configId: randomUUID(),
      currentVersionId: randomUUID(),
      automatic: false,
      enabled: false,
      time: '00:05',
      successTarget: 20,
      attemptLimit: 20,
      archivedAt: null,
      latestCycle: null,
      readiness: [],
      nextRunAt: null,
      executionKind: 'APP_OPEN',
    };
  }
  const a = task('配置 A'),
    b = task('配置 B'),
    other = task('其他服务器任务', randomUUID(), randomUUID()),
    tasks = [a, b];
  const cycle = (id = runA, status = 'RUNNING') => ({
    id: randomUUID(),
    executionKind: 'APP_OPEN',
    day: '2026-10-31',
    round: 1,
    status,
    successes: 0,
    attemptsStarted: 1,
    successTarget: 20,
    attemptLimit: 20,
    apkCount: 10,
    registerRunIds: [id],
    downloadRunId: null,
    activeRunId: id,
  });
  const state = {
    node,
    second,
    a,
    b,
    tasks,
    config,
    proxy,
    configId,
    runA,
    runB,
    opId,
    releaseId,
    cycle,
    failStartOnce: false,
    staleStart: false,
    legacy: false,
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname.replace('/api/v1', ''),
      method = request.method();
    requests.push({ path, method });
    if (method === 'GET') {
      if (path === '/nodes')
        return route.fulfill({ json: { items: [node, second], nextCursor: null } });
      if (path.startsWith('/nodes/'))
        return route.fulfill({ json: path.endsWith(nodeId) ? node : second });
      if (path === '/releases')
        return route.fulfill({
          json: {
            items: [
              {
                id: releaseId,
                manifest: { agentVersion: '0.13.3', features: [], gitCommit: 'a'.repeat(40) },
              },
            ],
            nextCursor: null,
          },
        });
      if (path === '/task-plans')
        return route.fulfill({
          json: url.searchParams.has('cursor')
            ? { items: tasks, nextCursor: null }
            : { items: [other], nextCursor: other.id },
        });
      if (path.startsWith('/task-plans/')) {
        const t = tasks.find((t) => path.endsWith(t.id));
        const body = state.legacy
          ? JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'))
          : structuredClone(config);
        body.execution.proxySecretVersionId = proxy;
        if (state.staleStart) {
          t.version++;
          state.staleStart = false;
        }
        return route.fulfill({ json: { task: t, configuration: body, cycles: [] } });
      }
      if (path === '/secrets')
        return route.fulfill({
          json: {
            items: [{ id: proxy, name: '住宅代理', type: 'HTTP_PROXY', revokedAt: null }],
            nextCursor: null,
          },
        });
      if (path === '/configs')
        return route.fulfill({
          json: { items: [{ id: configId, name: '共享打开测试配置' }], nextCursor: null },
        });
      if (path === '/configs/' + configId + '/versions')
        return route.fulfill({ json: { items: [{ id: 'version-1' }], nextCursor: null } });
      if (path.endsWith('/versions/version-1')) return route.fulfill({ json: { body: config } });
      if (path === '/deployments') return route.fulfill({ json: { items: [], nextCursor: null } });
      return route.fulfill({ status: 503, json: { error: { message: '测试边界：详情尚不可用' } } });
    }
    const body = request.postDataJSON();
    writes.push({ path, method, body, headers: request.headers() });
    if (path.includes('/control')) {
      const t = tasks.find((t) => path.includes(t.id));
      if (body.action === 'START' && state.failStartOnce) {
        state.failStartOnce = false;
        return route.abort('failed');
      }
      if (body.action === 'STOP') {
        t.enabled = false;
        t.latestCycle.status = 'STOPPING';
        node.activeStopRequested = true;
      } else {
        t.enabled = true;
        t.latestCycle = cycle(t.id === a.id ? runA : runB, 'QUEUED');
        t.version++;
        node.occupancy = 'BUSY';
        node.activeRunId = t.id === a.id ? runA : runB;
      }
      return route.fulfill({ json: t });
    }
    if (path.endsWith('/stop')) {
      node.activeStopRequested = true;
      return route.fulfill({ json: { status: 'STOP_REQUESTED' } });
    }
    if (path === '/deployments') {
      node.activeOperationId = opId;
      node.occupancy = 'BUSY';
      return route.fulfill({ status: 202, json: { operationId: opId } });
    }
    if (path === '/task-plans') {
      const t = task(body.name, randomUUID(), body.nodeId);
      tasks.unshift(t);
      return route.fulfill({ status: 201, json: t });
    }
    if (path.startsWith('/task-plans/') && method === 'PUT') {
      const t = tasks.find((t) => path.endsWith(t.id));
      t.version++;
      t.executionKind = 'APP_OPEN';
      return route.fulfill({ json: t });
    }
    return route.fulfill({ status: 422, json: { error: { message: '未预期的测试操作' } } });
  });
  await page.route('**/__server-console', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><div id="app"></div><script type="module" src="/@fs/${preview.replaceAll('\\', '/')}"></script>`,
    }),
  );
  try {
    await run({
      page,
      state,
      writes,
      requests,
      row: () => page.getByRole('row', { name: 'EC2-A', exact: true }),
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await rm(preview, { force: true });
  }
}
const open = async (page) => {
  await page.goto(process.env.APP_ORIGIN + '/__server-console');
  await expect(page.getByRole('row', { name: 'EC2-A', exact: true })).toBeVisible();
};

test('server row paginates choices, reuses failed intent and stops the actual occupied task before showing idle', async () =>
  fixture(async ({ page, state, writes, row }) => {
    await open(page);
    const r = row();
    await expect(r.getByRole('combobox')).toHaveValue(state.a.id);
    await expect(r).toContainText('16.0 GiB 总内存');
    await expect(r).toContainText('CPU 未采集');
    state.failStartOnce = true;
    await r.getByRole('button', { name: '开始', exact: true }).click();
    await expect(page.getByRole('alert').first()).toContainText('无法连接中台');
    await r.getByRole('button', { name: '开始', exact: true }).click();
    await expect(r).toContainText('准备执行');
    const starts = writes.filter((w) => w.body.action === 'START');
    assert.equal(starts.length, 2);
    assert.equal(starts[0].headers['idempotency-key'], starts[1].headers['idempotency-key']);
    assert.equal(starts[0].headers['if-match'], '1');
    // Backend changed while the browser still showed task A. Stop must use the fresh slot B.
    state.a.enabled = false;
    state.a.latestCycle.status = 'STOPPED';
    state.b.enabled = true;
    state.b.latestCycle = state.cycle(state.runB);
    state.node.activeRunId = state.runB;
    await r.getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(() => writes.at(-1)?.path).toBe('/task-plans/' + state.b.id + '/control');
    assert.equal(writes.at(-1).body.action, 'STOP');
    await expect(r.getByRole('button', { name: '等待清理', exact: true })).toBeDisabled();
    await expect(r.getByRole('button', { name: '开始', exact: true })).toBeDisabled();
    await expect(r.getByRole('combobox')).toBeDisabled();
    state.b.latestCycle.status = 'STOPPED';
    state.node.occupancy = 'IDLE';
    state.node.activeRunId = null;
    state.node.activeStopRequested = false;
    await expect(r.locator('.server-status').last()).toHaveText('空闲', { timeout: 7000 });
  }));

test('completed rounds require explicit confirmation; stale and legacy configurations cannot silently start', async () =>
  fixture(async ({ page, state, writes, row }) => {
    state.a.latestCycle = {
      ...state.cycle(),
      status: 'DONE',
      successes: 20,
      attemptsStarted: 20,
      activeRunId: null,
    };
    await open(page);
    await row().getByRole('button', { name: '开始', exact: true }).click();
    await expect(page.getByRole('alert', { name: '确认再次开始' })).toBeVisible();
    assert.equal(writes.length, 0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(writes.length, 0);
    await row().getByRole('button', { name: '开始', exact: true }).click();
    await page.getByRole('button', { name: '确认新增一轮', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    assert.equal(writes[0].body.action, 'NEW_ROUND');
    state.node.occupancy = 'IDLE';
    state.node.activeRunId = null;
    state.a.enabled = false;
    state.a.latestCycle = null;
    await expect(row().getByRole('button', { name: '开始', exact: true })).toBeEnabled({
      timeout: 7000,
    });
    state.staleStart = true;
    await row().getByRole('button', { name: '开始', exact: true }).click();
    await expect(page.getByRole('alert').first()).toContainText('任务配置或状态已变化');
    assert.equal(writes.length, 1);
    state.a.executionKind = 'REGISTRATION';
    await expect(row().getByRole('button', { name: '开始', exact: true })).toBeDisabled({
      timeout: 7000,
    });
    await expect(row()).toContainText('历史流程');
  }));

test('server inline configuration copies a template without rebinding another task or starting it', async () =>
  fixture(async ({ page, state, writes }) => {
    await open(page);
    const r = page.getByRole('row', { name: 'EC2-B', exact: true });
    await r.getByRole('combobox').selectOption('__copy__:' + state.configId);
    await expect(page.getByRole('button', { name: '下一步', exact: true })).toHaveCount(0);
    await expect(page.locator('#task-node')).toHaveValue(state.second.id);
    await expect(page.locator('#task-node')).toBeDisabled();
    await expect(page.locator('#task-name')).toHaveValue('共享打开测试配置');
    await page.locator('#task-target').fill('5');
    await page.locator('#task-limit').fill('10');
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    const w = writes[0];
    assert.equal(w.path, '/task-plans');
    assert.equal(w.body.nodeId, state.second.id);
    assert.equal(w.body.configId, undefined);
    assert.deepEqual(configurationIssues(w.body.configuration), []);
    assert.deepEqual(schemaIssues('TaskPlanInput', w.body), []);
    assert.deepEqual(w.body.configuration.registrationFlows, []);
    assert.equal(w.body.configuration.execution.appOpen.dwellMs, 10000);
    await expect(r.getByRole('combobox')).toContainText('共享打开测试配置');
    assert.equal(
      writes.some((w) => w.path.includes('/control')),
      false,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.screenshot({
      path: join(process.env.P0_SCREENSHOT_DIR, 'v116-servers-mobile.png'),
      fullPage: true,
    });
  }));

test('deployment and standalone stop preserve actual ownership; offline servers cannot start', async () =>
  fixture(async ({ page, state, writes, requests, row }) => {
    await open(page);
    await row().getByRole('button', { name: '部署', exact: true }).click();
    await expect(page.getByRole('button', { name: '一键部署', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: /已阅读并接受/ }).check();
    await page.getByRole('button', { name: '一键部署', exact: true }).click();
    await expect.poll(() => writes[0]?.path).toBe('/deployments');
    assert.equal(writes[0].body.nodeId, state.node.id);
    assert.equal(writes[0].body.releaseId, state.releaseId);
    assert.equal(writes[0].body.licenseAccepted, true);
    await row().getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(() => writes.at(-1)?.path).toBe('/deployments/' + state.opId + '/stop');
    state.node.activeOperationId = null;
    state.node.activeStopRequested = false;
    state.node.activeRunId = state.runB;
    state.node.occupancy = 'BUSY';
    await expect(row().getByRole('button', { name: '停止', exact: true })).toBeEnabled({
      timeout: 7000,
    });
    await row().getByRole('button', { name: '停止', exact: true }).click();
    await expect.poll(() => writes.at(-1)?.path).toBe('/runs/' + state.runB + '/stop');
    await row().getByRole('button', { name: '日志', exact: true }).click();
    await expect
      .poll(() => requests.some((r) => r.path === '/runs/' + state.runB + '/summary'))
      .toBe(true);
    await expect(page.getByRole('button', { name: '关闭日志', exact: true })).toBeVisible();
    state.node.activeRunId = null;
    state.node.activeStopRequested = false;
    state.node.occupancy = 'IDLE';
    state.node.connection = 'OFFLINE';
    await expect(row()).toContainText('服务器离线', { timeout: 7000 });
    await expect(row().getByRole('button', { name: '开始', exact: true })).toBeDisabled();
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.screenshot({
      path: join(process.env.P0_SCREENSHOT_DIR, 'v116-servers-desktop.png'),
      fullPage: false,
    });
  }));

test('legacy configuration conversion requires a deliberate choice and creates only a current-flow version', async () =>
  fixture(async ({ page, state, writes, row }) => {
    state.legacy = true;
    state.a.executionKind = 'REGISTRATION';
    await open(page);
    await expect(row().getByRole('button', { name: '开始', exact: true })).toBeDisabled();
    await row().getByRole('button', { name: '配置', exact: true }).click();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(page.getByRole('alert').last()).toContainText(
      '请先确认将历史流程另存为 APP 打开测试',
    );
    assert.equal(writes.length, 0);
    await page.getByRole('checkbox', { name: '确认转换为 APP 打开测试', exact: true }).check();
    await page.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => writes.length).toBe(1);
    assert.equal(writes[0].method, 'PUT');
    assert.equal(writes[0].path, '/task-plans/' + state.a.id);
    assert.equal(writes[0].headers['if-match'], '1');
    assert.deepEqual(writes[0].body.configuration.registrationFlows, []);
    assert.equal(writes[0].body.configuration.execution.autoRegistration, undefined);
    assert.equal(writes[0].body.configuration.execution.appOpen.dwellMs, 10000);
    assert.deepEqual(configurationIssues(writes[0].body.configuration), []);
    assert.equal(
      writes.some((w) => w.path.includes('/control')),
      false,
    );
  }));
