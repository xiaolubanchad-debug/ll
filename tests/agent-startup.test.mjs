import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers';
import { startAgent } from '../apps/agent/dist/main.js';
import { agentProtocolsForVersion } from '@apk/contracts';

for (const agentVersion of ['0.12.3', '0.13.1'])
  test(
    'real Agent startup advertises both protocols and polls claims: ' + agentVersion,
    { timeout: 12000 },
    async () => {
      const base = resolve('.tmp'),
        dir = await mkdtemp(join(base, 'agent-startup-'));
      const cancel = new AbortController(),
        token = randomBytes(32).toString('base64url');
      const seen = { heartbeat: null, claims: 0, enrollment: 0 };
      const server = createServer(async (req, res) => {
        let text = '';
        for await (const bytes of req) text += bytes;
        const body = JSON.parse(text);
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/v1/agent/enroll') {
          seen.enrollment++;
          res.end(JSON.stringify({ credential: token }));
        } else if (req.url === '/api/v1/agent/heartbeats') {
          seen.heartbeat = body;
          res.end('{}');
        } else if (req.url === '/api/v1/agent/claims') {
          seen.claims++;
          res.end(JSON.stringify({ kind: 'idle' }));
        } else if (req.url === '/api/v1/agent/reconcile') {
          res.end('{}');
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
        if (seen.heartbeat && seen.claims) setImmediate(() => cancel.abort());
      });
      await new Promise((ok, no) => {
        server.once('error', no);
        server.listen(0, '127.0.0.1', ok);
      });
      const deadline = setTimeout(() => cancel.abort(), 5000);
      try {
        await startAgent(
          {
            nodeId: randomUUID(),
            releaseId: randomUUID(),
            agentVersion,
            apiUrl: 'http://127.0.0.1:' + server.address().port,
            bootstrapToken: token,
            sdkRoot: '/owned-fixture',
            toolsRoot: resolve('.'),
            dataRoot: join(dir, 'execution'),
          },
          join(dir, 'identity'),
          cancel.signal,
          async () => ({
            download: true,
            android: true,
            kvm: true,
            freeDiskBytes: 100000000000,
            memoryKiB: 16000000,
            markerPresent: false,
            errors: [],
            versions: {},
          }),
        );
        assert.equal(seen.enrollment, 1);
        assert.equal(seen.heartbeat?.capabilities.downloadProtocol, '1.0');
        assert.equal(seen.heartbeat?.capabilities.registrationProtocol, '1.0');
        assert.ok(seen.claims > 0, 'healthy process must actually start its claim loop');
        assert.deepEqual(agentProtocolsForVersion('0.3.4'), {
          download: true,
          registration: false,
        });
        assert.deepEqual(agentProtocolsForVersion('0.4.0'), { download: true, registration: true });
        assert.deepEqual(agentProtocolsForVersion('0.12.4'), {
          download: false,
          registration: false,
        });
      } finally {
        clearTimeout(deadline);
        cancel.abort();
        server.closeAllConnections();
        await new Promise((ok) => server.close(ok));
        assert.ok(resolve(dir).startsWith(base + sep), 'TEST_CLEANUP_PATH_INVALID');
        await rm(dir, { recursive: true, force: true, maxRetries: 3 });
      }
    },
  );
