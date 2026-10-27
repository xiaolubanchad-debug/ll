import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
// Only a Chromium process owned by this service and carrying the exact dedicated
// profile argument may be terminated. Never kill by executable name or bare PID.
export async function cleanupBrowser(root: string, profile: string) {
  if (!resolve(profile).startsWith(resolve(root) + sep)) return false;
  if (process.platform !== 'linux') return false;
  const matches = async () => {
    const found: number[] = [];
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const info = await stat('/proc/' + entry);
        if (info.uid !== process.getuid?.()) continue;
        const args = (await readFile('/proc/' + entry + '/cmdline', 'utf8')).split('\0');
        if (args.includes('--user-data-dir=' + profile)) found.push(Number(entry));
      } catch {
        /* exited or inaccessible process */
      }
    }
    return found;
  };
  let current = await matches();
  for (const pid of current) {
    try {
      const args = (await readFile('/proc/' + pid + '/cmdline', 'utf8')).split('\0');
      if (!args.includes('--user-data-dir=' + profile)) continue;
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    } catch {
      /* already stopped */
    }
  }
  for (let i = 0; i < 30; i++) {
    current = await matches();
    if (!current.length) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const pid of current) {
    try {
      const args = (await readFile('/proc/' + pid + '/cmdline', 'utf8')).split('\0');
      if (args.includes('--user-data-dir=' + profile)) process.kill(pid, 'SIGKILL');
    } catch {
      /* already stopped */
    }
  }
  await new Promise((r) => setTimeout(r, 200));
  return !(await matches()).length;
}
