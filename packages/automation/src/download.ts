import { mkdir, mkdtemp } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Browser,
  BrowserContext,
  Page,
  Download,
  BrowserType,
  Frame,
  Locator,
} from 'playwright';
import type { TestConfiguration, ApkMetadata } from '@apk/contracts';
import { ApkCache, removeOwned } from './cache.js';
import { inspectApk } from './apk.js';
import { NetworkPolicy, startEgress } from './network.js';
import { sha, canonical, normalizeUrl, cacheDay, DownloadError } from './common.js';
import type { RegistrationCompletion } from './registration.js';
import { androidBrowser } from './mobile-browser.js';
import { navigationSite } from './navigation-site.js';
import { frameApkLinks } from './apk-links.js';
export interface AutomationEvent {
  type:
    | 'TARGETS_DISCOVERED'
    | 'TASK_STAGE'
    | 'TASK_FINISHED'
    | 'RUN_FINISHED'
    | 'PROXY_CHECKED'
    | 'BROWSER_ENVIRONMENT'
    | 'APP_OBSTRUCTION'
    | 'LOG'
    | 'DEVICE_SESSION';
  taskId?: string;
  payload: Record<string, unknown>;
}
export interface Target {
  deviceSessionId?: string;
  appIndex?: number;
  variantId?: string;
  taskId: string;
  targetKey: string;
  entryId?: string;
  label: string;
  sourceUrl: string;
  pid: string;
  href: string;
  position: number;
}
export interface BrowserRecord {
  pid: number;
  profile: string;
}
export interface DownloadOptions {
  dailyDownload?: boolean;
  fixedCacheDay?: string;
  beforeAction?: () => void;
  chromium?: BrowserType;
  policy?: NetworkPolicy;
  now?: () => Date;
  onBrowser?: (record: BrowserRecord) => Promise<void>;
  onClosed?: () => Promise<void>;
  afterDownload?: (
    target: Target,
    apk: ApkMetadata,
    file: string,
    index: number,
    signal?: AbortSignal,
  ) => Promise<RegistrationCompletion>;
}
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((ok, no) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      ok();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      no(new DownloadError('CANCELLED'));
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
async function discover(page: Page, config: TestConfiguration): Promise<Target[]> {
  const snapshots = await page.locator('xpath=' + config.source.xpath).evaluateAll((elements) =>
    elements.map((element, position) => {
      const anchor = element instanceof HTMLAnchorElement ? element : element.querySelector('a');
      return {
        pid: element.getAttribute('pid') ?? element.closest('[pid]')?.getAttribute('pid') ?? '',
        href: anchor?.href ?? '',
        label: (element.getAttribute('aria-label') ?? element.textContent ?? '')
          .trim()
          .slice(0, 200),
        position,
      };
    }),
  );
  const seen = new Set<string>(),
    targets: Target[] = [];
  for (const item of snapshots) {
    let href = '';
    if (item.href && !item.href.startsWith('javascript:')) href = normalizeUrl(item.href);
    const identity = {
      source: normalizeUrl(config.source.url),
      xpath: config.source.xpath,
      pid: item.pid,
      href,
      ...(!item.pid ? { position: item.position } : {}),
    };
    const key = sha(canonical(identity));
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      ...item,
      ...(/^[A-Za-z0-9._:-]{1,100}$/.test(item.pid.trim()) ? { entryId: item.pid.trim() } : {}),
      href,
      taskId: randomUUID(),
      targetKey: key,
      sourceUrl: href || normalizeUrl(config.source.url),
    });
  }
  if (targets.length > config.download.maxTargets) throw new DownloadError('TARGET_LIMIT');
  return targets;
}
async function locate(page: Page, config: TestConfiguration, target: Target) {
  const matches = page.locator('xpath=' + config.source.xpath);
  const length = await matches.count();
  for (let i = 0; i < length; i++) {
    const candidate = matches.nth(i);
    const data = await candidate.evaluate((element) => {
      const anchor = element instanceof HTMLAnchorElement ? element : element.querySelector('a');
      return {
        pid: element.getAttribute('pid') ?? element.closest('[pid]')?.getAttribute('pid') ?? '',
        href: anchor?.href ?? '',
      };
    });
    let href = '';
    if (data.href && !data.href.startsWith('javascript:')) href = normalizeUrl(data.href);
    if (
      (target.pid ? data.pid === target.pid && href === target.href : i === target.position) &&
      (await candidate.isVisible())
    )
      return candidate;
  }
  throw new DownloadError('TARGET_MISSING');
}
async function capture(
  context: BrowserContext,
  source: Page,
  config: TestConfiguration,
  target: Target,
  signal: AbortSignal,
  beforeAction: () => void,
  mobile: Awaited<ReturnType<typeof androidBrowser>>,
  emit: (event: AutomationEvent) => Promise<void>,
): Promise<Download> {
  let result: Download | undefined;
  const pages = new Set<Page>([source]),
    clicks = new Map<Page, number>();
  let landingClicks = 0;
  const arrived = new Map<Page, { url: string; at: number }>();
  const sourceUrl = source.url();
  const attempted = new WeakMap<Frame, Set<string>>();
  const acted = new Set<Page>();
  const requested = new Set<string>();
  const linkSnapshots = new WeakMap<Frame, { url: string; at: number; links: string[] }>();
  const log = (message: string) =>
    emit({
      type: 'LOG',
      taskId: target.taskId,
      payload: { level: 'INFO', message },
    });
  const requestListener = (request: import('playwright').Request) => {
    try {
      const url = normalizeUrl(request.url());
      if (/\.apk$/i.test(decodeURIComponent(new URL(url).pathname))) requested.add(url);
    } catch {
      /* Unsupported requests are handled by the network policy. */
    }
  };
  const listener = (download: Download) => {
    if (!result) result = download;
    else void download.cancel();
  };
  const attach = (page: Page) => {
    if (pages.size >= config.download.maxLandingClicks + 2) {
      void page.close().catch(() => {});
      return;
    }
    pages.add(page);
    page.on('download', listener);
  };
  const fresh = (page: Page) => attach(page);
  source.on('download', listener);
  context.on('page', fresh);
  context.on('request', requestListener);
  const end = Date.now() + config.download.timeoutMs;
  try {
    beforeAction();
    const element = await locate(source, config, target);
    await element
      .tap({
        timeout: Math.min(config.download.timeoutMs, 10000),
        noWaitAfter: true,
      })
      .catch(() => {});
    await pause(150, signal);
    while (!result && Date.now() < end) {
      for (const page of pages) {
        if (result) break;
        if (page.isClosed()) continue;
        // The source may already have redirected before the icon was clicked.
        // Only a navigation makes it a landing page; popups are handled separately.
        if (page === source && page.url() === sourceUrl) continue;
        const count = clicks.get(page) ?? 0;
        if (
          count >= config.download.maxLandingClicks ||
          landingClicks >= config.download.maxLandingClicks
        )
          continue;
        let u: URL;
        try {
          u = new URL(page.url());
          normalizeUrl(u.href);
        } catch {
          continue;
        }
        const rulesFor = (host: string) => [
          ...config.download.landingRules.filter(
            (r) => r.host.toLowerCase() === host.toLowerCase(),
          ),
          ...config.download.landingRules.filter((r) => r.host === '*'),
        ];
        const rules = rulesFor(u.hostname);
        const previous = arrived.get(page);
        if (!previous || previous.url !== page.url()) {
          arrived.set(page, { url: page.url(), at: Date.now() });
          acted.delete(page);
        }
        try {
          await mobile.confirm(page, 'LANDING', target.taskId);
        } catch (error) {
          if (error instanceof DownloadError) throw error;
          else continue;
        }
        if (
          Date.now() - arrived.get(page)!.at >= Math.max(1500, rules[0]?.autoWaitMs ?? 1500) &&
          (await navigationSite(page)) &&
          !result
        )
          throw new DownloadError('NAVIGATION_SITE');
        if (rules[0]?.mode === 'AUTO') continue;
        const elapsed = Date.now() - arrived.get(page)!.at;
        let clicked = false;
        const sourceLinks = new Map<string, string>();
        for (const frame of page.frames().slice(0, 16)) {
          let frameRules: typeof rules;
          try {
            frameRules = rulesFor(new URL(normalizeUrl(frame.url())).hostname);
          } catch {
            continue;
          }
          if (!frameRules.length || frameRules[0]?.mode === 'AUTO') continue;
          const tap = async (candidate: Locator, signature: string, message: string) => {
            if (!(await candidate.isVisible().catch(() => false))) return false;
            const seen = attempted.get(frame) ?? new Set<string>();
            if (seen.has(signature)) return false;
            seen.add(signature);
            attempted.set(frame, seen);
            beforeAction();
            clicks.set(page, (clicks.get(page) ?? 0) + 1);
            landingClicks++;
            acted.add(page);
            await log(message);
            beforeAction();
            if (Date.now() >= end) throw new DownloadError('DOWNLOAD_FAILED');
            await candidate
              .tap({
                timeout: Math.min(2000, Math.max(1, end - Date.now())),
                noWaitAfter: true,
              })
              .catch(() => {});
            await pause(150, signal);
            return true;
          };
          for (const rule of frameRules) {
            if (rule.mode === 'AUTO') continue;
            if (rule.mode !== 'CLICK' && elapsed < (rule.autoWaitMs ?? 1500)) continue;
            const candidates = frame.locator(rule.by + '=' + rule.selector);
            const n = await candidates.count().catch(() => 0);
            for (let i = 0; i < Math.min(n, 100); i++) {
              const candidate = candidates.nth(i);
              // A redirected source is not another chance to tap its original icon.
              if (
                page === source &&
                frame === page.mainFrame() &&
                normalizeUrl(page.url()) === normalizeUrl(config.source.url) &&
                (await candidate.evaluate(
                  (e, pid) => !!pid && e.getAttribute('pid') === pid,
                  target.pid,
                ))
              )
                continue;
              const signature = canonical([
                frame.url(),
                rule.by,
                rule.selector,
                i,
                await candidate.getAttribute('href'),
              ]);
              clicked = await tap(candidate, signature, '下载入口：已操作配置控件');
              if (clicked || result) break;
            }
            if (clicked || result) break;
          }
          if (clicked || result) break;
          // Do not send another request from the same page after a control has been used.
          if (acted.has(page) || elapsed < Math.max(1500, frameRules[0]?.autoWaitMs ?? 1500))
            continue;
          const controls = frame.getByText(
            /^(?:高速下载|立即下载|安卓下载|安卓版下载|下载\s*APP|普通下载|安全下载|下载安卓版|download\s*apk|install\s*app)$/i,
          );
          const visible: Locator[] = [];
          for (let i = 0, n = Math.min(100, await controls.count().catch(() => 0)); i < n; i++) {
            const candidate = controls.nth(i);
            if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
          }
          if (visible.length === 1) {
            clicked = await tap(
              visible[0]!,
              canonical([frame.url(), 'DOWNLOAD_TEXT']),
              '下载入口：已操作明确下载文字',
            );
            if (clicked || result) break;
          }
          if (visible.length > 1) continue;
          let snapshot = linkSnapshots.get(frame);
          if (!snapshot || snapshot.url !== frame.url() || Date.now() - snapshot.at >= 1000) {
            snapshot = {
              url: frame.url(),
              at: Date.now(),
              links: await frameApkLinks(frame).catch(() => []),
            };
            linkSnapshots.set(frame, snapshot);
          }
          for (const link of snapshot.links) sourceLinks.set(link, frame.url());
        }
        if (!clicked && !result && !acted.has(page) && sourceLinks.size === 1) {
          const [link, referer] = [...sourceLinks.entries()][0]!;
          if (!requested.has(link)) {
            beforeAction();
            requested.add(link);
            landingClicks++;
            acted.add(page);
            await log('下载入口：正在访问源码中的唯一 APK 地址');
            beforeAction();
            if (Date.now() >= end) throw new DownloadError('DOWNLOAD_FAILED');
            if (result) continue;
            const downloadPage = await context.newPage();
            await mobile.prepare(downloadPage);
            beforeAction();
            if (!result)
              await downloadPage
                .goto(link, {
                  referer,
                  waitUntil: 'domcontentloaded',
                  timeout: Math.min(10000, Math.max(1, end - Date.now())),
                })
                .catch(() => {});
          }
        }
      }
      if (!result) await pause(100, signal);
    }
    if (!result) {
      await log('下载等待结束：未收到浏览器下载文件');
      throw new DownloadError('DOWNLOAD_FAILED');
    }
    await log('下载传输：已收到浏览器文件，等待保存与 APK 校验');
    return result;
  } finally {
    context.off('page', fresh);
    context.off('request', requestListener);
    for (const page of pages) page.off('download', listener);
  }
}
export async function runDownload(
  config: TestConfiguration,
  nodeId: string,
  root: string,
  toolsRoot: string,
  signal: AbortSignal,
  emit: (event: AutomationEvent) => Promise<void>,
  options: DownloadOptions = {},
) {
  root = resolve(root);
  const policy = options.policy ?? new NetworkPolicy(),
    now = options.now ?? (() => new Date());
  const max = config.download.maxApkBytes ?? 268435456;
  const beforeAction = () => {
    if (signal.aborted) throw new DownloadError('CANCELLED');
    options.beforeAction?.();
  };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const jobs = join(root, 'jobs');
  await mkdir(jobs, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(join(jobs, 'download-'));
  const profile = join(temp, 'profile');
  const cache = await ApkCache.open(join(root, 'cache'));
  const egress = await startEgress(policy, max, config.download.timeoutMs);
  let browser: Browser | undefined, context: BrowserContext | undefined;
  let clean = false;
  let limit = false;
  let proxyClosed = false,
    cacheClosed = false;
  const cleanup = async () => {
    if (clean) return;
    await context?.close();
    context = undefined;
    await browser?.close();
    browser = undefined;
    if (!proxyClosed) {
      await egress.close();
      proxyClosed = true;
    }
    if (!cacheClosed) {
      cache.close();
      cacheClosed = true;
    }
    await removeOwned(jobs, temp);
    clean = true;
    await options.onClosed?.();
  };
  const abort = () => {
    void browser?.close().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await options.onBrowser?.({ pid: 0, profile });
    beforeAction();
    await policy.endpoint(config.source.url);
    beforeAction();
    const runtime = (await import(
      pathToFileURL(join(resolve(toolsRoot), 'node_modules/playwright/index.mjs')).href
    )) as Pick<typeof import('playwright'), 'chromium' | 'devices'>;
    const chromium = options.chromium ?? runtime.chromium;
    const mobile = runtime.devices['Pixel 7']!;
    // Playwright requires its explicit persistent-context API for a supplied profile.
    // Each batch uses this fresh private directory; no shared browser profile is opened.
    beforeAction();
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      downloadsPath: join(temp, 'raw'),
      proxy: { server: egress.url, bypass: '<-loopback>' },
      acceptDownloads: true,
      serviceWorkers: 'block',
      viewport: mobile.viewport,
      screen: { width: 412, height: 915 },
      deviceScaleFactor: mobile.deviceScaleFactor,
      isMobile: true,
      hasTouch: true,
      userAgent: config.source.browserUserAgent || mobile.userAgent,
      args: [
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        '--disable-features=Prerender2,SpeculationRulesPrefetch',
      ],
    });
    browser = context.browser()!;
    const mobileBrowser = await androidBrowser(
      context,
      config.source.browserUserAgent || mobile.userAgent,
      emit,
    );
    await context.route('**/*', async (route) => {
      try {
        normalizeUrl(route.request().url());
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: join(temp, 'raw'),
      eventsEnabled: true,
    });
    cdp.on('Browser.downloadProgress', (e) => {
      if (e.receivedBytes > max) {
        limit = true;
        void cdp.send('Browser.cancelDownload', { guid: e.guid }).catch(() => {});
      }
    });
    const source = await context.newPage();
    await mobileBrowser.prepare(source);
    let targets: Target[] | undefined;
    for (let attempt = 0; attempt < 2 && !targets; attempt++) {
      try {
        beforeAction();
        await source.goto(config.source.url, {
          waitUntil: 'domcontentloaded',
          timeout: config.download.timeoutMs,
        });
        targets = await discover(source, config);
        await mobileBrowser.confirm(source, 'SOURCE');
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof DownloadError && error.code === 'TARGET_LIMIT') throw error;
        if (attempt === 1)
          throw new DownloadError(egress.wasBlocked() ? 'NETWORK_BLOCKED' : 'DISCOVERY_FAILED');
      }
    }
    if (!targets!.length)
      await emit({
        type: 'TARGETS_DISCOVERED',
        payload: { targets: [], startIndex: 0, complete: true },
      });
    for (let start = 0; start < targets!.length; start += 20)
      await emit({
        type: 'TARGETS_DISCOVERED',
        payload: {
          targets: targets!
            .slice(start, start + 20)
            .map(({ taskId, targetKey, label, sourceUrl, entryId }) => ({
              taskId,
              targetKey,
              label,
              sourceUrl,
              ...(entryId ? { entryId } : {}),
            })),
          startIndex: start,
          complete: start + 20 >= targets!.length,
        },
      });
    let succeeded = 0,
      navigationSkipped = 0,
      review = false,
      cleanupIncomplete = false;
    for (const [index, target] of targets!.entries()) {
      beforeAction();
      const day = options.fixedCacheDay ?? cacheDay(now());
      await emit({
        type: 'TASK_STAGE',
        taskId: target.taskId,
        payload: { stage: 'DOWNLOADING' },
      });
      let apk: ApkMetadata | null = null,
        hit = false,
        errorCode = 'DOWNLOAD_FAILED';
      try {
        apk = await cache.get(nodeId, day, target.targetKey, max, signal);
        if (apk) {
          hit = true;
          cache.pin(nodeId, day, target.targetKey);
        } else {
          for (
            let attempt = 0;
            attempt <= (options.dailyDownload ? 0 : config.download.retries);
            attempt++
          ) {
            const work = await mkdtemp(join(temp, 'target-'));
            let download: Download | undefined;
            try {
              if (signal.aborted) throw new DownloadError('CANCELLED');
              for (const page of context.pages()) if (page !== source) await page.close();
              if (normalizeUrl(source.url()) !== normalizeUrl(config.source.url))
                await source.goto(config.source.url, {
                  waitUntil: 'domcontentloaded',
                  timeout: config.download.timeoutMs,
                });
              limit = false;
              download = await capture(
                context,
                source,
                config,
                target,
                signal,
                beforeAction,
                mobileBrowser,
                emit,
              );
              const file = join(work, 'payload.apk');
              const timeout = setTimeout(() => void download?.cancel(), config.download.timeoutMs);
              try {
                const stream = await download.createReadStream();
                if (!stream) throw new DownloadError('DOWNLOAD_FAILED');
                let size = 0;
                await pipeline(
                  stream,
                  new Transform({
                    transform(chunk: Buffer, _enc, done) {
                      size += chunk.length;
                      done(size > max ? new DownloadError('APK_TOO_LARGE') : null, chunk);
                    },
                  }),
                  createWriteStream(file, { flags: 'wx', mode: 0o600 }),
                  { signal },
                );
                const inspected = await inspectApk(file, max, day, signal);
                await cache.put(nodeId, day, target.targetKey, file, inspected);
                apk = inspected;
                break;
              } finally {
                clearTimeout(timeout);
                await download.cancel().catch(() => {});
              }
            } catch (error) {
              if (signal.aborted) throw error;
              errorCode = limit
                ? 'APK_TOO_LARGE'
                : error instanceof DownloadError && error.code !== 'DOWNLOAD_FAILED'
                  ? error.code
                  : egress.wasBlocked()
                    ? 'NETWORK_BLOCKED'
                    : 'DOWNLOAD_FAILED';
              if (errorCode === 'NAVIGATION_SITE') break;
              if (attempt < config.download.retries) await pause(250 * 2 ** attempt, signal);
            } finally {
              await download?.delete().catch(() => {});
              await removeOwned(temp, work);
            }
          }
        }
        if (apk) {
          await emit({
            type: 'TASK_STAGE',
            taskId: target.taskId,
            payload: { stage: 'DOWNLOADED', cacheHit: hit, apk },
          });
          const completion = options.afterDownload
            ? await options.afterDownload(
                target,
                apk,
                cache.path(cache.key(nodeId, day, target.targetKey)),
                index,
              )
            : {
                status: 'SUCCEEDED',
                proof: 'FILE_VALIDATION',
                artifactIds: [],
                cleanupComplete: true,
              };
          const { cleanupComplete, ...payload } = completion;
          await emit({
            type: 'TASK_FINISHED',
            taskId: target.taskId,
            payload,
          });
          if (completion.status === 'SUCCEEDED') succeeded++;
          cleanupIncomplete = !cleanupComplete;
          review = cleanupIncomplete || completion.status === 'UNKNOWN';
          if (review) break;
          if (signal.aborted) throw new DownloadError('CANCELLED');
        } else {
          const skipped = errorCode === 'NAVIGATION_SITE';
          if (skipped) navigationSkipped++;
          await emit({
            type: 'TASK_FINISHED',
            taskId: target.taskId,
            payload: {
              status: skipped ? 'SKIPPED' : 'FAILED',
              proof: 'NONE',
              artifactIds: [],
              errorCode,
            },
          });
        }
      } catch (error) {
        if (signal.aborted) throw error;
        throw error;
      }
    }
    cache.releasePins();
    const cutoff = options.dailyDownload
      ? (options.fixedCacheDay ?? cacheDay(now()))
      : cacheDay(new Date(now().getTime() - 7 * 86400000));
    if (
      !options.dailyDownload ||
      (succeeded > 0 && succeeded + navigationSkipped === targets!.length)
    )
      await cache.prune(cutoff);
    await cleanup();
    await emit({
      type: 'RUN_FINISHED',
      payload: {
        status: review
          ? 'NEEDS_REVIEW'
          : !targets!.length
            ? 'FAILED'
            : succeeded > 0 && succeeded + navigationSkipped === targets!.length
              ? 'SUCCEEDED'
              : succeeded
                ? 'PARTIAL_FAILED'
                : 'FAILED',
        ...(review
          ? {
              errorCode: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'REGISTRATION_UNKNOWN',
            }
          : !targets!.length
            ? { errorCode: 'NO_TARGETS' }
            : navigationSkipped === targets!.length
              ? { errorCode: 'NO_APK_AVAILABLE' }
              : {}),
      },
    });
  } catch (error) {
    if (signal.aborted) throw new DownloadError('CANCELLED');
    const code = error instanceof DownloadError ? error.code : 'DOWNLOAD_FAILED';
    await cleanup();
    await emit({
      type: 'RUN_FINISHED',
      payload: {
        status: 'FAILED',
        errorCode: [
          'TARGET_LIMIT',
          'DISCOVERY_FAILED',
          'NETWORK_BLOCKED',
          'APK_INVALID',
          'APK_TOO_LARGE',
        ].includes(code)
          ? code
          : 'DOWNLOAD_FAILED',
      },
    });
  } finally {
    signal.removeEventListener('abort', abort);
    await cleanup();
  }
}
