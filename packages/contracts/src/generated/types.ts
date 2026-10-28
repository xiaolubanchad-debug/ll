// Generated. Run npm run generate:contracts.
export interface TestConfiguration {
  schemaVersion: '1.0';
  name: string;
  source: {
    url: string;
    xpath: string;
    browserUserAgent: string;
  };
  download: {
    cacheTimezone: 'Asia/Shanghai';
    maxTargets: number;
    maxLandingClicks: number;
    timeoutMs: number;
    retries: number;
    /**
     * @minItems 1
     * @maxItems 50
     */
    landingRules: {
      host: string;
      by: 'css' | 'xpath';
      selector: string;
    }[];
    maxApkBytes?: number;
  };
  execution: {
    mode: 'DOWNLOAD_ONLY' | 'FULL';
    proxySecretVersionId?: string;
    /**
     * @minItems 1
     * @maxItems 10
     */
    deviceProfiles: DeviceProfile[];
  };
  /**
   * @maxItems 100
   */
  registrationFlows: Flow[];
}
export interface DeviceProfile {
  id: string;
  name: string;
  avdDevice: string;
  systemImage: string;
  locale: string;
}
export interface Flow {
  packageName: string;
  activity: string;
  enabled: boolean;
  /**
   * @minItems 1
   * @maxItems 60
   */
  steps: Step[];
  success: {
    locator: Locator;
    timeoutMs: number;
  };
  failure?: {
    locator: Locator;
    timeoutMs: number;
  };
}
export interface Step {
  action: 'click' | 'input' | 'wait' | 'back' | 'submit';
  locator?: Locator;
  text?: '{username}' | '{password}';
  timeoutMs: number;
  optional: boolean;
}
export interface Locator {
  by: 'id' | 'accessibilityId' | 'xpath' | 'androidUiAutomator';
  value: string;
}

export type AgentMessage = Enroll | Heartbeat | Claim | Delivery | Accept | Events | Account;
export type Uuid = string;
export type Version = string;
export type Time = string;
export type Hash = string;

export interface Enroll {
  kind: 'enroll';
  protocolVersion: '1.0';
  nodeId: Uuid;
  bootId: Uuid;
  agentVersion: Version;
  releaseId: Uuid;
}
export interface Heartbeat {
  kind: 'heartbeat';
  protocolVersion: '1.0';
  nodeId: Uuid;
  bootId: Uuid;
  agentVersion: Version;
  releaseId: Uuid;
  sentAt: Time;
  capabilities: {
    download: boolean;
    android: boolean;
    kvm: boolean;
    freeDiskBytes: number;
    downloadProtocol?: '1.0';
    registrationProtocol?: '1.0';
  };
  currentDelivery: null | CurrentDelivery;
  report?: {
    ubuntu: string;
    arch: string;
    memoryKiB: number;
    freeDiskBytes: number;
    kvm: boolean;
    sudo: boolean;
    markerPresent: boolean;
    android: boolean;
    download: boolean;
    versions: {
      node?: string;
      adb?: string;
      emulator?: string;
      appium?: string;
      playwright?: string;
      systemImage?: string;
    };
    /**
     * @maxItems 20
     */
    errors: (
      | 'NO_KVM'
      | 'DISK_LOW'
      | 'UNSUPPORTED_OS'
      | 'UNSUPPORTED_ARCH'
      | 'SUDO_REQUIRED'
      | 'ANDROID_NOT_READY'
      | 'INSTALL_IN_PROGRESS'
    )[];
  };
}
export interface CurrentDelivery {
  deliveryId: Uuid;
  runId: Uuid;
  fence: number;
}
export interface Claim {
  kind: 'claim';
  protocolVersion: '1.0';
  nodeId: Uuid;
  bootId: Uuid;
}
export interface Delivery {
  kind: 'delivery';
  protocolVersion: '1.0';
  nodeId: Uuid;
  deliveryId: Uuid;
  runId: Uuid;
  fence: number;
  configVersionId: Uuid;
  configHash: Hash;
  releaseId: Uuid;
  issuedAt: Time;
  ackDeadline: Time;
  leaseExpiresAt: Time;
}
export interface Accept {
  kind: 'accept';
  protocolVersion: '1.0';
  nodeId: Uuid;
  bootId: Uuid;
  deliveryId: Uuid;
  fence: number;
}
export interface Events {
  kind: 'events';
  protocolVersion: '1.0';
  nodeId: Uuid;
  deliveryId: Uuid;
  fence: number;
  /**
   * @minItems 1
   * @maxItems 100
   */
  events: Event[];
}
export interface Event {
  eventId: Uuid;
  runId: Uuid;
  taskId?: Uuid;
  sequence: number;
  occurredAt: Time;
  type:
    | 'RUN_STARTED'
    | 'TARGETS_DISCOVERED'
    | 'TASK_STAGE'
    | 'SUBMISSION_INTENT'
    | 'TASK_FINISHED'
    | 'RUN_FINISHED'
    | 'STOP_ACK'
    | 'LOG';
  payload: {
    [k: string]: unknown;
  };
}
export interface Account {
  kind: 'account';
  protocolVersion: '1.0';
  nodeId: Uuid;
  deliveryId: Uuid;
  fence: number;
  taskId: Uuid;
  accountRef: Uuid;
  username: string;
  password: string;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface PasswordChangeInput {
  currentPassword: string;
  newPassword: string;
}

export interface NodeInput {
  name: string;
  host: string;
  port: number;
  username: string;
  credentialVersionId: string;
  sudoCredentialVersionId?: string | null;
}

export interface SecretInput {
  type: 'SSH_KEY' | 'SSH_PASSWORD' | 'SUDO_PASSWORD' | 'HTTP_PROXY';
  secretValue: {
    privateKey?: string;
    passphrase?: string;
    password?: string;
    host?: string;
    port?: number;
    username?: string;
  };
}

export interface HostKeyInput {
  probeId: string;
  expectedFingerprint: string;
}

export interface DeploymentInput {
  nodeId: string;
  releaseId: string;
  licenseAccepted: true;
}

export interface ReasonInput {
  reason: string;
}

export interface ReconcileInput {
  checkId: string;
  reason: string;
}

export interface ReleaseInput {
  id: string;
  gitCommit: string;
  agentVersion: string;
  protocolVersion: '1.0';
  artifactName: string;
  sha256: string;
  playbookSha256: string;
  signature: string;
  toolchain: {
    nodeVersion: '24.18.0';
    nodeUrl: 'https://nodejs.org/dist/v24.18.0/node-v24.18.0-linux-x64.tar.xz';
    nodeSha256: string;
    playwrightVersion: string;
    appiumVersion: string;
    uiautomator2Version: string;
    systemImage: 'system-images;android-35;google_apis;x86_64';
    /**
     * @minItems 4
     * @maxItems 4
     */
    archives: {
      role: 'cmdlineTools' | 'emulator' | 'platformTools' | 'systemImage';
      url: string;
      checksum: string;
      revision: string;
    }[];
    npmLockSha256: string;
  };
  /**
   * @maxItems 2
   */
  features?: ('DOWNLOAD_V1' | 'REGISTRATION_V1')[];
}

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
  versions: {
    node?: string;
    adb?: string;
    emulator?: string;
    appium?: string;
    playwright?: string;
    systemImage?: string;
  };
  /**
   * @maxItems 20
   */
  errors: (
    | 'NO_KVM'
    | 'DISK_LOW'
    | 'UNSUPPORTED_OS'
    | 'UNSUPPORTED_ARCH'
    | 'SUDO_REQUIRED'
    | 'ANDROID_NOT_READY'
    | 'INSTALL_IN_PROGRESS'
  )[];
}

export interface NodeView {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  version: number;
  credentialVersionId: string | null;
  sudoCredentialVersionId: string | null;
  expectedFingerprint: string | null;
  deploymentStatus: string;
  connection: 'ONLINE' | 'OFFLINE';
  occupancy: 'IDLE' | 'BUSY' | 'QUARANTINED';
  lastSeenAt: string | null;
  agentVersion: string | null;
  agentReleaseId: string | null;
  health: {
    [k: string]: unknown;
  } | null;
  createdAt: string;
  downloadProtocol?: '1.0' | null;
  registrationProtocol?: string | null;
}

export interface ExecutionOS {
  distribution: 'ubuntu';
  version: '24.04' | '26.04';
}

export interface ConfigInput {
  name: string;
}

export interface RunInput {
  nodeId: string;
  configVersionId: string;
  releaseId: string;
  supersedesRunId?: string;
}

export interface RunReconcileInput {
  reason: string;
}

export interface AgentReconcileInput {
  protocolVersion: '1.0';
  nodeId: string;
  bootId: string;
  /**
   * @maxItems 100
   */
  deliveries: {
    deliveryId: string;
    fence: number;
    cleanupComplete: boolean;
    /**
     * @maxItems 1000
     */
    submissions?: {
      taskId: string;
      submissionId: string;
      accountRef: string;
    }[];
  }[];
  cleanupComplete: boolean;
}

export interface DeliveryConfigInput {
  protocolVersion: '1.0';
  nodeId: string;
  bootId: string;
  deliveryId: string;
  fence: number;
}

export interface ApkMetadata {
  packageName: string;
  versionName: string | null;
  versionCode: number | null;
  /**
   * @maxItems 20
   */
  abis: string[];
  size: number;
  apkSha256: string;
  cacheDay: string;
}

export interface ArtifactInput {
  protocolVersion: '1.0';
  nodeId: string;
  bootId: string;
  deliveryId: string;
  fence: number;
  taskId: string;
  artifactId: string;
  kind: 'screenshot';
  sha256: string;
  dataBase64: string;
  redaction: 'CREDENTIAL_MASKED';
}

export interface AccountViewInput {
  reason: string;
}

export interface TaskReconcileInput {
  outcome: 'SUCCEEDED' | 'FAILED';
  reason: string;
  /**
   * @maxItems 100
   */
  evidenceIds: string[];
}

export interface SessionView {
  admin: {
    id: string;
    username: string;
    role: 'SUPER_ADMIN';
  };
  csrfToken: string;
}

export interface ValidationResult {
  valid: true;
}

export interface NodeList {
  items: {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    version: number;
    credentialVersionId: string | null;
    sudoCredentialVersionId: string | null;
    expectedFingerprint: string | null;
    deploymentStatus: string;
    connection: 'ONLINE' | 'OFFLINE';
    occupancy: 'IDLE' | 'BUSY' | 'QUARANTINED';
    lastSeenAt: string | null;
    agentVersion: string | null;
    agentReleaseId: string | null;
    health: {
      [k: string]: unknown;
    } | null;
    createdAt: string;
    downloadProtocol?: '1.0' | null;
    registrationProtocol?: string | null;
  }[];
  nextCursor: string | null;
}

export interface RunList {
  items: {
    id: string;
    nodeId: string;
    status: string;
    createdAt: string;
  }[];
  nextCursor: string | null;
}

export interface AuditList {
  items: {
    id: string;
    action: string;
    createdAt: string;
  }[];
  nextCursor: string | null;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId: string;
    details: {
      path: string;
      message: string;
    }[];
  };
}
