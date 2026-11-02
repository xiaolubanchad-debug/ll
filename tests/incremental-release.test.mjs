import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { schemaIssues } from '@apk/contracts';
import { lockLibrary } from '../packages/platform/dist/library-lock.js';
import {
  planEnvironment,
  captureEnvironment,
  reuseEnvironment,
} from '../apps/agent/dist/environment.js';
import { planChanges } from '../scripts/release-plan.mjs';
import { validateHubConfig, moduleOverrides } from '../scripts/hub-release-config.mjs';

test('profile omission fails before activation; selected builds preserve unrelated services', () => {
  const args = {
    NODE_IMAGE: 'node@sha256:' + 'a'.repeat(64),
    NGINX_IMAGE: 'nginx@sha256:' + 'b'.repeat(64),
  };
  const config = {
    services: Object.fromEntries(
      ['api', 'worker', 'web', 'tools'].map((x) => [x, { image: 'old-' + x, build: { args } }]),
    ),
  };
  const missing = structuredClone(config);
  delete missing.services.tools;
  assert.throws(() => validateHubConfig(missing), /HUB_SERVICE_MISSING/);
  const before = { services: { api: { image: 'kept-api' }, web: { image: 'kept-web' } } };
  const result = moduleOverrides(config, ['worker'], '1'.repeat(12), '/opt/apk-hub/source', before);
  assert.deepEqual(result.services.api, before.services.api);
  assert.deepEqual(result.services.web, before.services.web);
  assert.equal(result.services.worker.build.target, 'worker');
  assert.equal(before.services.worker, undefined);
  assert.throws(
    () => moduleOverrides(config, ['postgres'], '1'.repeat(12), 'unused'),
    /HUB_MODULE_INVALID/,
  );
  const unpinned = structuredClone(config);
  unpinned.services.api.build.args.NODE_IMAGE = 'node:latest';
  assert.throws(() => validateHubConfig(unpinned), /PINNED_BASE_REQUIRED/);
});

test('module dependency expansion and conservative fallback', () => {
  assert.deepEqual(planChanges(['apps/web/src/App.vue']).modules, ['web']);
  assert.deepEqual(planChanges(['apps/agent/src/tasks.ts']).modules, ['agent', 'tools']);
  assert.deepEqual(planChanges(['packages/platform/src/jobs.ts']).modules, [
    'api',
    'tools',
    'worker',
  ]);
  assert.equal(planChanges(['apps/control-api/prisma/migrations/x/migration.sql']).migrate, true);
  assert.deepEqual(planChanges(['docs/example.md', 'README.md']).modules, []);
  assert.deepEqual(planChanges(['unmapped-runtime-file']).tests, ['ALL']);
});
test('new deploy and environment contract rejects unsafe mode, unknown fields and invalid fingerprint', () => {
  const input = { nodeId: randomUUID(), releaseId: randomUUID(), licenseAccepted: true };
  assert.deepEqual(schemaIssues('DeploymentInput', input), []);
  assert.deepEqual(schemaIssues('DeploymentInput', { ...input, mode: 'FULL' }), []);
  assert.ok(schemaIssues('DeploymentInput', { ...input, mode: 'SKIP_SIGNATURE' }).length);
  assert.ok(
    schemaIssues('EnvironmentSpec', {
      version: 1,
      recipeSha256: 'a'.repeat(64),
      fingerprint: 'bad',
    }).length,
  );
});
test('full provenance is required, reused unchanged and drift forces full', async () => {
  const dir = await mkdtemp(resolve('.tmp/apk-environment-'));
  try {
    const paths = {
      state: dir,
      machineId: join(dir, 'machine-id'),
      osRelease: join(dir, 'os-release'),
      roots: [join(dir, 'sdk')],
      controls: [join(dir, 'registry')],
      requireRoot: false,
    };
    await mkdir(paths.roots[0]);
    await writeFile(paths.machineId, 'host-one');
    await writeFile(paths.osRelease, 'ubuntu:26.04');
    await writeFile(paths.controls[0], 'driver-registry');
    await writeFile(join(paths.roots[0], 'system.img'), 'owned synthetic image');
    const input = {
      nodeId: randomUUID(),
      releaseId: randomUUID(),
      environmentFingerprint: 'a'.repeat(64),
      sdkRoot: '/unused',
      toolsRoot: '/unused',
    };
    assert.equal((await planEnvironment(input, 'AUTO', paths)).reason, 'BASELINE_MISSING');
    await writeFile(
      join(dir, 'health.json'),
      JSON.stringify({ releaseId: input.releaseId, bootSucceeded: false }),
    );
    await assert.rejects(captureEnvironment(input, paths), /ANDROID_NOT_READY/);
    await writeFile(
      join(dir, 'health.json'),
      JSON.stringify({ releaseId: input.releaseId, bootSucceeded: true }),
    );
    await captureEnvironment(input, paths);
    const receipt = JSON.parse(await readFile(join(dir, 'environment-receipt.json'), 'utf8'));
    assert.equal((await planEnvironment(input, 'AUTO', paths)).mode, 'CODE');
    assert.equal((await planEnvironment(input, 'FULL', paths)).reason, 'FORCED_FULL');
    const next = { ...input, releaseId: randomUUID() };
    await reuseEnvironment(next, paths);
    const proof = JSON.parse(await readFile(join(dir, 'health.json'), 'utf8'));
    assert.equal(proof.mode, 'CODE');
    assert.equal(proof.releaseId, next.releaseId);
    assert.equal(proof.fullReleaseId, input.releaseId);
    assert.equal(proof.fullVerifiedAt, receipt.fullVerifiedAt);
    assert.equal(proof.bootSucceeded, undefined);
    assert.equal(
      (await planEnvironment({ ...input, environmentFingerprint: 'b'.repeat(64) }, 'AUTO', paths))
        .mode,
      'FULL',
    );
    await writeFile(join(paths.roots[0], 'system.img'), 'modified synthetic image');
    assert.equal((await planEnvironment(input, 'AUTO', paths)).reason, 'ENVIRONMENT_CHANGED');
    await assert.rejects(reuseEnvironment(next, paths), /ENVIRONMENT_CHANGED/);
    await writeFile(join(dir, 'environment-receipt.json'), '{}');
    assert.equal((await planEnvironment(input, 'AUTO', paths)).reason, 'BASELINE_INVALID');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('full baseline permission check fails closed', async () => {
  if (process.platform === 'win32') return;
  const dir = await mkdtemp(resolve('.tmp/apk-permission-'));
  try {
    await writeFile(join(dir, 'environment-receipt.json'), '{}');
    await chmod(join(dir, 'environment-receipt.json'), 0o666);
    const paths = {
      state: dir,
      machineId: 'unused',
      osRelease: 'unused',
      roots: [],
      controls: [],
      requireRoot: true,
    };
    assert.equal(
      (await planEnvironment({ environmentFingerprint: 'a'.repeat(64) }, 'AUTO', paths)).reason,
      'BASELINE_INVALID',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('database release gate rejects new library mutations until host unlocks', async () => {
  if (!process.env.DATABASE_URL) return;
  const db = new PrismaClient();
  let unlock;
  const released = new Promise((r) => {
    unlock = r;
  });
  let ready;
  const acquired = new Promise((r) => {
    ready = r;
  });
  const hold = db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('apk-hub-release-v1',0))`;
      ready();
      await released;
    },
    { timeout: 15000 },
  );
  try {
    await acquired;
    await assert.rejects(
      db.$transaction((tx) => lockLibrary(tx)),
      (e) => e.code === 'HUB_UPDATING' && e.status === 503,
    );
    unlock();
    await hold;
    await db.$transaction((tx) => lockLibrary(tx));
  } finally {
    unlock();
    await hold;
    await db.$disconnect();
  }
});
