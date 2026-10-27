import validators from './generated/validators.js';
import type {
  TestConfiguration,
  AgentMessage,
  LoginInput,
  PasswordChangeInput,
} from './generated/types.js';
export type { TestConfiguration, AgentMessage, LoginInput, PasswordChangeInput };
export type { SessionView, NodeList, RunList, AuditList } from './generated/types.js';
export interface Issue {
  path: string;
  message: string;
}
function schemaIssues(name: keyof typeof validators, value: unknown): Issue[] {
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
  const packages = config.registrationFlows.map((f) => f.packageName);
  if (new Set(packages).size !== packages.length)
    issues.push({ path: '/registrationFlows', message: '同一个包名只能配置一个流程' });
  for (const [i, flow] of config.registrationFlows.entries()) {
    const index = flow.steps.findIndex((s) => s.action === 'submit');
    if (flow.steps.slice(index + 1).some((s) => !['wait', 'back'].includes(s.action)))
      issues.push({ path: `/registrationFlows/${i}/steps`, message: '提交后只允许等待或返回' });
  }
  return issues;
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
export const loginIssues = (value: unknown) => schemaIssues('LoginInput', value);
export const passwordChangeIssues = (value: unknown) => schemaIssues('PasswordChangeInput', value);
