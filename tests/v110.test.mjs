import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  configurationIssues,
  schemaIssues,
  functionalEvidenceText,
  parseFunctionalEvidence,
  contentIsolationSupported,
} from '@apk/contracts';
import { functionalEvidence } from '@apk/automation';
import { TaskEngine } from '../apps/agent/dist/tasks.js';
const pkg = 'com.example.owned';
const config = JSON.parse(await readFile('contracts/fixtures/config.valid.json', 'utf8'));
const record = (overrides = {}) => ({
  schemaVersion: '1.0',
  kind: 'FUNCTIONAL_EVIDENCE',
  stage: 'DISCOVERY',
  outcome: 'UNVERIFIED',
  verification: 'NO_SUBMISSION',
  sourceDigest: 'a'.repeat(64),
  controls: [],
  ...overrides,
});
const row = (text, y, more = '') =>
  `<node package="${pkg}" class="android.widget.TextView" text="${text}" enabled="true" clickable="false" bounds="[10,${y}][300,${y + 40}]" ${more}/>`;
test('content isolation is on for old configurations and cannot be disabled', () => {
  const old = structuredClone(config);
  delete old.execution.contentIsolation;
  assert.deepEqual(configurationIssues(old), []);
  assert.deepEqual(
    configurationIssues({ ...old, execution: { ...old.execution, contentIsolation: true } }),
    [],
  );
  for (const value of [false, 'OFF', 0, null])
    assert.ok(
      configurationIssues({ ...old, execution: { ...old.execution, contentIsolation: value } })
        .length,
    );
  assert.equal(contentIsolationSupported(['REGISTRATION_V1'], '0.8.0'), false);
  assert.equal(contentIsolationSupported(['CONTENT_ISOLATION_V1'], '0.7.2'), false);
  assert.equal(contentIsolationSupported(['CONTENT_ISOLATION_V1'], '0.8.0'), true);
});
test('functional records contain only known roles and geometry, never business text or pixels', () => {
  const source = `<hierarchy><node package="${pkg}" class="android.widget.FrameLayout" bounds="[0,0][1080,1920]">${row('OWNED_BUSINESS_CONTENT_MUST_NOT_EXPORT', 20)}${row('个人中心', 70)}${row('UID：12345678', 120)}<node package="${pkg}" class="android.widget.Button" text="注册新账号" enabled="true" clickable="true" bounds="[10,200][300,260]"/></node></hierarchy>`;
  const bytes = functionalEvidence(source, pkg),
    view = parseFunctionalEvidence(bytes.toString());
  assert.ok(view.controls.some((c) => c.role === 'REGISTER'));
  for (const forbidden of [
    'OWNED_BUSINESS',
    '12345678',
    pkg,
    '个人中心',
    '注册新账号',
    '<hierarchy',
    'data:image',
    'iVBOR',
  ])
    assert.ok(!bytes.toString().includes(forbidden));
  assert.equal(view.stage, 'DISCOVERY');
  assert.equal(view.outcome, 'UNVERIFIED');
  assert.equal(
    functionalEvidence(source, pkg, { outcome: 'SUCCEEDED', automatic: true })
      .toString()
      .includes('AUTO_EXPLICIT_UI'),
    true,
  );
});
test('content cannot be hidden in JSON fields, duplicate keys or malformed records', () => {
  const text = functionalEvidenceText(record());
  assert.ok(parseFunctionalEvidence(text));
  for (const value of [
    text.replace('"kind":', '"body":"OWNED_PRIVATE_BODY","kind":'),
    text.replace('"kind":', '"kind":"OWNED_PRIVATE_BODY","kind":'),
    ' ' + text,
    text + '\n',
    '<svg>content</svg>',
    'iVBORw0KGgo=',
    JSON.stringify({
      ...record(),
      controls: [{ role: 'BODY', rect: { x: 0, y: 0, width: 1, height: 1 } }],
    }),
  ])
    assert.equal(parseFunctionalEvidence(value), undefined);
  assert.throws(
    () =>
      functionalEvidenceText(
        record({ controls: [{ role: 'LOGIN', rect: { x: 16384, y: 0, width: 2, height: 2 } }] }),
      ),
    /CONTENT_ISOLATION_REQUIRED/,
  );
  for (const bad of [
    record({ outcome: 'SUCCEEDED' }),
    record({ stage: 'RESULT' }),
    { ...record(), image: 'data:image/png;base64,abc' },
  ])
    assert.ok(schemaIssues('FunctionalEvidence', bad).length);
});
test('SQLite rejects raw content before saving and restart refuses legacy picture uploads', async () => {
  await mkdir('.tmp', { recursive: true });
  const root = await mkdtemp(resolve('.tmp/v110-store-')),
    calls = [];
  const hub = async (path, body) => {
    calls.push({ path, body });
    return path === 'artifacts' ? { artifactId: body.artifactId } : {};
  };
  let engine = await TaskEngine.open(root, randomUUID(), randomUUID(), resolve('.'), hub);
  const d = { deliveryId: randomUUID() },
    task = randomUUID();
  try {
    for (const bytes of [Buffer.from('iVBORw0KGgo='), Buffer.from('{"body":"OWNED_RAW"}')])
      assert.throws(
        () => engine.store.evidence(d, task, bytes),
        (e) => e.code === 'CONTENT_ISOLATION_REQUIRED',
      );
    assert.equal(engine.store.pendingEvidence(d.deliveryId).length, 0);
    const good = functionalEvidenceText(record()),
      id = engine.store.evidence(d, task, Buffer.from(good));
    await engine.flush(d);
    assert.ok(
      calls.some(
        (c) =>
          c.path === 'artifacts' &&
          c.body.artifactId === id &&
          c.body.kind === 'functional-evidence',
      ),
    );
    assert.equal(engine.store.pendingEvidence(d.deliveryId).length, 0);
    engine.store.db
      .prepare('INSERT INTO evidence(id,delivery,task,sha,data) VALUES(?,?,?,?,?)')
      .run(
        randomUUID(),
        d.deliveryId,
        task,
        'b'.repeat(64),
        Buffer.from('LEGACY_RAW_PIXELS').toString('base64'),
      );
    await engine.close();
    engine = await TaskEngine.open(root, randomUUID(), randomUUID(), resolve('.'), hub);
    assert.ok(
      parseFunctionalEvidence(
        Buffer.from(
          engine.store.db.prepare('SELECT data FROM evidence WHERE id=?').get(id).data,
          'base64',
        ).toString(),
      ),
    );
    const before = calls.length;
    await assert.rejects(engine.flush(d), (e) => e.code === 'CONTENT_ISOLATION_REQUIRED');
    assert.equal(calls.length, before);
    assert.equal(engine.store.db.prepare('SELECT count(*) AS n FROM evidence').get().n, 2);
  } finally {
    await engine.close();
  }
});
