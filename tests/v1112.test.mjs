import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import {
  appObstructions,
  discoverRegistration,
  RegistrationError,
  appLoading,
  readRegistrationPage,
} from '@apk/automation';
import { appReadinessSupported } from '@apk/contracts';
const pkg = 'com.example.modalback';
const node = (id, text = '', type = 'View', rect = '[20,100][180,280]', more = '') =>
  '<node package="' +
  pkg +
  '" class="android.view.' +
  type +
  '" resource-id="' +
  pkg +
  ':id/' +
  id +
  '" text="' +
  text +
  '" enabled="true" bounds="' +
  rect +
  '" ' +
  more +
  '/>';
const tree = (body) =>
  '<hierarchy><node package="' +
  pkg +
  '" class="android.widget.FrameLayout" bounds="[0,0][200,400]">' +
  body +
  '</node></hierarchy>';
const modal = tree(
  node('panel', '保存账号说明') +
    node('barrier', '', 'View', '[0,0][200,400]', 'clickable="true" content-desc="关闭"'),
);
const done = tree(node('home', '首页'));
test('decorated explicit loading hints stay readonly while ordinary body content is not loading', () => {
  for (const text of [
    '正在加载中～请稍等一会儿～',
    '正在加载中，请稍等一下下…',
    '\u200b正在加载中，请耐心等待片刻❤️',
  ])
    assert.ok(appLoading(readRegistrationPage(tree(node('loading', text)), pkg)));
  assert.equal(
    appLoading(readRegistrationPage(tree(node('body', '内容中提到正在加载中，请稍等一会儿')), pkg)),
    false,
  );
});
function harness(body = modal) {
  let closed = false,
    allowed = true,
    backs = 0;
  const notes = [];
  const session = {
    source: async () => (closed ? done : body),
    find: async (l) => (l.value === '关闭' || l.value.endsWith('/barrier') ? 'barrier' : 'panel'),
    rect: async (id) =>
      id === 'barrier'
        ? { x: 0, y: 0, width: 200, height: 400 }
        : { x: 20, y: 100, width: 160, height: 180 },
    attached: async () => !closed,
    back: async () => {
      backs++;
      closed = true;
    },
    screenshot: async () => {
      const png = new PNG({ width: 200, height: 400 });
      png.data.fill(255);
      return PNG.sync.write(png);
    },
    ocr: async () => [],
    tap: async () => assert.fail('a native barrier is never tapped at its centre'),
  };
  return {
    session,
    notes,
    get backs() {
      return backs;
    },
    allow: () => allowed,
    deny: () => {
      allowed = false;
    },
  };
}
const run = (h, pictures = false) =>
  appObstructions(
    h.session,
    pkg,
    () => {},
    async (n) => h.notes.push(n),
    pictures,
    {},
    h.allow,
  );
test('0.9.2 retains the signed readiness capability', () =>
  assert.ok(appReadinessSupported(['APP_READINESS_V1'], '0.9.2')));
test('a native close barrier and unique foreground object allow one confirmed startup Back', async () => {
  for (const pictures of [false, true]) {
    const h = harness();
    await run(h, pictures).clear(new AbortController().signal);
    assert.equal(h.backs, 1);
    assert.ok(h.notes.every((n) => n.method === 'BACK'));
    assert.equal(h.notes.at(-1).phase, 'CLEARED');
  }
});
test('independent foreground regions, challenge text, form fields, consent and post-account work cannot use generic Back', async () => {
  for (const body of [
    modal.replace('保存账号说明', '请完成人机验证'),
    modal.replace('保存账号说明', '系统公告：请完成人机验证'),
    modal.replace('保存账号说明', '手机验证'),
    modal.replace('保存账号说明', '请确认隐私政策'),
    modal.replace('保存账号说明', '年龄验证'),
    modal.replace('保存账号说明', '立即注册'),
    modal.replace(
      'android.view.View" resource-id="' + pkg + ':id/panel',
      'android.webkit.WebView" resource-id="' + pkg + ':id/panel',
    ),
    tree(
      node('left', '', 'View', '[10,80][90,250]') +
        node('right', '', 'View', '[110,80][190,250]') +
        node('barrier', '', 'View', '[0,0][200,400]', 'clickable="true" content-desc="关闭"'),
    ),
    tree(node('barrier', '', 'View', '[0,0][200,400]', 'clickable="true" content-desc="关闭"')),
  ]) {
    const h = harness(body);
    await assert.rejects(run(h).clear(AbortSignal.timeout(70)));
    assert.equal(h.backs, 0);
  }
  const h = harness();
  h.deny();
  await assert.rejects(run(h).clear(AbortSignal.timeout(70)));
  assert.equal(h.backs, 0);
});
test('a surviving foreground object cannot confirm dismissal and does not repeat Back', async () => {
  const h = harness();
  h.session.attached = async (id) => id === 'panel';
  await assert.rejects(
    appObstructions(
      h.session,
      pkg,
      () => {},
      async (n) => h.notes.push(n),
      false,
      { confirmationTimeoutMs: 1000 },
      h.allow,
    ).clear(new AbortController().signal),
    (e) => e.code === 'AUTO_OBSTRUCTION_STALLED',
  );
  assert.equal(h.backs, 1);
  assert.ok(!h.notes.some((n) => n.phase === 'CLEARED'));
});
test('startup permission is rechecked after resolving the old objects and before Back', async () => {
  const h = harness(),
    find = h.session.find;
  h.session.find = async (...args) => {
    h.deny();
    return find(...args);
  };
  await assert.rejects(
    run(h).clear(new AbortController().signal),
    (e) => e.code === 'AUTO_OBSTRUCTION_UNVERIFIED',
  );
  assert.equal(h.backs, 0);
});

test('a vanished entry is reread only after a changed page, and no old navigation click is repeated', async () => {
  const home = tree(node('mine', '我的', 'View', '[10,320][90,360]', 'clickable="true"'));
  const profile = tree(node('login', '登录', 'View', '[10,160][190,200]', 'clickable="true"'));
  const form = tree(
    node('title', '注册') +
      '<node package="' +
      pkg +
      '" class="android.widget.EditText" resource-id="' +
      pkg +
      ':id/username" hint="Username" enabled="true" bounds="[10,100][190,140]"/><node package="' +
      pkg +
      '" class="android.widget.EditText" resource-id="' +
      pkg +
      ':id/password" hint="Password" password="true" enabled="true" bounds="[10,160][190,200]"/>' +
      node('submit', '注册', 'View', '[10,240][190,280]', 'clickable="true"'),
  );
  let state = home,
    lookups = 0;
  const clicks = [];
  const session = {
    source: async () => state,
    find: async () => {
      if (lookups++ === 0) {
        state = profile;
        throw new RegistrationError('FLOW_STEP_FAILED');
      }
      return 'login';
    },
    click: async (id) => {
      clicks.push(id);
      state = form;
    },
  };
  const config = {
    enabled: true,
    screenshotFallback: false,
    maxNavigationSteps: 8,
    timeoutMs: 15000,
    successTimeoutMs: 1000,
  };
  const recognition = {
    source: 'CONTROLS',
    navigationSteps: 0,
    cache: 'MISS',
    learned: false,
    needsAdaptation: false,
  };
  const found = await discoverRegistration(
    session,
    pkg,
    config,
    'changed-before-lookup',
    new AbortController().signal,
    () => {},
    recognition,
  );
  assert.ok(found.form);
  assert.deepEqual(clicks, ['login']);
  assert.equal(recognition.navigationSteps, 1);
  lookups = 0;
  state = home;
  session.find = async () => {
    lookups++;
    throw new RegistrationError('FLOW_STEP_FAILED');
  };
  await assert.rejects(
    discoverRegistration(
      session,
      pkg,
      config,
      'unchanged-failed-lookup',
      new AbortController().signal,
      () => {},
      recognition,
    ),
    (e) => e.code === 'FLOW_STEP_FAILED',
  );
  assert.equal(lookups, 1);
  assert.deepEqual(clicks, ['login']);
});
