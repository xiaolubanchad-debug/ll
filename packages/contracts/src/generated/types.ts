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
    landingRules: [
      {
        host: string;
        by: 'css' | 'xpath';
        selector: string;
      },
      ...{
        host: string;
        by: 'css' | 'xpath';
        selector: string;
      }[]
    ];
  };
  execution: {
    mode: 'DOWNLOAD_ONLY' | 'FULL';
    proxySecretVersionId?: string;
    /**
     * @minItems 1
     * @maxItems 10
     */
    deviceProfiles:
      | [DeviceProfile]
      | [DeviceProfile, DeviceProfile]
      | [DeviceProfile, DeviceProfile, DeviceProfile]
      | [DeviceProfile, DeviceProfile, DeviceProfile, DeviceProfile]
      | [DeviceProfile, DeviceProfile, DeviceProfile, DeviceProfile, DeviceProfile]
      | [DeviceProfile, DeviceProfile, DeviceProfile, DeviceProfile, DeviceProfile, DeviceProfile]
      | [DeviceProfile, DeviceProfile, DeviceProfile, DeviceProfile, DeviceProfile, DeviceProfile, DeviceProfile]
      | [
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile
        ]
      | [
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile
        ]
      | [
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile,
          DeviceProfile
        ];
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
  steps: [Step, ...Step[]];
  success: {
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
  };
  currentDelivery: null | CurrentDelivery;
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
  events: [Event, ...Event[]];
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
    createdAt: string;
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
