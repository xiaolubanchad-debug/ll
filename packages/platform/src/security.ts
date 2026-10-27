import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fault } from './errors.js';
export const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, 'en'))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function masterKey() {
  try {
    const file = process.env.MASTER_KEY_FILE;
    if (!file) throw Error();
    const key = readFileSync(resolve(file));
    if (key.length !== 32 || (process.platform !== 'win32' && (statSync(file).mode & 0o077) !== 0))
      throw Error();
    return key;
  } catch {
    return fault('KEY_UNAVAILABLE', '部署密钥尚未配置或不可用', 503);
  }
}
export interface Envelope {
  iv: string;
  tag: string;
  data: string;
}
export function encrypt(value: unknown, aad: string): Envelope {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}
export function decrypt(value: unknown, aad: string): unknown {
  try {
    const e = value as Envelope;
    const cipher = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(e.iv, 'base64'));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(Buffer.from(e.tag, 'base64'));
    return JSON.parse(
      Buffer.concat([cipher.update(Buffer.from(e.data, 'base64')), cipher.final()]).toString(
        'utf8',
      ),
    );
  } catch {
    return fault('CREDENTIAL_UNAVAILABLE', '凭据不可解密，请检查密钥版本', 503);
  }
}
export const derivedToken = (bootstrap: string, nodeId: string, bootId: string) =>
  createHmac('sha256', masterKey())
    .update('agent-v1\0' + bootstrap + '\0' + nodeId + '\0' + bootId)
    .digest('base64url');
