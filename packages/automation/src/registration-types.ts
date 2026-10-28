import type { TestConfiguration } from '@apk/contracts';
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
  proof: 'APP_UI' | 'FILE_VALIDATION' | 'NONE';
  artifactIds: string[];
  accountRef?: string;
  errorCode?: string;
}
export interface AndroidSession {
  observation: DeviceObservation;
  supportedAbis: string[];
  install(file: string): Promise<void>;
  launch(packageName: string, activity: string): Promise<void>;
  find(locator: Locator, timeout: number, signal?: AbortSignal): Promise<string>;
  click(id: string, timeout?: number): Promise<void>;
  submit(id: string, timeout: number): Promise<void>;
  input(id: string, value: string): Promise<void>;
  back(): Promise<void>;
  rect(id: string): Promise<Rect>;
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
