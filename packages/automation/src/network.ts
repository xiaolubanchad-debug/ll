import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { DownloadError, normalizeUrl } from './common.js';
export class NetworkPolicy {
  constructor(
    private readonly testEndpoints: ReadonlySet<string> = new Set(),
    private readonly resolver = lookup,
  ) {}
  async endpoint(value: string) {
    const u = new URL(normalizeUrl(value));
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new DownloadError('NETWORK_BLOCKED');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const answers = await this.resolver(host, { all: true, verbatim: true });
    const test = this.testEndpoints.has(u.origin);
    if (
      !answers.length ||
      answers.some(
        (a) =>
          !ipaddr.isValid(a.address) || (!test && ipaddr.process(a.address).range() !== 'unicast'),
      )
    )
      throw new DownloadError('NETWORK_BLOCKED');
    return { url: u, address: answers[0].address, port };
  }
}
export async function startEgress(policy: NetworkPolicy, maxBytes: number, timeout: number) {
  const sockets = new Set<Socket>();
  let blocked = false;
  let closed = false;
  const headers = (input: Record<string, string | string[] | undefined>) =>
    Object.fromEntries(
      Object.entries(input).filter(
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
  const server = createServer((req, res) => {
    void (async () => {
      const target = await policy.endpoint(req.url ?? '');
      if (closed) throw new DownloadError('CANCELLED');
      if (target.url.protocol !== 'http:') throw new DownloadError('NETWORK_BLOCKED');
      const upstream = httpRequest(
        {
          host: target.address,
          port: target.port,
          method: req.method,
          path: target.url.pathname + target.url.search,
          headers: { ...headers(req.headers), host: target.url.host },
          timeout,
        },
        (response) => {
          if (Number(response.headers['content-length'] ?? 0) > maxBytes) {
            response.destroy();
            res.writeHead(413).end();
            return;
          }
          res.writeHead(response.statusCode ?? 502, headers(response.headers));
          let count = 0;
          response.on('data', (b: Buffer) => {
            count += b.length;
            if (count > maxBytes) {
              response.destroy();
              res.destroy();
            }
          });
          response.pipe(res);
          response.on('error', () => res.destroy());
        },
      );
      upstream.on('socket', (s) => {
        if (sockets.has(s)) return;
        sockets.add(s);
        s.once('close', () => sockets.delete(s));
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.on('aborted', () => upstream.destroy());
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    })().catch(() => {
      blocked = true;
      if (!res.headersSent) res.writeHead(403);
      res.end();
    });
  });
  server.on('connect', (req, client, head) => {
    void (async () => {
      const target = await policy.endpoint('https://' + req.url);
      if (closed) throw new DownloadError('CANCELLED');
      const socket = connect({ host: target.address, port: target.port });
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.setTimeout(timeout, () => socket.destroy());
      socket.on('error', () => client.destroy());
      client.on('error', () => socket.destroy());
      client.on('close', () => socket.destroy());
      socket.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) socket.write(head);
        let count = 0;
        socket.on('data', (b: Buffer) => {
          count += b.length;
          if (count > maxBytes + 16 * 1024 * 1024) socket.destroy();
        });
        socket.pipe(client);
        client.pipe(socket);
      });
    })().catch(() => {
      blocked = true;
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    if (sockets.size > 64) socket.destroy();
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(timeout, () => socket.destroy());
  });
  await new Promise<void>((ok, no) => {
    server.once('error', no);
    server.listen(0, '127.0.0.1', ok);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new DownloadError('NETWORK_BLOCKED');
  return {
    url: `http://127.0.0.1:${address.port}`,
    wasBlocked: () => blocked,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
