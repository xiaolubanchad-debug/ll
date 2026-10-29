import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { runDownload, NetworkPolicy } from '@apk/automation';
import { collectHealth } from '../../apps/agent/dist/health.js';
import { parseInspection } from '../../apps/deploy-worker/dist/worker.js';
import { fixtureSite } from '../p2-fixtures.mjs';
assert.equal(process.getuid(), 10001);
const os = await readFile('/etc/os-release', 'utf8');
const version = os.match(/^VERSION_ID="?([^"\s]+)/m)[1];
assert.ok(['24.04', '26.04'].includes(version));
const health = await collectHealth('/nonexistent-sdk', '/nonexistent-tools', randomUUID());
assert.equal(health.ubuntu, 'ubuntu:' + version);
assert.ok(!health.errors.includes('UNSUPPORTED_OS'));
assert.ok(health.errors.includes('NO_KVM'));
assert.equal(health.android, false);
const checked = parseInspection(
  `UBUNTU=ubuntu:${version}\nARCH=x86_64\nMEMORY=32768000\nDISK=53687091200\nKVM=0\nSUDO=1\nMARKER=0\n`,
);
assert.deepEqual(checked.errors, ['NO_KVM']);
const site = await fixtureSite();
const dir = await mkdtemp(join(resolve('.tmp'), 'ubuntu-smoke-'));
try {
  const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
  config.source = {
    url: site.url + '/source',
    xpath: "//a[@class='jgg-item']",
    browserUserAgent: 'Mozilla/5.0 (Linux; Android 13) Chrome/149.0.0.0 Mobile Safari/537.36',
  };
  config.execution.mode = 'DOWNLOAD_ONLY';
  delete config.execution.proxySecretVersionId;
  config.registrationFlows = [];
  config.download.landingRules = [{ host: '127.0.0.1', by: 'css', selector: 'a.download' }];
  config.download.retries = 0;
  config.download.timeoutMs = 10000;
  for (const cacheHit of [false, true]) {
    const events = [];
    await runDownload(
      config,
      'ubuntu-fixture-node',
      dir,
      resolve('.'),
      new AbortController().signal,
      async (e) => {
        events.push(e);
      },
      { chromium, policy: new NetworkPolicy(new Set([site.url])) },
    );
    const results = events.filter((e) => e.type === 'TASK_FINISHED');
    assert.equal(results.length, 3);
    for (const e of results) {
      assert.equal(e.payload.status, 'SUCCEEDED', JSON.stringify(e.payload));
    }
    const downloaded = events.filter(
      (e) => e.type === 'TASK_STAGE' && e.payload.stage === 'DOWNLOADED',
    );
    assert.equal(downloaded.length, 3);
    for (const e of downloaded) assert.equal(e.payload.cacheHit, cacheHit);
    assert.equal(events.find((e) => e.type === 'RUN_FINISHED').payload.status, 'SUCCEEDED');
  }
  assert.equal(site.forbiddenRequests(), 0);
  console.log(
    `PASS Ubuntu ${version}: actual packages, unprivileged Chromium direct/popup/same-page downloads, cache, and NO_KVM preserved.`,
  );
} finally {
  await site.close();
}
