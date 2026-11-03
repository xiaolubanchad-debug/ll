import type { AppProcessObservation } from '@apk/contracts';

export interface AndroidLaunchMarker {
  startedAtMs: number;
  systemPid: number;
}

export const processLogLimit = 256 * 1024;
export const unavailableProcessObservation: AppProcessObservation = {
  availability: 'UNAVAILABLE',
  truncated: false,
  events: [],
};

export function androidEpochMs(text: string): number | undefined {
  const match = /^(\d{9,11})\.(\d{3,9})$/.exec(text.trim());
  return match ? Number(match[1]) * 1000 + Number(match[2].slice(0, 3)) : undefined;
}

export function androidLaunchMarker(output: string): AndroidLaunchMarker | undefined {
  const match = /^(\d+)\r?\n([^\r\n]+)$/.exec(output.trim());
  if (!match) return;
  const systemPid = Number(match[1]);
  const startedAtMs = androidEpochMs(match[2]);
  if (
    startedAtMs !== undefined &&
    Number.isSafeInteger(systemPid) &&
    systemPid >= 1 &&
    systemPid <= 4194304
  )
    return { startedAtMs, systemPid };
}

export function readAndroidProcessEvents(
  output: string,
  pkg: string,
  marker: AndroidLaunchMarker,
): AppProcessObservation {
  const events: AppProcessObservation['events'] = [];
  let truncated = output.length >= processLogLimit;
  for (const line of output.split(/\r?\n/)) {
    const entry =
      /^\s*(\d{9,11}\.\d{3,9})\s+(\d+)\s+\d+\s+[VDIWEFAS]\s+(am_proc_start|am_proc_died|am_crash)\s*:\s*\[\d+,\s*(\d+),\s*([^\r\n]*)\]$/.exec(
        line,
      );
    if (!entry) continue;
    const [, time, writer, tag, rawPid, fields] = entry;
    if (Number(writer) !== marker.systemPid) continue;
    const name = fields
      .split(',', tag === 'am_proc_start' ? 2 : 1)
      .at(-1)
      ?.trim();
    if (!name || (name !== pkg && !name.startsWith(pkg + ':'))) continue;
    const at = androidEpochMs(time);
    const pid = Number(rawPid);
    if (
      at === undefined ||
      at < marker.startedAtMs ||
      at - marker.startedAtMs > 120000 ||
      !Number.isSafeInteger(pid) ||
      pid < 1 ||
      pid > 4194304
    )
      continue;
    if (events.length >= 16) {
      truncated = true;
      continue;
    }
    events.push({
      kind: tag === 'am_proc_start' ? 'STARTED' : tag === 'am_proc_died' ? 'EXITED' : 'CRASH',
      process: name === pkg ? 'MAIN' : 'CHILD',
      pid,
      offsetMs: at - marker.startedAtMs,
    });
  }
  return {
    availability: 'OBSERVED',
    truncated,
    events: events.sort((a, b) => a.offsetMs - b.offsetMs),
  };
}
