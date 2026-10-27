import { createHash } from 'node:crypto';
export class DownloadError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
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
export function normalizeUrl(value: string) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
    throw new DownloadError('NETWORK_BLOCKED');
  u.hash = '';
  return u.href;
}
export function cacheDay(at: Date) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);
  const get = (s: string) => p.find((x) => x.type === s)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
