import { mkdir, mkdtemp } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Browser, BrowserContext, Page, Download, BrowserType } from 'playwright';
import type { TestConfiguration, ApkMetadata } from '@apk/contracts';
import { ApkCache, removeOwned } from './cache.js';
import { inspectApk } from './apk.js';
import { NetworkPolicy, startEgress } from './network.js';
import { sha, canonical, normalizeUrl, cacheDay, DownloadError } from './common.js';
import type { RegistrationCompletion } from './registration.js';
export interface AutomationEvent {
  type: 'TARGETS_DISCOVERED' | 'TASK_STAGE' | 'TASK_FINISHED' | 'RUN_FINISHED' | 'PROXY_CHECKED';
  taskId?: string;
  payload: Record<string, unknown>;
}
export interface Target {
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
): Promise<Download> {
  let result: Download | undefined;
  const pages = new Set<Page>([source]),
    clicks = new Map<Page, number>();
  let landingClicks = 0;
  const arrived = new Map<Page, { url: string; at: number }>();
  const sourceUrl = source.url();
  const attempted = new WeakMap<Page, Set<string>>();
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
  const end = Date.now() + config.download.timeoutMs;
  try {
    beforeAction();
    const element = await locate(source, config, target);
    await element
      .tap({ timeout: Math.min(config.download.timeoutMs, 10000), noWaitAfter: true })
      .catch(() => {});
    await pause(150, signal);
    while (!result && Date.now() < end) {
      for (const page of pages) {
        if (result || page.isClosed()) break;
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
        const rules = [
          ...config.download.landingRules.filter(
            (r) => r.host.toLowerCase() === u.hostname.toLowerCase(),
          ),
          ...config.download.landingRules.filter((r) => r.host === '*'),
        ];
        const previous = arrived.get(page);
        if (!previous || previous.url !== page.url())
          arrived.set(page, { url: page.url(), at: Date.now() });
        if (rules[0]?.mode === 'AUTO') continue;
        for (const rule of rules) {
          if (rule.mode === 'AUTO') continue;
          const elapsed = Date.now() - arrived.get(page)!.at;
          if (rule.mode !== 'CLICK' && elapsed < (rule.autoWaitMs ?? 1500)) continue;
          const candidates = page.locator(rule.by + '=' + rule.selector);
          const n = await candidates.count().catch(() => 0);
          let clicked = false;
          for (let i = 0; i < Math.min(n, 100); i++) {
            const candidate = candidates.nth(i);
            if (!(await candidate.isVisible().catch(() => false))) continue;
            const signature = canonical([
              page.url(),
              rule.by,
              rule.selector,
              i,
              await candidate.getAttribute('href'),
            ]);
            const seen = attempted.get(page) ?? new Set<string>();
            if (seen.has(signature)) continue;
            seen.add(signature);
            attempted.set(page, seen);
            // Do not re-click the source icon while waiting for a popup or navigation.
            if (
              page === source &&
              normalizeUrl(page.url()) === normalizeUrl(config.source.url) &&
              (await candidate.evaluate(
                (e, pid) => !!pid && e.getAttribute('pid') === pid,
                target.pid,
              ))
            )
              continue;
            clicks.set(page, count + 1);
            landingClicks++;
            beforeAction();
            await candidate.tap({ timeout: 2000, noWaitAfter: true }).catch(() => {});
            clicked = true;
            await pause(150, signal);
            break;
          }
          if (clicked || result) break;
        }
      }
      if (!result) await pause(100, signal);
    }
    if (!result) throw new DownloadError('DOWNLOAD_FAILED');
    return result;
  } finally {
    context.off('page', fresh);
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
    let targets: Target[] | undefined;
    for (let attempt = 0; attempt < 2 && !targets; attempt++) {
      try {
        beforeAction();
        await source.goto(config.source.url, {
          waitUntil: 'domcontentloaded',
          timeout: config.download.timeoutMs,
        });
        targets = await discover(source, config);
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
      review = false,
      cleanupIncomplete = false;
    for (const [index, target] of targets!.entries()) {
      beforeAction();
      const day = options.fixedCacheDay ?? cacheDay(now());
      await emit({ type: 'TASK_STAGE', taskId: target.taskId, payload: { stage: 'DOWNLOADING' } });
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
              download = await capture(context, source, config, target, signal, beforeAction);
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
        } else
          await emit({
            type: 'TASK_FINISHED',
            taskId: target.taskId,
            payload: { status: 'FAILED', proof: 'NONE', artifactIds: [], errorCode },
          });
      } catch (error) {
        if (signal.aborted) throw error;
        throw error;
      }
    }
    cache.releasePins();
    const cutoff = options.dailyDownload
      ? (options.fixedCacheDay ?? cacheDay(now()))
      : cacheDay(new Date(now().getTime() - 7 * 86400000));
    if (!options.dailyDownload || (targets!.length > 0 && succeeded === targets!.length))
      await cache.prune(cutoff);
    await cleanup();
    await emit({
      type: 'RUN_FINISHED',
      payload: {
        status: review
          ? 'NEEDS_REVIEW'
          : !targets!.length
            ? 'FAILED'
            : succeeded === targets!.length
              ? 'SUCCEEDED'
              : succeeded
                ? 'PARTIAL_FAILED'
                : 'FAILED',
        ...(review
          ? { errorCode: cleanupIncomplete ? 'CLEANUP_INCOMPLETE' : 'REGISTRATION_UNKNOWN' }
          : !targets!.length
            ? { errorCode: 'NO_TARGETS' }
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
