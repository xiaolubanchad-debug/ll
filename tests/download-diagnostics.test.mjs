import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { runDownload, NetworkPolicy, ApkCache } from '@apk/automation';
import { fixtureApk } from './p2-fixtures.mjs';
import { schemaIssues } from '@apk/contracts';

test(
  'owned Chromium pages distinguish unconfirmed taps, missing events, interrupted transport and invalid files',
  { timeout: 85000 },
  async (t) => {
    const paths = ['covered', 'no-file', 'hang.apk', 'html.apk', 'good.apk'],
      requests = [],
      sockets = new Set(),
      apk = fixtureApk();
    const server = createServer((req, res) => {
      const p = new URL(req.url, 'http://localhost').pathname;
      requests.push(p);
      res.setHeader('Cache-Control', 'no-store');
      if (p === '/good.apk' || p === '/html.apk' || p === '/hang.apk') {
        res.writeHead(200, {
          'content-type': 'application/vnd.android.package-archive',
          'content-disposition': 'attachment; filename="owned.apk"',
          ...(p === '/hang.apk' ? { 'content-length': '10000000' } : {}),
        });
        if (p === '/hang.apk') {
          res.write(apk);
          const timer = setInterval(() => res.write(Buffer.alloc(1024)), 200);
          req.on('close', () => clearInterval(timer));
        } else
          res.end(
            p === '/good.apk' ? apk : '<html>' + 'Owned error response '.repeat(10) + '</html>',
          );
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      const shell =
        '<meta name="viewport" content="width=device-width,initial-scale=1"><style>a,button{display:block;padding:20px;margin:10px}</style>';
      if (p === '/source')
        res.end(
          shell +
            paths
              .map(
                (p, i) =>
                  `<a class="icon" pid="owned${i}" href="/${p}" target="_blank">Owned target ${i}</a>`,
              )
              .join(''),
        );
      else if (p === '/covered')
        res.end(
          shell +
            '<a class="download" href="/must-not.apk">Owned download</a><div style="position:fixed;inset:0;z-index:999;background:#fff">Owned modal</div>',
        );
      else if (p === '/no-file')
        res.end(
          shell +
            '<button class="download" ontouchend="fetch(\'/touch-count\')">Owned download</button>',
        );
      else res.end(shell + 'Owned fixture');
    });
    server.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    });
    const root = await mkdtemp(resolve('.tmp/download-diagnostics-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const origin = 'http://127.0.0.1:' + server.address().port,
      config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
    config.source = { url: origin + '/source', xpath: '//a[@class="icon"]', browserUserAgent: '' };
    config.execution.mode = 'DOWNLOAD_ONLY';
    config.download.retries = 0;
    config.download.timeoutMs = 10000;
    config.download.landingRules = [{ host: '*', by: 'css', selector: '.download' }];
    const events = [];
    await runDownload(
      config,
      randomUUID(),
      root,
      resolve('.'),
      AbortSignal.timeout(75000),
      async (e) => events.push(e),
      { chromium, policy: new NetworkPolicy(new Set([origin])), dailyDownload: true },
    );
    const ends = events.filter((e) => e.type === 'TASK_FINISHED');
    assert.equal(ends.length, 5, JSON.stringify(ends));
    assert.equal(ends[0].payload.errorCode, 'DOWNLOAD_CONTROL_UNCONFIRMED');
    assert.equal(ends[1].payload.errorCode, 'DOWNLOAD_NO_FILE');
    assert.ok(
      ['DOWNLOAD_TRANSFER_TIMEOUT', 'DOWNLOAD_TRANSFER_FAILED'].includes(ends[2].payload.errorCode),
      JSON.stringify(ends[2]),
    );
    assert.equal(ends[3].payload.errorCode, 'APK_INVALID_NOT_ZIP');
    assert.equal(ends[4].payload.status, 'SUCCEEDED');
    assert.equal(requests.filter((p) => p === '/touch-count').length, 1);
    assert.equal(requests.includes('/must-not.apk'), false);
    const logs = (id) =>
      events.filter((e) => e.taskId === id && e.type === 'LOG').map((e) => e.payload.message);
    assert.ok(!logs(ends[0].taskId).includes('下载入口：已操作配置控件'));
    assert.equal(logs(ends[1].taskId).filter((m) => m === '下载入口：已操作配置控件').length, 1);
    assert.ok(!logs(ends[2].taskId).includes('下载传输：文件已保存，开始 APK 校验'));
    assert.ok(logs(ends[3].taskId).includes('下载传输：文件已保存，开始 APK 校验'));
    assert.ok(
      !JSON.stringify(
        events.filter((e) => e.type === 'LOG' || e.type === 'TASK_FINISHED'),
      ).includes(origin),
    );
    assert.deepEqual(await readdir(join(root, 'jobs')), []);
    const cache = await ApkCache.open(join(root, 'cache'));
    try {
      assert.equal(cache.db.prepare('SELECT count(*) n FROM cache').get().n, 1);
    } finally {
      cache.close();
    }
    const messages = JSON.parse(await readFile('contracts/fixtures/agent.valid.json', 'utf8')),
      body = messages.find((m) => m.kind === 'events');
    for (const event of events.filter((e) => e.type === 'LOG'))
      assert.deepEqual(
        schemaIssues('AgentMessage', {
          ...body,
          events: [
            { ...body.events[0], type: 'LOG', taskId: event.taskId, payload: event.payload },
          ],
        }),
        [],
      );
  },
);
