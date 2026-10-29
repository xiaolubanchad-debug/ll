import { PNG } from 'pngjs';
import type { Rect } from './registration-types.js';
import { RegistrationError } from './registration-types.js';
import { sha } from './common.js';

export function screenshotPixels(bytes: Buffer) {
  if (
    bytes.length < 45 ||
    bytes.length > 10485760 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.readUInt32BE(16) > 4096 ||
    bytes.readUInt32BE(20) > 4096
  )
    throw new RegistrationError('AUTO_PAGE_INVALID');
  try {
    return PNG.sync.read(bytes, { checkCRC: true });
  } catch {
    throw new RegistrationError('AUTO_PAGE_INVALID');
  }
}
export function pixelRegion(png: PNG, rect: Rect) {
  const x = Math.floor(rect.x),
    y = Math.floor(rect.y),
    w = Math.ceil(rect.width),
    h = Math.ceil(rect.height);
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > png.width || y + h > png.height)
    throw new RegistrationError('AUTO_PAGE_INVALID');
  const rows: Buffer[] = [];
  for (let row = y; row < y + h; row++)
    rows.push(png.data.subarray((row * png.width + x) * 4, (row * png.width + x + w) * 4));
  return sha(Buffer.concat(rows));
}

// Only validates a supplied UI-owned close region; it never searches arbitrary screen corners.
export function closeIcon(png: PNG, rect: Rect): boolean {
  const max = Math.min(160, png.width * 0.18);
  if (
    rect.width < 12 ||
    rect.height < 12 ||
    rect.width > max ||
    rect.height > max ||
    rect.width / rect.height < 0.7 ||
    rect.width / rect.height > 1.4
  )
    return false;
  pixelRegion(png, rect);
  const light = (x: number, y: number) => {
    const i = (Math.floor(y) * png.width + Math.floor(x)) * 4;
    return png.data[i]! * 0.299 + png.data[i + 1]! * 0.587 + png.data[i + 2]! * 0.114;
  };
  const inset = 0.15;
  const points = [
    light(rect.x + rect.width * inset, rect.y + rect.height / 2),
    light(rect.x + rect.width * (1 - inset), rect.y + rect.height / 2),
    light(rect.x + rect.width / 2, rect.y + rect.height * inset),
    light(rect.x + rect.width / 2, rect.y + rect.height * (1 - inset)),
  ].sort((a, b) => a - b);
  const background = (points[1]! + points[2]!) / 2;
  const pixels: { x: number; y: number }[] = [];
  for (let y = Math.ceil(rect.y + rect.height * 0.2); y < rect.y + rect.height * 0.8; y++)
    for (let x = Math.ceil(rect.x + rect.width * 0.2); x < rect.x + rect.width * 0.8; x++)
      if (Math.abs(light(x, y) - background) >= 80) pixels.push({ x, y });
  if (pixels.length < 10 || pixels.length > rect.width * rect.height * 0.45) return false;
  const minX = Math.min(...pixels.map((p) => p.x)),
    maxX = Math.max(...pixels.map((p) => p.x)),
    minY = Math.min(...pixels.map((p) => p.y)),
    maxY = Math.max(...pixels.map((p) => p.y));
  if (
    maxX - minX < rect.width * 0.35 ||
    maxY - minY < rect.height * 0.35 ||
    (maxX - minX) / (maxY - minY) < 0.7 ||
    (maxX - minX) / (maxY - minY) > 1.4
  )
    return false;
  let matched = 0,
    first = 0,
    second = 0;
  const quadrants = new Set<number>();
  for (const p of pixels) {
    const x = (p.x - minX) / (maxX - minX),
      y = (p.y - minY) / (maxY - minY);
    const a = Math.abs(x - y) <= 0.14,
      b = Math.abs(x + y - 1) <= 0.14;
    if (a || b) {
      matched++;
      quadrants.add((x >= 0.5 ? 1 : 0) + (y >= 0.5 ? 2 : 0));
    }
    if (a) first++;
    if (b) second++;
  }
  return (
    matched / pixels.length >= 0.88 &&
    first / pixels.length >= 0.32 &&
    second / pixels.length >= 0.32 &&
    quadrants.size === 4
  );
}

export function closeIconStamp(png: PNG, rect: Rect): string {
  const light = (x: number, y: number) => {
    const i = (Math.floor(y) * png.width + Math.floor(x)) * 4;
    return png.data[i]! * 0.299 + png.data[i + 1]! * 0.587 + png.data[i + 2]! * 0.114;
  };
  const samples = [
    light(rect.x + rect.width * 0.15, rect.y + rect.height / 2),
    light(rect.x + rect.width * 0.85, rect.y + rect.height / 2),
    light(rect.x + rect.width / 2, rect.y + rect.height * 0.15),
    light(rect.x + rect.width / 2, rect.y + rect.height * 0.85),
  ].sort((a, b) => a - b);
  const background = (samples[1]! + samples[2]!) / 2;
  let stamp = '';
  for (let y = 0; y < 9; y++)
    for (let x = 0; x < 9; x++)
      stamp +=
        Math.abs(
          light(rect.x + rect.width * (0.22 + x * 0.07), rect.y + rect.height * (0.22 + y * 0.07)) -
            background,
        ) >= 80
          ? '1'
          : '0';
  return stamp;
}
export function sameCloseIcon(a: string, b: string): boolean {
  return (
    a.length === 81 &&
    b.length === 81 &&
    [...a].filter((value, index) => value !== b[index]).length <= 6
  );
}
