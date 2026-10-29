import test from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import {
  appObstructions,
  closeIcon,
  readRegistrationPage,
  obstructionCandidates,
} from '@apk/automation';
import { schemaIssues, configurationIssues, appReadinessSupported } from '@apk/contracts';
import { readFile } from 'node:fs/promises';
const pkg = 'com.example.startup';
const row = (id, text, rect = '[10,100][190,140]', type = 'Button', clickable = true) =>
  `<node package="${pkg}" class="android.widget.${type}" resource-id="${pkg}:id/${id}" text="${text}" clickable="${clickable}" enabled="true" bounds="${rect}"/>`;
const tree = (body) =>
  `<hierarchy><node package="${pkg}" class="android.widget.FrameLayout" bounds="[0,0][200,400]">${body}</node></hierarchy>`;
const short = { confirmationTimeoutMs: 1000 };

test('changed native element geometry is reread before a single click', async () => {
  let clicks = 0,
    rectangles = 0;
  const notes = [];
  const session = {
    source: async () => tree(row(clicks ? 'register' : 'ad_close', clicks ? '注册' : '关闭广告')),
    find: async () => 'close',
    rect: async () => ({ x: 10, y: ++rectangles === 1 ? 120 : 100, width: 180, height: 40 }),
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
  assert.ok(notes.some((n) => n.phase === 'UNVERIFIED'));
  assert.ok(notes.every((n) => n.index === 1));
  assert.equal(notes.at(-1).phase, 'CLEARED');
});

test('delayed close is confirmed after its animation, with exactly one command and honest phases', async () => {
  let pressedAt = 0,
    clicks = 0;
  const notes = [];
  const session = {
    source: async () =>
      tree(
        pressedAt && Date.now() - pressedAt >= 1500
          ? row('register', '注册')
          : row('ad_close', '关闭广告') +
              row('video', String(Date.now()), '[0,200][100,220]', 'TextView', false),
      ),
    find: async (l) => l.value,
    click: async () => {
      clicks++;
      pressedAt = Date.now();
    },
  };
  const source = await appObstructions(
    session,
    pkg,
    () => {},
    async (n) => notes.push({ ...n, at: Date.now() }),
    false,
  ).clear(new AbortController().signal);
  assert.match(source, /注册/);
  assert.equal(clicks, 1);
  assert.deepEqual(
    notes.map((n) => n.phase),
    ['DETECTED', 'ACTION_SENT', 'WAITING', 'CLEARED'],
  );
  assert.ok(notes.at(-1).at - pressedAt >= 1500);
});

test('changing background never counts as a dismissed overlay and never repeats its button', async () => {
  let clicks = 0,
    reads = 0;
  const notes = [];
  const session = {
    source: async () =>
      tree(
        row('ad_close', '关闭广告') +
          row('video', String(++reads), '[0,200][100,220]', 'TextView', false),
      ),
    find: async () => 'ad_close',
    click: async () => clicks++,
  };
  await assert.rejects(
    appObstructions(
      session,
      pkg,
      () => {},
      async (n) => notes.push(n),
      false,
      short,
    ).clear(new AbortController().signal),
    /AUTO_OBSTRUCTION_STALLED/,
  );
  assert.equal(clicks, 1);
  assert.ok(!notes.some((n) => n.phase === 'CLEARED'));
  assert.equal(notes.at(-1).phase, 'UNCHANGED');
});

test('a label uses its unique clickable parent and parent-child candidates are merged', async () => {
  let hidden = false,
    clicks = 0;
  const session = {
    source: async () =>
      tree(
        hidden
          ? row('register', '注册')
          : `<node package="${pkg}" class="android.widget.LinearLayout" resource-id="${pkg}:id/ad_close" enabled="true" clickable="true" bounds="[10,100][190,140]">${row('label', '关闭广告', '[60,110][140,130]', 'TextView', false)}</node>`,
      ),
    find: async (l) => {
      assert.deepEqual(l, { by: 'id', value: pkg + ':id/ad_close' });
      return 'parent';
    },
    rect: async () => ({ x: 10, y: 100, width: 180, height: 40 }),
    click: async (id) => {
      assert.equal(id, 'parent');
      clicks++;
      hidden = true;
    },
  };
  assert.equal(obstructionCandidates(readRegistrationPage(await session.source(), pkg)).length, 1);
  await appObstructions(
    session,
    pkg,
    () => {},
    async () => {},
    false,
  ).clear(new AbortController().signal);
  assert.equal(clicks, 1);
});

function picture(symbol = 'x') {
  const p = new PNG({ width: 200, height: 400 });
  p.data.fill(255);
  for (let y = 30; y < 62; y++)
    for (let x = 140; x < 172; x++) {
      const cx = x - 140,
        cy = y - 30,
        inset = cx >= 7 && cx <= 24 && cy >= 7 && cy <= 24;
      const ink =
        inset &&
        (symbol === 'x'
          ? Math.abs(cx - cy) <= 1 || Math.abs(cx + cy - 31) <= 1
          : symbol === 'plus'
            ? Math.abs(cx - 15) <= 1 || Math.abs(cy - 15) <= 1
            : cx < 12);
      const i = (y * p.width + x) * 4;
      for (let k = 0; k < 3; k++) p.data[i + k] = ink ? 0 : 255;
    }
  return p;
}
function iconTree(scope = true, x = 140) {
  return tree(
    scope
      ? `<node package="${pkg}" class="android.widget.FrameLayout" resource-id="${pkg}:id/ad_panel" bounds="[20,20][180,280]">${row('graphic', '', `[${x},30][${x + 32},62]`, 'ImageButton')}</node>`
      : row('graphic', '', `[${x},30][${x + 32},62]`, 'ImageButton'),
  );
}

test('a graphical x is validated inside its UI-owned popup, then disappearance is confirmed', async () => {
  const p = picture(),
    bytes = PNG.sync.write(p),
    rect = { x: 140, y: 30, width: 32, height: 32 };
  assert.equal(closeIcon(p, rect), true);
  assert.equal(closeIcon(picture('plus'), rect), false);
  assert.equal(closeIcon(picture('noise'), rect), false);
  let hidden = false,
    taps = 0;
  const notes = [];
  const session = {
    source: async () => (hidden ? tree(row('register', '注册')) : iconTree()),
    screenshot: async () => bytes,
    ocr: async () => [],
    tap: async (x, y) => {
      assert.deepEqual([x, y], [156, 46]);
      taps++;
      hidden = true;
    },
  };
  await appObstructions(
    session,
    pkg,
    () => {},
    async (n) => notes.push(n),
    true,
  ).clear(new AbortController().signal);
  assert.equal(taps, 1);
  assert.ok(notes.every((n) => n.method === 'ICON'));
  assert.equal(notes.at(-1).phase, 'CLEARED');
});

test('an unscoped x, a plus sign and disabled image recognition never become a tap', async () => {
  for (const [scope, symbol, enabled] of [
    [false, 'x', true],
    [true, 'plus', true],
    [true, 'x', false],
  ]) {
    let taps = 0;
    const session = {
      source: async () => iconTree(scope),
      screenshot: async () => PNG.sync.write(picture(symbol)),
      ocr: async () => [],
      tap: async () => taps++,
    };
    await appObstructions(
      session,
      pkg,
      () => {},
      async () => {},
      true,
      { iconRecognition: enabled },
    ).clear(new AbortController().signal);
    assert.equal(taps, 0);
  }
});

test('stop during confirmation and a one-action budget never allow another mutation', async () => {
  let clicks = 0;
  const stop = new AbortController(),
    notes = [];
  const session = {
    source: async () => tree(row('ad_close', '关闭广告')),
    find: async () => 'close',
    click: async () => clicks++,
  };
  await assert.rejects(
    appObstructions(
      session,
      pkg,
      () => {},
      async (n) => {
        notes.push(n);
        if (n.phase === 'ACTION_SENT') stop.abort();
      },
      false,
    ).clear(stop.signal),
    /CANCELLED/,
  );
  assert.equal(clicks, 1);
  assert.ok(!notes.some((n) => n.phase === 'CLEARED'));
  let state = 0;
  session.source = async () =>
    tree(
      state === 0
        ? row('ad_close', '关闭广告')
        : row('notice', '公告', '[0,0][100,30]', 'TextView', false) + row('ack', '我知道了'),
    );
  session.click = async () => {
    clicks++;
    state++;
  };
  await assert.rejects(
    appObstructions(
      session,
      pkg,
      () => {},
      async () => {},
      false,
      { maxActions: 1 },
    ).clear(new AbortController().signal),
    /AUTO_OBSTRUCTION_LIMIT/,
  );
  assert.equal(clicks, 2);
});

test('startup settings and phases are bounded; neither raw UI nor a bare icon event is accepted', async () => {
  const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
  config.execution.autoRegistration = {
    enabled: true,
    screenshotFallback: true,
    maxNavigationSteps: 8,
    timeoutMs: 60000,
    successTimeoutMs: 60000,
    startup: { confirmationTimeoutMs: 3000, iconRecognition: true },
  };
  assert.deepEqual(configurationIssues(config), []);
  for (const startup of [
    { confirmationTimeoutMs: 500 },
    { maxActions: 13 },
    { totalTimeoutMs: 100000 },
    { image: 'raw pixels' },
    { iconRecognition: 'yes' },
  ])
    assert.ok(schemaIssues('StartupPolicy', startup).length);
  const body = JSON.parse(await readFile('contracts/fixtures/agent.valid.json', 'utf8')).find(
      (x) => x.kind === 'events',
    ),
    event = body.events[0];
  event.type = 'APP_OBSTRUCTION';
  event.taskId = '44444444-4444-4444-8444-444444444444';
  event.payload = { action: 'CLOSE_POPUP', method: 'ICON', index: 1, phase: 'CLEARED' };
  body.events = [event];
  assert.deepEqual(schemaIssues('AgentMessage', body), []);
  for (const payload of [
    { action: 'CLOSE_POPUP', method: 'ICON', index: 1 },
    { ...event.payload, phase: 'GUESS' },
    { ...event.payload, text: 'private content' },
    { ...event.payload, action: 'WAIT_SPLASH' },
  ])
    assert.ok(schemaIssues('AgentMessage', { ...body, events: [{ ...event, payload }] }).length);
  assert.equal(appReadinessSupported(['APP_READINESS_V1'], '0.9.0'), true);
  assert.equal(appReadinessSupported(['APP_READINESS_V1'], '0.8.1'), false);
  assert.equal(appReadinessSupported([], '0.9.0'), false);
});

test('an entire-screen Close semantic is never clicked at its centre; a modal-owned bottom x is used', async () => {
  const p = picture(),
    bytes = PNG.sync.write(p),
    original = PNG.sync.read(bytes); // Move the owned glyph to a bottom-centred control.
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++)
      for (let k = 0; k < 4; k++)
        p.data[((228 + y) * p.width + 84 + x) * 4 + k] =
          original.data[((30 + y) * p.width + 140 + x) * 4 + k];
  const image = PNG.sync.write(p);
  let hidden = false,
    taps = 0;
  const session = {
    source: async () =>
      hidden
        ? tree(row('register', '注册'))
        : tree(
            `<node package="${pkg}" class="android.view.View" bounds="[20,80][180,260]">${row('graphic', '', '[84,228][116,260]', 'ImageView')}</node>` +
              row('barrier', '关闭', '[0,0][200,400]', 'View'),
          ),
    screenshot: async () => image,
    ocr: async () => {
      assert.ok(hidden, 'a verified graphical close is checked before reading background text');
      return [];
    },
    tap: async (x, y) => {
      assert.deepEqual([x, y], [100, 244]);
      taps++;
      hidden = true;
    },
  };
  await appObstructions(
    session,
    pkg,
    () => {},
    async () => {},
    true,
  ).clear(new AbortController().signal);
  assert.equal(taps, 1);
  let mutations = 0;
  const unknown = {
    source: async () => tree(row('barrier', '关闭', '[0,0][200,400]', 'View')),
    find: async () => {
      mutations++;
      return 'barrier';
    },
    click: async () => mutations++,
    screenshot: async () => image,
    ocr: async () => [],
    tap: async () => mutations++,
  };
  await assert.rejects(
    appObstructions(
      unknown,
      pkg,
      () => {},
      async () => {},
      true,
    ).clear(new AbortController().signal),
    /AUTO_OBSTRUCTION_UNVERIFIED/,
  );
  assert.equal(mutations, 0);
});

test('a disabled but still-present close target is not reported cleared before it disappears', async () => {
  let clicked = 0;
  const notes = [];
  const session = {
    source: async () =>
      tree(
        clicked && Date.now() - clicked >= 1300
          ? row('register', '注册')
          : row('close', '关闭').replace('enabled="true"', `enabled="${!clicked}"`),
      ),
    find: async () => 'close',
    click: async () => {
      clicked = Date.now();
    },
  };
  await appObstructions(
    session,
    pkg,
    () => {},
    async (n) => notes.push({ ...n, at: Date.now() }),
    false,
  ).clear(new AbortController().signal);
  assert.ok(notes.find((n) => n.phase === 'CLEARED').at - clicked >= 1300);
});

test('background changes at a graphical control edge do not invalidate its stable x core', async () => {
  const a = picture(),
    b = picture();
  for (let y = 30; y < 62; y++)
    for (let x = 140; x < 172; x++)
      if (x < 143 || x > 168 || y < 33 || y > 58) {
        const i = (y * b.width + x) * 4;
        b.data[i] = 30;
        b.data[i + 1] = 30;
        b.data[i + 2] = 30;
      }
  let hidden = false,
    reads = 0,
    taps = 0;
  const session = {
    source: async () => (hidden ? tree(row('register', '注册')) : iconTree()),
    screenshot: async () => PNG.sync.write(++reads % 2 ? a : b),
    ocr: async () => [],
    tap: async () => {
      taps++;
      hidden = true;
    },
  };
  await appObstructions(
    session,
    pkg,
    () => {},
    async () => {},
    true,
  ).clear(new AbortController().signal);
  assert.equal(taps, 1);
});

test('a changed close candidate keeps its own action index and is reread before a single tap', async () => {
  let state = 'ad',
    moveOnce = false,
    moved = false,
    taps = 0;
  const notes = [];
  const session = {
    source: async () => {
      if (state === 'ad') return tree(row('ad_close', '关闭广告'));
      if (state === 'done') return tree(row('register', '注册'));
      if (moveOnce) {
        moveOnce = false;
        return iconTree(true, 100);
      }
      return iconTree();
    },
    find: async () => 'ad',
    click: async () => {
      state = 'icon';
    },
    screenshot: async () => PNG.sync.write(picture()),
    ocr: async () => [],
    tap: async () => {
      taps++;
      state = 'done';
    },
  };
  await appObstructions(
    session,
    pkg,
    () => {},
    async (n) => {
      notes.push(n);
      if (n.method === 'ICON' && n.phase === 'DETECTED' && !moved) {
        moved = true;
        moveOnce = true;
      }
    },
    true,
  ).clear(new AbortController().signal);
  assert.equal(taps, 1);
  assert.ok(notes.some((n) => n.method === 'ICON' && n.phase === 'UNVERIFIED' && n.index === 2));
  assert.ok(notes.filter((n) => n.method === 'ICON').every((n) => n.index === 2));
});
