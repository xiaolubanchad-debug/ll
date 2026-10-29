import type { Page } from 'playwright';

// Classify only the displayed destination. Never follow a directory's links.
export async function navigationSite(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const r = element.getBoundingClientRect(),
        s = getComputedStyle(element);
      return (
        r.width > 0 &&
        r.height > 0 &&
        r.bottom > 0 &&
        r.top < innerHeight &&
        r.right > 0 &&
        r.left < innerWidth &&
        s.visibility !== 'hidden' &&
        s.display !== 'none'
      );
    };
    const links = [...document.querySelectorAll('a[href]')].filter(visible);
    if (
      links.some(
        (a) =>
          /\.apk(?:$|[?#])/i.test((a as HTMLAnchorElement).href) ||
          /\.apk$/i.test(a.getAttribute('download') ?? ''),
      )
    )
      return false;
    const tiles = [...document.querySelectorAll('a.jgg-item[pid]')].filter(visible);
    const primary = [...document.querySelectorAll('a,button,div,span,[role=button]')]
      .filter(visible)
      .some(
        (e) =>
          !e.closest('.jgg-item') &&
          /^(高速下载|普通下载|安卓下载|安卓版下载|立即下载|下载APP|点击下载|安全下载|下载安卓版|downloadapk|installapp)$/i.test(
            (e.textContent ?? '').replace(/\s/g, ''),
          ),
      );
    if (primary) return false;
    if (new Set(tiles.map((e) => e.getAttribute('pid'))).size >= 8) return true;
    const heading = [...document.querySelectorAll('title,h1,h2,h3,[role=heading]')]
      .map((e) => (e.textContent ?? '').slice(0, 300))
      .join(' ');
    if (!/导航|应用推荐|应用大全|软件合集|app\s*directory/i.test(heading)) return false;
    const icons = links.filter((a) => a.querySelector('img,svg') && (a.textContent ?? '').trim());
    const hosts = new Set(
      icons.flatMap((a) => {
        try {
          const u = new URL((a as HTMLAnchorElement).href);
          return /^https?:$/.test(u.protocol) && u.hostname !== location.hostname
            ? [u.hostname]
            : [];
        } catch {
          return [];
        }
      }),
    );
    return icons.length >= 8 && hosts.size >= 4;
  });
}
