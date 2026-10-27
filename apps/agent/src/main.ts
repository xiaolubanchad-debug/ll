import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { join, resolve } from 'node:path';
import { collectHealth } from './health.js';
interface Config {
  nodeId: string;
  releaseId: string;
  agentVersion: string;
  apiUrl: string;
  sdkRoot: string;
  toolsRoot: string;
  bootstrapToken?: string;
}
export interface Identity {
  credential?: string;
  enrollmentBootId: string;
}
export async function loadIdentity(dir: string): Promise<Identity> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, 'identity.key');
  let key: Buffer;
  try {
    key = await readFile(keyPath);
  } catch {
    key = randomBytes(32);
    await writeFile(keyPath, key, { flag: 'wx', mode: 0o600 });
  }
  try {
    const sealed = await readFile(join(dir, 'identity.enc'));
    const cipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
    cipher.setAAD(Buffer.from('apk-agent-v1'));
    cipher.setAuthTag(sealed.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(sealed.subarray(28)), cipher.final()]).toString('utf8'),
    ) as Identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { enrollmentBootId: randomUUID() };
    throw Error('IDENTITY_INVALID', { cause: error });
  }
}
export async function saveIdentity(dir: string, value: Identity) {
  const key = await readFile(join(dir, 'identity.key')),
    iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('apk-agent-v1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const file = join(dir, 'identity.tmp');
  await writeFile(file, Buffer.concat([iv, cipher.getAuthTag(), data]), { mode: 0o600 });
  await rename(file, join(dir, 'identity.enc'));
  await chmod(join(dir, 'identity.enc'), 0o600);
}
export async function callHub(apiUrl: string, path: string, token: string, body: unknown) {
  const base = new URL(apiUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (!['https:'].includes(base.protocol) &&
      !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))
  )
    throw Error('HUB_URL_INVALID');
  const response = await fetch(new URL('/api/v1/agent/' + path, base), {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw Error(
      response.status === 401 || response.status === 410
        ? 'IDENTITY_REJECTED'
        : 'HUB_REQUEST_FAILED',
    );
  const text = await response.text();
  if (text.length > 65536) throw Error('HUB_RESPONSE_INVALID');
  return JSON.parse(text) as Record<string, unknown>;
}
export async function startAgent(
  config: Config,
  dir: string,
  signal: AbortSignal,
  health = collectHealth,
) {
  const identity = await loadIdentity(dir);
  const bootId = randomUUID();
  if (!identity.credential) {
    if (!config.bootstrapToken) throw Error('BOOTSTRAP_REQUIRED');
    await saveIdentity(dir, identity);
    const response = await callHub(config.apiUrl, 'enroll', config.bootstrapToken, {
      kind: 'enroll',
      protocolVersion: '1.0',
      nodeId: config.nodeId,
      releaseId: config.releaseId,
      agentVersion: config.agentVersion,
      bootId: identity.enrollmentBootId,
    });
    if (typeof response.credential !== 'string' || !/^[-_A-Za-z0-9]{43}$/.test(response.credential))
      throw Error('IDENTITY_INVALID');
    identity.credential = response.credential;
    await saveIdentity(dir, identity);
  }
  let report = await health(config.sdkRoot, config.toolsRoot, config.releaseId),
    checkedAt = Date.now(),
    refreshing = false;
  while (!signal.aborted) {
    if (Date.now() - checkedAt > 60000 && !refreshing) {
      refreshing = true;
      void health(config.sdkRoot, config.toolsRoot, config.releaseId)
        .then(
          (value) => {
            report = value;
            checkedAt = Date.now();
          },
          () => {
            report = { ...report, android: false, errors: ['ANDROID_NOT_READY'] };
            checkedAt = Date.now();
          },
        )
        .finally(() => {
          refreshing = false;
        });
    }
    try {
      await callHub(config.apiUrl, 'heartbeats', identity.credential, {
        kind: 'heartbeat',
        protocolVersion: '1.0',
        nodeId: config.nodeId,
        releaseId: config.releaseId,
        agentVersion: config.agentVersion,
        bootId,
        sentAt: new Date().toISOString(),
        capabilities: {
          download: report.download,
          android: report.android,
          kvm: report.kvm,
          freeDiskBytes: report.freeDiskBytes,
        },
        currentDelivery: null,
        report,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'IDENTITY_REJECTED') throw error;
      console.error('Agent 心跳暂未确认，将重试');
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, 15000);
      function done() {
        clearTimeout(timer);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
    });
  }
}
async function main() {
  const configPath = resolve(process.env.AGENT_CONFIG ?? '/var/lib/apk-platform/agent-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as Config;
  const abort = new AbortController();
  process.on('SIGTERM', () => abort.abort());
  process.on('SIGINT', () => abort.abort());
  await startAgent(
    config,
    process.env.AGENT_STATE_DIR ?? '/var/lib/apk-platform/agent-state',
    abort.signal,
  );
}
// The release bundle is a separate entry point so tests can import this module safely.
export { main };
