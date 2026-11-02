import type { SourceElement, SourceElementCheck } from './generated/types.js';

export function xpathString(value: string): string {
  if (!value.includes("'")) return "'" + value + "'";
  if (!value.includes('"')) return '"' + value + '"';
  return (
    'concat(' +
    value
      .split("'")
      .map((part) => "'" + part + "'")
      .join(',"\'",') +
    ')'
  );
}
export function sourceElementXPath(xpath: string, element: SourceElement) {
  const base = '(' + xpath + ')';
  return element.scope === 'POSITION'
    ? base + '[' + (element.position + 1) + ']'
    : base +
        '[' +
        element.attributes
          .map((a) => '@*[name()=' + xpathString(a.name) + ']=' + xpathString(a.value))
          .join(' and ') +
        ']';
}
export function sourceElementLabel(element: SourceElement) {
  return (
    element.tag +
    (element.scope === 'ATTRIBUTE'
      ? element.attributes.map((a) => '[' + a.name + '=' + JSON.stringify(a.value) + ']').join('')
      : ' · XPath 第 ' + (element.position + 1) + ' 项')
  );
}
export function sourceCheckXPath(rule: SourceElementCheck): string {
  if (rule.kind === 'XPATH') return rule.xpath;
  if (rule.kind === 'TAG') return '//' + rule.tag;
  return '//*[@*[name()=' + xpathString(rule.attribute) + ']=' + xpathString(rule.value) + ']';
}
