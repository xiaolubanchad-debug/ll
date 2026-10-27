export interface HealthReport {
  ubuntu: string;
  arch: string;
  memoryKiB: number;
  freeDiskBytes: number;
  kvm: boolean;
  sudo: boolean;
  markerPresent: boolean;
  android: boolean;
  download: boolean;
  versions: Record<string, string>;
  errors: string[];
}
export const TERMINAL = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'];
export const BUSY_RUNS = [
  'QUEUED',
  'ASSIGNED',
  'RUNNING',
  'STOP_REQUESTED',
  'NEEDS_REVIEW',
] as const;
export const SAFE_CODES = [
  'OK',
  'SSH_AUTH_FAILED',
  'SSH_UNREACHABLE',
  'HOST_KEY_MISMATCH',
  'SSH_KEY_INVALID',
  'NO_KVM',
  'DISK_LOW',
  'UNSUPPORTED_OS',
  'UNSUPPORTED_ARCH',
  'SUDO_REQUIRED',
  'ANDROID_NOT_READY',
  'AGENT_TIMEOUT',
  'ANSIBLE_FAILED',
  'JOB_CANCELLED',
  'WORKER_LOST',
  'INSTALL_IN_PROGRESS',
  'TOOLCHAIN_MISMATCH',
  'RELEASE_INVALID',
  'KEY_UNAVAILABLE',
];
