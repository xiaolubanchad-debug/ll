import type { Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import type { SourceElement, SourceElementCheck } from '@apk/contracts';
import { sourceElementXPath, sourceCheckXPath } from '@apk/contracts';
import type { AutomationEvent } from './download.js';
import { canonical, sha, DownloadError } from './common.js';

export const sourceAttributeNames = (xpath: string) =>
  [
    ...new Set([
      ...Array.from(xpath.matchAll(/@([A-Za-z_][A-Za-z0-9_.:-]{0,63})/g), (m) => m[1]),
      'id',
      'name',
      'pid',
    ]),
  ]
    .filter(
      (name) =>
        !(
          /^(?:href|src|style|value|on)/i.test(name) ||
          /password|secret|token|authorization|cookie|credential|csrf|api.?key|session/i.test(name)
        ),
    )
    .slice(0, 20);
type Raw = {
  position: number;
  tag: string;
  label: string;
  attributes: { name: string; value: string }[];
};
export function describeSourceElements(rows: Raw[]): SourceElement[] {
  const signature = (a: Raw['attributes']) => canonical(a),
    counts = new Map<string, number>();
  for (const row of rows)
    for (const key of new Set(row.attributes.map((a) => signature([a]))))
      counts.set(key, (counts.get(key) ?? 0) + 1);
  return rows.map((row) => {
    const single = row.attributes.map((a) => [a]).find((a) => counts.get(signature(a)) === 1),
      combined = row.attributes.slice(0, 3);
    const unique =
      single ??
      (combined.length &&
      rows.filter((r) =>
        combined.every((v) => r.attributes.some((x) => x.name === v.name && x.value === v.value)),
      ).length === 1
        ? combined
        : undefined);
    const attributes = unique ?? [],
      scope = unique ? ('ATTRIBUTE' as const) : ('POSITION' as const);
    return {
      key: sha(canonical(unique ? { attributes } : { position: row.position, tag: row.tag })),
      position: row.position,
      tag: row.tag,
      scope,
      attributes,
      label: row.label,
    };
  });
}
export async function checkConfiguredSourceElements(
  page: Page,
  rules: SourceElementCheck[],
  signal: AbortSignal,
  emit: (event: AutomationEvent) => Promise<void>,
  beforeAction: () => void,
  unreadable = false,
) {
  if (!rules.length) return;
  const selectors = rules.map((rule) => ({ id: rule.id, xpath: sourceCheckXPath(rule) }));
  const read = () =>
    page.evaluate(
      (items) =>
        items.map((item) => {
          try {
            const result = document.evaluate(
              item.xpath,
              document,
              null,
              XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
              null,
            );
            for (let i = 0; i < result.snapshotLength; i++)
              if (!(result.snapshotItem(i) instanceof Element))
                return { id: item.id, status: 'READ_FAILED' as const, matchedCount: 0 };
            return {
              id: item.id,
              status: result.snapshotLength ? ('FOUND' as const) : ('NOT_FOUND' as const),
              matchedCount: result.snapshotLength,
            };
          } catch {
            return { id: item.id, status: 'READ_FAILED' as const, matchedCount: 0 };
          }
        }),
      selectors,
    );
  beforeAction();
  signal.throwIfAborted();
  let results = unreadable
    ? rules.map((rule) => ({ id: rule.id, status: 'READ_FAILED' as const, matchedCount: 0 }))
    : await read().catch(() =>
        rules.map((rule) => ({ id: rule.id, status: 'READ_FAILED' as const, matchedCount: 0 })),
      );
  const deadline = Date.now() + 3000;
  while (!unreadable && results.some((r) => r.status === 'NOT_FOUND') && Date.now() < deadline) {
    await delay(Math.min(250, Math.max(1, deadline - Date.now())), undefined, { signal });
    beforeAction();
    results = await read().catch(() =>
      rules.map((rule) => ({ id: rule.id, status: 'READ_FAILED' as const, matchedCount: 0 })),
    );
  }
  for (const result of results) {
    beforeAction();
    signal.throwIfAborted();
    await emit({
      type: 'ELEMENT_OBSERVATION',
      payload: {
        phase: 'CHECK',
        ruleId: result.id,
        status: result.status,
        matchedCount: result.matchedCount,
      },
    });
  }
}
export async function locateSourceElement(page: Page, xpath: string, element: SourceElement) {
  const locator = page.locator('xpath=' + sourceElementXPath(xpath, element));
  if (!(await locator.count())) throw new DownloadError('TARGET_MISSING');
  const visible = [];
  for (let i = 0, n = await locator.count(); i < Math.min(n, 1000); i++)
    if (await locator.nth(i).isVisible()) visible.push(locator.nth(i));
  if (!visible.length) throw new DownloadError('TARGET_NOT_VISIBLE');
  if (visible.length > 1) throw new DownloadError('TARGET_NOT_UNIQUE');
  return visible[0]!;
}
