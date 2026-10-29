import type { AndroidSession, Rect } from './registration-types.js';
import { PNG } from 'pngjs';
import type { UiControl, UiPage } from './registration-ui.js';
import { readRegistrationPage, compactLabel, labels, controlLocator } from './registration-ui.js';
import { RegistrationError } from './registration-types.js';
import { canonical, sha } from './common.js';

type Action = 'SKIP_AD' | 'CLOSE_AD' | 'CLOSE_POPUP' | 'ACK_NOTICE' | 'WAIT_SPLASH';
function pixels(bytes: Buffer, rect: Rect) {
  if (
    bytes.length < 45 ||
    bytes.length > 10485760 ||
    bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    bytes.readUInt32BE(16) > 4096 ||
    bytes.readUInt32BE(20) > 4096
  )
    throw new RegistrationError('AUTO_PAGE_INVALID');
  const p = PNG.sync.read(bytes, { checkCRC: true }),
    x = Math.floor(rect.x),
    y = Math.floor(rect.y),
    w = Math.ceil(rect.width),
    h = Math.ceil(rect.height);
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > p.width || y + h > p.height)
    throw new RegistrationError('AUTO_PAGE_INVALID');
  const rows = [];
  for (let r = y; r < y + h; r++)
    rows.push(p.data.subarray((r * p.width + x) * 4, (r * p.width + x + w) * 4));
  return sha(Buffer.concat(rows));
}
export interface ObstructionNote {
  action: Action;
  method: 'CONTROLS' | 'OCR';
  index: number;
}
export function obstructionRole(text: string, notice: boolean): Action | undefined {
  const s = compactLabel(text);
  if (/^(跳过|跳过广告|跳過|skip|skipad|skipads|skipin)(\d{1,2}s?|\d{1,2}秒)?$/.test(s))
    return /[1-9]/.test(s) ? 'WAIT_SPLASH' : 'SKIP_AD';
  if (/^(关闭广告|關閉廣告|closead|closeadvertisement|dismissad)$/.test(s)) return 'CLOSE_AD';
  if (/^(关闭|關閉|关闭弹窗|关闭窗口|稍后|暂不|close|dismiss|notnow|later)$/.test(s))
    return 'CLOSE_POPUP';
  if (notice && /^(我知道了|知道了|好的|确定|确认|ok|gotit|understood)$/.test(s))
    return 'ACK_NOTICE';
  return undefined;
}
function candidate(page: UiPage): { control: UiControl; action: Action } | undefined {
  const notice = page.controls.some((e) =>
    labels(e).some((v) => /公告|通知|温馨提示|announcement|notice/i.test(v)),
  );
  const rows = page.controls.flatMap((control) => {
    if (control.editable || control.checkable) return [];
    let action = labels(control)
      .map((v) => obstructionRole(v, notice))
      .find(Boolean);
    if (
      action === 'SKIP_AD' &&
      (!control.enabled ||
        page.controls.some(
          (e) => !e.editable && labels(e).some((v) => /^\s*[1-9]\d?\s*(s|秒)\s*$/i.test(v)),
        ))
    )
      action = 'WAIT_SPLASH';
    if (
      !action &&
      /(?:^|[_/])(ad_?close|close_?ad|splash_?skip|skip_?ad)(?:$|_)/i.test(control.resourceId)
    )
      action = 'CLOSE_AD';
    if (
      !action ||
      (!control.clickable && action !== 'WAIT_SPLASH') ||
      (!control.enabled && action !== 'WAIT_SPLASH')
    )
      return [];
    return [{ control, action }];
  });
  const unique = [
    ...new Map(rows.map((r) => [canonical([r.control.rect, labels(r.control)]), r])).values(),
  ];
  const actionable = unique.filter((r) => r.action !== 'WAIT_SPLASH');
  if (actionable.length > 1) throw new RegistrationError('AUTO_OBSTRUCTION_AMBIGUOUS');
  return actionable[0] ?? unique.find((r) => r.action === 'WAIT_SPLASH');
}
export function appObstructions(
  session: AndroidSession,
  pkg: string,
  beforeAction: () => void,
  note: (note: ObstructionNote) => Promise<void>,
  screenshotFallback: boolean,
) {
  let actions = 0,
    spent = 0;
  const visited = new Set<string>(),
    ocrTried = new Set<string>();
  const check = (signal: AbortSignal) => {
    if (signal.aborted) throw new RegistrationError('CANCELLED');
    beforeAction();
    if (spent >= 60000) throw new RegistrationError('AUTO_OBSTRUCTION_TIMEOUT');
  };
  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          resolve();
        },
        abort = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          reject(new RegistrationError('CANCELLED'));
        },
        timer = setTimeout(done, ms);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  const clear = async (signal: AbortSignal, initialSource?: string): Promise<string> => {
    check(signal);
    let source = initialSource ?? (await session.source(signal)),
      waiting = 0;
    for (;;) {
      check(signal);
      const page = readRegistrationPage(source, pkg);
      if (page.foreign) throw new RegistrationError('AUTO_FOREIGN_SCREEN');
      const found = candidate(page);
      const start = Date.now();
      if (!found) {
        if (!screenshotFallback || !session.ocr || !session.tap) {
          visited.clear();
          return source;
        }
        const picture = await session.screenshot(signal),
          pictureKey = sha(picture);
        if (ocrTried.has(pictureKey)) {
          visited.clear();
          return source;
        }
        ocrTried.add(pictureKey);
        const lines = await session.ocr(picture, signal);
        check(signal);
        const notice = lines.some((l) => /公告|通知|温馨提示|announcement|notice/i.test(l.text));
        const choices = lines.flatMap((line) => {
          const action = obstructionRole(line.text, notice);
          return action && line.confidence >= 85 ? [{ ...line, action }] : [];
        });
        if (choices.length > 1) throw new RegistrationError('AUTO_OBSTRUCTION_AMBIGUOUS');
        const choice = choices[0];
        if (!choice) {
          visited.clear();
          return source;
        }
        if (choice.action === 'WAIT_SPLASH') {
          if (waiting >= 15000) throw new RegistrationError('AUTO_SPLASH_TIMEOUT');
          if (waiting === 0)
            await note({ action: 'WAIT_SPLASH', method: 'OCR', index: Math.min(actions + 1, 12) });
          await pause(500, signal);
          source = await session.source(signal);
          ocrTried.delete(pictureKey);
          const elapsed = Date.now() - start;
          spent += elapsed;
          waiting += elapsed;
          continue;
        }
        if (actions >= 12) throw new RegistrationError('AUTO_OBSTRUCTION_LIMIT');
        const mark = sha(canonical([page.hash, sha(picture), choice.action, choice.rect]));
        if (visited.has(mark)) throw new RegistrationError('AUTO_OBSTRUCTION_STALLED');
        const current = readRegistrationPage(await session.source(signal), pkg);
        if (current.foreign) throw new RegistrationError('AUTO_FOREIGN_SCREEN');
        if (
          current.hash !== page.hash ||
          pixels(picture, choice.rect) !== pixels(await session.screenshot(signal), choice.rect)
        ) {
          source = await session.source(signal);
          spent += Date.now() - start;
          continue;
        }
        check(signal);
        await session.tap(
          Math.round(choice.rect.x + choice.rect.width / 2),
          Math.round(choice.rect.y + choice.rect.height / 2),
          5000,
        );
        actions++;
        visited.add(mark);
        await note({ action: choice.action, method: 'OCR', index: actions });
        await pause(150, signal);
        source = await session.source(signal);
        spent += Date.now() - start;
        continue;
      }
      if (found.action === 'WAIT_SPLASH') {
        if (waiting >= 15000) throw new RegistrationError('AUTO_SPLASH_TIMEOUT');
        if (waiting === 0)
          await note({
            action: 'WAIT_SPLASH',
            method: 'CONTROLS',
            index: Math.min(actions + 1, 12),
          });
        await pause(500, signal);
        source = await session.source(signal);
        const elapsed = Date.now() - start;
        spent += elapsed;
        waiting += elapsed;
        continue;
      }
      if (actions >= 12) throw new RegistrationError('AUTO_OBSTRUCTION_LIMIT');
      const locator = controlLocator(found.control, page),
        mark = sha(canonical([page.hash, found.action, locator, found.control.rect]));
      if (visited.has(mark)) throw new RegistrationError('AUTO_OBSTRUCTION_STALLED');
      await pause(150, signal);
      const fresh = readRegistrationPage(await session.source(signal), pkg),
        next = candidate(fresh);
      if (fresh.foreign) throw new RegistrationError('AUTO_FOREIGN_SCREEN');
      if (
        !next ||
        next.action !== found.action ||
        canonical(controlLocator(next.control, fresh)) !== canonical(locator) ||
        canonical(next.control.rect) !== canonical(found.control.rect)
      ) {
        source = await session.source(signal);
        spent += Date.now() - start;
        continue;
      }
      check(signal);
      const id = await session.find(locator, 2000, signal);
      check(signal);
      await session.click(id, 5000);
      actions++;
      visited.add(mark);
      await note({ action: found.action, method: 'CONTROLS', index: actions });
      await pause(150, signal);
      source = await session.source(signal);
      spent += Date.now() - start;
    }
  };
  return { clear };
}
