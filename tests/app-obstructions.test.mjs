import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { PNG } from 'pngjs';
import { appObstructions, obstructionRole, AppiumClient } from '@apk/automation';
const pkg = 'com.example.owned';
const node = (id, text, y = 10, clickable = true) =>
  `<node package="${pkg}" class="android.widget.Button" text="${text}" resource-id="${pkg}:id/${id}" enabled="true" clickable="${clickable}" bounds="[10,${y}][150,${y + 30}]"/>`;
const xml = (body) => `<hierarchy>${body}</hierarchy>`;
test('disabled skip and separate countdown wait until the ad becomes skippable', async () => {
  let reads = 0,
    closed = false;
  const notes = [];
  const session = {
    source: async () => {
      reads++;
      return xml(
        closed
          ? node('register', '注册')
          : reads < 3
            ? node('skip', '跳过广告').replace('enabled="true"', 'enabled="false"') +
              node('countdown', '1 秒', 50, false)
            : node('skip', '跳过广告'),
      );
    },
    find: async (l) => l.value,
    click: async () => {
      assert.ok(reads >= 3);
      closed = true;
    },
  };
  await appObstructions(
    session,
    pkg,
    () => {},
    async (n) => notes.push(n),
    false,
  ).clear(new AbortController().signal);
  assert.deepEqual(
    notes.map((n) => n.action),
    ['WAIT_SPLASH', 'SKIP_AD'],
  );
  assert.equal(obstructionRole('Skip in 3s', false), 'WAIT_SPLASH');
});
test('APP startup countdown, ad and notice close before form; later popup is handled again', async () => {
  let state = 'splash',
    reads = 0;
  const notes = [],
    clicks = [];
  const session = {
    source: async () =>
      xml(
        state === 'splash'
          ? node('skip', ++reads < 3 ? '跳过 1 秒' : '跳过广告')
          : state === 'notice'
            ? node('title', '公告', 10, false) + node('ack', '我知道了', 50)
            : state === 'popup'
              ? node('close', '关闭')
              : node('form', '注册'),
      ),
    find: async (l) => l.value,
    click: async (id) => {
      clicks.push(id);
      state = id.endsWith('/skip') ? 'notice' : 'form';
    },
  };
  const handler = appObstructions(
    session,
    pkg,
    () => {},
    async (n) => notes.push(n),
    false,
  );
  assert.match(await handler.clear(new AbortController().signal), /注册/);
  assert.deepEqual(
    notes.map((n) => n.action),
    ['WAIT_SPLASH', 'SKIP_AD', 'ACK_NOTICE'],
  );
  state = 'popup';
  await handler.clear(new AbortController().signal);
  state = 'popup';
  await handler.clear(new AbortController().signal);
  assert.equal(clicks.length, 4, 'a new later popup can use the same close control');
  assert.equal(notes.at(-1).action, 'CLOSE_POPUP');
});
test('ambiguous controls, unchanged popup and stop never cause unbounded clicks', async () => {
  let clicks = 0;
  const signal = new AbortController();
  const session = {
    source: async () => xml(node('a', '关闭') + node('b', '关闭广告', 50)),
    find: async () => 'close',
    click: async () => clicks++,
  };
  await assert.rejects(
    appObstructions(
      session,
      pkg,
      () => {},
      async () => {},
      false,
    ).clear(signal.signal),
    /AUTO_OBSTRUCTION_AMBIGUOUS/,
  );
  assert.equal(clicks, 0);
  session.source = async () => xml(node('a', '关闭'));
  await assert.rejects(
    appObstructions(
      session,
      pkg,
      () => {},
      async () => {},
      false,
    ).clear(signal.signal),
    /AUTO_OBSTRUCTION_STALLED/,
  );
  assert.equal(clicks, 1);
  signal.abort();
  await assert.rejects(
    appObstructions(
      session,
      pkg,
      () => {},
      async () => {},
      false,
    ).clear(signal.signal),
    /CANCELLED/,
  );
  assert.equal(clicks, 1);
  for (const text of [
    '注册',
    '购买',
    '立即体验',
    '点击广告',
    '关闭账户',
    '注销账号',
    '下载推荐APP',
  ])
    assert.equal(obstructionRole(text, true), undefined);
  assert.equal(obstructionRole('确定', false), undefined);
});
test('image-only close is checked twice and never uses a guessed corner', async () => {
  const image = new PNG({ width: 200, height: 200 });
  image.data.fill(255);
  const picture = PNG.sync.write(image);
  let hidden = false,
    taps = 0;
  const notes = [];
  const session = {
    source: async () => xml(hidden ? node('register', '注册') : ''),
    screenshot: async () => picture,
    ocr: async () =>
      hidden
        ? []
        : [{ text: '关闭广告', confidence: 99, rect: { x: 20, y: 40, width: 100, height: 30 } }],
    tap: async (x, y) => {
      assert.equal(x, 70);
      assert.equal(y, 55);
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
  assert.equal(notes[0].method, 'OCR');
});
test('page reads tolerate slow source and retry only transient read errors; mutations stay once', async (t) => {
  let mode = 'slow',
    reads = 0,
    mutations = 0;
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    if (req.method === 'POST') {
      mutations++;
      res.writeHead(500).end(
        JSON.stringify({
          value: { error: 'unknown error', message: 'private-error-must-not-leak' },
        }),
      );
      return;
    }
    reads++;
    if (mode === 'slow') await new Promise((r) => setTimeout(r, 5400));
    if (mode === 'timeout') await new Promise((r) => setTimeout(r, 200));
    if (mode === 'retry' && reads === 1) {
      res.writeHead(500).end(JSON.stringify({ value: { error: 'unknown error' } }));
      return;
    }
    if (mode === 'lost') {
      res.writeHead(404).end(
        JSON.stringify({
          value: { error: 'invalid session id', message: 'private-error-must-not-leak' },
        }),
      );
      return;
    }
    res.end(JSON.stringify({ value: xml(node('register', '注册')) }));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  const client = new AppiumClient(server.address().port);
  client.session = 'owned';
  assert.match(await client.source(), /注册/);
  assert.equal(reads, 1, 'a valid source after five seconds is accepted');
  mode = 'retry';
  reads = 0;
  assert.match(await client.source(), /注册/);
  assert.equal(reads, 2);
  mode = 'lost';
  reads = 0;
  await assert.rejects(
    client.source(),
    (e) => e.code === 'APPIUM_SESSION_LOST' && !e.message.includes('private'),
  );
  assert.equal(reads, 1);
  const command = client.command.bind(client);
  client.command = (m, p, b, timeout, signal) =>
    command(m, p, b, p.endsWith('/source') ? 30 : timeout, signal);
  mode = 'timeout';
  reads = 0;
  await assert.rejects(client.source(), (e) => e.code === 'APPIUM_READ_TIMEOUT');
  assert.equal(reads, 2, 'a timed-out read is retried once only');
  reads = 0;
  await assert.rejects(client.source(AbortSignal.timeout(10)), (e) => e.code === 'CANCELLED');
  assert.equal(reads, 1, 'cancel does not retry');
  await assert.rejects(client.click('owned'), /APPIUM_FAILED/);
  assert.equal(mutations, 1);
});
