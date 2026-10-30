import type { StartupPolicy } from '@apk/contracts';
import { schemaIssues } from '@apk/contracts';
import type { AndroidSession, Rect, Locator } from './registration-types.js';
import { RegistrationError } from './registration-types.js';
import type { UiControl, UiPage } from './registration-ui.js';
import {
  readRegistrationPage,
  compactLabel,
  labels,
  controlLocator,
  controlReference,
  entryRole,
  appLoading,
  nativeScreenKey,
} from './registration-ui.js';
import { canonical, sha } from './common.js';
import {
  screenshotPixels,
  pixelRegion,
  closeIcon,
  closeIconStamp,
  sameCloseIcon,
} from './close-icon.js';

type Action =
  | 'SKIP_AD'
  | 'CLOSE_AD'
  | 'CLOSE_POPUP'
  | 'ACK_NOTICE'
  | 'WAIT_SPLASH'
  | 'WAIT_OVERLAY'
  | 'RETRY_LOAD';
type Method = 'CONTROLS' | 'OCR' | 'ICON' | 'BACK';
type Phase = 'DETECTED' | 'WAITING' | 'ACTION_SENT' | 'CLEARED' | 'UNCHANGED' | 'UNVERIFIED';
export interface ObstructionNote {
  action: Action;
  method: Method;
  index: number;
  phase: Phase;
}
interface Candidate {
  action: Action;
  method: Method;
  key: string;
  rect: Rect;
  locator?: Locator;
  scope?: Rect;
  pixels?: string;
  target?: UiControl;
  index?: number;
  tracking?: { locator: Locator; rect: Rect; allowClip?: boolean }[];
}
const contains = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;
const equalRect = (a: Rect, b: Rect) =>
  ['x', 'y', 'width', 'height'].every(
    (k) => Math.abs(a[k as keyof Rect] - b[k as keyof Rect]) <= 2,
  );
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
export function obstructionRegions(page: UiPage): Rect[] {
  const explicit = page.controls
    .filter(
      (c) =>
        !c.editable &&
        /(?:Layout|ViewGroup|WebView|Dialog)$/.test(c.className) &&
        (/(?:^|[_/])(ad|advert|splash|popup|dialog|notice|alert)(?:[_/]|$)/i.test(c.resourceId) ||
          /Dialog$/.test(c.className)),
    )
    .map((c) => c.rect);
  const window = page.window;
  const inferred =
    window && modalBarrier(page)
      ? page.controls
          .filter(
            (c) =>
              !c.editable &&
              /(?:^|[.])(?:View|FrameLayout|LinearLayout|ViewGroup)$/.test(c.className) &&
              contains(window, c.rect) &&
              c.rect.width * c.rect.height >= window.width * window.height * 0.06 &&
              c.rect.width * c.rect.height <= window.width * window.height * 0.85,
          )
          .map((c) => c.rect)
      : [];
  return [...new Map([...explicit, ...inferred].map((r) => [canonical(r), r])).values()].slice(
    0,
    32,
  );
}
function modalBarrier(page: UiPage): boolean {
  return (
    !!page.window &&
    page.controls.some(
      (c) =>
        c.ownClickable &&
        labels(c).some((v) => obstructionRole(v, false) === 'CLOSE_POPUP') &&
        c.rect.width * c.rect.height >= page.window!.width * page.window!.height * 0.6,
    )
  );
}
export function obstructionEvidence(page: UiPage): boolean {
  return modalBarrier(page) || obstructionCandidates(page).length > 0;
}
function touchTarget(control: UiControl, page: UiPage): UiControl | undefined {
  if (control.ownClickable !== false && control.clickable) return control;
  if (!control.clickParent) return undefined;
  const p = control.clickParent;
  const parent = page.controls.find(
    (c) =>
      c.ownClickable &&
      c.className === p.className &&
      c.resourceId === p.resourceId &&
      equalRect(c.rect, p.rect),
  );
  if (
    !parent ||
    !contains(parent.rect, control.rect) ||
    /(?:WebView|ScrollView|RecyclerView|ListView)$/.test(parent.className)
  )
    return undefined;
  if (
    page.controls.some(
      (c) => c !== control && (c.editable || c.checkable) && contains(parent.rect, c.rect),
    )
  )
    return undefined;
  if (
    page.controls.some(
      (c) =>
        c !== control &&
        c !== parent &&
        contains(parent.rect, c.rect) &&
        labels(c).some((v) => !obstructionRole(v, true) && !/^\s*\d{1,2}\s*(?:s|秒)\s*$/i.test(v)),
    )
  )
    return undefined;
  if (
    page.window &&
    (parent.rect.width * parent.rect.height > page.window.width * page.window.height * 0.12 ||
      parent.rect.height > page.window.height * 0.22)
  )
    return undefined;
  return parent;
}
export function obstructionCandidates(page: UiPage, allowStartupRetry = false): Candidate[] {
  const notice = page.controls.some((c) =>
    labels(c).some((v) => /公告|通知|温馨提示|announcement|notice/i.test(v)),
  );
  const scopes = obstructionRegions(page),
    found = new Map<string, Candidate>();
  const text = page.controls.flatMap(labels).join(' ');
  const networkRetry =
    allowStartupRetry &&
    !page.controls.some((c) => c.editable || c.checkable || labels(c).some((v) => entryRole(v))) &&
    !/注册|registration|用户名|password|密码/i.test(text) &&
    (/加载失败|请求失败|failed.?to.?load|unable.?to.?connect/i.test(text) ||
      (/网络|连接|服务器|network|connection|server/i.test(text) &&
        /失败|异常|错误|超时|不可用|timeout|error|failed|unavailable/i.test(text)));
  for (const c of page.controls) {
    if (c.editable || c.checkable) continue;
    let action = labels(c)
      .map((v) => obstructionRole(v, notice))
      .find(Boolean);
    if (
      !action &&
      networkRetry &&
      labels(c).some((v) =>
        /^(重试|重新加载|点击重试|点击重新加载|retry|reload|tryagain)$/.test(compactLabel(v)),
      )
    )
      action = 'RETRY_LOAD';
    if (
      action === 'SKIP_AD' &&
      (!c.enabled ||
        page.controls.some(
          (e) => !e.editable && labels(e).some((v) => /^\s*[1-9]\d?\s*(s|秒)\s*$/i.test(v)),
        ))
    )
      action = 'WAIT_SPLASH';
    if (
      !action &&
      /(?:^|[_/])(ad_?close|close_?ad|splash_?skip|skip_?ad)(?:$|_)/i.test(c.resourceId)
    )
      action = 'CLOSE_AD';
    if (
      !action &&
      scopes.some((r) => contains(r, c.rect)) &&
      /(?:^|[_/])(?:iv_close|btn_close|close_btn|img_close|dialog_close|close_popup)(?:$|_)/i.test(
        c.resourceId,
      )
    )
      action = 'CLOSE_POPUP';
    if (
      !action &&
      scopes.some((r) => contains(r, c.rect)) &&
      labels(c).some((v) => /^[×✕✖]$/.test(v.trim()))
    )
      action = 'CLOSE_POPUP';
    if (!action || (!c.enabled && action !== 'WAIT_SPLASH')) continue;
    const target = action === 'WAIT_SPLASH' ? c : touchTarget(c, page);
    if (!target) continue;
    if (
      page.window &&
      action !== 'WAIT_SPLASH' &&
      target.rect.width * target.rect.height >= page.window.width * page.window.height * 0.6
    )
      continue;
    const locator = action === 'WAIT_SPLASH' ? undefined : controlLocator(target, page);
    const key = sha(canonical(['CONTROLS', locator ?? target.rect]));
    const value: Candidate = {
      action,
      method: 'CONTROLS',
      key,
      rect: target.rect,
      target,
      ...(locator ? { locator } : {}),
    };
    const previous = found.get(key);
    if (!previous || action === 'CLOSE_AD') found.set(key, value);
  }
  return [...found.values()];
}
const choose = (candidates: Candidate[]) => {
  const active = candidates.filter((c) => c.action !== 'WAIT_SPLASH');
  if (active.length > 1) throw new RegistrationError('AUTO_OBSTRUCTION_AMBIGUOUS');
  return active[0] ?? candidates.find((c) => c.action === 'WAIT_SPLASH');
};

function noticeBack(page: UiPage): Candidate | undefined {
  if (
    !modalBarrier(page) ||
    page.controls.some(
      (c) =>
        c.editable ||
        c.checkable ||
        labels(c).some(
          (v) =>
            entryRole(v) ||
            /隐私政策|用户协议|服务条款|privacy.?policy|terms.?of.?service/i.test(v),
        ),
    )
  )
    return undefined;
  const notices = page.controls.filter(
    (c) =>
      !c.ownClickable &&
      labels(c).some((v) => /公告|系统通知|温馨提示|使用提醒|announcement|notice/i.test(v)),
  );
  const barrier = page.controls.find(
    (c) =>
      c.ownClickable &&
      labels(c).some((v) => obstructionRole(v, false) === 'CLOSE_POPUP') &&
      page.window &&
      c.rect.width * c.rect.height >= page.window.width * page.window.height * 0.6,
  );
  if (notices.length !== 1 || !barrier) return undefined;
  const barrierRef = controlReference(barrier, page),
    noticeRef = controlReference(notices[0]!, page);
  if (!barrierRef || !noticeRef) return undefined;
  const tracking = [
    { locator: barrierRef, rect: barrier.rect, allowClip: true },
    { locator: noticeRef, rect: notices[0]!.rect, allowClip: true },
  ];
  return {
    action: 'CLOSE_POPUP',
    method: 'BACK',
    rect: notices[0]!.rect,
    tracking,
    key: sha(canonical(['BACK', tracking, labels(notices[0]!)])),
  };
}

export function appObstructions(
  session: AndroidSession,
  pkg: string,
  beforeAction: () => void,
  note: (note: ObstructionNote) => Promise<void>,
  screenshotFallback: boolean,
  input: StartupPolicy = {},
  allowStartupRetry: () => boolean = () => false,
) {
  if (schemaIssues('StartupPolicy', input).length)
    throw new RegistrationError('AUTO_STARTUP_CONFIG_INVALID');
  const settings = {
    confirmationTimeoutMs: 3000,
    splashTimeoutMs: 15000,
    totalTimeoutMs: 60000,
    maxActions: 12,
    iconRecognition: true,
    ...input,
  };
  let actions = 0,
    spent = 0,
    loadRetries = 0;
  const ocrCache = new Map<string, Awaited<ReturnType<NonNullable<AndroidSession['ocr']>>>>();
  const pause = (ms: number, signal: AbortSignal) =>
    new Promise<void>((ok, no) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        ok();
      };
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        no(new RegistrationError('CANCELLED'));
      };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  const clear = async (signal: AbortSignal, initialSource?: string): Promise<string> => {
    const started = Date.now(),
      remaining = settings.totalTimeoutMs - spent;
    if (remaining <= 0) throw new RegistrationError('AUTO_OBSTRUCTION_TIMEOUT');
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, remaining))]);
    const check = () => {
      if (signal.aborted) throw new RegistrationError('CANCELLED');
      beforeAction();
      if (bounded.aborted || Date.now() - started >= remaining)
        throw new RegistrationError('AUTO_OBSTRUCTION_TIMEOUT');
    };
    const read = async () => {
      check();
      const source = await session.source(bounded);
      check();
      const page = readRegistrationPage(source, pkg);
      if (page.foreign) throw new RegistrationError('AUTO_FOREIGN_SCREEN');
      return { source, page };
    };
    const identify = async (page: UiPage, strict = true): Promise<Candidate | undefined> => {
      const native = choose(obstructionCandidates(page, allowStartupRetry()));
      if (native) return native;
      if (appLoading(page)) return undefined;
      if (session.attached) {
        const notice = noticeBack(page);
        if (notice) return notice;
      }
      if (!modalBarrier(page) && !obstructionRegions(page).length && nativeScreenKey(page, pkg))
        return undefined;
      if (!screenshotFallback || !session.tap || !session.screenshot) {
        if (strict && modalBarrier(page))
          throw new RegistrationError('AUTO_OBSTRUCTION_UNVERIFIED');
        return undefined;
      }
      const scopes = obstructionRegions(page);
      check();
      const bytes = await session.screenshot(bounded),
        png = screenshotPixels(bytes),
        pictureKey = sha(canonical([sha(bytes), page.hash]));
      const findIcon = () => {
        if (!settings.iconRecognition || !scopes.length) return undefined;
        const candidates = page.controls.flatMap((c) => {
          if (
            !c.enabled ||
            c.editable ||
            c.checkable ||
            labels(c).length ||
            !/(?:^|[.$])(?:ImageButton|ImageView|View)$/.test(c.className)
          )
            return [];
          const target = touchTarget(c, page),
            scope = scopes
              .filter((r) => contains(r, c.rect))
              .sort((a, b) => a.width * a.height - b.width * b.height)[0];
          if (
            !target ||
            !scope ||
            c.rect.x < 0 ||
            c.rect.y < 0 ||
            c.rect.x + c.rect.width > png.width ||
            c.rect.y + c.rect.height > png.height
          )
            return [];
          if (
            !/ImageButton$/.test(c.className) &&
            !(
              c.rect.y <= scope.y + Math.min(scope.height * 0.25, c.rect.height * 2) &&
              (c.rect.x - scope.x <= c.rect.width * 2 ||
                scope.x + scope.width - c.rect.x - c.rect.width <= c.rect.width * 2)
            ) &&
            !(
              c.rect.y >= scope.y + scope.height - c.rect.height * 2 &&
              Math.abs(c.rect.x + c.rect.width / 2 - scope.x - scope.width / 2) <=
                c.rect.width * 1.5
            )
          )
            return [];
          if (!closeIcon(png, c.rect)) return [];
          let tracking: Candidate['tracking'];
          if (session.attached) {
            const owner = page.controls.find((p) => equalRect(p.rect, scope));
            if (owner) {
              try {
                tracking = [
                  { locator: controlLocator(target, page), rect: target.rect },
                  { locator: controlLocator(owner, page), rect: owner.rect, allowClip: true },
                ];
                if (canonical(tracking[0]!.locator) === canonical(tracking[1]!.locator))
                  tracking = undefined;
              } catch (error) {
                if (
                  !(error instanceof RegistrationError) ||
                  error.code !== 'AUTO_CONTROL_AMBIGUOUS'
                )
                  throw error;
              }
            }
          }
          return [
            {
              action: 'CLOSE_POPUP' as const,
              method: 'ICON' as const,
              key: sha(canonical(['ICON', c.rect, scope, tracking?.map((t) => t.locator) ?? []])),
              rect: c.rect,
              scope,
              pixels: closeIconStamp(png, c.rect),
              ...(tracking ? { tracking } : {}),
            },
          ];
        });
        return choose([...new Map(candidates.map((c) => [canonical(c.rect), c])).values()]);
      };
      const icon = findIcon();
      if (modalBarrier(page) && icon) return icon;
      if (session.ocr) {
        let lines = ocrCache.get(pictureKey);
        if (!lines) {
          lines = await session.ocr(bytes, bounded);
          check();
          if (ocrCache.size >= 8) ocrCache.clear();
          ocrCache.set(pictureKey, lines);
        }
        const notice = lines.some((l) => /公告|通知|温馨提示|announcement|notice/i.test(l.text));
        const candidates = lines.flatMap((line) => {
          const action = obstructionRole(line.text, notice);
          return action && line.confidence >= 85
            ? [
                {
                  action,
                  method: 'OCR' as const,
                  key: sha(canonical(['OCR', action, line.rect])),
                  rect: line.rect,
                  pixels: pixelRegion(png, line.rect),
                  scope: scopes.find((r) => contains(r, line.rect)),
                },
              ]
            : [];
        });
        const selected = choose(candidates);
        if (selected) return selected;
      }
      if (icon) return icon;
      if (strict && modalBarrier(page)) throw new RegistrationError('AUTO_OBSTRUCTION_UNVERIFIED');
      return undefined;
    };
    const report = async (c: Candidate, phase: Phase) => {
      await note({
        action: c.action,
        method: c.method,
        index: c.index ?? Math.max(1, Math.min(actions + 1, settings.maxActions)),
        phase,
      });
      check();
    };
    let source = initialSource,
      waitingSince: number | undefined,
      overlaySince: number | undefined;
    let pending: Candidate | undefined;
    try {
      for (;;) {
        check();
        const current =
          source === undefined ? await read() : { source, page: readRegistrationPage(source, pkg) };
        source = undefined;
        if (current.page.foreign) throw new RegistrationError('AUTO_FOREIGN_SCREEN');
        let candidate: Candidate | undefined;
        try {
          candidate = await identify(current.page);
        } catch (error) {
          if (!(error instanceof RegistrationError) || error.code !== 'AUTO_OBSTRUCTION_UNVERIFIED')
            throw error;
          if (overlaySince === undefined) {
            overlaySince = Date.now();
            await note({
              action: 'WAIT_OVERLAY',
              method: 'CONTROLS',
              index: Math.min(actions + 1, settings.maxActions),
              phase: 'WAITING',
            });
          }
          if (Date.now() - overlaySince >= 15000) throw error;
          await pause(400, bounded);
          continue;
        }
        overlaySince = undefined;
        if (!candidate) return current.source;
        if (candidate.action === 'WAIT_SPLASH') {
          if (waitingSince === undefined) {
            waitingSince = Date.now();
            await note({
              action: candidate.action,
              method: candidate.method,
              index: Math.min(actions + 1, settings.maxActions),
              phase: 'WAITING',
            });
          }
          if (Date.now() - waitingSince >= settings.splashTimeoutMs)
            throw new RegistrationError('AUTO_SPLASH_TIMEOUT');
          await pause(250, bounded);
          continue;
        }
        waitingSince = undefined;
        if (candidate.action === 'RETRY_LOAD' && loadRetries >= 1)
          throw new RegistrationError('AUTO_STARTUP_NETWORK_FAILED');
        if (actions >= settings.maxActions) throw new RegistrationError('AUTO_OBSTRUCTION_LIMIT');
        candidate.index = actions + 1;
        await report(candidate, 'DETECTED');
        await pause(150, bounded);
        const fresh = await read(),
          next = await identify(fresh.page, false);
        if (
          !next ||
          next.key !== candidate.key ||
          !equalRect(next.rect, candidate.rect) ||
          (candidate.pixels &&
            (candidate.method === 'ICON'
              ? !sameCloseIcon(candidate.pixels, next.pixels ?? '')
              : candidate.pixels !== next.pixels))
        ) {
          await report(candidate, 'UNVERIFIED');
          await pause(150, bounded);
          source = undefined;
          continue;
        }
        check();
        const tracked: string[] = [];
        let trackingChanged = false;
        for (const target of candidate.tracking ?? []) {
          const id = await session.find(target.locator, 2000, bounded);
          check();
          const actual = await session.rect(id);
          if (
            !equalRect(actual, target.rect) &&
            !(
              target.allowClip &&
              actual.width > 0 &&
              actual.height > 0 &&
              contains(target.rect, actual)
            )
          ) {
            trackingChanged = true;
            break;
          }
          tracked.push(id);
        }
        if (trackingChanged) {
          await report(candidate, 'UNVERIFIED');
          await pause(150, bounded);
          continue;
        }
        if (candidate.action === 'RETRY_LOAD' && !allowStartupRetry())
          throw new RegistrationError('AUTO_STARTUP_NETWORK_FAILED');
        if (candidate.method === 'BACK') {
          check();
          await session.back(5000, bounded);
        } else if (candidate.locator) {
          const id = await session.find(candidate.locator, 2000, bounded);
          if (session.rect && !equalRect(await session.rect(id), candidate.rect)) {
            await report(candidate, 'UNVERIFIED');
            await pause(150, bounded);
            source = undefined;
            continue;
          }
          check();
          await session.click(id, 5000);
        } else {
          check();
          await session.tap!(
            Math.round(candidate.rect.x + candidate.rect.width / 2),
            Math.round(candidate.rect.y + candidate.rect.height / 2),
            5000,
          );
        }
        actions++;
        if (candidate.action === 'RETRY_LOAD') loadRetries++;
        pending = candidate;
        await report(candidate, 'ACTION_SENT');
        await report(candidate, 'WAITING');
        const deadline = Date.now() + settings.confirmationTimeoutMs;
        let absentSince: number | undefined,
          confirmed = false;
        while (Date.now() < deadline) {
          await pause(Math.min(250, Math.max(1, deadline - Date.now())), bounded);
          const observation = await read();
          check();
          let absent = false;
          if (
            ['ICON', 'BACK'].includes(candidate.method) &&
            tracked.length === 2 &&
            session.attached
          ) {
            const first = await session.attached(tracked[0]!, bounded);
            check();
            const second = await session.attached(tracked[1]!, bounded);
            check();
            absent = !first && !second;
          } else if (candidate.method === 'CONTROLS' && candidate.target) {
            const target = candidate.target;
            absent = !observation.page.controls.some(
              (c) =>
                c.className === target.className &&
                (target.resourceId
                  ? c.resourceId === target.resourceId
                  : equalRect(c.rect, target.rect) &&
                    canonical(labels(c)) === canonical(labels(target))),
            );
          } else {
            const observed = await identify(observation.page, false);
            absent = !observed || observed.key !== candidate.key;
          }
          if (candidate.method === 'ICON' && absent && candidate.scope && tracked.length !== 2) {
            const scopeRemains = obstructionRegions(observation.page).some((r) =>
              equalRect(r, candidate.scope!),
            );
            const downstream = observation.page.controls.some(
              (c) => c.editable || labels(c).some((v) => entryRole(v)),
            );
            absent = !scopeRemains || downstream;
          }
          if (!absent) absentSince = undefined;
          else if (absentSince === undefined) absentSince = Date.now();
          else if (Date.now() - absentSince >= 300) {
            source = observation.source;
            confirmed = true;
            break;
          }
        }
        if (!confirmed) {
          await report(candidate, 'UNCHANGED');
          throw new RegistrationError('AUTO_OBSTRUCTION_STALLED');
        }
        await report(candidate, 'CLEARED');
        pending = undefined;
      }
    } catch (error) {
      if (
        pending &&
        !signal.aborted &&
        (!(error instanceof RegistrationError) ||
          !['AUTO_OBSTRUCTION_STALLED', 'CANCELLED'].includes(error.code))
      )
        await note({
          action: pending.action,
          method: pending.method,
          index: pending.index ?? Math.max(1, actions),
          phase: 'UNVERIFIED',
        }).catch(() => {});
      if (signal.aborted) throw new RegistrationError('CANCELLED');
      if (bounded.aborted) throw new RegistrationError('AUTO_OBSTRUCTION_TIMEOUT');
      throw error;
    } finally {
      spent += Date.now() - started;
      ocrCache.clear();
    }
  };
  return { clear };
}
