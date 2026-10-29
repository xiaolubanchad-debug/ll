import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { ApkCache, extractApkLinks, NetworkPolicy, runDownload } from '@apk/automation';
import { fixtureApk, fixtureSite } from './p2-fixtures.mjs';
import { schemaIssues } from '@apk/contracts';

test('download diagnostics only accept task-bound fixed messages, never raw page text', async () => {
  const fixtures = JSON.parse(await readFile('contracts/fixtures/agent.valid.json', 'utf8'));
  const body = structuredClone(fixtures.find((value) => value.kind === 'events'));
  const event = body.events[0];
  event.type = 'LOG';
  event.taskId = randomUUID();
  event.payload = { level: 'INFO', message: '下载入口：正在访问源码中的唯一 APK 地址' };
  body.events = [event];
  assert.deepEqual(schemaIssues('AgentMessage', body), []);
  for (const change of [
    { payload: { ...event.payload, message: '<html>private page content</html>' } },
    { payload: { ...event.payload, url: 'https://example.test/app.apk?token=private' } },
    { payload: { ...event.payload, level: 'WARN' } },
    { taskId: undefined },
  ])
    assert.ok(schemaIssues('AgentMessage', { ...body, events: [{ ...event, ...change }] }).length);
});

test('APK literals preserve signed queries, decode escapes and reject prose, expressions and unsafe schemes', () => {
  const base = 'https://downloads.example/landing/index';
  assert.deepEqual(extractApkLinks(base, ['../release/app.APK?token=a%2Bb&amp;channel=test'], []), [
    'https://downloads.example/release/app.APK?token=a%2Bb&channel=test',
  ]);
  assert.deepEqual(
    extractApkLinks(base, [], [String.raw`{"apk":"https:\/\/cdn.example\u002fapp.apk?x=1&y=2"}`]),
    ['https://cdn.example/app.apk?x=1&y=2'],
  );
  assert.deepEqual(extractApkLinks(base, ["go('/files/app.apk')"], []), [
    'https://downloads.example/files/app.apk',
  ]);
  for (const value of [
    'app.apk',
    'Please download app.apk',
    'https://example.test/?next=app.apk',
    'https://example.test/app.apk.js',
    'https://user:password@example.test/app.apk',
    'javascript:alert("/app.apk")',
    'data:text/plain,app.apk',
    'file:///tmp/app.apk',
  ])
    assert.deepEqual(extractApkLinks(base, [value], []), [], value);
  assert.deepEqual(
    extractApkLinks(
      base,
      [],
      ["const a='/app.apk' + '?token=' + token; const b=`'/other.apk' ${x}`;"],
    ),
    [],
  );
  assert.equal(extractApkLinks(base, [], ["'/one.apk'; '/two.apk'; '/one.apk'"]).length, 2);
});

test(
  'Android fallback downloads use touch, frames and static sources; ambiguous and invalid files never succeed',
  { timeout: 90000 },
  async (t) => {
    const routes = [
      'touch',
      'frame',
      'inline',
      'attribute',
      'base',
      'ambiguous',
      'invalid',
      'blocked',
    ];
    const apk = fixtureApk(),
      requests = [],
      touches = [],
      sockets = new Set();
    const html = (body) =>
      '<meta name="viewport" content="width=device-width,initial-scale=1">' + body;
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://localhost');
      requests.push({ path: url.pathname, query: url.search, ua: req.headers['user-agent'] });
      res.setHeader('cache-control', 'no-store');
      if (url.pathname === '/tap') {
        touches.push(url.searchParams.get('event'));
        res.end('ok');
        return;
      }
      if (url.pathname.endsWith('.apk')) {
        res.writeHead(200, {
          'content-type': 'application/vnd.android.package-archive',
          'content-disposition': 'attachment; filename="owned.apk"',
        });
        res.end(url.pathname === '/invalid.apk' ? Buffer.from('<html>not an APK</html>') : apk);
        return;
      }
      const pages = {
        '/source': routes
          .map(
            (route) =>
              `<a class="icon" pid="${route}" href="/${route}" target="_blank">${route}</a>`,
          )
          .join(''),
        '/touch': `<div id="download" style="padding:20px">高速下载</div><script>document.querySelector('#download').addEventListener('touchend', async e=>{e.preventDefault();await fetch('/tap?event='+e.type);location.assign('/touch.apk');});</script>`,
        '/frame': '<iframe src="/frame-control" style="width:390px;height:250px"></iframe>',
        '/frame-control': `<span onclick="location.assign('/frame.apk')" style="display:block;padding:20px">高速下载</span>`,
        '/inline':
          '<script type="application/json">{"apk":"\\/inline.apk?token=a%2Bb&channel=test"}</script>',
        '/attribute':
          '<div data-apk-url="/attribute.apk?token=a%2Bb&amp;channel=test">Owned download metadata</div>',
        '/base':
          '<base href="/files/"><script type="application/json">{"apk":"nested/base.APK"}</script>',
        '/ambiguous':
          '<script type="application/json">{"a":"/never-one.apk","b":"/never-two.apk"}</script>',
        '/invalid': '<script type="application/json">{"apk":"/invalid.apk"}</script>',
        '/blocked':
          '<script type="application/json">{"apk":"http://127.0.0.1:34567/blocked.apk"}</script>',
      };
      // APK extension is deliberately case insensitive.
      if (url.pathname.endsWith('.APK')) {
        res
          .writeHead(200, {
            'content-type': 'application/vnd.android.package-archive',
            'content-disposition': 'attachment; filename="owned.apk"',
          })
          .end(apk);
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html(pages[url.pathname] ?? 'Not found'));
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((r) => server.close(r));
    });
    const parent = resolve('.tmp');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'download-discovery-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
    config.source = { url: origin + '/source', xpath: '//a[@class="icon"]', browserUserAgent: '' };
    config.execution.mode = 'FULL';
    config.download.timeoutMs = 10000;
    config.download.retries = 0;
    config.download.landingRules = [
      {
        host: '*',
        by: 'css',
        selector: 'a[href*=".apk"],a:has-text("下载"),button:has-text("下载")',
      },
    ];
    const events = [],
      handoffs = [];
    await runDownload(
      config,
      randomUUID(),
      root,
      resolve('.'),
      AbortSignal.timeout(80000),
      async (e) => {
        events.push(e);
      },
      {
        chromium,
        policy: new NetworkPolicy(new Set([origin])),
        afterDownload: async (target, metadata, file) => {
          assert.match(file, /[/\\]cache[/\\]files[/\\][a-f0-9]{64}\.apk$/);
          assert.ok((await readFile(file)).equals(apk));
          assert.equal(metadata.size, apk.length);
          handoffs.push(target.pid);
          return {
            status: 'SUCCEEDED',
            proof: 'FILE_VALIDATION',
            artifactIds: [],
            cleanupComplete: true,
          };
        },
      },
    );
    const finished = events.filter((e) => e.type === 'TASK_FINISHED');
    assert.equal(finished.length, routes.length, JSON.stringify(events));
    assert.deepEqual(
      finished.map((e) => e.payload.status),
      [
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
        'SUCCEEDED',
        'FAILED',
        'FAILED',
        'FAILED',
      ],
      JSON.stringify(finished),
    );
    assert.equal(finished[6].payload.errorCode, 'APK_INVALID');
    assert.equal(finished[7].payload.errorCode, 'NETWORK_BLOCKED');
    assert.deepEqual(handoffs, routes.slice(0, 5));
    assert.deepEqual(touches, ['touchend']);
    for (const path of [
      '/touch.apk',
      '/frame.apk',
      '/inline.apk',
      '/attribute.apk',
      '/files/nested/base.APK',
    ]) {
      const found = requests.filter((r) => r.path === path);
      assert.equal(found.length, 1, path);
      assert.match(found[0].ua, /Android.*Mobile/);
    }
    assert.ok(!requests.some((r) => r.path.startsWith('/never-')));
    assert.equal(requests.find((r) => r.path === '/inline.apk').query, '?token=a%2Bb&channel=test');
    const logs = events.filter((e) => e.type === 'LOG');
    assert.ok(logs.length >= 6);
    assert.ok(
      logs.every(
        (e) =>
          !JSON.stringify(e.payload).includes('token=') &&
          !JSON.stringify(e.payload).includes(origin),
      ),
    );
    assert.deepEqual(await readdir(join(root, 'jobs')), []);
    const cache = await ApkCache.open(join(root, 'cache'));
    try {
      assert.equal(cache.db.prepare('SELECT count(*) n FROM cache').get().n, 5);
    } finally {
      cache.close();
    }
  },
);

test(
  'stop received while a download log is delivered prevents the next touch and cleans its profile',
  { timeout: 20000 },
  async (t) => {
    const site = await fixtureSite();
    t.after(() => site.close());
    const parent = resolve('.tmp');
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, 'download-stop-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
    config.source = { url: site.url + '/source', xpath: '//a[@pid="2"]', browserUserAgent: '' };
    config.execution.mode = 'DOWNLOAD_ONLY';
    config.download.retries = 0;
    config.download.timeoutMs = 10000;
    config.download.landingRules = [{ host: '*', by: 'css', selector: 'a.download' }];
    const stop = new AbortController(),
      events = [];
    await assert.rejects(
      () =>
        runDownload(
          config,
          randomUUID(),
          root,
          resolve('.'),
          stop.signal,
          async (event) => {
            events.push(event);
            if (event.type === 'LOG') stop.abort();
          },
          { chromium, policy: new NetworkPolicy(new Set([site.url])) },
        ),
      { code: 'CANCELLED' },
    );
    assert.ok(
      !events.some(
        (event) => event.type === 'TASK_FINISHED' && event.payload.status === 'SUCCEEDED',
      ),
    );
    assert.equal(site.counts.get('/second.apk') ?? 0, 0);
    assert.deepEqual(await readdir(join(root, 'jobs')), []);
  },
);
