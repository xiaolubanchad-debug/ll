import ssh2 from 'ssh2';
const { Client } = ssh2;
type Client = ssh2.Client;
import type { ConnectConfig } from 'ssh2';
import { createHash } from 'node:crypto';
import type { Node, PrismaClient } from '@prisma/client';
import { readSecret } from './secrets.js';
import { PlatformError } from './errors.js';
export const fingerprint = (key: Buffer) =>
  'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
export function hostKeyLine(key: Buffer) {
  const length = key.readUInt32BE(0);
  const algorithm = key.subarray(4, 4 + length).toString('ascii');
  if (!/^[-a-zA-Z0-9@.]+$/.test(algorithm))
    throw new PlatformError(422, 'HOST_KEY_INVALID', '主机公钥无效');
  return algorithm + ' ' + key.toString('base64');
}
function connection(config: ConnectConfig, signal?: AbortSignal): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const fail = (code: string, message: string) => {
      if (!settled) {
        settled = true;
        client.destroy();
        reject(new PlatformError(409, code, message));
      }
    };
    const abort = () => fail('JOB_CANCELLED', '操作已停止');
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    client.on('ready', () => {
      settled = true;
      resolve(client);
    });
    client.on('error', (error: Error & { level?: string }) =>
      fail(
        error.level === 'client-authentication' ? 'SSH_AUTH_FAILED' : 'SSH_UNREACHABLE',
        'SSH 连接或认证失败',
      ),
    );
    client.once('close', () => {
      signal?.removeEventListener('abort', abort);
      if (!settled) fail('SSH_UNREACHABLE', 'SSH 连接已关闭');
    });
    try {
      client.connect({
        ...config,
        readyTimeout: 10000,
        keepaliveInterval: 5000,
        keepaliveCountMax: 2,
      });
    } catch {
      fail('SSH_KEY_INVALID', 'SSH 连接资料无效');
    }
  });
}
export async function probeHost(
  node: Pick<Node, 'host' | 'port' | 'username'>,
  signal?: AbortSignal,
) {
  let key: Buffer | undefined;
  try {
    await connection(
      {
        host: node.host,
        port: node.port,
        username: node.username,
        hostVerifier: (raw: Buffer) => {
          key = Buffer.from(raw);
          return false;
        },
      },
      signal,
    );
  } catch (error) {
    if (!key) throw error;
  }
  if (!key) throw new PlatformError(409, 'SSH_UNREACHABLE', '未获得主机指纹');
  return { fingerprint: fingerprint(key), hostKey: hostKeyLine(key) };
}
export async function connectNode(db: PrismaClient, node: Node, signal?: AbortSignal) {
  const secret = await readSecret(db, node.credentialVersionId!, ['SSH_KEY', 'SSH_PASSWORD']);
  let mismatch = false;
  try {
    return await connection(
      {
        host: node.host,
        port: node.port,
        username: node.username,
        ...secret,
        hostVerifier: (key: Buffer) => {
          const valid = fingerprint(Buffer.from(key)) === node.expectedFingerprint;
          mismatch = !valid;
          return valid;
        },
      },
      signal,
    );
  } catch (error) {
    if (mismatch) throw new PlatformError(409, 'HOST_KEY_MISMATCH', '主机指纹已变化，已停止连接');
    throw error;
  }
}
export async function remoteScript(
  client: Client,
  script: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = (error?: Error, text = '') => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(text);
    };
    const abort = () => {
      client.destroy();
      done(new PlatformError(409, 'JOB_CANCELLED', '操作已停止'));
    };
    const timer = setTimeout(() => {
      client.destroy();
      done(new PlatformError(409, 'SSH_UNREACHABLE', '远程检查超时'));
    }, 30000);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener('abort', abort, { once: true });
    client.exec('sh -s', (error, stream) => {
      if (error) {
        done(new PlatformError(409, 'SSH_UNREACHABLE', '远程检查无法启动'));
        return;
      }
      let text = '';
      stream.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (text.length > 65536) {
          stream.close();
          done(new PlatformError(409, 'SSH_UNREACHABLE', '检查响应过大'));
        }
      });
      stream.stderr.on('data', () => {});
      stream.on('error', () => done(new PlatformError(409, 'SSH_UNREACHABLE', '远程检查中断')));
      stream.on('close', (code: number) =>
        done(code ? new PlatformError(409, 'SSH_UNREACHABLE', '远程检查失败') : undefined, text),
      );
      stream.end(script);
    });
  });
}
