import type { Frame } from 'playwright';
import { normalizeUrl } from './common.js';

const sourceLimit = 1024 * 1024;
const valueLimit = 4096;

function decodeLiteral(value: string) {
  return value
    .replace(/\\(?:u([\da-f]{4})|x([\da-f]{2})|([\\/"']))/gi, (_all, u, x, char) =>
      u || x ? String.fromCharCode(parseInt(u || x, 16)) : char,
    )
    .replace(/&(?:amp|quot|apos|#(\d{1,5})|#x([\da-f]{1,4}));/gi, (all, n, hex) => {
      if (n || hex) return String.fromCharCode(parseInt(n || hex, hex ? 16 : 10));
      return all.toLowerCase() === '&amp;' ? '&' : all.toLowerCase() === '&quot;' ? '"' : "'";
    });
}

// This is string-literal discovery only. Expressions are never evaluated.
function* literals(source: string) {
  for (let i = 0; i < source.length; i++) {
    const quote = source[i];
    if (quote === '`') {
      for (i++; i < source.length && source[i] !== '`'; i++) if (source[i] === '\\') i++;
      continue;
    }
    if (quote !== '"' && quote !== "'") continue;
    const start = i + 1;
    for (i++; i < source.length; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === quote) {
        let before = start - 2,
          after = i + 1;
        while (before >= 0 && /\s/.test(source[before]!)) before--;
        while (after < source.length && /\s/.test(source[after]!)) after++;
        if (i - start <= valueLimit && source[before] !== '+' && source[after] !== '+')
          yield source.slice(start, i);
        break;
      }
    }
  }
}

export function extractApkLinks(base: string, attributes: string[], scripts: string[]): string[] {
  const found = new Set<string>();
  let budget = sourceLimit;
  const add = (raw: string) => {
    if (!raw || raw.length > valueLimit || found.size >= 32) return;
    const value = decodeLiteral(raw).trim();
    // A filename in prose is not enough; require an explicit URL or a path.
    if (!/^(?:https?:\/\/|\/|\.{1,2}\/|[\w.-]+\/)/i.test(value)) return;
    if (/[\s<>"'`\\]/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32)) return;
    try {
      const url = new URL(value, base);
      if (!/\.apk$/i.test(decodeURIComponent(url.pathname))) return;
      found.add(normalizeUrl(url.href));
    } catch {
      // Invalid or unsupported literals are ignored, never executed.
    }
  };
  for (const value of attributes.slice(0, 512)) {
    if (budget <= 0) break;
    const text = value.slice(0, Math.min(valueLimit, budget));
    budget -= text.length;
    if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) continue;
    add(text);
    for (const literal of literals(text)) add(literal);
  }
  for (const script of scripts.slice(0, 128)) {
    if (budget <= 0) break;
    const text = script.slice(0, budget);
    budget -= text.length;
    for (const literal of literals(text)) add(literal);
  }
  return [...found];
}

export async function frameApkLinks(frame: Frame) {
  const input = await frame.evaluate((limit) => {
    let remaining = limit;
    const take = (value: string | null) => {
      const text = (value ?? '').slice(0, Math.max(0, Math.min(4096, remaining)));
      remaining -= text.length;
      return text;
    };
    const attributes: string[] = [];
    for (const element of document.querySelectorAll(
      'a[href],[data-url],[data-download],[data-apk],[data-apk-url],[data-android-url],[onclick]',
    )) {
      for (const name of [
        'href',
        'data-url',
        'data-download',
        'data-apk',
        'data-apk-url',
        'data-android-url',
        'onclick',
      ]) {
        if (element.hasAttribute(name)) attributes.push(take(element.getAttribute(name)));
        if (attributes.length >= 512 || remaining <= 0) break;
      }
      if (attributes.length >= 512 || remaining <= 0) break;
    }
    const scripts: string[] = [];
    for (const script of document.scripts) {
      if (script.src || remaining <= 0 || scripts.length >= 128) continue;
      const text = (script.textContent ?? '').slice(0, remaining);
      scripts.push(text);
      remaining -= text.length;
    }
    return { base: document.baseURI, attributes, scripts };
  }, sourceLimit);
  return extractApkLinks(input.base, input.attributes, input.scripts);
}
