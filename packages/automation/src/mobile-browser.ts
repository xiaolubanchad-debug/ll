import type { BrowserContext, Page } from 'playwright';
import { androidBrowserUa } from '@apk/contracts';
import { DownloadError } from './common.js';
import type { AutomationEvent } from './download.js';

export async function androidBrowser(
  context: BrowserContext,
  userAgent: string,
  emit: (event: AutomationEvent) => Promise<void>,
) {
  if (!androidBrowserUa(userAgent) || !userAgent)
    throw new DownloadError('ANDROID_BROWSER_REQUIRED');
  const version = userAgent.match(/Chrome\/([\d.]+)/)![1],
    major = version.split('.')[0],
    androidVersion = (userAgent.match(/Android\s+([\d.]+)/)?.[1] ?? '13')
      .split('.')
      .concat('0', '0')
      .slice(0, 3)
      .join('.');
  const configured = new WeakMap<Page, Promise<void>>(),
    confirmed = new WeakMap<Page, string>();
  await context.setExtraHTTPHeaders({
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"',
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}"`,
  });
  // Popup scripts can execute before Playwright exposes their Page object.
  await context.addInitScript(
    ({ major, version, androidVersion }) => {
      Object.defineProperty(navigator, 'platform', {
        configurable: true,
        get: () => 'Linux armv8l',
      });
      const data = (
        navigator as Navigator & {
          userAgentData?: {
            getHighEntropyValues: (keys: string[]) => Promise<Record<string, unknown>>;
          };
        }
      ).userAgentData;
      if (!data) return;
      const proto = Object.getPrototypeOf(data),
        get = data.getHighEntropyValues;
      const brands = [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
      ];
      for (const [key, value] of Object.entries({ mobile: true, platform: 'Android', brands }))
        Object.defineProperty(proto, key, { configurable: true, get: () => value });
      Object.defineProperty(proto, 'toJSON', {
        configurable: true,
        value: () => ({ brands, mobile: true, platform: 'Android' }),
      });
      Object.defineProperty(proto, 'getHighEntropyValues', {
        configurable: true,
        value: async function (this: typeof data, keys: string[]) {
          const result = await get.call(this, keys),
            values: Record<string, unknown> = {
              architecture: 'arm',
              bitness: '64',
              model: 'Pixel 7',
              platform: 'Android',
              platformVersion: androidVersion,
              uaFullVersion: version,
              fullVersionList: brands.map((b) => ({ ...b, version })),
              wow64: false,
            };
          return {
            ...result,
            brands,
            mobile: true,
            platform: 'Android',
            ...Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, values[k]])),
          };
        },
      });
    },
    { major, version, androidVersion },
  );
  const prepare = (page: Page) => {
    let pending = configured.get(page);
    if (!pending) {
      pending = (async () => {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setUserAgentOverride', {
          userAgent,
          platform: 'Linux armv8l',
          userAgentMetadata: {
            brands: [
              { brand: 'Chromium', version: major },
              { brand: 'Google Chrome', version: major },
            ],
            fullVersionList: [
              { brand: 'Chromium', version },
              { brand: 'Google Chrome', version },
            ],
            platform: 'Android',
            platformVersion: androidVersion,
            architecture: 'arm',
            model: 'Pixel 7',
            mobile: true,
            bitness: '64',
            wow64: false,
          },
        });
      })();
      configured.set(page, pending);
    }
    return pending;
  };
  // The context init script covers the first popup document; CDP supplies subsequent requests.
  context.on('page', (page) => {
    void prepare(page).catch(() => {});
  });
  const confirm = async (page: Page, role: 'SOURCE' | 'LANDING', taskId?: string) => {
    await prepare(page);
    if (confirmed.get(page) === page.url()) return;
    if (!/^https?:/.test(page.url())) return;
    const actual = await page.evaluate(async () => {
      const hints = (
        navigator as Navigator & {
          userAgentData?: {
            mobile: boolean;
            platform: string;
            getHighEntropyValues: (keys: string[]) => Promise<Record<string, unknown>>;
          };
        }
      ).userAgentData;
      return {
        ua: navigator.userAgent,
        platform: navigator.platform,
        touch: navigator.maxTouchPoints > 0,
        mobile: matchMedia('(pointer: coarse)').matches,
        width: screen.width,
        height: screen.height,
        hints: hints
          ? {
              mobile: hints.mobile,
              platform: hints.platform,
              platformVersion: (await hints.getHighEntropyValues(['platformVersion']))
                .platformVersion,
            }
          : null,
        secure: isSecureContext,
      };
    });
    if (
      actual.ua !== userAgent ||
      !actual.platform.startsWith('Linux') ||
      !actual.touch ||
      !actual.mobile ||
      actual.width !== 412 ||
      actual.height !== 915 ||
      (actual.secure &&
        (!actual.hints?.mobile ||
          actual.hints.platform !== 'Android' ||
          actual.hints.platformVersion !== androidVersion))
    )
      throw new DownloadError('BROWSER_ENVIRONMENT_INVALID');
    confirmed.set(page, page.url());
    await emit({
      type: 'BROWSER_ENVIRONMENT',
      ...(taskId ? { taskId } : {}),
      payload: {
        role,
        platform: 'Android',
        mobile: true,
        touch: true,
        width: 412,
        height: 915,
        userAgent: actual.ua,
        scope: 'EMULATED_BROWSER',
      },
    });
  };
  return { prepare, confirm };
}
