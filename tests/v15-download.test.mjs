import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { runDownload, NetworkPolicy, ApkCache } from '@apk/automation';
import { fixtureSite, fixtureApk } from './p2-fixtures.mjs';
async function temporary(t) {
  const parent = resolve('.tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'v15-download-'));
  t.after(async () => {
    assert.ok(root.startsWith(parent + sep));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
test('1.5 old files are retained on failure and removed only after a complete verified new day', async (t) => {
  const site = await fixtureSite();
  t.after(() => site.close());
  const root = await temporary(t),
    node = randomUUID();
  const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
  config.execution.mode = 'DOWNLOAD_ONLY';
  delete config.execution.proxySecretVersionId;
  config.registrationFlows = [];
  config.source = {
    url: site.url + '/source',
    xpath: '//a[@class="jgg-item"]',
    browserUserAgent: '',
  };
  config.download.timeoutMs = 10000;
  config.download.retries = 2;
  const events = [];
  const run = async (day) => {
    events.length = 0;
    await runDownload(
      config,
      node,
      root,
      resolve('.'),
      AbortSignal.timeout(30000),
      async (e) => {
        events.push(e);
      },
      {
        chromium,
        policy: new NetworkPolicy(new Set([site.url])),
        dailyDownload: true,
        fixedCacheDay: day,
      },
    );
  };
  await run('2026-10-28');
  assert.equal(events.at(-1).payload.status, 'SUCCEEDED');
  const old = await readdir(join(root, 'cache/files'));
  assert.equal(old.length, 3);
  config.source = { ...config.source, url: site.url + '/invalid' };
  await run('2026-10-29');
  assert.equal(events.at(-1).payload.status, 'FAILED');
  assert.equal(site.counts.get('/invalid.apk'), 1, 'daily downloads do not retry the source');
  assert.deepEqual(await readdir(join(root, 'cache/files')), old);
  config.source = { ...config.source, url: site.url + '/source' };
  await run('2026-10-29');
  assert.equal(events.at(-1).payload.status, 'SUCCEEDED');
  const current = await readdir(join(root, 'cache/files'));
  assert.equal(current.length, 3);
  assert.ok(old.every((file) => !current.includes(file)));
  const cache = await ApkCache.open(join(root, 'cache'));
  try {
    assert.equal(
      cache.db.prepare('SELECT count(*) AS n FROM cache WHERE day < ?').get('2026-10-29').n,
      0,
    );
  } finally {
    cache.close();
  }
});
test('1.5 AUTO landing ignores a visible backup button and waits for delayed automatic download', async (t) => {
  const apk = fixtureApk(),
    counts = new Map(),
    sockets = new Set();
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    res.setHeader('cache-control', 'no-store');
    if (path.endsWith('.apk')) {
      res.writeHead(200, {
        'content-type': 'application/vnd.android.package-archive',
        'content-disposition': 'attachment; filename="owned.apk"',
      });
      res.end(apk);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        (path === '/source'
          ? '<a class="icon" pid="auto" href="/landing" target="_blank">automatic</a>'
          : '<a id="backup" href="/backup.apk">download backup</a><script>setTimeout(()=>location.assign("/automatic.apk"),2200)</script>'),
    );
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
  const origin = 'http://127.0.0.1:' + server.address().port,
    config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
  config.source = { url: origin + '/source', xpath: '//a[@class="icon"]', browserUserAgent: '' };
  config.execution.mode = 'DOWNLOAD_ONLY';
  delete config.execution.proxySecretVersionId;
  config.registrationFlows = [];
  config.download.timeoutMs = 10000;
  config.download.landingRules = [
    { host: '127.0.0.1', by: 'css', selector: '#backup', mode: 'AUTO' },
  ];
  const events = [];
  await runDownload(
    config,
    randomUUID(),
    await temporary(t),
    resolve('.'),
    AbortSignal.timeout(20000),
    async (e) => {
      events.push(e);
    },
    {
      chromium,
      policy: new NetworkPolicy(new Set([origin])),
      dailyDownload: true,
      fixedCacheDay: '2026-10-28',
    },
  );
  assert.equal(events.at(-1).payload.status, 'SUCCEEDED');
  assert.equal(counts.get('/automatic.apk'), 1);
  assert.equal(counts.get('/backup.apk') ?? 0, 0);
});
