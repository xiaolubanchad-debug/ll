import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { createApp } from '../apps/control-api/dist/app.js';
import { initializeAdmin } from '../apps/control-api/dist/admin.js';
import { AuthController, ConsoleController } from '../apps/control-api/dist/controllers.js';
import {
  NodesController,
  DeploymentController,
  AgentController,
} from '../apps/control-api/dist/p1-controllers.js';
import { settings } from '../apps/control-api/dist/settings.js';
import { configurationIssues } from '@apk/contracts';
import { P2Controller, P2AgentController } from '../apps/control-api/dist/p2-controllers.js';
import { P3Controller, P3AgentController } from '../apps/control-api/dist/p3-controllers.js';

const db = new PrismaClient();
const origin = process.env.APP_ORIGIN;
const password = process.env.P0_TEST_PASSWORD;
let app, base, cookie, csrf;
async function call(
  path,
  { method = 'GET', body, token = cookie, csrfToken = csrf, requestOrigin = origin } = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { cookie: token } : {}),
      ...(method !== 'GET'
        ? {
            'content-type': 'application/json',
            origin: requestOrigin,
            ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
          }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = response.status === 204 ? null : await response.json();
  return {
    status: response.status,
    data,
    cookie: response.headers.get('set-cookie'),
    headers: response.headers,
  };
}
async function login(p = password) {
  const r = await call('/auth/login', {
    method: 'POST',
    body: { username: 'p0admin', password: p },
    token: null,
  });
  assert.equal(r.status, 200);
  cookie = r.cookie.split(';')[0];
  csrf = r.data.csrfToken;
  return r;
}

test('P0 real PostgreSQL acceptance', async (t) => {
  app = await createApp();
  await app.listen(0, '127.0.0.1');
  base = (await app.getUrl()) + '/api/v1';
  try {
    await t.test(
      'empty database has no default account; initialization is single-use',
      async () => {
        assert.equal(await db.admin.count(), 0);
        assert.equal(
          (
            await call('/auth/login', {
              method: 'POST',
              body: { username: 'admin', password: 'admin' },
              token: null,
            })
          ).status,
          401,
        );
        const exec = promisify(execFile);
        const cliEnv = { ...process.env, ADMIN_USERNAME: 'p0admin', ADMIN_PASSWORD: password };
        await exec(process.execPath, ['apps/control-api/dist/admin-cli.js'], { env: cliEnv });
        await assert.rejects(
          exec(process.execPath, ['apps/control-api/dist/admin-cli.js'], { env: cliEnv }),
        );
        await db.admin.deleteMany();
        const results = await Promise.allSettled([
          initializeAdmin(db, 'p0admin', password),
          initializeAdmin(db, 'otheradmin', 'DifferentPassword123'),
        ]);
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        // Ensure the intended test identity regardless of which initialization wins.
        const admin = await db.admin.findFirst();
        await db.admin.update({ where: { id: admin.id }, data: { username: 'p0admin' } });
        const { passwordHash } = await import('../apps/control-api/dist/auth.js');
        await db.admin.update({
          where: { id: admin.id },
          data: { passwordHash: await passwordHash(password) },
        });
        assert.equal(await db.admin.count(), 1);
        assert.match((await db.admin.findFirst()).passwordHash, /^\$argon2id\$/);
        await assert.rejects(initializeAdmin(db, 'replacement', 'Replacement123456'));
        await assert.rejects(
          db.admin.create({
            data: { username: 'bypass', singleton: 2, passwordHash: 'not-a-password-hash' },
          }),
        );
      },
    );
    await t.test(
      'unauthenticated readers cannot read server, task, configuration or audit data',
      async () => {
        for (const path of ['/nodes', '/runs', '/audit-events', '/openapi.json'])
          assert.equal((await call(path, { token: null })).status, 401);
        assert.equal((await call('/health/live', { token: null })).status, 200);
        assert.equal((await call('/health/ready', { token: null })).status, 200);
      },
    );
    await t.test('strict input and login origin validation do not echo secrets', async () => {
      const value = await call('/auth/login', {
        method: 'POST',
        body: { username: 'p0admin', password, unexpected: 'sensitive-value' },
        token: null,
      });
      assert.equal(value.status, 422);
      assert.ok(!JSON.stringify(value.data).includes(password));
      assert.ok(!JSON.stringify(value.data).includes('sensitive-value'));
      assert.equal(
        (
          await call('/auth/login', {
            method: 'POST',
            requestOrigin: 'https://foreign.example',
            body: { username: 'p0admin', password },
          })
        ).status,
        403,
      );
      const unknown = await call('/auth/login', {
        method: 'POST',
        body: { username: 'unknown', password: 'wrong' },
        token: null,
      });
      const wrong = await call('/auth/login', {
        method: 'POST',
        body: { username: 'p0admin', password: 'wrong' },
        token: null,
      });
      assert.equal(unknown.status, 401);
      assert.equal(unknown.data.error.message, wrong.data.error.message);
    });
    await t.test('sessions use httpOnly sameSite cookies and store only token hashes', async () => {
      const r = await login();
      assert.match(r.cookie, /HttpOnly/i);
      assert.match(r.cookie, /SameSite=Strict/i);
      const stored = await db.session.findFirst();
      assert.notEqual(stored.tokenHash, cookie.split('=')[1]);
      assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);
      const me = await call('/auth/me');
      assert.equal(me.data.admin.username, 'p0admin');
      assert.equal(me.data.csrfToken, csrf);
      assert.ok(!JSON.stringify(me.data).includes('passwordHash'));
      assert.equal(r.headers.get('cache-control'), 'no-store');
      const expired = await login();
      await db.session.updateMany({ where: { revokedAt: null }, data: { expiresAt: new Date(0) } });
      assert.equal((await call('/auth/me')).status, 401);
      assert.ok(expired.cookie);
      await login();
    });
    await t.test('CSRF rejects missing or wrong tokens and foreign origins', async () => {
      for (const token of ['', 'a'.repeat(64), 'é'.repeat(64)])
        assert.equal(
          (await call('/auth/logout', { method: 'POST', body: {}, csrfToken: token })).status,
          403,
        );
      assert.equal(
        (
          await call('/auth/logout', {
            method: 'POST',
            body: {},
            requestOrigin: 'https://foreign.example',
          })
        ).status,
        403,
      );
      assert.equal((await call('/nodes')).status, 200);
      assert.equal((await call('/runs')).status, 200);
    });
    await t.test(
      'malformed JSON and oversized input use safe errors; pagination is strict',
      async () => {
        const malformed = await fetch(base + '/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: '{',
        });
        assert.equal(malformed.status, 400);
        assert.equal((await malformed.json()).error.code, 'BAD_REQUEST');
        const large = await fetch(base + '/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify({ password: 'x'.repeat(300000) }),
        });
        assert.equal(large.status, 413);
        assert.equal((await call('/audit-events?limit=0')).status, 422);
        assert.equal((await call('/audit-events?cursor=' + '-'.repeat(36))).status, 422);
        assert.equal((await call('/audit-events?limit=1')).data.items.length, 1);
      },
    );
    await t.test(
      'shared config checks agree with authenticated backend and reject malicious extensions',
      async () => {
        const example = JSON.parse(fs.readFileSync('contracts/fixtures/config.valid.json', 'utf8'));
        assert.deepEqual(configurationIssues(example), []);
        assert.equal(
          (await call('/configs/validate', { method: 'POST', body: example })).status,
          200,
        );
        example.execution.proxyPassword = 'never-log-this';
        assert.ok(configurationIssues(example).length);
        const r = await call('/configs/validate', { method: 'POST', body: example });
        assert.equal(r.status, 422);
        assert.ok(!JSON.stringify(r.data).includes('never-log-this'));
      },
    );
    await t.test('password change revokes old sessions and rotates current token', async () => {
      const first = await login(),
        firstCookie = first.cookie.split(';')[0];
      await login();
      const old = cookie;
      const newPassword = 'ChangedTestPassword123';
      const wrong = await call('/auth/password', {
        method: 'PUT',
        body: { currentPassword: 'wrong', newPassword },
      });
      assert.equal(wrong.status, 401);
      const changed = await call('/auth/password', {
        method: 'PUT',
        body: { currentPassword: password, newPassword },
      });
      assert.equal(changed.status, 200);
      cookie = changed.cookie.split(';')[0];
      csrf = changed.data.csrfToken;
      assert.notEqual(cookie, old);
      for (const token of [firstCookie, old])
        assert.equal((await call('/auth/me', { token })).status, 401);
      assert.equal((await call('/auth/me')).status, 200);
      assert.equal(
        (
          await call('/auth/login', {
            method: 'POST',
            body: { username: 'p0admin', password },
            token: null,
          })
        ).status,
        401,
      );
      await login(newPassword);
    });
    await t.test(
      'logout revokes server session; audit contains no credentials or tokens',
      async () => {
        const old = cookie;
        assert.equal((await call('/auth/logout', { method: 'POST', body: {} })).status, 204);
        assert.equal((await call('/auth/me', { token: old })).status, 401);
        const text = JSON.stringify(await db.auditEvent.findMany());
        assert.ok(!text.includes(password));
        assert.ok(!text.includes(old));
        assert.ok(!text.includes('ChangedTestPassword123'));
        assert.ok(text.includes('PASSWORD_CHANGED'));
      },
    );
    await t.test('database rate limit persists across API restarts', async () => {
      await db.loginBucket.deleteMany();
      process.env.LOGIN_MAX_ATTEMPTS = '2';
      for (let i = 0; i < 2; i++)
        assert.equal(
          (
            await call('/auth/login', {
              method: 'POST',
              body: { username: 'rateuser', password: 'wrong' },
              token: null,
            })
          ).status,
          401,
        );
      await app.close();
      app = await createApp();
      await app.listen(0, '127.0.0.1');
      base = (await app.getUrl()) + '/api/v1';
      assert.equal(
        (
          await call('/auth/login', {
            method: 'POST',
            body: { username: 'rateuser', password: 'wrong' },
            token: null,
          })
        ).status,
        429,
      );
      delete process.env.LOGIN_MAX_ATTEMPTS;
      await db.loginBucket.deleteMany();
    });
    await t.test('production settings require https and secure cookies', async () => {
      assert.throws(() =>
        settings({ ...process.env, NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
      );
      assert.throws(() => settings({ ...process.env, SESSION_CSRF_KEY: 'short' }));
      assert.equal(
        settings({
          ...process.env,
          NODE_ENV: 'production',
          APP_ORIGIN: 'https://console.example.test',
          COOKIE_SECURE: 'true',
        }).secureCookie,
        true,
      );
    });
    await t.test('route implementation, manifest and generated OpenAPI agree', async () => {
      const manifest = JSON.parse(fs.readFileSync('contracts/p0.http.json', 'utf8'));
      manifest.routes.push(...JSON.parse(fs.readFileSync('contracts/p1.http.json', 'utf8')).routes);
      manifest.routes.push(...JSON.parse(fs.readFileSync('contracts/p2.http.json', 'utf8')).routes);
      manifest.routes.push(...JSON.parse(fs.readFileSync('contracts/p3.http.json', 'utf8')).routes);
      const actual = [];
      for (const C of [
        AuthController,
        ConsoleController,
        NodesController,
        DeploymentController,
        AgentController,
        P2Controller,
        P2AgentController,
        P3Controller,
        P3AgentController,
      ])
        for (const key of Object.getOwnPropertyNames(C.prototype)) {
          const handler = C.prototype[key];
          if (typeof handler !== 'function' || !Reflect.hasMetadata(METHOD_METADATA, handler))
            continue;
          actual.push(
            RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)].toLowerCase() +
              ' /' +
              [Reflect.getMetadata(PATH_METADATA, C), Reflect.getMetadata(PATH_METADATA, handler)]
                .filter((p) => p && p !== '/')
                .join('/'),
          );
        }
      for (let i = 0; i < actual.length; i++)
        actual[i] = actual[i].replace(/:([a-zA-Z]+)/g, '{$1}');
      assert.deepEqual(actual.sort(), manifest.routes.map((r) => r.method + ' ' + r.path).sort());
      const spec = JSON.parse(fs.readFileSync('contracts/openapi.json', 'utf8'));
      assert.deepEqual(
        Object.entries(spec.paths)
          .flatMap(([p, m]) =>
            Object.keys(m).map((method) => method + ' ' + p.replace('/api/v1', '')),
          )
          .sort(),
        actual.sort(),
      );
    });
  } finally {
    await app?.close();
    await db.$disconnect();
  }
});
