import { createServer } from 'node:http';
const crc = (b) => {
  let c = 0xffffffff;
  for (const n of b) {
    c ^= n;
    for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};
export function fixtureApk(packageName = 'com.example.p2') {
  const strings = ['manifest', 'package', 'versionName', 'versionCode', packageName, '1.2.3'];
  const encoded = strings.map((s) =>
    Buffer.concat([
      Buffer.from([s.length, Buffer.byteLength(s)]),
      Buffer.from(s),
      Buffer.from([0]),
    ]),
  );
  const data = Buffer.concat(encoded);
  const pool = Buffer.alloc(Math.ceil((28 + strings.length * 4 + data.length) / 4) * 4);
  pool.writeUInt16LE(1, 0);
  pool.writeUInt16LE(28, 2);
  pool.writeUInt32LE(pool.length, 4);
  pool.writeUInt32LE(strings.length, 8);
  pool.writeUInt32LE(0x100, 16);
  pool.writeUInt32LE(28 + strings.length * 4, 20);
  let offset = 0;
  encoded.forEach((b, i) => {
    pool.writeUInt32LE(offset, 28 + i * 4);
    offset += b.length;
  });
  data.copy(pool, 28 + strings.length * 4);
  const tag = Buffer.alloc(96);
  tag.writeUInt16LE(0x102);
  tag.writeUInt16LE(16, 2);
  tag.writeUInt32LE(96, 4);
  tag.writeUInt32LE(1, 8);
  tag.writeUInt32LE(0xffffffff, 12);
  tag.writeUInt32LE(0xffffffff, 16);
  tag.writeUInt32LE(0, 20);
  tag.writeUInt16LE(20, 24);
  tag.writeUInt16LE(20, 26);
  tag.writeUInt16LE(3, 28);
  for (let i = 0; i < 3; i++) {
    const p = 36 + i * 20;
    tag.writeUInt32LE(0xffffffff, p);
    tag.writeUInt32LE(i + 1, p + 4);
    tag.writeUInt32LE(i < 2 ? i + 4 : 0xffffffff, p + 8);
    tag.writeUInt16LE(8, p + 12);
    tag[p + 15] = i < 2 ? 3 : 0x10;
    tag.writeUInt32LE(i < 2 ? i + 4 : 12, p + 16);
  }
  const end = Buffer.alloc(24);
  end.writeUInt16LE(0x103);
  end.writeUInt16LE(16, 2);
  end.writeUInt32LE(24, 4);
  end.writeUInt32LE(1, 8);
  end.writeUInt32LE(0xffffffff, 12);
  end.writeUInt32LE(0xffffffff, 16);
  const xml = Buffer.alloc(8);
  xml.writeUInt16LE(3);
  xml.writeUInt16LE(8, 2);
  xml.writeUInt32LE(8 + pool.length + tag.length + end.length, 4);
  return zip([
    ['AndroidManifest.xml', Buffer.concat([xml, pool, tag, end])],
    ['classes.dex', Buffer.concat([Buffer.from('dex\n035\0'), Buffer.alloc(104)])],
    ['lib/x86_64/libfixture.so', Buffer.from('fixture-only-not-an-installable-library')],
  ]);
}
export function zip(files) {
  const local = [],
    central = [];
  let offset = 0;
  for (const [path, data] of files) {
    const name = Buffer.from(path),
      head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc(data), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(crc(data), 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += head.length + name.length + data.length;
  }
  const cd = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}
export async function fixtureSite() {
  let forbiddenCount = 0;
  const forbidden = createServer((_req, res) => {
    forbiddenCount++;
    res.end('private fixture must not be reached');
  });
  await new Promise((r) => forbidden.listen(0, '127.0.0.1', r));
  const forbiddenUrl = 'http://127.0.0.1:' + forbidden.address().port + '/private';
  const apk = fixtureApk(),
    counts = new Map(),
    agents = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    agents.push(req.headers['user-agent']);
    res.setHeader('Cache-Control', 'no-store');
    if (['/direct.apk', '/second.apk', '/third.apk'].includes(path)) {
      res.writeHead(200, {
        'content-type': 'application/vnd.android.package-archive',
        'content-disposition': 'attachment; filename="../../untrusted.apk"',
      });
      res.end(apk);
      return;
    }
    if (path === '/invalid.apk') {
      res.writeHead(200, { 'content-disposition': 'attachment; filename="bad.apk"' });
      res.end('not an APK');
      return;
    }
    if (path === '/hang.apk') {
      res.writeHead(200, {
        'content-disposition': 'attachment; filename="hang.apk"',
        'content-length': '1000000',
      });
      res.write(apk);
      return;
    }
    if (path === '/redirect') {
      res.writeHead(302, { location: forbiddenUrl });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (path === '/source')
      res.end(
        `<div aria-label="1 / 5"><a class="jgg-item" pid="1" href="/direct.apk">直接 APK</a><a class="jgg-item" pid="2" href="/landing" target="_blank">新窗口</a><a class="jgg-item" pid="3" href="/same">同页落地</a></div><div aria-label="2 / 5" style="display:none"><a class="jgg-item" pid="1" href="/direct.apk">轮播副本</a></div>`,
      );
    else if (path === '/landing' || path === '/same')
      res.end(
        `<a class="download" href="${path === '/same' ? '/third.apk' : '/second.apk'}">下载</a>`,
      );
    else if (path === '/invalid')
      res.end('<a class="jgg-item" pid="4" href="/invalid.apk">坏文件</a>');
    else if (path === '/hang') res.end('<a class="jgg-item" pid="5" href="/hang.apk">慢下载</a>');
    else if (path === '/blocked')
      res.end('<a class="jgg-item" pid="6" href="/redirect">私网重定向</a>');
    else if (path === '/empty') res.end('<p>空页面</p>');
    else {
      res.statusCode = 404;
      res.end('missing');
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    apk,
    counts,
    agents,
    forbiddenRequests: () => forbiddenCount,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
      await new Promise((r) => forbidden.close(r));
    },
  };
}
