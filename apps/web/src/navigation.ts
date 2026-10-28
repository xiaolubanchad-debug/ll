import { ref } from 'vue';
export type Section =
  | 'overview'
  | 'nodes'
  | 'runs'
  | 'config'
  | 'security'
  | 'results'
  | 'assets'
  | 'proxies';
const sections: Section[] = [
  'overview',
  'nodes',
  'runs',
  'config',
  'security',
  'results',
  'assets',
  'proxies',
];
function parse() {
  const url = new URL(location.hash.slice(1) || '/overview', 'https://console.invalid');
  const parts = url.pathname.split('/').filter(Boolean),
    section = sections.includes(parts[0] as Section) ? (parts[0] as Section) : 'overview';
  const id = section === 'runs' && /^[a-f0-9-]{36}$/i.test(parts[1] ?? '') ? parts[1] : '';
  return { section, id, query: url.searchParams, key: url.pathname + url.search };
}
export const route = ref(parse());
window.addEventListener('hashchange', () => {
  route.value = parse();
});
export function navigate(section: Section, id = '', query: Record<string, string> = {}) {
  const params = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== ''));
  location.hash =
    '/' + section + (id ? '/' + encodeURIComponent(id) : '') + (params.size ? '?' + params : '');
}
export const href = (section: Section, id = '', query: Record<string, string> = {}) =>
  '#/' +
  section +
  (id ? '/' + encodeURIComponent(id) : '') +
  (Object.keys(query).length ? '?' + new URLSearchParams(query) : '');
