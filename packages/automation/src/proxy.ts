import { createServer, request, Agent } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { isIP } from 'node:net';
import type { Socket } from 'node:net';
import { NetworkPolicy } from './network.js';
import type { ProxyCredential } from './registration-types.js';
import { RegistrationError } from './registration-types.js';
const authority = (host: string, port: number) =>
  (isIP(host) === 6 ? '[' + host + ']' : host) + ':' + port;
const cleanHeaders = (headers: Record<string, string | string[] | undefined>) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) =>
        ![
          'proxy-authorization',
          'proxy-connection',
          'connection',
          'keep-alive',
          'transfer-encoding',
          'upgrade',
        ].includes(key.toLowerCase()),
    ),
  );

export async function startProxyBridge(
  credential: ProxyCredential,
  policy = new NetworkPolicy(),
  connectTimeoutMs = 10000,
) {
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs < 100 || connectTimeoutMs > 10000)
    throw new RegistrationError('PROXY_CONNECT_FAILED');
  const upstream = await policy.endpoint('http://' + authority(credential.host, credential.port));
  const authorization =
    'Basic ' + Buffer.from(credential.username + ':' + credential.password).toString('base64');
  const sockets = new Set<Socket>();
  let closed = false;
  let failure: string | undefined;
  const failedConnect = (error: NodeJS.ErrnoException) => {
    if (['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(error.code ?? ''))
      failure ??= 'PROXY_CONNECT_FAILED';
  };
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(120000, () => socket.destroy());
    if (sockets.size > 128) socket.destroy();
  };
  const server = createServer((req, res) => {
    void (async () => {
      const target = await policy.endpoint(req.url ?? '');
      if (closed || target.url.protocol !== 'http:') throw Error();
      const url =
        'http://' +
        authority(target.address, target.port) +
        target.url.pathname +
        target.url.search;
      const remote = request(
        {
          host: upstream.address,
          port: upstream.port,
          method: req.method,
          path: url,
          headers: {
            ...cleanHeaders(req.headers),
            host: target.url.host,
            'proxy-authorization': authorization,
            connection: 'close',
          },
          agent: false,
        },
        (response) => {
          if (response.statusCode === 407) {
            failure = 'PROXY_AUTH_FAILED';
            response.resume();
            res.writeHead(502).end();
            return;
          }
          res.writeHead(response.statusCode ?? 502, cleanHeaders(response.headers));
          let bytes = 0;
          response.on('data', (b: Buffer) => {
            bytes += b.length;
            if (bytes > 67108864) response.destroy();
          });
          response.on('error', () => res.destroy());
          response.pipe(res);
        },
      );
      remote.on('socket', track);
      remote.on('error', (error: NodeJS.ErrnoException) => {
        failedConnect(error);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      remote.setTimeout(15000, () => remote.destroy());
      req.on('aborted', () => remote.destroy());
      res.on('close', () => remote.destroy());
      req.pipe(remote);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(403);
      res.end();
    });
  });
  server.on('connection', track);
  server.on('connect', (req, client, head) => {
    void (async () => {
      const target = await policy.endpoint('https://' + req.url);
      if (closed) throw Error();
      const remote = request({
        host: upstream.address,
        port: upstream.port,
        method: 'CONNECT',
        path: authority(target.address, target.port),
        headers: {
          host: authority(target.address, target.port),
          'proxy-authorization': authorization,
        },
        agent: false,
      });
      // Bound the whole CONNECT handshake, including a provider waiting for a residential peer.
      // This target timeout must not masquerade as authentication or TCP connection failure.
      const deadline = setTimeout(
        () => remote.destroy(Error('PROXY_TUNNEL_TIMEOUT')),
        connectTimeoutMs,
      );
      remote.once('close', () => clearTimeout(deadline));
      client.once('close', () => remote.destroy());
      remote.on('socket', track);
      remote.on('connect', (response, socket, upstreamHead) => {
        clearTimeout(deadline);
        if (response.statusCode !== 200) {
          if (response.statusCode === 407) failure = 'PROXY_AUTH_FAILED';
          socket.destroy();
          client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          return;
        }
        if (closed) {
          socket.destroy();
          client.destroy();
          return;
        }
        track(socket);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) socket.write(head);
        if (upstreamHead.length) client.write(upstreamHead);
        let bytes = 0;
        socket.on('data', (b: Buffer) => {
          bytes += b.length;
          if (bytes > 67108864) socket.destroy();
        });
        socket.on('error', () => client.destroy());
        client.on('error', () => socket.destroy());
        client.on('close', () => socket.destroy());
        socket.on('close', () => client.destroy());
        socket.pipe(client);
        client.pipe(socket);
      });
      remote.on('error', (error: NodeJS.ErrnoException) => {
        failedConnect(error);
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      });
      remote.end();
    })().catch(() => client.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
  });
  await new Promise<void>((ok, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', ok);
  });
  const port = (server.address() as { port: number }).port;
  return {
    port,
    assertHealthy() {
      if (failure) throw new RegistrationError(failure);
    },
    url: 'http://127.0.0.1:' + port,
    async close() {
      closed = true;
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
export async function proxyObservation(port: number, signal: AbortSignal, url?: string) {
  return probeProxyEndpoints(
    port,
    signal,
    url
      ? [{ url, format: 'JSON' }]
      : [
          { url: 'https://api.ipify.org?format=json', format: 'JSON' },
          { url: 'https://www.cloudflare.com/cdn-cgi/trace', format: 'TRACE' },
        ],
  );
}

// Endpoint overrides are for owned boundary tests; execution configuration cannot supply them.
export async function probeProxyEndpoints(
  port: number,
  signal: AbortSignal,
  endpoints: readonly { url: string; format: 'JSON' | 'TRACE' }[],
) {
  for (const endpoint of endpoints) {
    if (signal.aborted) throw new RegistrationError('CANCELLED');
    try {
      return await observeProxyEndpoint(port, signal, endpoint.url, endpoint.format);
    } catch {
      if (signal.aborted) throw new RegistrationError('CANCELLED');
    }
  }
  throw new RegistrationError('PROXY_CHECK_FAILED');
}

async function observeProxyEndpoint(
  port: number,
  signal: AbortSignal,
  url: string,
  format: 'JSON' | 'TRACE',
) {
  const u = new URL(url),
    abort = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
  let agent: Agent | undefined, socket: Socket | undefined;
  try {
    if (u.protocol === 'https:') {
      socket = await new Promise<Socket>((ok, no) => {
        const req = request({
          host: '127.0.0.1',
          port,
          method: 'CONNECT',
          path: authority(u.hostname.replace(/^\[|\]$/g, ''), Number(u.port || 443)),
          signal: abort,
          agent: false,
        });
        req.on('connect', (res, s) => {
          if (res.statusCode === 200) ok(s);
          else {
            s.destroy();
            no(Error());
          }
        });
        req.on('error', no);
        req.end();
      });
      const secure = tlsConnect({
        socket,
        servername: u.hostname,
        rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1'],
      });
      socket = secure;
      await new Promise<void>((ok, no) => {
        const cancel = () => secure.destroy(Error('PROBE_ABORTED'));
        abort.addEventListener('abort', cancel, { once: true });
        secure.once('secureConnect', () => {
          abort.removeEventListener('abort', cancel);
          ok();
        });
        secure.once('error', (error) => {
          abort.removeEventListener('abort', cancel);
          no(error);
        });
        secure.once('close', () => {
          abort.removeEventListener('abort', cancel);
          no(Error('PROBE_CLOSED'));
        });
        if (abort.aborted) cancel();
      });
      agent = new Agent({ keepAlive: false });
      agent.createConnection = () => secure;
    } else if (u.protocol !== 'http:') throw Error();
    const text = await new Promise<string>((ok, no) => {
      const req = request(
        u.protocol === 'https:'
          ? {
              host: u.hostname,
              port: Number(u.port || 443),
              path: u.pathname + u.search,
              agent,
              signal: abort,
              headers: { host: u.host, connection: 'close' },
            }
          : {
              host: '127.0.0.1',
              port,
              path: u.href,
              agent: false,
              signal: abort,
              headers: { host: u.host, connection: 'close' },
            },
        (res) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          res.on('data', (b: Buffer) => {
            bytes += b.length;
            if (bytes > 4096) res.destroy();
            else chunks.push(b);
          });
          res.on('error', no);
          res.on('end', () =>
            res.statusCode === 200 ? ok(Buffer.concat(chunks).toString()) : no(Error()),
          );
        },
      );
      req.on('error', no);
      req.end();
    });
    const lines =
      format === 'TRACE' ? text.split(/\r?\n/).filter((line) => line.startsWith('ip=')) : [];
    const ip =
      format === 'JSON'
        ? (JSON.parse(text) as { ip?: unknown }).ip
        : lines.length === 1
          ? lines[0].slice(3)
          : undefined;
    if (typeof ip !== 'string' || !isIP(ip)) throw Error();
    return { ip, at: new Date().toISOString() };
  } catch {
    throw new RegistrationError(signal.aborted ? 'CANCELLED' : 'PROXY_CHECK_FAILED');
  } finally {
    agent?.destroy();
    socket?.destroy();
  }
}
