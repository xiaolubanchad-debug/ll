import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import {
  readRegistrationPage,
  registrationForm,
  registrationBindingsValid,
  registrationEntries,
  appNavigationPage,
  automaticIdentity,
  redactScreenshot,
  runDownload,
  NetworkPolicy,
  validShellAndroidId,
  discoverRegistration,
} from '@apk/automation';
import { fixtureApk } from './p2-fixtures.mjs';
const pkg = 'com.example.owned';
test('shell Android identifiers accept valid unpadded 64-bit hex without inventing an identity', () => {
  for (const id of ['123456789abcdef', '0123456789abcdef', 'a', 'ffffffffffffffff'])
    assert.equal(validShellAndroidId(id), true);
  for (const id of [
    '',
    'null',
    '0',
    '0000000000000000',
    '123456789abcdef01',
    'device-id',
    '123456789abcdeg',
  ])
    assert.equal(validShellAndroidId(id), false);
});
const node = (text, y, extra = '', kind = 'TextView', x = 10, w = 100) =>
  `<node package="${pkg}" class="android.widget.${kind}" text="${text}" enabled="true" ${extra.includes('clickable=') ? '' : 'clickable="false"'} bounds="[${x},${y}][${x + w},${y + 40}]" ${extra}/>`;
const page = (body) =>
  `<hierarchy><node package="${pkg}" class="android.widget.FrameLayout" bounds="[0,0][1080,1920]"><node package="${pkg}" class="android.webkit.WebView" clickable="true" bounds="[0,0][1080,1920]">${body}</node></node></hierarchy>`;
test('anonymous duplicate-ID form fields retain their bindings when values change', () => {
  const content = (u = '', p = '', c = '') =>
    page(
      node('注册新账号', 10) +
        node('用户名', 100) +
        node(u, 100, `resource-id="${pkg}:id/input"`, 'EditText', 180, 700) +
        node('密码', 240) +
        node(p, 240, `resource-id="${pkg}:id/input" password="true"`, 'EditText', 180, 700) +
        node('确认密码', 380) +
        node(c, 380, `resource-id="${pkg}:id/input" password="true"`, 'EditText', 180, 700) +
        `<node package="${pkg}" class="android.view.View" text="注册" clickable="true" enabled="true" bounds="[100,500][900,570]"/>`,
    );
  const initial = readRegistrationPage(content(), pkg),
    form = registrationForm(initial, pkg);
  assert.ok(form);
  assert.notEqual(form.password.value, form.confirm.value);
  assert.equal(
    initial.controls.find((e) => e.text === '注册新账号').clickable,
    false,
    'whole WebView touch handling cannot turn its heading into a button',
  );
  assert.ok(
    registrationBindingsValid(
      readRegistrationPage(content('chenming', 'Example987', 'Example987'), pkg),
      form,
    ),
  );
  assert.ok(
    !registrationBindingsValid(
      readRegistrationPage(content().replace('[180,380]', '[181,380]'), pkg),
      form,
    ),
  );
});
test('offscreen entries and misleading resource IDs never become navigation clicks', () => {
  const tree = page(
    node('', 80, `clickable="true" resource-id="${pkg}:id/tab_mine"`) +
      node('注册', 2500, 'clickable="true"') +
      node('充值', 200, `clickable="true" resource-id="${pkg}:id/btn_register_recharge"`),
  );
  const entries = registrationEntries(readRegistrationPage(tree, pkg), pkg);
  assert.deepEqual(
    entries.map((e) => e.role),
    ['ACCOUNT'],
  );
  for (const s of ['点击登录', '未登录', '注册新账号'])
    assert.equal(
      registrationEntries(readRegistrationPage(page(node(s, 100, 'clickable="true"')), pkg), pkg)
        .length,
      1,
    );
});
test('automatic identity is an observation, and screenshot identifiers are masked', () => {
  const source = page(node('个人中心', 20) + node('游客', 80) + node('用户ID：12345678', 160));
  const native = readRegistrationPage(source, pkg),
    identity = automaticIdentity(native);
  assert.equal(identity.kind, 'GUEST');
  assert.equal(identity.value, '12345678');
  for (const placeholder of ['null', 'unknown', '0000', '----'])
    assert.equal(
      automaticIdentity(readRegistrationPage(source.replace('12345678', placeholder), pkg)),
      undefined,
    );
  assert.equal(
    automaticIdentity(
      readRegistrationPage(page(node('欢迎', 20) + node('设备ID：12345678', 160)), pkg),
    ),
    undefined,
  );
  assert.equal(
    automaticIdentity(
      readRegistrationPage(
        source.replace('</hierarchy>', node('UID：87654321', 300) + '</hierarchy>'),
        pkg,
      ),
    ),
    undefined,
  );
  const image = new PNG({ width: 1080, height: 1920 });
  image.data.fill(255);
  const safe = PNG.sync.read(
    redactScreenshot(
      PNG.sync.write(image),
      source,
      { username: 'exampleuser', password: 'OwnedPass123' },
      [],
      pkg,
    ),
  );
  assert.equal(safe.data[(170 * 1080 + 20) * 4], 0);
  assert.equal(safe.data[(1000 * 1080 + 800) * 4], 255);
});
test('guest profile OCR headings are not clicked as account navigation', async () => {
  const xml = page(node('个人中心', 20) + node('游客', 80) + node('UID：12345678', 160));
  const picture = new PNG({ width: 1080, height: 1920 });
  picture.data.fill(255);
  let taps = 0;
  const recognition = {
    source: 'CONTROLS',
    navigationSteps: 0,
    cache: 'MISS',
    learned: false,
    needsAdaptation: false,
  };
  await assert.rejects(
    discoverRegistration(
      {
        source: async () => xml,
        screenshot: async () => PNG.sync.write(picture),
        ocr: async () => [
          { text: '个人中心', confidence: 99, rect: { x: 10, y: 20, width: 100, height: 40 } },
        ],
        tap: async () => {
          taps++;
        },
      },
      pkg,
      {
        enabled: true,
        screenshotFallback: true,
        timeoutMs: 15000,
        successTimeoutMs: 1000,
        maxNavigationSteps: 8,
      },
      'owned-guest',
      new AbortController().signal,
      () => {},
      recognition,
    ),
    (e) => e.code === 'APP_AUTO_IDENTITY',
  );
  assert.equal(taps, 0);
  assert.equal(recognition.automaticIdentity.kind, 'GUEST');
  assert.match(recognition.automaticIdentity.identifierHash, /^[a-f0-9]{64}$/);
});
test('a directory is not inferred from a normal page or a form', () => {
  const body =
    node('热门推荐', 10) +
    node('站长精选', 60) +
    Array.from({ length: 8 }, (_, i) => node('应用' + i, 150 + i * 80, 'clickable="true"')).join(
      '',
    );
  assert.equal(appNavigationPage(readRegistrationPage(page(body), pkg)), true);
  assert.equal(
    appNavigationPage(
      readRegistrationPage(page(body + node('点击登录', 900, 'clickable="true"')), pkg),
    ),
    false,
  );
  assert.equal(
    appNavigationPage(
      readRegistrationPage(page(node('普通首页', 10) + node('更多', 60, 'clickable="true"')), pkg),
    ),
    false,
  );
});
test(
  'mobile directory skip continues to the next APK and never clicks its catalog',
  { timeout: 40000 },
  async (t) => {
    const apk = fixtureApk();
    let catalogClicks = 0;
    const tiles = Array.from(
      { length: 8 },
      (_, i) => `<a class="jgg-item" pid="${i}" href="/catalog-child">App ${i}</a>`,
    ).join('');
    const html = (body) =>
      `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>a{display:block;padding:10px}.jgg-item{display:inline-block;width:60px}</style>${body}`;
    const server = createServer((req, res) => {
      if (req.url === '/source')
        return res.end(
          html(
            '<a class="icon" pid="nav" href="/directory">Directory</a><a class="icon" pid="product" href="/product">Product</a>',
          ),
        );
      if (req.url === '/directory') return res.end(html(tiles));
      if (req.url === '/product') return res.end(html(tiles + '<a href="/owned.apk">立即下载</a>'));
      if (req.url === '/owned.apk') {
        res.writeHead(200, {
          'content-type': 'application/vnd.android.package-archive',
          'content-disposition': 'attachment; filename="owned.apk"',
        });
        return res.end(apk);
      }
      if (req.url === '/catalog-child') catalogClicks++;
      res.writeHead(404).end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => server.close(r)));
    const origin = 'http://127.0.0.1:' + server.address().port,
      config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
    config.source = { url: origin + '/source', xpath: '//a[@class="icon"]', browserUserAgent: '' };
    config.execution.mode = 'DOWNLOAD';
    config.registrationFlows = [];
    config.download.timeoutMs = 6000;
    config.download.retries = 0;
    config.download.landingRules = [{ host: '*', by: 'css', selector: 'a[href$=".apk"]' }];
    await mkdir('.tmp', { recursive: true });
    const root = await mkdtemp(resolve('.tmp/v192-download-')),
      events = [];
    await runDownload(
      config,
      randomUUID(),
      root,
      resolve('.'),
      new AbortController().signal,
      async (e) => events.push(e),
      { chromium, policy: new NetworkPolicy(new Set([origin])), dailyDownload: true },
    );
    const done = events.filter((e) => e.type === 'TASK_FINISHED');
    assert.deepEqual(
      done.map((e) => e.payload.status),
      ['SKIPPED', 'SUCCEEDED'],
    );
    assert.equal(done[0].payload.errorCode, 'NAVIGATION_SITE');
    assert.equal(events.at(-1).payload.status, 'SUCCEEDED');
    assert.equal(catalogClicks, 0);
  },
);
