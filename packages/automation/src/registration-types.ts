import type { TestConfiguration, RegistrationRecognition } from '@apk/contracts';
export type Locator = TestConfiguration['registrationFlows'][number]['success']['locator'];
export type Profile = TestConfiguration['execution']['deviceProfiles'][number];
export interface Account {
  accountRef: string;
  username: string;
  password: string;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface OcrLine {
  text: string;
  confidence: number;
  rect: Rect;
}
export interface DeviceObservation {
  profileId: string;
  avdName: string;
  apiLevel: number;
  model: string;
  locale: string;
  shellAndroidIdHash: string;
  androidIdScope: 'SHELL_NOT_APP';
  proxyObservedIp: string;
  proxyObservedAt: string;
  proxyIpScope: 'PROBE_ONLY';
  appUserAgent: 'UNVERIFIED';
  identitySource: 'EMULATOR_NOT_REAL_DEVICE';
}
export interface AndroidRecord {
  workspace: string;
  avdName: string;
  appiumTmp: string;
  serial?: string;
  systemPort?: number;
  emulatorPid?: number;
  appiumPid?: number;
}
export interface TaskCompletion {
  status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'CANCELLED' | 'UNKNOWN';
  proof: 'APP_UI' | 'FILE_VALIDATION' | 'APP_OPEN' | 'NONE';
  artifactIds: string[];
  accountRef?: string;
  errorCode?: string;
  recognition?: RegistrationRecognition;
  openObservation?: {
    dwellMs: 10000;
    elapsedMs: number;
    samples: number;
    scope: 'FOREGROUND_POLL_ONLY';
    cleanupComplete: true;
  };
}
export interface AndroidSession {
  observation: DeviceObservation;
  supportedAbis: string[];
  install(file: string): Promise<void>;
  launch(packageName: string, activity: string): Promise<void>;
  foreground?(packageName: string): Promise<boolean>;
  find(locator: Locator, timeout: number, signal?: AbortSignal): Promise<string>;
  click(id: string, timeout?: number): Promise<void>;
  tap?(x: number, y: number, timeout?: number): Promise<void>;
  ocr?(bytes: Buffer, signal: AbortSignal): Promise<OcrLine[]>;
  submit(id: string, timeout: number): Promise<void>;
  input(id: string, value: string): Promise<void>;
  hideKeyboard?(): Promise<void>;
  back(timeout?: number, signal?: AbortSignal): Promise<void>;
  rect(id: string): Promise<Rect>;
  attached?(id: string, signal?: AbortSignal): Promise<boolean>;
  screenshot(signal?: AbortSignal): Promise<Buffer>;
  source(signal?: AbortSignal): Promise<string>;
  close(): Promise<boolean>;
}
export class RegistrationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface ProxyCredential {
  host: string;
  port: number;
  username: string;
  password: string;
}
