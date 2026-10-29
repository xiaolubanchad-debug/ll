// Generated. Run npm run generate:contracts.
export interface TaskPlanInput {
  name: string;
  nodeId: string;
  configId?: string;
  configuration: APKTestConfigurationVersion10;
  automatic: boolean;
  time: string;
  successTarget: number;
  attemptLimit: number;
}
export interface APKTestConfigurationVersion10 {
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
      mode?: 'AUTO' | 'CLICK' | 'AUTO_THEN_CLICK';
      autoWaitMs?: number;
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
    deviceProfiles: {
      id: string;
      name: string;
      avdDevice: string;
      systemImage: string;
      locale: string;
    }[];
    autoRegistration?: {
      enabled: boolean;
      screenshotFallback: boolean;
      maxNavigationSteps: number;
      timeoutMs: number;
      successTimeoutMs: number;
    };
  };
  /**
   * @maxItems 100
   */
  registrationFlows: {
    packageName: string;
    activity: string;
    enabled: boolean;
    /**
     * @minItems 1
     * @maxItems 60
     */
    steps: {
      action: 'click' | 'input' | 'wait' | 'back' | 'submit';
      locator?: {
        by: 'id' | 'accessibilityId' | 'xpath' | 'androidUiAutomator';
        value: string;
      };
      text?: '{username}' | '{password}';
      timeoutMs: number;
      optional: boolean;
    }[];
    success: {
      locator: {
        by: 'id' | 'accessibilityId' | 'xpath' | 'androidUiAutomator';
        value: string;
      };
      timeoutMs: number;
    };
    failure?: {
      locator: {
        by: 'id' | 'accessibilityId' | 'xpath' | 'androidUiAutomator';
        value: string;
      };
      timeoutMs: number;
    };
    entryId?: string;
  }[];
}

export interface TaskControlInput {
  action: 'START' | 'STOP' | 'NEW_ROUND' | 'DISABLE_DAILY' | 'ARCHIVE' | 'RESTORE' | 'RETRY_DOWNLOAD';
}

export interface TaskCycleView {
  id: string;
  day: string;
  round: number;
  status: string;
  errorCode: string | null;
  successes: number;
  attemptsStarted: number;
  successTarget: number;
  attemptLimit: number;
  downloadRunId: string | null;
  activeRunId: string | null;
  registerRunIds: string[];
  deferredDownloadRules: boolean;
  apkCount: number;
  downloadRetryOf: string | null;
}

export interface TaskPlanView {
  id: string;
  name: string;
  nodeId: string;
  nodeName: string;
  version: number;
  configId: string;
  currentVersionId: string;
  automatic: boolean;
  enabled: boolean;
  time: string;
  successTarget: number;
  attemptLimit: number;
  archivedAt: string | null;
  latestCycle: {
    id: string;
    day: string;
    round: number;
    status: string;
    errorCode: string | null;
    successes: number;
    attemptsStarted: number;
    successTarget: number;
    attemptLimit: number;
    downloadRunId: string | null;
    activeRunId: string | null;
    registerRunIds: string[];
    deferredDownloadRules: boolean;
    apkCount: number;
    downloadRetryOf: string | null;
  } | null;
  readiness: {
    code: string;
    message: string;
    section: string;
  }[];
  nextRunAt: string | null;
}

export interface TaskPlanDetail {
  task: {
    id: string;
    name: string;
    nodeId: string;
    nodeName: string;
    version: number;
    configId: string;
    currentVersionId: string;
    automatic: boolean;
    enabled: boolean;
    time: string;
    successTarget: number;
    attemptLimit: number;
    archivedAt: string | null;
    latestCycle: {
      id: string;
      day: string;
      round: number;
      status: string;
      errorCode: string | null;
      successes: number;
      attemptsStarted: number;
      successTarget: number;
      attemptLimit: number;
      downloadRunId: string | null;
      activeRunId: string | null;
      registerRunIds: string[];
      deferredDownloadRules: boolean;
      apkCount: number;
      downloadRetryOf: string | null;
    } | null;
    readiness: {
      code: string;
      message: string;
      section: string;
    }[];
    nextRunAt: string | null;
  };
  configuration: APKTestConfigurationVersion10;
  cycles: {
    id: string;
    day: string;
    round: number;
    status: string;
    errorCode: string | null;
    successes: number;
    attemptsStarted: number;
    successTarget: number;
    attemptLimit: number;
    downloadRunId: string | null;
    activeRunId: string | null;
    registerRunIds: string[];
    deferredDownloadRules: boolean;
    apkCount: number;
    downloadRetryOf: string | null;
  }[];
}
export interface APKTestConfigurationVersion10 {
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
      mode?: 'AUTO' | 'CLICK' | 'AUTO_THEN_CLICK';
      autoWaitMs?: number;
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
    deviceProfiles: {
      id: string;
      name: string;
      avdDevice: string;
      systemImage: string;
      locale: string;
    }[];
    autoRegistration?: {
      enabled: boolean;
      screenshotFallback: boolean;
      maxNavigationSteps: number;
      timeoutMs: number;
      successTimeoutMs: number;
    };
  };
  /**
   * @maxItems 100
   */
  registrationFlows: {
    packageName: string;
    activity: string;
    enabled: boolean;
    /**
     * @minItems 1
     * @maxItems 60
     */
    steps: {
      action: 'click' | 'input' | 'wait' | 'back' | 'submit';
      locator?: {
        by: 'id' | 'accessibilityId' | 'xpath' | 'androidUiAutomator';
        value: string;
      };
      text?: '{username}' | '{password}';
      timeoutMs: number;
      optional: boolean;
    }[];
    success: {
      locator: {
        by: 'id' | 'accessibilityId' | 'xpath' | 'androidUiAutomator';
        value: string;
      };
      timeoutMs: number;
    };
    failure?: {
      locator: {
        by: 'id' | 'accessibilityId' | 'xpath' | 'androidUiAutomator';
        value: string;
      };
      timeoutMs: number;
    };
    entryId?: string;
  }[];
}

export interface TaskPlanList {
  items: {
    id: string;
    name: string;
    nodeId: string;
    nodeName: string;
    version: number;
    configId: string;
    currentVersionId: string;
    automatic: boolean;
    enabled: boolean;
    time: string;
    successTarget: number;
    attemptLimit: number;
    archivedAt: string | null;
    latestCycle: {
      id: string;
      day: string;
      round: number;
      status: string;
      errorCode: string | null;
      successes: number;
      attemptsStarted: number;
      successTarget: number;
      attemptLimit: number;
      downloadRunId: string | null;
      activeRunId: string | null;
      registerRunIds: string[];
      deferredDownloadRules: boolean;
      apkCount: number;
      downloadRetryOf: string | null;
    } | null;
    readiness: {
      code: string;
      message: string;
      section: string;
    }[];
    nextRunAt: string | null;
  }[];
  nextCursor: string | null;
}

export interface TaskPlanQuery {
  cursor?: string;
  limit?: string;
  archived?: 'ACTIVE' | 'ARCHIVED' | 'ALL';
}

export interface MaintenanceQuery {
  kind: 'CONFIGURATION' | 'CONFIG_VERSION' | 'RELEASE';
  configId?: string;
  archived?: 'ACTIVE' | 'ARCHIVED' | 'ALL';
  cursor?: string;
  limit?: string;
}

export interface MaintenanceItem {
  id: string;
  kind: string;
  title: string;
  revision: number;
  archivedAt: string | null;
  references: {
    label: string;
    count: number;
  }[];
  canDelete: boolean;
  canArchive: boolean;
}

export interface MaintenanceList {
  items: {
    id: string;
    kind: string;
    title: string;
    revision: number;
    archivedAt: string | null;
    references: {
      label: string;
      count: number;
    }[];
    canDelete: boolean;
    canArchive: boolean;
  }[];
  nextCursor: string | null;
}

export interface MaintenanceInput {
  action: 'ARCHIVE' | 'RESTORE' | 'DELETE';
  /**
   * @minItems 1
   * @maxItems 100
   */
  items: {
    id: string;
    kind: 'CONFIGURATION' | 'CONFIG_VERSION' | 'RELEASE';
    revision: number;
  }[];
}

export interface MaintenanceResult {
  affected: number;
}

export type ResultCategory =
  | 'SUCCESS'
  | 'REJECTED'
  | 'ERROR'
  | 'ADAPTATION'
  | 'UNKNOWN'
  | 'SKIPPED'
  | 'STOPPED'
  | 'PENDING';

export interface RunQuery {
  nodeId?: string;
  configVersionId?: string;
  purpose?: 'DOWNLOAD' | 'REGISTER' | 'LEGACY' | 'PROXY_CHECK';
  status?:
    | 'QUEUED'
    | 'ASSIGNED'
    | 'RUNNING'
    | 'STOP_REQUESTED'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'PARTIAL_FAILED'
    | 'CANCELLED'
    | 'NEEDS_REVIEW';
  cacheDay?: string;
  cursor?: string;
  limit?: string;
}

export interface ConsoleRunListView {
  items: {
    id: string;
    nodeName: string;
    configName: string;
    purpose: string;
    status: string;
    createdAt: string;
    successes: number;
    successTarget: number;
    attemptsStarted: number;
    attemptLimit: number;
    errorCode: string | null;
    nodeId: string;
    configVersionId: string | null;
    configVersion: number;
    cacheDay: string | null;
  }[];
  nextCursor: string | null;
}

export interface ResultsQuery {
  from?: string;
  to?: string;
  nodeId?: string;
  runId?: string;
  q?: string;
  category?: 'SUCCESS' | 'REJECTED' | 'ERROR' | 'ADAPTATION' | 'UNKNOWN' | 'SKIPPED' | 'STOPPED' | 'PENDING';
  review?: 'OPEN' | 'RESOLVED';
  cursor?: string;
  limit?: string;
}

export interface OverviewQuery {
  day?: string;
  nodeId?: string;
}

export interface TimelineQuery {
  afterSequence?: string;
  beforeSequence?: string;
  taskId?: string;
  limit?: string;
}

export interface AssetQuery {
  day?: string;
  nodeId?: string;
  q?: string;
  cursor?: string;
  limit?: string;
}

export interface RegistrationRecordView {
  id: string;
  runId: string;
  nodeId: string;
  nodeName: string;
  configName: string;
  configVersion: number;
  purpose: string;
  position: number;
  label: string;
  entryId: string | null;
  status: string;
  category: 'SUCCESS' | 'REJECTED' | 'ERROR' | 'ADAPTATION' | 'UNKNOWN' | 'SKIPPED' | 'STOPPED' | 'PENDING';
  proof: string;
  errorCode: string | null;
  lastStage: string;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number | null;
  apk: {
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
  } | null;
  hasAccount: boolean;
  reviewOutcome: ('SUCCEEDED' | 'FAILED') | null;
}

export interface RegistrationListView {
  items: {
    id: string;
    runId: string;
    nodeId: string;
    nodeName: string;
    configName: string;
    configVersion: number;
    purpose: string;
    position: number;
    label: string;
    entryId: string | null;
    status: string;
    category: 'SUCCESS' | 'REJECTED' | 'ERROR' | 'ADAPTATION' | 'UNKNOWN' | 'SKIPPED' | 'STOPPED' | 'PENDING';
    proof: string;
    errorCode: string | null;
    lastStage: string;
    startedAt: string;
    finishedAt: string | null;
    elapsedMs: number | null;
    apk: {
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
    } | null;
    hasAccount: boolean;
    reviewOutcome: ('SUCCEEDED' | 'FAILED') | null;
  }[];
  nextCursor: string | null;
}

export interface RegistrationDetailView {
  record: {
    id: string;
    runId: string;
    nodeId: string;
    nodeName: string;
    configName: string;
    configVersion: number;
    purpose: string;
    position: number;
    label: string;
    entryId: string | null;
    status: string;
    category: 'SUCCESS' | 'REJECTED' | 'ERROR' | 'ADAPTATION' | 'UNKNOWN' | 'SKIPPED' | 'STOPPED' | 'PENDING';
    proof: string;
    errorCode: string | null;
    lastStage: string;
    startedAt: string;
    finishedAt: string | null;
    elapsedMs: number | null;
    apk: {
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
    } | null;
    hasAccount: boolean;
    reviewOutcome: ('SUCCEEDED' | 'FAILED') | null;
  };
  observation: {
    model: string;
    locale: string;
    shellAndroidIdHash: string;
    proxyObservedIp: string;
    proxyObservedAt: string;
  } | null;
  recognition: {
    source: 'CONTROLS' | 'OCR' | 'LEARNED';
    navigationSteps: number;
    cache: 'MISS' | 'HIT' | 'INVALIDATED';
    learned: boolean;
    needsAdaptation: boolean;
    templateHash?: string;
    automaticIdentity?: {
      kind: 'GUEST' | 'APP_ASSIGNED';
      identifierHash: string;
      scope: 'APP_UI_ONLY';
    };
  } | null;
  reviews: {
    outcome: 'SUCCEEDED' | 'FAILED';
    reason: string;
    createdAt: string;
  }[];
}

export interface OverviewView {
  day: string;
  generatedAt: string;
  servers: {
    total: number;
    online: number;
    busy: number;
    quarantined: number;
  };
  downloads: {
    validated: number;
    failed: number;
  };
  registrations: {
    SUCCESS: number;
    REJECTED: number;
    ERROR: number;
    ADAPTATION: number;
    UNKNOWN: number;
    SKIPPED: number;
    STOPPED: number;
    PENDING: number;
  };
  reviewedUnknown: number;
  activeRuns: {
    id: string;
    nodeName: string;
    configName: string;
    purpose: string;
    status: string;
    createdAt: string;
    successes: number;
    successTarget: number;
    attemptsStarted: number;
    attemptLimit: number;
    errorCode: string | null;
  }[];
}

export interface RunSummaryView {
  run: {
    id: string;
    nodeName: string;
    configName: string;
    purpose: string;
    status: string;
    createdAt: string;
    successes: number;
    successTarget: number;
    attemptsStarted: number;
    attemptLimit: number;
    errorCode: string | null;
  };
  nodeId: string;
  configVersion: number;
  releaseId: string | null;
  finishedAt: string | null;
  counts: {
    SUCCESS: number;
    REJECTED: number;
    ERROR: number;
    ADAPTATION: number;
    UNKNOWN: number;
    SKIPPED: number;
    STOPPED: number;
    PENDING: number;
  };
  taskCount: number;
  cleanup: 'CONFIRMED' | 'PENDING' | 'NEEDS_REVIEW';
  activeTask: {
    id: string;
    position: number;
    label: string;
    stage: string;
    packageName: string | null;
  } | null;
  automaticIdentityCount: number;
}

export interface TimelinePage {
  items: {
    id: string;
    sequence: number;
    taskId: string | null;
    occurredAt: string;
    receivedAt: string;
    type: string;
    stage: string | null;
    title: string;
    errorCode: string | null;
    recordedForReview: boolean;
    applied: boolean;
  }[];
  hasEarlier: boolean;
  hasLater: boolean;
  firstSequence: number | null;
  lastSequence: number | null;
}

export interface AssetListView {
  items: {
    id: string;
    runId: string;
    nodeId: string;
    nodeName: string;
    configName: string;
    label: string;
    entryId: string | null;
    status: string;
    errorCode: string | null;
    createdAt: string;
    apk: {
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
    } | null;
  }[];
  nextCursor: string | null;
}

export interface ValidationListView {
  items: {
    id: string;
    nodeName: string;
    status: string;
    createdAt: string;
    passed: boolean;
    cleanupComplete: boolean;
    cases: {
      name: string;
      status: string;
      proof: string;
      requests: number;
    }[];
  }[];
  nextCursor: string | null;
}

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
      mode?: 'AUTO' | 'CLICK' | 'AUTO_THEN_CLICK';
      autoWaitMs?: number;
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
    deviceProfiles: {
      id: string;
      name: string;
      avdDevice: string;
      systemImage: string;
      locale: string;
    }[];
    autoRegistration?: {
      enabled: boolean;
      screenshotFallback: boolean;
      maxNavigationSteps: number;
      timeoutMs: number;
      successTimeoutMs: number;
    };
  };
  /**
   * @maxItems 100
   */
  registrationFlows: {
    packageName: string;
    activity: string;
    enabled: boolean;
    /**
     * @minItems 1
     * @maxItems 60
     */
    steps: {
      action: 'click' | 'input' | 'wait' | 'back' | 'submit';
      locator?: {
        by: 'id' | 'accessibilityId' | 'xpath' | 'androidUiAutomator';
        value: string;
      };
      text?: '{username}' | '{password}';
      timeoutMs: number;
      optional: boolean;
    }[];
    success: {
      locator: {
        by: 'id' | 'accessibilityId' | 'xpath' | 'androidUiAutomator';
        value: string;
      };
      timeoutMs: number;
    };
    failure?: {
      locator: {
        by: 'id' | 'accessibilityId' | 'xpath' | 'androidUiAutomator';
        value: string;
      };
      timeoutMs: number;
    };
    entryId?: string;
  }[];
}

export type AgentMessage =
  | {
      kind: 'enroll';
      protocolVersion: '1.0';
      nodeId: string;
      bootId: string;
      agentVersion: string;
      releaseId: string;
    }
  | {
      kind: 'heartbeat';
      protocolVersion: '1.0';
      nodeId: string;
      bootId: string;
      agentVersion: string;
      releaseId: string;
      sentAt: string;
      capabilities: {
        download: boolean;
        android: boolean;
        kvm: boolean;
        freeDiskBytes: number;
        downloadProtocol?: '1.0';
        registrationProtocol?: '1.0';
      };
      currentDelivery: null | {
        deliveryId: string;
        runId: string;
        fence: number;
      };
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
  | {
      kind: 'claim';
      protocolVersion: '1.0';
      nodeId: string;
      bootId: string;
    }
  | {
      kind: 'delivery';
      protocolVersion: '1.0';
      nodeId: string;
      deliveryId: string;
      runId: string;
      fence: number;
      configVersionId: string;
      configHash: string;
      releaseId: string;
      issuedAt: string;
      ackDeadline: string;
      leaseExpiresAt: string;
    }
  | {
      kind: 'accept';
      protocolVersion: '1.0';
      nodeId: string;
      bootId: string;
      deliveryId: string;
      fence: number;
    }
  | {
      kind: 'events';
      protocolVersion: '1.0';
      nodeId: string;
      deliveryId: string;
      fence: number;
      /**
       * @minItems 1
       * @maxItems 100
       */
      events: {
        eventId: string;
        runId: string;
        taskId?: string;
        sequence: number;
        occurredAt: string;
        type:
          | 'RUN_STARTED'
          | 'TARGETS_DISCOVERED'
          | 'TASK_STAGE'
          | 'SUBMISSION_INTENT'
          | 'TASK_FINISHED'
          | 'RUN_FINISHED'
          | 'STOP_ACK'
          | 'LOG'
          | 'PROXY_CHECKED'
          | 'BROWSER_ENVIRONMENT'
          | 'APP_OBSTRUCTION';
        payload: {
          [k: string]: unknown;
        };
      }[];
    }
  | {
      kind: 'account';
      protocolVersion: '1.0';
      nodeId: string;
      deliveryId: string;
      fence: number;
      taskId: string;
      accountRef: string;
      username: string;
      password: string;
    };

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
  name?: string;
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
   * @maxItems 4
   */
  features?: ('DOWNLOAD_V1' | 'REGISTRATION_V1' | 'DAILY_V1' | 'AUTO_REGISTRATION_V1')[];
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
  purpose?: 'DOWNLOAD' | 'REGISTER' | 'PROXY_CHECK';
  sourceDownloadId?: string;
  successTarget?: number;
  attemptLimit?: number;
  proxySecretVersionId?: string;
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

export interface ScheduleInput {
  nodeId: string;
  configVersionId: string;
  releaseId: string;
  enabled: boolean;
  autoRegister: boolean;
  time: string;
  timezone: 'Asia/Shanghai';
  successTarget: number;
  attemptLimit: number;
}

export interface ProxyObservation {
  status: 'SUCCEEDED' | 'FAILED';
  ip?: string;
  at?: string;
  scope?: 'PROBE_ONLY';
  errorCode?: 'PROXY_CHECK_FAILED';
}

export interface DailyExecutionPlan {
  purpose: 'DOWNLOAD' | 'REGISTER' | 'PROXY_CHECK';
  cacheDay: string;
  successTarget: number;
  attemptLimit: number;
  proxySecretVersionId?: string;
  /**
   * @maxItems 1000
   */
  assets: {
    targetKey: string;
    label: string;
    sourceUrl: string;
    apk: {
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
    };
    entryId?: string;
  }[];
}

export interface AutoRegistration {
  enabled: boolean;
  screenshotFallback: boolean;
  maxNavigationSteps: number;
  timeoutMs: number;
  successTimeoutMs: number;
}

export interface RegistrationRecognition {
  source: 'CONTROLS' | 'OCR' | 'LEARNED';
  navigationSteps: number;
  cache: 'MISS' | 'HIT' | 'INVALIDATED';
  learned: boolean;
  needsAdaptation: boolean;
  templateHash?: string;
  automaticIdentity?: {
    kind: 'GUEST' | 'APP_ASSIGNED';
    identifierHash: string;
    scope: 'APP_UI_ONLY';
  };
}

export interface LearnedRegistrationTemplate {
  version: '1.0';
  /**
   * @maxItems 12
   */
  navigation: {
    screenHash: string;
    candidateHash: string;
    role: 'REGISTER' | 'ACCOUNT' | 'LOGIN' | 'CONSENT';
  }[];
  formHash: string;
  templateHash: string;
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
    purpose: string;
    cacheDay: string | null;
    configVersionId: string | null;
    successTarget: number;
    attemptLimit: number;
    attemptsStarted: number;
    successes: number;
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
