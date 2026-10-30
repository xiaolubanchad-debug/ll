import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { PNG } from 'pngjs';
import {
  AppiumClient,
  entryRole,
  controlReference,
  readRegistrationPage,
  appLoading,
  appObstructions,
  discoverRegistration,
  nativeScreenKey,
  registrationForm,
  registrationBindingsValid,
  registrationEntries,
} from '@apk/automation';
import { schemaIssues, appReadinessSupported } from '@apk/contracts';
const pkg = 'com.example.ownedloading';
const message = JSON.parse(await readFile('contracts/fixtures/agent.valid.json', 'utf8')).find(
  (x) => x.kind === 'events',
);
const obstructionIssues = (payload) =>
  schemaIssues('AgentMessage', {
    ...message,
    events: [
      {
        ...message.events[0],
        taskId: '44444444-4444-4444-8444-444444444444',
        type: 'APP_OBSTRUCTION',
        payload,
      },
    ],
  });
const row = (
  id,
  text = '',
  type = 'TextView',
  click = false,
  extra = '',
  rect = '[10,80][190,120]',
) =>
  `<node package="${pkg}" class="android.widget.${type}" resource-id="${pkg}:id/${id}" text="${text}" enabled="true" clickable="${click}" bounds="${rect}" ${extra}/>`;
const tree = (body) =>
  `<hierarchy><node package="${pkg}" class="android.widget.FrameLayout" bounds="[0,0][200,400]">${body}</node></hierarchy>`;
const form = tree(
  row('title', '注册') +
    row('username', '', 'EditText', true, 'hint="Username"', '[10,130][190,160]') +
    row('password', '', 'EditText', true, 'hint="Password" password="true"', '[10,180][190,210]') +
    row('submit', '注册', 'Button', true, '', '[10,240][190,280]'),
);
const settings = {
  enabled: true,
  screenshotFallback: true,
  maxNavigationSteps: 8,
  timeoutMs: 15000,
  successTimeoutMs: 1000,
};
const recognition = () => ({
  source: 'CONTROLS',
  navigationSteps: 0,
  cache: 'MISS',
  learned: false,
  needsAdaptation: false,
});

test('native locator labels decode XML references once, with no general entity expansion', () => {
  const page = readRegistrationPage(
      tree(
        `<node package="${pkg}" class="android.widget.Button" content-desc="注册&#10;账号" text="A &amp; B &quot;Q&quot; &lt;x&gt;" hint="&#x1f600;" enabled="true" clickable="true" bounds="[10,80][190,120]"/>`,
      ),
      pkg,
    ),
    control = page.controls.at(-1);
  assert.equal(control.description, '注册\n账号');
  assert.equal(entryRole(control.description), 'REGISTER');
  assert.equal(control.text, 'A & B "Q" <x>');
  assert.equal(control.hint, '😀');
  const literal = readRegistrationPage(
    tree(row('encoded', '&amp;#x6ce8;&amp;#x518c;')),
    pkg,
  ).controls.at(-1);
  assert.equal(entryRole(literal.text), undefined);
  assert.equal(literal.text, '&#x6ce8;&#x518c;');
  for (const entity of ['&#0;', '&#xD800;', '&#x110000;'])
    assert.throws(
      () => readRegistrationPage(tree(row('invalid', entity)), pkg),
      (e) => e.code === 'AUTO_PAGE_INVALID',
    );
  assert.throws(
    () =>
      readRegistrationPage(
        '<!DOCTYPE hierarchy [<!ENTITY x "注册">]>' + tree(row('entity', '&x;')),
        pkg,
      ),
    (e) => e.code === 'AUTO_PAGE_INVALID',
  );
});

test('a unique short close description distinguishes a barrier from equal-size wrapper nodes', () => {
  const page = readRegistrationPage(
      tree(
        `<node package="${pkg}" class="android.view.View" enabled="true" clickable="false" bounds="[0,0][200,400]"/><node package="${pkg}" class="android.view.View" content-desc="关闭" enabled="true" clickable="true" bounds="[0,0][200,400]"/>`,
      ),
      pkg,
    ),
    barrier = page.controls.at(-1);
  assert.deepEqual(controlReference(barrier, page), { by: 'accessibilityId', value: '关闭' });
  assert.equal(controlReference(page.controls[1], page), undefined);
});

test('only a noninteractive explicit loading page is treated as startup loading', () => {
  for (const text of [
    '正在加载…',
    '加载中，请稍候',
    '正在加载中……请稍等……',
    'Loading...',
    '网络连接中',
  ]) {
    assert.equal(appLoading(readRegistrationPage(tree(row('loading', text)), pkg)), true, text);
  }
  for (const content of [
    row('error', '网络失败，请重试'),
    row('empty', ''),
    row('content', '推荐'),
    row('content', '推荐内容中提到正在加载中，请稍等'),
    row('loading', '加载中') + row('login', '登录', 'Button', true),
    row('loading', '加载中') + row('accept', '我知道了', 'Button', true),
  ]) {
    assert.equal(appLoading(readRegistrationPage(tree(content), pkg)), false);
  }
});

test('slow loading survives the short no-entry window without screenshots or account actions', async () => {
  const readyAt = Date.now() + 2300,
    png = new PNG({ width: 200, height: 400 });
  png.data.fill(255);
  const bytes = PNG.sync.write(png);
  let shots = 0,
    actions = 0;
  const session = {
    source: async () => (Date.now() < readyAt ? tree(row('loading', '正在加载…')) : form),
    screenshot: async () => {
      assert.ok(Date.now() >= readyAt);
      shots++;
      return bytes;
    },
    ocr: async () => [],
    tap: async () => actions++,
    click: async () => actions++,
  };
  const readiness = appObstructions(
    session,
    pkg,
    () => {},
    async () => {},
    true,
  );
  const found = await discoverRegistration(
    session,
    pkg,
    settings,
    'owned-loading',
    new AbortController().signal,
    () => {},
    recognition(),
    undefined,
    readiness.clear,
  );
  assert.ok(found.form);
  assert.equal(actions, 0);
  assert.equal(shots, 0, 'a usable native form does not need a full-screen picture');
});

test('persistent loading ends at the phase deadline without guessing or taking pictures', async () => {
  let reads = 0;
  await assert.rejects(
    discoverRegistration(
      {
        source: async () => {
          reads++;
          return tree(row('loading', '加载中'));
        },
        screenshot: async () => assert.fail('loading must not capture'),
        click: async () => assert.fail('loading must not click'),
      },
      pkg,
      { ...settings, timeoutMs: 850 },
      'owned-loading-deadline',
      new AbortController().signal,
      () => {},
      recognition(),
    ),
    (e) => e.code === 'AUTO_LOADING_TIMEOUT',
  );
  assert.ok(reads >= 2 && reads < 8);
});

test('a modal transition is observed until its own close button appears, never tapping its centre', async () => {
  const readyAt = Date.now() + 1300;
  let clicks = 0;
  const notes = [];
  const session = {
    source: async () =>
      clicks
        ? form
        : Date.now() < readyAt
          ? tree(
              `<node package="${pkg}" class="android.view.View" content-desc="关闭" clickable="true" enabled="true" bounds="[0,0][200,400]"/>`,
            )
          : tree(row('close', '关闭广告', 'Button', true)),
    find: async () => {
      assert.ok(Date.now() >= readyAt);
      return 'close';
    },
    click: async () => clicks++,
  };
  await appObstructions(
    session,
    pkg,
    () => {},
    async (n) => notes.push(n),
    false,
  ).clear(new AbortController().signal);
  assert.equal(clicks, 1);
  assert.equal(notes[0].action, 'WAIT_OVERLAY');
  assert.equal(notes[0].phase, 'WAITING');
  assert.equal(notes.at(-1).phase, 'CLEARED');
});

test('an unverifiable modal is bounded and stop during its wait does not mutate', async () => {
  const abort = new AbortController();
  let notes = 0;
  const session = {
    source: async () =>
      tree(
        `<node package="${pkg}" class="android.view.View" content-desc="关闭" clickable="true" enabled="true" bounds="[0,0][200,400]"/>`,
      ),
    click: async () => assert.fail('unknown overlay cannot be clicked'),
  };
  await assert.rejects(
    appObstructions(
      session,
      pkg,
      () => {},
      async () => {
        notes++;
        abort.abort();
      },
      false,
    ).clear(abort.signal),
    (e) => e.code === 'CANCELLED',
  );
  assert.equal(notes, 1);
  const started = Date.now(),
    phases = [];
  await assert.rejects(
    appObstructions(
      session,
      pkg,
      () => {},
      async (n) => phases.push(n),
      false,
    ).clear(new AbortController().signal),
    (e) => e.code === 'AUTO_OBSTRUCTION_UNVERIFIED',
  );
  assert.ok(Date.now() - started >= 14000 && Date.now() - started < 20000);
  assert.equal(phases.length, 1);
  assert.equal(phases[0].phase, 'WAITING');
});

test('one transient read retries after backoff; constructor cancellation and mutations never retry', async (t) => {
  let reads = 0,
    mutations = 0,
    mode = 'recover',
    firstAt = 0,
    secondAt = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') {
      mutations++;
      res
        .writeHead(500)
        .end(
          JSON.stringify({ value: { error: 'unknown error', message: 'PRIVATE_RESPONSE_BODY' } }),
        );
      return;
    }
    reads++;
    if (reads === 1) firstAt = Date.now();
    else secondAt = Date.now();
    if (mode === 'recover' && reads > 1) res.end(JSON.stringify({ value: form }));
    else
      res
        .writeHead(500)
        .end(
          JSON.stringify({ value: { error: 'unknown error', message: 'PRIVATE_RESPONSE_BODY' } }),
        );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const client = new AppiumClient(server.address().port);
  client.session = 'owned';
  assert.equal(await client.source(), form);
  assert.equal(reads, 2);
  assert.ok(secondAt - firstAt >= 350);
  mode = 'fail';
  reads = 0;
  await assert.rejects(
    client.source(),
    (e) => e.code === 'APPIUM_READ_SERVER' && !e.message.includes('PRIVATE'),
  );
  assert.equal(reads, 2);
  const abort = new AbortController(),
    stopped = new AppiumClient(server.address().port, abort.signal);
  stopped.session = 'owned';
  reads = 0;
  const timer = setTimeout(() => abort.abort(), 60);
  await assert.rejects(stopped.source(), (e) => e.code === 'CANCELLED');
  clearTimeout(timer);
  assert.equal(reads, 1);
  await assert.rejects(client.submit('button', 1000));
  assert.equal(mutations, 1);
});

test('0.9.1 preserves readiness capability and waiting events cannot pretend an action occurred', () => {
  assert.equal(appReadinessSupported(['APP_READINESS_V1'], '0.9.1'), true);
  assert.equal(
    obstructionIssues({
      action: 'WAIT_OVERLAY',
      method: 'CONTROLS',
      index: 1,
      phase: 'WAITING',
    }).length,
    0,
  );
  for (const phase of ['ACTION_SENT', 'CLEARED', 'UNCHANGED', undefined])
    assert.ok(
      obstructionIssues({
        action: 'WAIT_OVERLAY',
        method: 'CONTROLS',
        index: 1,
        ...(phase ? { phase } : {}),
      }).length,
    );
});

test('disabled, stale and failed element reads have distinct attachment meanings', async (t) => {
  let mode = 'disabled';
  const server = createServer((_req, res) =>
    mode === 'disabled'
      ? res.end(JSON.stringify({ value: false }))
      : res.writeHead(mode === 'stale' ? 404 : 500).end(
          JSON.stringify({
            value: {
              error: mode === 'stale' ? 'stale element reference' : 'unknown error',
              message: 'PRIVATE_RESPONSE_BODY',
            },
          }),
        ),
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const client = new AppiumClient(server.address().port);
  client.session = 'owned';
  assert.equal(await client.attached('close'), true);
  mode = 'stale';
  assert.equal(await client.attached('close'), false);
  mode = 'server';
  await assert.rejects(client.attached('close'), (e) => !e.message.includes('PRIVATE'));
});

function modalPicture() {
  const png = new PNG({ width: 200, height: 400 });
  png.data.fill(255);
  for (let i = 8; i < 25; i++)
    for (let d = -1; d <= 1; d++)
      for (const x of [84 + i, 84 + 32 - i]) {
        const at = ((294 + i + d) * 200 + x) * 4;
        png.data[at] = png.data[at + 1] = png.data[at + 2] = 0;
      }
  return PNG.sync.write(png);
}
const sameModal = () =>
  tree(
    `<node package="${pkg}" class="android.widget.FrameLayout" resource-id="${pkg}:id/ad_panel" enabled="true" clickable="false" bounds="[20,80][180,350]">${row('graphic_target', '', 'ImageView', true, '', '[84,294][116,326]')}</node>`,
  );
const closeRect = { x: 84, y: 294, width: 32, height: 32 },
  panelRect = { x: 20, y: 80, width: 160, height: 270 };

test('two consecutive modals at identical coordinates are distinguished by both old element references', async () => {
  let taps = 0;
  const notes = [],
    picture = modalPicture();
  const session = {
    source: async () => (taps < 2 ? sameModal() : form),
    screenshot: async () => picture,
    ocr: async () => [],
    find: async (l) => (l.value.endsWith('graphic_target') ? 'close' : 'panel') + '-' + taps,
    rect: async (id) => (id.startsWith('close') ? closeRect : panelRect),
    attached: async (id) => Number(id.split('-').at(-1)) >= taps,
    tap: async () => taps++,
  };
  await appObstructions(
    session,
    pkg,
    () => {},
    async (n) => notes.push(n),
    true,
  ).clear(new AbortController().signal);
  assert.equal(taps, 2);
  assert.equal(notes.filter((n) => n.phase === 'CLEARED').length, 2);
  assert.deepEqual(
    notes.filter((n) => n.phase === 'ACTION_SENT').map((n) => n.index),
    [1, 2],
  );
});

test('a recreated close button with the original panel still attached cannot justify another click', async () => {
  let taps = 0;
  const picture = modalPicture(),
    notes = [];
  const session = {
    source: async () => sameModal(),
    screenshot: async () => picture,
    ocr: async () => [],
    find: async (l) => (l.value.endsWith('graphic_target') ? 'close' : 'panel'),
    rect: async (id) => (id === 'close' ? closeRect : panelRect),
    attached: async (id) => id === 'panel',
    tap: async () => taps++,
  };
  await assert.rejects(
    appObstructions(
      session,
      pkg,
      () => {},
      async (n) => notes.push(n),
      true,
      { confirmationTimeoutMs: 1000 },
    ).clear(new AbortController().signal),
    (e) => e.code === 'AUTO_OBSTRUCTION_STALLED',
  );
  assert.equal(taps, 1);
  assert.ok(!notes.some((n) => n.phase === 'CLEARED'));
});

test('a native notice with an explicit close barrier can use one verified Back; forms and terms cannot', async () => {
  let closed = false,
    backs = 0;
  const notes = [];
  const notice = tree(
    `<node package="${pkg}" class="android.view.View" content-desc="关闭" enabled="true" clickable="true" bounds="[0,0][200,400]"/>` +
      row('notice', '系统公告：测试提示', 'TextView', false, '', '[20,100][180,280]'),
  );
  const session = {
    source: async () => (closed ? form : notice),
    find: async (l) => (l.value.includes('notice') ? 'notice' : 'barrier'),
    rect: async (id) =>
      id === 'notice'
        ? { x: 20, y: 100, width: 160, height: 100 }
        : { x: 0, y: 0, width: 200, height: 400 },
    attached: async () => !closed,
    back: async () => {
      backs++;
      closed = true;
    },
    tap: async () => assert.fail('notice does not use guessed coordinates'),
  };
  await appObstructions(
    session,
    pkg,
    () => {},
    async (n) => notes.push(n),
    false,
  ).clear(new AbortController().signal);
  assert.equal(backs, 1);
  assert.ok(notes.every((n) => n.method === 'BACK'));
  assert.equal(notes.at(-1).phase, 'CLEARED');
  for (const text of ['用户协议和隐私政策公告', '普通推荐内容']) {
    let called = 0;
    const blocked = {
      ...session,
      source: async () => notice.replace('系统公告：测试提示', text),
      back: async () => called++,
    };
    const abort = AbortSignal.timeout(80);
    await assert.rejects(
      appObstructions(
        blocked,
        pkg,
        () => {},
        async () => {},
        false,
      ).clear(abort),
    );
    assert.equal(called, 0);
  }
});

test('one startup network recovery is explicitly gated before account work and never retries registration', async () => {
  let state = 'network',
    clicks = 0,
    allowed = true;
  const notes = [];
  const network = tree(
    row('error', '网络连接失败') + row('retry', '重试', 'Button', true, '', '[10,140][190,180]'),
  );
  const session = {
    source: async () => (state === 'network' ? network : form),
    find: async () => 'retry',
    click: async () => {
      clicks++;
      state = 'form';
    },
  };
  const handler = appObstructions(
    session,
    pkg,
    () => {},
    async (n) => notes.push(n),
    false,
    {},
    () => allowed,
  );
  await handler.clear(new AbortController().signal);
  assert.equal(clicks, 1);
  assert.equal(notes.at(-1).phase, 'CLEARED');
  assert.ok(notes.every((n) => n.action === 'RETRY_LOAD'));
  state = 'network';
  await assert.rejects(
    handler.clear(new AbortController().signal),
    (e) => e.code === 'AUTO_STARTUP_NETWORK_FAILED',
  );
  assert.equal(clicks, 1);
  allowed = false;
  await appObstructions(
    session,
    pkg,
    () => {},
    async () => {},
    false,
    {},
    () => allowed,
  ).clear(new AbortController().signal);
  assert.equal(clicks, 1);
  const registrationFailure = {
    ...session,
    source: async () => network.replace('网络连接失败', '注册失败，请重试'),
  };
  await appObstructions(
    registrationFailure,
    pkg,
    () => {},
    async () => {},
    false,
    {},
    () => true,
  ).clear(new AbortController().signal);
  assert.equal(clicks, 1);
});

test('native stability ignores background feed changes but rejects moving controls and covering layers', () => {
  const page = readRegistrationPage(form, pkg),
    stable = nativeScreenKey(page, pkg);
  assert.ok(stable);
  assert.equal(
    nativeScreenKey(
      readRegistrationPage(form.replace('text="注册"', 'text="Create account"'), pkg),
      pkg,
    ),
    stable,
  );
  assert.equal(
    nativeScreenKey(
      readRegistrationPage(
        form.replace('</hierarchy>', row('feed', 'Updated content') + '</hierarchy>'),
        pkg,
      ),
      pkg,
    ),
    stable,
  );
  assert.notEqual(
    nativeScreenKey(
      readRegistrationPage(form.replace('[10,130][190,160]', '[10,131][190,161]'), pkg),
      pkg,
    ),
    stable,
  );
  const covered = form.replace(
    '</hierarchy>',
    row('cover', '', 'FrameLayout', true, '', '[0,0][200,400]') + '</hierarchy>',
  );
  assert.equal(nativeScreenKey(readRegistrationPage(covered, pkg), pkg), undefined);
});

test('a native View button inherits one short child label, while a whole-screen ancestor cannot submit', () => {
  const nested = form.replace(
    row('submit', '注册', 'Button', true, '', '[10,240][190,280]'),
    '<node package="' +
      pkg +
      '" class="android.view.View" resource-id="' +
      pkg +
      ':id/submit" enabled="true" clickable="true" bounds="[10,240][190,280]">' +
      row('submit_label', '注册', 'TextView', false, '', '[30,245][170,275]') +
      '</node>',
  );
  const page = readRegistrationPage(nested, pkg),
    bound = registrationForm(page, pkg);
  assert.equal(bound.submit.value, pkg + ':id/submit');
  assert.ok(registrationBindingsValid(page, bound));
  assert.equal(registrationEntries(page, pkg).filter((c) => c.role === 'REGISTER').length, 1);
  const unsafe = nested.replace('bounds="[10,240][190,280]"', 'bounds="[0,0][200,400]"');
  assert.equal(registrationForm(readRegistrationPage(unsafe, pkg), pkg), undefined);
});

test('a persistent account tab does not hide a new explicit login entry after navigation', async () => {
  let state = 'home';
  const clicks = [];
  const account = row('mine', '我的', 'Button', true, '', '[10,350][70,390]');
  const login = row('login', '登录', 'Button', true, '', '[10,140][190,180]');
  const session = {
    source: async () =>
      state === 'form' ? form : tree(account + (state === 'profile' ? login : '')),
    find: async (l) => l.value.split('/').at(-1),
    click: async (id) => {
      clicks.push(id);
      state = id === 'mine' ? 'profile' : 'form';
    },
  };
  const found = await discoverRegistration(
    session,
    pkg,
    settings,
    'persistent-tab',
    new AbortController().signal,
    () => {},
    recognition(),
  );
  assert.ok(found.form);
  assert.deepEqual(clicks, ['mine', 'login']);
});

test('startup preparation has its own bounded loading time before the shorter discovery phase', async () => {
  const until = Date.now() + 1400;
  const session = {
    source: async () => (Date.now() < until ? tree(row('loading', '正在加载中……请稍等……')) : form),
    screenshot: async () => assert.fail('native preparation must not capture'),
  };
  const handler = appObstructions(
    session,
    pkg,
    () => {},
    async () => {},
    true,
    { totalTimeoutMs: 10000 },
  );
  await handler.prepare(new AbortController().signal);
  const result = await discoverRegistration(
    session,
    pkg,
    { ...settings, timeoutMs: 800 },
    'separate-startup',
    new AbortController().signal,
    () => {},
    recognition(),
    undefined,
    handler.clear,
  );
  assert.ok(result.form);
});

test('startup preparation and subsequent clearing share one action budget, and loading stop is immediate', async () => {
  let state = 'ad',
    clicks = 0;
  const ad = tree(row('skip', '跳过', 'Button', true));
  const session = {
    source: async () => (state === 'ad' ? ad : form),
    find: async () => 'skip',
    click: async () => {
      clicks++;
      state = 'form';
    },
  };
  const handler = appObstructions(
    session,
    pkg,
    () => {},
    async () => {},
    false,
    { maxActions: 1 },
  );
  await handler.prepare(new AbortController().signal);
  state = 'ad';
  await assert.rejects(
    handler.clear(new AbortController().signal),
    (e) => e.code === 'AUTO_OBSTRUCTION_LIMIT',
  );
  assert.equal(clicks, 1);
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 50);
  await assert.rejects(
    appObstructions(
      { source: async () => tree(row('loading', '加载中')) },
      pkg,
      () => {},
      async () => {},
      false,
    ).prepare(stop.signal),
    (e) => e.code === 'CANCELLED',
  );
});
