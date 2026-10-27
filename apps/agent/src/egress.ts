import { readFile } from 'node:fs/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
export function firewallRules(uid: number, addresses: string[], port: number, replace: boolean) {
  if (
    !Number.isInteger(uid) ||
    uid < 1 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    addresses.some((a) => !isIP(a) || !/^[a-fA-F0-9:.]+$/.test(a))
  )
    throw Error('EGRESS_RULE_INVALID');
  const allow = addresses
    .map(
      (a) =>
        `  meta skuid ${uid} ${isIP(a) === 4 ? 'ip' : 'ip6'} daddr ${a} tcp dport ${port} accept`,
    )
    .join('\n');
  return `${replace ? 'delete table inet apk_platform\n' : ''}table inet apk_platform {\n chain output {\n  type filter hook output priority -10; policy accept;\n  meta skuid ${uid} oifname "lo" accept\n${allow}\n  meta skuid ${uid} ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 } reject\n  meta skuid ${uid} ip6 daddr { ::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8, 2001:db8::/32 } reject\n }\n}\n`;
}
export async function installEgress() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw Error('EGRESS_ROOT_REQUIRED');
  const config = JSON.parse(await readFile('/var/lib/apk-platform/egress-policy.json', 'utf8')) as {
    apiUrl: string;
  };
  const url = new URL(config.apiUrl);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('HUB_URL_INVALID');
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
  if (!addresses.length) throw Error('HUB_UNREACHABLE');
  const uid = Number(
    execFileSync('/usr/bin/id', ['-u', 'apk-runner'], { encoding: 'utf8' }).trim(),
  );
  const exists =
    spawnSync('/usr/sbin/nft', ['list', 'table', 'inet', 'apk_platform'], { stdio: 'ignore' })
      .status === 0;
  const rules = firewallRules(
    uid,
    addresses.map((a) => a.address),
    Number(url.port || 443),
    exists,
  );
  const result = spawnSync('/usr/sbin/nft', ['-f', '-'], {
    input: rules,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  if (result.status !== 0) throw Error('EGRESS_INSTALL_FAILED');
}
