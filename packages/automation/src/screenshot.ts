import { PNG } from 'pngjs';
import { XMLParser } from 'fast-xml-parser';
import type { Rect, Account } from './registration-types.js';
import { RegistrationError } from './registration-types.js';
import { automaticIdentity, readRegistrationPage } from './registration-ui.js';
export function redactScreenshot(
  bytes: Buffer,
  source: string,
  account: Account,
  inputs: Rect[],
  pkg?: string,
) {
  if (
    bytes.length < 45 ||
    bytes.length > 10485760 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.readUInt32BE(16) > 4096 ||
    bytes.readUInt32BE(20) > 4096 ||
    source.length > 2097152 ||
    /<!DOCTYPE|<!ENTITY/i.test(source)
  )
    throw new RegistrationError('EVIDENCE_UNSAFE');
  const image = PNG.sync.read(bytes, { checkCRC: true }),
    rects = [...inputs];
  if (pkg) rects.push(...(automaticIdentity(readRegistrationPage(source, pkg))?.rects ?? []));
  const visit = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const row = value as Record<string, unknown>;
    const texts = Object.entries(row)
      .filter(([k, v]) => k.startsWith('@_') && typeof v === 'string')
      .map(([, v]) => v) as string[];
    if (texts.some((t) => [account.username, account.password].some((s) => t.includes(s)))) {
      const match =
        typeof row['@_bounds'] === 'string'
          ? row['@_bounds'].match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/)
          : null;
      if (!match) throw new RegistrationError('EVIDENCE_UNSAFE');
      const [x, y, x2, y2] = match.slice(1).map(Number);
      rects.push({ x, y, width: x2 - x, height: y2 - y });
    }
    for (const child of Object.values(row)) if (typeof child === 'object') visit(child);
  };
  visit(new XMLParser({ ignoreAttributes: false, processEntities: false }).parse(source));
  for (const r of rects) {
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite) || r.width < 0 || r.height < 0)
      throw new RegistrationError('EVIDENCE_UNSAFE');
    const x1 = Math.max(0, Math.floor(r.x) - 8),
      x2 = Math.min(image.width, Math.ceil(r.x + r.width) + 8),
      y1 = Math.max(0, Math.floor(r.y) - 8),
      y2 = Math.min(image.height, Math.ceil(r.y + r.height) + 8);
    for (let y = y1; y < y2; y++)
      for (let x = x1; x < x2; x++) {
        const i = (y * image.width + x) * 4;
        image.data[i] = 0;
        image.data[i + 1] = 0;
        image.data[i + 2] = 0;
        image.data[i + 3] = 255;
      }
  }
  return PNG.sync.write(image);
}
