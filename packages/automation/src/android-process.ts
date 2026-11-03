import type { AppProcessObservation } from '@apk/contracts';

export interface AndroidLaunchMarker {
  startedAtMs: number;
  systemPid: number;
  utcOffset?: string;
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
  const match = /^(\d+)\r?\n(\d+\.\d+)(?: ([^\r\n]+))?$/.exec(output.trim());
  if (!match) return;
  const systemPid = Number(match[1]);
  const startedAtMs = androidEpochMs(match[2]);
  if (
    startedAtMs !== undefined &&
    Number.isSafeInteger(systemPid) &&
    systemPid >= 1 &&
    systemPid <= 4194304
  )
    return {
      startedAtMs,
      systemPid,
      ...(/^[+-](?:0\d|1[0-4])[0-5]\d$/.test(match[3] ?? '') ? { utcOffset: match[3] } : {}),
    };
}

type ProcessEvent = AppProcessObservation['events'][number];

function launchTrigger(value?: string): ProcessEvent['trigger'] {
  if (!value) return 'UNKNOWN';
  if (['activity', 'top-activity', 'next-activity'].includes(value)) return 'ACTIVITY';
  if (value === 'service' || value === 'restart') return 'SERVICE';
  if (value === 'broadcast') return 'BROADCAST';
  if (value === 'content provider' || value === 'provider') return 'PROVIDER';
  return 'OTHER';
}

const exitReasons: Readonly<Record<number, ProcessEvent['exitReason']>> = {
  0: 'UNKNOWN',
  1: 'EXIT_SELF',
  2: 'SIGNALED',
  3: 'LOW_MEMORY',
  4: 'CRASH',
  5: 'NATIVE_CRASH',
  6: 'ANR',
  7: 'INITIALIZATION_FAILURE',
  10: 'SYSTEM_STOP',
  11: 'SYSTEM_STOP',
  12: 'DEPENDENCY_DIED',
};

export function addAndroidExitReasons(
  output: string,
  pkg: string,
  marker: AndroidLaunchMarker,
  observation: AppProcessObservation,
): AppProcessObservation {
  if (!marker.utcOffset) return observation;
  const exits = output
    .split(/^[ \t]*ApplicationExitInfo\s+#?\d+:[ \t]*$/m)
    .slice(1)
    .flatMap((block) => {
      const timestamp = /\btimestamp=(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3})\b/.exec(block)?.[1];
      const pid = Number(/\bpid=(\d+)\b/.exec(block)?.[1]);
      const name = /\bprocess=([^\s,]+)/.exec(block)?.[1];
      const reason = /\breason=(\d+)\b/.exec(block)?.[1];
      if (
        !timestamp ||
        !name ||
        reason === undefined ||
        (name !== pkg && !name.startsWith(pkg + ':'))
      )
        return [];
      const offsetMs =
        Date.parse(timestamp.replace(' ', 'T') + marker.utcOffset) - marker.startedAtMs;
      if (!Number.isFinite(offsetMs) || offsetMs < 0 || offsetMs > 120000) return [];
      return [
        {
          pid,
          process: name === pkg ? 'MAIN' : 'CHILD',
          offsetMs,
          reason: exitReasons[Number(reason)] ?? 'OTHER',
        },
      ];
    });
  return {
    ...observation,
    events: observation.events.map((event) => {
      if (event.kind !== 'EXITED') return event;
      const matches = exits.filter(
        (exit) =>
          exit.pid === event.pid &&
          exit.process === event.process &&
          Math.abs(exit.offsetMs - event.offsetMs) <= 2000,
      );
      return { ...event, exitReason: matches.length === 1 ? matches[0].reason : 'UNKNOWN' };
    }),
  };
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
    const starting = tag === 'am_proc_start';
    const parts = fields.split(',', starting ? 3 : 1);
    const name = parts[starting ? 1 : 0]?.trim();
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
      kind: starting ? 'STARTED' : tag === 'am_proc_died' ? 'EXITED' : 'CRASH',
      process: name === pkg ? 'MAIN' : 'CHILD',
      pid,
      offsetMs: at - marker.startedAtMs,
      ...(starting
        ? { trigger: launchTrigger(parts[2]?.trim()) }
        : tag === 'am_proc_died'
          ? { exitReason: 'UNKNOWN' as const }
          : {}),
    });
  }
  return {
    availability: 'OBSERVED',
    truncated,
    events: events.sort((a, b) => a.offsetMs - b.offsetMs),
  };
}
