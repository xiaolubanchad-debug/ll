import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const command = (name) =>
  process.env.JAVA_HOME
    ? join(process.env.JAVA_HOME, 'bin', name + (process.platform === 'win32' ? '.exe' : ''))
    : name;
const available = spawnSync(command('javac'), ['-version'], { windowsHide: true }).status === 0;

test(
  'owned Java sender bounds requests and preserves one installation across real network faults',
  {
    skip:
      !available && process.platform === 'win32'
        ? 'JDK unavailable locally; required on Linux CI'
        : false,
  },
  async (t) => {
    assert.equal(available, true, 'Linux native-client checks require a JDK');
    await mkdir(resolve('.tmp'), { recursive: true });
    const classes = await mkdtemp(resolve('.tmp/owned-java-'));
    const build = spawnSync(
      command('javac'),
      [
        '--release',
        '8',
        '-d',
        classes,
        'apps/test-client/EnrollmentSender.java',
        'tests/owned-client/EnrollmentHarness.java',
      ],
      { windowsHide: true, encoding: 'utf8' },
    );
    assert.equal(build.status, 0, build.stderr);

    async function fixture(handler, mode = 'normal') {
      const sockets = new Set(),
        intervals = new Set(),
        bodies = [],
        auth = [],
        uas = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const bytes of req) body += bytes;
        bodies.push(body);
        auth.push(req.headers.authorization);
        uas.push(req.headers['user-agent']);
        handler(req, res, bodies.length, intervals, body);
      });
      server.on('connection', (s) => {
        sockets.add(s);
        s.on('error', () => {});
        s.once('close', () => sockets.delete(s));
      });
      await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
      const began = performance.now();
      try {
        const result = await new Promise((ok, no) => {
          const child = spawn(
            command('java'),
            [
              '-cp',
              classes,
              'com.apkplatform.testclient.EnrollmentHarness',
              'http://127.0.0.1:' + server.address().port + '/enroll',
              mode,
            ],
            { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
          );
          let stdout = '',
            stderr = '';
          const deadline = setTimeout(() => {
            child.kill();
            no(Error('NATIVE_REQUEST_DID_NOT_TERMINATE'));
          }, 5000);
          child.stdout.on('data', (b) => (stdout += b));
          child.stderr.on('data', (b) => (stderr += b));
          child.once('error', no);
          child.once('close', (code) => {
            clearTimeout(deadline);
            if (code === 0) ok(JSON.parse(stdout));
            else no(Error('NATIVE_PROCESS_FAILED: ' + stderr));
          });
        });
        assert.ok(
          performance.now() - began < 4000,
          'native process must finish without lingering threads',
        );
        assert.ok(result.elapsedMs < 1600, 'total deadline must cover connect, headers and body');
        assert.ok(bodies.length <= 4);
        assert.ok(auth.every((v) => v === 'Bearer owned-fixture-token'));
        assert.ok(uas.every((v) => v === 'OwnedFixture/1.0'));
        assert.ok(
          new Set(bodies).size <= 1,
          'each retry must send exactly the same persisted body',
        );
        return { ...result, calls: bodies.length };
      } finally {
        for (const timer of intervals) clearInterval(timer);
        for (const s of sockets) s.destroy();
        await new Promise((ok) => server.close(ok));
      }
    }
    try {
      await t.test(
        'lost creation reply retries the same request and creates only one account',
        async () => {
          const created = new Set();
          const r = await fixture((_req, res, count, _timers, body) => {
            created.add(JSON.parse(body).requestKey);
            if (count > 1) res.end('CONFIRMED');
          });
          assert.equal(r.confirmed, true);
          assert.equal(r.successFlags, 1);
          assert.equal(r.calls, 2);
          assert.equal(created.size, 1);
        },
      );
      await t.test(
        'a dripping 200 body cannot renew the overall deadline or report success',
        async () => {
          const r = await fixture((_req, res, _count, timers) => {
            res.writeHead(200);
            res.write('C');
            const timer = setInterval(() => res.write('x'), 30);
            timers.add(timer);
            res.once('close', () => {
              clearInterval(timer);
              timers.delete(timer);
            });
          });
          assert.equal(r.confirmed, false);
          assert.equal(r.successFlags, 0);
          assert.equal(r.acceptedCallbacks, 0);
          assert.equal(r.lastStatus, 'NETWORK_TIMEOUT');
          assert.ok(r.calls >= 2);
        },
      );
      await t.test('all unresponsive attempts stop within the one overall budget', async () => {
        const r = await fixture(() => {});
        assert.equal(r.confirmed, false);
        assert.equal(r.successFlags, 0);
        assert.ok(r.calls >= 2);
        assert.equal(r.lastStatus, 'NETWORK_TIMEOUT');
      });
      await t.test('explicit refusal does not retry a rejected request', async () => {
        const r = await fixture((_req, res) => res.writeHead(403).end());
        assert.equal(r.calls, 1);
        assert.equal(r.successFlags, 0);
        assert.equal(r.lastStatus, 'HTTP_403');
      });
      await t.test('redirect is never followed', async () => {
        const r = await fixture((_req, res) =>
          res.writeHead(302, { location: '/unexpected' }).end(),
        );
        assert.equal(r.calls, 1);
        assert.equal(r.successFlags, 0);
        assert.equal(r.lastStatus, 'HTTP_302');
      });
      await t.test('invalid complete 200 response never receives a success flag', async () => {
        const r = await fixture((_req, res) => res.end('TRUNCATED_OR_INVALID'));
        assert.equal(r.confirmed, false);
        assert.equal(r.successFlags, 0);
        assert.equal(r.calls, 4);
        assert.equal(r.lastStatus, 'NETWORK_ERROR');
      });
      await t.test('oversized 200 body is bounded and never accepted', async () => {
        const r = await fixture((_req, res) => res.end('x'.repeat(17000)));
        assert.equal(r.confirmed, false);
        assert.equal(r.successFlags, 0);
        assert.equal(r.acceptedCallbacks, 0);
      });
      await t.test('temporary 503 can recover using the identical request', async () => {
        const r = await fixture((_req, res, count) =>
          count === 1 ? res.writeHead(503).end() : res.end('CONFIRMED'),
        );
        assert.equal(r.calls, 2);
        assert.equal(r.confirmed, true);
        assert.equal(r.successFlags, 1);
      });
      await t.test('cancellation during a request prevents all later attempts', async () => {
        const r = await fixture(() => {}, 'cancel');
        assert.equal(r.calls, 1);
        assert.equal(r.confirmed, false);
        assert.equal(r.successFlags, 0);
      });
      await t.test('pre-cancelled work sends no request', async () => {
        const r = await fixture((_req, res) => res.end('CONFIRMED'), 'pre-cancel');
        assert.equal(r.calls, 0);
        assert.equal(r.confirmed, false);
        assert.equal(r.successFlags, 0);
      });
    } finally {
      await rm(classes, { recursive: true, force: true });
    }
  },
);
