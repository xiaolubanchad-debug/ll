import validators from './generated/validators.js';
export type {
  TestEnrollInput,
  TestEnrollResult,
  TestBootstrapInput,
  TestBootstrap,
  TestDataQuery,
  TestDataPage,
  TestDataCredentials,
  TestClientInfo,
  ResultCategory,
  RegistrationRecordView,
  RegistrationListView,
  RegistrationDetailView,
  OverviewView,
  RunSummaryView,
  TimelinePage,
  AppOpenTimings,
  AssetListView,
  ValidationListView,
  ResultsQuery,
  OverviewQuery,
  TimelineQuery,
  AssetQuery,
  RunQuery,
  ConsoleRunListView,
} from './generated/types.js';
import type {
  TestConfiguration,
  AgentMessage,
  LoginInput,
  PasswordChangeInput,
} from './generated/types.js';
export type {
  ArtifactInput,
  FunctionalEvidence,
  AccountViewInput,
  TaskReconcileInput,
} from './generated/types.js';
import type { FunctionalEvidence } from './generated/types.js';
import type { AppOpenTimings } from './generated/types.js';
export type { ScheduleInput, DailyExecutionPlan, ProxyObservation } from './generated/types.js';
export type {
  AutoRegistration,
  StartupPolicy,
  RegistrationRecognition,
  LearnedRegistrationTemplate,
} from './generated/types.js';
export type { TestConfiguration, AgentMessage, LoginInput, PasswordChangeInput };
export type { SessionView, NodeList, RunList, AuditList } from './generated/types.js';
export type {
  NodeInput,
  SecretInput,
  HostKeyInput,
  DeploymentInput,
  ReasonInput,
  ReconcileInput,
  ReleaseInput,
} from './generated/types.js';
export type { NodeView } from './generated/types.js';
export type {
  ConfigInput,
  RunInput,
  RunReconcileInput,
  AgentReconcileInput,
  DeliveryConfigInput,
  ApkMetadata,
} from './generated/types.js';
export interface Issue {
  path: string;
  message: string;
}
const evidenceCanonical = (value: unknown): string =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
export function parseFunctionalEvidence(text: string): FunctionalEvidence | undefined {
  if (!text || text.length > 65536) return undefined;
  try {
    const value = JSON.parse(text) as FunctionalEvidence;
    if (schemaIssues('FunctionalEvidence', value).length || evidenceCanonical(value) !== text)
      return undefined;
    if (value.controls.some(({ rect: r }) => r.x + r.width > 16384 || r.y + r.height > 16384))
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
export function functionalEvidenceText(value: FunctionalEvidence): string {
  const text = evidenceCanonical(value);
  if (!parseFunctionalEvidence(text)) throw Error('CONTENT_ISOLATION_REQUIRED');
  return text;
}
export function contentIsolationSupported(
  features: readonly string[] | undefined,
  version: string | null | undefined,
): boolean {
  return knownAgentAtLeast(version, '0.8.0') && features?.includes('CONTENT_ISOLATION_V1') === true;
}
export function appReadinessSupported(
  features: readonly string[] | undefined,
  version: string | null | undefined,
): boolean {
  return knownAgentAtLeast(version, '0.9.0') && features?.includes('APP_READINESS_V1') === true;
}
export function appOpenSupported(
  features: readonly string[] | undefined,
  version: string | null | undefined,
): boolean {
  return knownAgentAtLeast(version, '0.10.0') && features?.includes('APP_OPEN_V1') === true;
}
export function parallelAppOpenSupported(
  features: readonly string[] | undefined,
  version: string | null | undefined,
): boolean {
  return (
    knownAgentAtLeast(version, '0.11.0') && features?.includes('APP_OPEN_PARALLEL_V1') === true
  );
}
export function executionOSSupported(distribution: string, version: string): boolean {
  return schemaIssues('ExecutionOS', { distribution, version }).length === 0;
}
export function schemaIssues(name: keyof typeof validators, value: unknown): Issue[] {
  const validate = validators[name];
  const labels: Record<string, string> = {
    required: '缺少必填字段',
    additionalProperties: '包含不支持的字段',
    type: '字段类型无效',
    pattern: '格式不符合要求',
    format: '格式不符合要求',
    minLength: '内容过短',
    maxLength: '内容过长',
    const: '固定值不匹配',
    enum: '选项无效',
    minimum: '数值过小',
    maximum: '数值过大',
  };
  return validate(value)
    ? []
    : (validate.errors ?? []).map((error) => ({
        path: error.instancePath || '/',
        message: labels[error.keyword] ?? '不符合配置规则',
      }));
}
export function configurationIssues(value: unknown): Issue[] {
  const issues = schemaIssues('TestConfiguration', value);
  if (issues.length) return issues;
  const config = value as TestConfiguration;
  if (!androidBrowserUa(config.source.browserUserAgent ?? ''))
    issues.push({
      path: '/source/browserUserAgent',
      message: '网页 UA 必须为安卓手机 Chrome，或留空使用默认值',
    });
  if (config.execution.autoRegistration?.enabled && config.execution.mode !== 'FULL')
    issues.push({ path: '/execution/autoRegistration', message: '自动识别注册需要完整模式和代理' });
  if (
    (config.execution.appOpen?.randomDeviceProfile || config.execution.appOpen?.ownedTestClient) &&
    config.execution.appOpen.concurrency === undefined
  )
    issues.push({
      path: '/execution/appOpen/concurrency',
      message: '测试档案和自有 APK 需要明确并发数',
    });
  if (
    config.execution.appOpen?.randomDeviceProfile &&
    config.execution.deviceProfiles.some(
      (p) =>
        p.systemImage !== 'system-images;android-35;google_apis;x86_64' || p.locale !== 'en-US',
    )
  )
    issues.push({
      path: '/execution/deviceProfiles',
      message: '当前测试型号档案只支持 API 35 x86_64 / en-US',
    });
  let url: URL;
  try {
    url = new URL(config.source.url);
  } catch {
    return [{ path: '/source/url', message: '网址格式无效' }];
  }
  if (url.username || url.password)
    issues.push({ path: '/source/url', message: '网址不能包含登录凭据' });
  const profiles = config.execution.deviceProfiles.map((p) => p.id);
  if (new Set(profiles).size !== profiles.length)
    issues.push({ path: '/execution/deviceProfiles', message: '设备配置编号不能重复' });
  const packages = config.registrationFlows.map((f) =>
    f.entryId ? 'entry:' + f.entryId : 'package:' + f.packageName,
  );
  if (new Set(packages).size !== packages.length)
    issues.push({ path: '/registrationFlows', message: '同一个入口或包名只能配置一个流程' });
  for (const [i, flow] of config.registrationFlows.entries()) {
    const index = flow.steps.findIndex((s) => s.action === 'submit');
    if (flow.steps.slice(index + 1).some((s) => s.action !== 'wait'))
      issues.push({ path: `/registrationFlows/${i}/steps`, message: '提交后只允许只读等待' });
    for (const locator of [
      ...flow.steps.map((s) => s.locator),
      flow.success.locator,
      flow.failure?.locator,
    ]) {
      if (locator?.by === 'androidUiAutomator' && !safeUiSelector(locator.value))
        issues.push({
          path: `/registrationFlows/${i}`,
          message: '只允许无副作用的 UiSelector 链，请改用资源 ID 或 XPath',
        });
    }
  }
  return issues;
}
export function androidBrowserUa(value: string): boolean {
  return (
    value === '' ||
    (!/[\r\n]|iPhone|iPad|Windows|Macintosh/i.test(value) &&
      /Android/i.test(value) &&
      /Mobile/i.test(value) &&
      /Chrome\/\d+(?:\.\d+){0,3}/.test(value))
  );
}
export function safeUiSelector(value: string) {
  return /^new UiSelector\(\)(?:(?:\.(?:text|textContains|resourceId|description|descriptionContains|className|packageName)\("[^"\\\r\n]{0,1000}"\))|(?:\.(?:index|instance)\([0-9]{1,4}\))|(?:\.(?:enabled|clickable|checked|selected|focusable|focused|scrollable)\((?:true|false)\)))+$/.test(
    value,
  );
}
export function registrationFlowFor(
  config: TestConfiguration,
  packageName: string,
  entryId?: string,
) {
  const matches = config.registrationFlows.filter((f) => f.enabled);
  return (
    matches.find(
      (f) =>
        !!entryId &&
        f.entryId === entryId &&
        (f.packageName === '*' || f.packageName === packageName),
    ) ?? matches.find((f) => !f.entryId && f.packageName === packageName)
  );
}
export function registrationAvailable(
  config: TestConfiguration,
  packageName: string,
  entryId?: string,
) {
  return (
    !!config.execution.appOpen ||
    !!registrationFlowFor(config, packageName, entryId) ||
    config.execution.autoRegistration?.enabled === true
  );
}
export function agentIssues(value: unknown): Issue[] {
  const issues = schemaIssues('AgentMessage', value);
  if (issues.length) return issues;
  const message = value as AgentMessage;
  if (
    message.kind === 'delivery' &&
    !(
      Date.parse(message.issuedAt) < Date.parse(message.ackDeadline) &&
      Date.parse(message.ackDeadline) < Date.parse(message.leaseExpiresAt)
    )
  )
    issues.push({ path: '/leaseExpiresAt', message: '租约时间顺序无效' });
  if (message.kind === 'events') {
    if (new Set(message.events.map((e) => e.eventId)).size !== message.events.length)
      issues.push({ path: '/events', message: '事件编号重复' });
    message.events.forEach((event, i) => {
      if (event.type === 'TASK_FINISHED') {
        const timings = (event.payload as { openTimings?: unknown }).openTimings;
        if (timings !== undefined)
          issues.push(
            ...appOpenTimingsIssues(timings).map((issue) => ({
              ...issue,
              path: `/events/${i}/payload/openTimings${issue.path}`,
            })),
          );
      }
      if (event.type === 'BROWSER_ENVIRONMENT') {
        const ua = (event.payload as { userAgent?: string }).userAgent;
        if (!ua || !androidBrowserUa(ua))
          issues.push({
            path: `/events/${i}/payload/userAgent`,
            message: '必须报告安卓手机网页环境',
          });
      }
      if (
        i > 0 &&
        (event.sequence <= message.events[i - 1].sequence ||
          event.runId !== message.events[0].runId)
      )
        issues.push({ path: '/events', message: '事件顺序或批次不一致' });
    });
  }
  return issues;
}
export function appOpenTimingsIssues(value: unknown): Issue[] {
  const issues = schemaIssues('AppOpenTimings', value);
  if (issues.length) return issues;
  const timings = value as AppOpenTimings;
  if (new Set(timings.steps.map((s) => s.name)).size !== timings.steps.length)
    issues.push({ path: '/steps', message: '步骤名称重复' });
  if (timings.steps.some((s) => s.startedMs + s.elapsedMs > timings.totalMs))
    issues.push({ path: '/steps', message: '步骤时间超过本轮总耗时' });
  return issues;
}
export const loginIssues = (value: unknown) => schemaIssues('LoginInput', value);
export const passwordChangeIssues = (value: unknown) => schemaIssues('PasswordChangeInput', value);

export type {
  TaskPlanInput,
  TaskControlInput,
  TaskCycleView,
  TaskPlanView,
  TaskPlanDetail,
  TaskPlanList,
  TaskPlanQuery,
  MaintenanceQuery,
  MaintenanceItem,
  MaintenanceList,
  MaintenanceInput,
  MaintenanceResult,
} from './generated/types.js';

export const IDENTITY_MODELS = ['qa-model-01', 'qa-model-02', 'qa-model-03'] as const;
export function identitySupported(
  features: readonly string[] | undefined,
  version: string | null | undefined,
): boolean {
  return knownAgentAtLeast(version, '0.12.0') && features?.includes('DEVICE_VARIANTS_V1') === true;
}
export function ownedTestSupported(
  features: readonly string[] | undefined,
  version: string | null | undefined,
): boolean {
  return (
    knownAgentAtLeast(version, '0.12.0') && features?.includes('OWNED_TEST_CLIENT_V1') === true
  );
}

const knownAgentVersions: readonly string[] = [
  '0.3.0',
  '0.3.1',
  '0.3.2',
  '0.3.3',
  '0.3.4',
  '0.4.0',
  '0.4.1',
  '0.5.0',
  '0.5.1',
  '0.6.0',
  '0.6.1',
  '0.7.0',
  '0.7.1',
  '0.7.2',
  '0.8.0',
  '0.8.1',
  '0.9.0',
  '0.9.1',
  '0.9.2',
  '0.10.0',
  '0.11.0',
  '0.11.1',
  '0.12.0',
  '0.12.1',
  '0.12.2',
  '0.12.3',
];
function knownAgentAtLeast(version: string | null | undefined, minimum: string): boolean {
  const index = knownAgentVersions.indexOf(version ?? '');
  return index >= knownAgentVersions.indexOf(minimum);
}
export function agentProtocolsForVersion(version: string | null | undefined) {
  return {
    download: knownAgentAtLeast(version, '0.3.0'),
    registration: knownAgentAtLeast(version, '0.4.0'),
  };
}

export function requiredAgentProtocolsReady(
  features: readonly string[] | undefined,
  report: { downloadProtocol?: string | null; registrationProtocol?: string | null },
): boolean {
  return (
    (!features?.includes('DOWNLOAD_V1') || report.downloadProtocol === '1.0') &&
    (!features?.includes('REGISTRATION_V1') || report.registrationProtocol === '1.0')
  );
}

export function dailySupported(
  features: readonly string[] | undefined,
  version: string | null | undefined,
): boolean {
  return knownAgentAtLeast(version, '0.5.0') && features?.includes('DAILY_V1') === true;
}

export function autoRegistrationSupported(
  features: readonly string[] | undefined,
  version: string | null | undefined,
): boolean {
  return knownAgentAtLeast(version, '0.6.0') && features?.includes('AUTO_REGISTRATION_V1') === true;
}
