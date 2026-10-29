import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { chromium } from '@playwright/test';
import { NetworkPolicy, runDownload } from '@apk/automation';
import { fixtureApk } from './p2-fixtures.mjs';

const routes = ['direct', 'manual-popup', 'manual-same', 'auto-popup', 'auto-same'];
const mobileState = `function state(action) {
  return {
    action, width: innerWidth, screenWidth: screen.width, screenHeight: screen.height,
    pixelRatio: devicePixelRatio, touchPoints: navigator.maxTouchPoints,
    coarse: matchMedia('(pointer: coarse)').matches, ua: navigator.userAgent,
    platform: navigator.platform, hints: navigator.userAgentData ? {mobile:navigator.userAgentData.mobile,platform:navigator.userAgentData.platform}:null
  };
}`;
const html = (
  body,
) => `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
  <style>.icon, #mobile-install { display:block; padding:14px; margin:10px; }
  @media (min-width: 600px), (pointer: fine) { .icon, #mobile-install { display:none; } }</style>
  ${body}`;

for (const customUa of [
  '',
  'Mozilla/5.0 (Linux; Android 13; Owned Mobile) AppleWebKit/537.36 Chrome/149.0.0.0 Mobile Safari/537.36',
]) {
  test(
    `phone screens and touch across APK download paths (${customUa || 'default Android UA'})`,
    {
      timeout: 60000,
    },
    async (t) => {
      const warnings = [];
      const onWarning = (warning) => {
        if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning);
      };
      process.on('warning', onWarning);
      t.after(() => process.off('warning', onWarning));
      const apk = fixtureApk(),
        sockets = new Set(),
        seen = [],
        counts = new Map();
      const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
        for (const key of ['source', 'landing']) {
          const value = url.searchParams.get(key);
          if (value)
            seen.push({
              path: url.pathname,
              key,
              headerUa: req.headers['user-agent'],
              mobileHint: req.headers['sec-ch-ua-mobile'],
              platformHint: req.headers['sec-ch-ua-platform'],
              ...JSON.parse(value),
            });
        }
        res.setHeader('cache-control', 'no-store');
        if (url.pathname.endsWith('.apk')) {
          res.writeHead(200, {
            'content-type': 'application/vnd.android.package-archive',
            'content-disposition': 'attachment; filename="owned-mobile-fixture.apk"',
          });
          res.end(apk);
          return;
        }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        if (url.pathname === '/source') {
          res.end(
            html(
              routes
                .map((route) => {
                  const target = route === 'direct' ? '/direct.apk' : '/' + route;
                  return `<a class="icon" pid="${route}" href="${target}" data-popup="${route.endsWith('popup')}">${route}</a>`;
                })
                .join('') +
                `<script>${mobileState}
          for (const icon of document.querySelectorAll('.icon')) {
            icon.addEventListener('click', e => e.preventDefault());
            icon.addEventListener('touchend', e => {
              e.preventDefault();
              const next = new URL(icon.href);
              next.searchParams.set('source', JSON.stringify(state(e.type)));
              if (icon.dataset.popup === 'true') window.open(next.href, '_blank');
              else location.assign(next.href);
            });
          }
        </script>`,
            ),
          );
          return;
        }
        const route = url.pathname.slice(1);
        if (routes.includes(route)) {
          const navigate = `const next = new URL('/${route}.apk', location.href);
          next.searchParams.set('landing', JSON.stringify(state(action)));
          location.assign(next.href);`;
          res.end(
            html(
              route.startsWith('manual')
                ? `<div id="mobile-install">Mobile touch area</div><script>${mobileState}
              document.querySelector('#mobile-install').addEventListener('touchend', e => {
                e.preventDefault(); const action = e.type; ${navigate}
              });</script>`
                : `<p>Automatic download, no button</p><script>${mobileState}
              setTimeout(() => { const action = 'automatic'; ${navigate} }, ${route === 'auto-popup' ? 0 : 250});
            </script>`,
            ),
          );
          return;
        }
        res.writeHead(404).end();
      });
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((r) => server.close(r));
      });
      const temporaryRoot = resolve('.tmp');
      await mkdir(temporaryRoot, { recursive: true });
      const root = await mkdtemp(join(temporaryRoot, 'mobile-download-'));
      t.after(async () => {
        assert.ok(root.startsWith(temporaryRoot + sep));
        await rm(root, { recursive: true, force: true });
      });
      const origin = 'http://127.0.0.1:' + server.address().port;
      const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
      config.source = {
        url: origin + '/source',
        xpath: '//a[@class="icon"]',
        browserUserAgent: customUa,
      };
      config.execution.mode = 'DOWNLOAD_ONLY';
      delete config.execution.proxySecretVersionId;
      config.registrationFlows = [];
      config.download.timeoutMs = 10000;
      config.download.retries = 0;
      config.download.landingRules = [
        { host: '127.0.0.1', by: 'css', selector: '#mobile-install' },
      ];
      const events = [];
      await runDownload(
        config,
        randomUUID(),
        root,
        resolve('.'),
        AbortSignal.timeout(45000),
        async (event) => {
          events.push(event);
        },
        { chromium, policy: new NetworkPolicy(new Set([origin])) },
      );
      const tasks = events.filter((e) => e.type === 'TASK_FINISHED');
      assert.equal(tasks.length, routes.length);
      assert.ok(
        tasks.every((e) => e.payload.status === 'SUCCEEDED'),
        JSON.stringify(tasks),
      );
      assert.equal(
        seen.filter((e) => e.key === 'source').length,
        routes.length,
        'one source touch per icon',
      );
      assert.equal(seen.filter((e) => e.key === 'landing').length, routes.length - 1);
      for (const route of routes) assert.equal(counts.get('/' + route + '.apk'), 1, route);
      for (const evidence of seen) {
        assert.equal(evidence.width, 412);
        assert.equal(evidence.screenWidth, 412);
        assert.equal(evidence.screenHeight, 915);
        assert.equal(evidence.pixelRatio, 2.625);
        assert.ok(evidence.touchPoints > 0);
        assert.equal(evidence.coarse, true);
        assert.equal(evidence.headerUa, evidence.ua);
        assert.match(evidence.platform, /^Linux/);
        assert.deepEqual(evidence.hints, { mobile: true, platform: 'Android' });
        assert.equal(evidence.mobileHint, '?1');
        assert.equal(evidence.platformHint, '"Android"');
        if (customUa) assert.equal(evidence.ua, customUa);
        else assert.match(evidence.ua, /Android.*Mobile/);
        if (evidence.key === 'source' || evidence.path.includes('manual'))
          assert.equal(evidence.action, 'touchend', 'must receive touch, not only mouse click');
        else assert.equal(evidence.action, 'automatic');
      }
      assert.deepEqual(await readdir(join(root, 'jobs')), [], 'owned browser profile cleaned');
      assert.deepEqual(warnings, [], 'keep-alive sockets register ownership cleanup once');
    },
  );
}
