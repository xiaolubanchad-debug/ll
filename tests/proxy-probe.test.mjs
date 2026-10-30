import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import {
  probeProxyEndpoints,
  proxyObservation,
  startProxyBridge,
  NetworkPolicy,
} from '@apk/automation';

async function fixture(work) {
  const sockets = new Set();
  const server = createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    await work(server, server.address().port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((ok) => server.close(ok));
  }
}
const signal = () => new AbortController().signal;
const endpoints = [
  { url: 'https://primary.example.test/ip', format: 'JSON' },
  { url: 'http://owned.example.test/trace', format: 'TRACE' },
];

test('owned-client CONNECT deadline closes a slow tunnel without poisoning later proxy requests', async () => {
  await fixture(async (server, port) => {
    let calls = 0,
      firstClosed;
    const firstClose = new Promise((resolve) => {
      firstClosed = resolve;
    });
    server.on('connect', (_req, socket) => {
      calls++;
      if (calls === 1) {
        socket.resume();
        socket.once('end', () => socket.end());
        socket.once('close', firstClosed);
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.on('data', (bytes) => socket.write(bytes));
    });
    const bridge = await startProxyBridge(
      { host: '127.0.0.1', port, username: 'owned', password: 'fixture' },
      new NetworkPolicy(new Set(['http://127.0.0.1:' + port])),
      100,
    );
    const tunnel = () =>
      new Promise((ok, no) => {
        const req = request({
          host: '127.0.0.1',
          port: bridge.port,
          method: 'CONNECT',
          path: '93.184.216.34:443',
          agent: false,
        });
        req.once('connect', (res, socket) => ok({ status: res.statusCode, socket }));
        req.once('error', no);
        req.end();
      });
    let socket;
    try {
      const slow = await tunnel();
      assert.equal(slow.status, 502);
      slow.socket.destroy();
      await firstClose;
      bridge.assertHealthy();
      const fast = await tunnel();
      socket = fast.socket;
      assert.equal(fast.status, 200);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const echoed = new Promise((resolve, reject) => {
        socket.once('data', resolve);
        socket.once('error', reject);
      });
      socket.write('owned-fixture');
      assert.equal((await echoed).toString(), 'owned-fixture');
      assert.equal(calls, 2);
      bridge.assertHealthy();
    } finally {
      socket?.destroy();
      await bridge.close();
    }
  });
});

test('proxy bridge makes no probe request and retains real upstream authentication failures', async () => {
  await fixture(async (server, port) => {
    let requests = 0;
    server.on('request', (_req, res) => {
      requests++;
      res.writeHead(407).end();
    });
    const bridge = await startProxyBridge(
      { host: '127.0.0.1', port, username: 'owned', password: 'fixture' },
      new NetworkPolicy(new Set(['http://127.0.0.1:' + port])),
    );
    try {
      assert.equal(requests, 0);
      bridge.assertHealthy();
      const status = await new Promise((ok, no) => {
        const req = request(
          { host: '127.0.0.1', port: bridge.port, path: 'http://93.184.216.34/owned-test' },
          (res) => {
            res.resume();
            res.once('end', () => ok(res.statusCode));
          },
        );
        req.on('error', no);
        req.end();
      });
      assert.equal(status, 502);
      assert.equal(requests, 1);
      assert.throws(
        () => bridge.assertHealthy(),
        (e) => e.code === 'PROXY_AUTH_FAILED',
      );
    } finally {
      await bridge.close();
    }
  });
});

test('proxy probe accepts a valid fallback after a TLS reset, without a direct connection', async () => {
  await fixture(async (server, port) => {
    let tunnels = 0,
      fallback = 0;
    server.on('connect', (req, client) => {
      assert.equal(req.url, 'primary.example.test:443');
      tunnels++;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      client.once('data', () => client.destroy());
    });
    server.on('request', (req, res) => {
      fallback++;
      assert.equal(req.url, 'http://owned.example.test/trace');
      res.end('fl=owned\nip=93.184.216.34\ntls=TLSv1.3\n');
    });
    const observed = await probeProxyEndpoints(port, signal(), endpoints);
    assert.equal(observed.ip, '93.184.216.34');
    assert.ok(Number.isFinite(Date.parse(observed.at)));
    assert.equal(tunnels, 1);
    assert.equal(fallback, 1);
  });
});

test('proxy probe stops after success and explicit owned URL does not fall back', async () => {
  await fixture(async (server, port) => {
    const requests = [];
    server.on('request', (req, res) => {
      requests.push(req.url);
      res.end(JSON.stringify({ ip: '2001:4860:4860::8888' }));
    });
    const candidates = [
      { url: 'http://owned.example.test/ip', format: 'JSON' },
      { url: 'http://unused.example.test/trace', format: 'TRACE' },
    ];
    assert.equal(
      (await probeProxyEndpoints(port, signal(), candidates)).ip,
      '2001:4860:4860::8888',
    );
    assert.deepEqual(requests, ['http://owned.example.test/ip']);
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      requests.push(req.url);
      res.writeHead(503).end();
    });
    await assert.rejects(
      proxyObservation(port, signal(), 'http://owned.example.test/ip'),
      /PROXY_CHECK_FAILED/,
    );
    assert.equal(requests.length, 2);
  });
});

test('proxy probe rejects redirects, invalid or ambiguous IPs and oversized responses', async () => {
  for (const body of ['ip=invalid\n', 'ip=93.184.216.34\nip=1.1.1.1\n', 'x'.repeat(4097)]) {
    await fixture(async (server, port) => {
      let requests = 0;
      server.on('request', (req, res) => {
        requests++;
        if (req.url.includes('/primary'))
          res.writeHead(302, { location: 'http://unused.example.test/' }).end();
        else res.end(body);
      });
      await assert.rejects(
        probeProxyEndpoints(port, signal(), [
          { url: 'http://owned.example.test/primary', format: 'JSON' },
          { url: 'http://owned.example.test/trace', format: 'TRACE' },
        ]),
        /PROXY_CHECK_FAILED/,
      );
      assert.equal(requests, 2);
    });
  }
});

test('stop during TLS handshake settles promptly and never starts the fallback', async () => {
  await fixture(async (server, port) => {
    let fallback = 0;
    server.on('connect', (_req, client) =>
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'),
    );
    server.on('request', (_req, res) => {
      fallback++;
      res.end('ip=93.184.216.34\n');
    });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 100);
    try {
      await assert.rejects(
        Promise.race([
          probeProxyEndpoints(port, abort.signal, endpoints),
          new Promise((_ok, no) =>
            setTimeout(() => no(Error('HANDSHAKE_DID_NOT_SETTLE')), 1000).unref(),
          ),
        ]),
        /CANCELLED/,
      );
      assert.equal(fallback, 0);
      await assert.rejects(probeProxyEndpoints(port, abort.signal, endpoints), /CANCELLED/);
    } finally {
      clearTimeout(timer);
    }
  });
});
