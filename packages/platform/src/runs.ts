import { Prisma } from '@prisma/client';
import type { PrismaClient, Run, Delivery, Prisma as P } from '@prisma/client';
import type {
  AgentMessage,
  RunInput,
  AgentReconcileInput,
  TestConfiguration,
} from '@apk/contracts';
import { agentIssues, schemaIssues, registrationFlowFor } from '@apk/contracts';
import { checked, readSecret } from './secrets.js';
import { digest, canonical } from './security.js';
import { lockNode, idle } from './nodes.js';
import { idempotent } from './jobs.js';
import { configSecrets } from './configurations.js';
import { fault } from './errors.js';
import { isIP } from 'node:net';
import { beijingDay, prepareDailyPlan, dailyTargetKey } from './daily-plan.js';
import type { DailyExecutionPlan } from '@apk/contracts';
import { lockLibrary } from './library-lock.js';
type Tx = P.TransactionClient;
export const ACTIVE_RUNS = ['ASSIGNED', 'RUNNING', 'STOP_REQUESTED'] as const;
export const RUN_END = ['SUCCEEDED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'];
export async function nodeAuth(tx: Tx, token: string, nodeId: string, bootId?: string) {
  const auth = await tx.agentCredential.findUnique({ where: { nodeId } });
  if (!auth || auth.revokedAt || auth.tokenHash !== digest(token))
    fault('UNAUTHENTICATED', '节点身份无效', 401);
  if (bootId && auth.bootId !== bootId) fault('AGENT_RECONCILE_REQUIRED', '节点重启后必须先核验');
  return auth;
}
export async function reviewRun(tx: Tx, run: Run, code: string) {
  if (RUN_END.includes(run.status)) return;
  await tx.run.update({
    where: { id: run.id },
    data: { status: 'NEEDS_REVIEW', finishedAt: new Date(), errorCode: code },
  });
  await tx.nodeSlot.updateMany({
    where: { nodeId: run.nodeId, runId: run.id },
    data: { quarantined: true },
  });
  if (run.purpose === 'REGISTER')
    await tx.task.updateMany({
      where: { runId: run.id, status: 'QUEUED', attemptStarted: false },
      data: { status: 'SKIPPED', errorCode: 'BATCH_NEEDS_REVIEW' },
    });
}
export async function expireNodeRun(tx: Tx, nodeId: string) {
  const slot = await tx.nodeSlot.findUnique({ where: { nodeId } });
  if (!slot?.runId) return;
  const run = await tx.run.findUnique({ where: { id: slot.runId }, include: { delivery: true } });
  if (!run || !ACTIVE_RUNS.includes(run.status as (typeof ACTIVE_RUNS)[number])) return;
  const d = run.delivery;
  if (
    !d ||
    d.leaseExpiresAt.getTime() <= Date.now() ||
    (!d.acceptedAt && d.ackDeadline.getTime() <= Date.now())
  )
    await reviewRun(tx, run, 'LEASE_EXPIRED');
}
export async function expireRuns(db: PrismaClient) {
  const candidates = await db.delivery.findMany({
    where: {
      run: { status: { in: [...ACTIVE_RUNS] } },
      OR: [
        { leaseExpiresAt: { lt: new Date() } },
        { acceptedAt: null, ackDeadline: { lt: new Date() } },
      ],
    },
    select: { run: { select: { nodeId: true } } },
    take: 100,
  });
  for (const { run } of candidates)
    await db.$transaction(async (tx) => {
      await lockNode(tx, run.nodeId);
      await expireNodeRun(tx, run.nodeId);
    });
}
export async function createRun(
  db: PrismaClient,
  body: unknown,
  actor: string,
  requestId: string,
  key: string,
  now = new Date(),
  scheduleId?: string,
  cycleId?: string,
  cycleGeneration?: number,
) {
  const input = checked<RunInput>('RunInput', body);
  return idempotent(db, actor, 'POST:/runs', key, input, async (tx) => {
    await lockLibrary(tx);
    const node = await lockNode(tx, input.nodeId);
    if (!cycleId && (await tx.managedTask.count({ where: { nodeId: node.id, enabled: true } })))
      fault('NODE_BUSY', '此服务器由任务中心管理，请先停止对应任务');
    if (cycleId) {
      const cycle = await tx.managedCycle.findUnique({
        where: { id: cycleId },
        include: { task: true },
      });
      if (
        !cycle ||
        cycle.stopRequested ||
        !cycle.task.enabled ||
        cycle.task.archivedAt ||
        cycle.day !== beijingDay(now)
      )
        fault('TASK_STOPPED', '任务已停止或日期已变化');
      if (cycleGeneration !== undefined && cycle.generation !== cycleGeneration)
        fault('TASK_CHANGED', '任务轮次已变化');
      if (
        cycle.nodeId !== input.nodeId ||
        cycle.configVersionId !== input.configVersionId ||
        cycle.releaseId !== input.releaseId
      )
        fault('VALIDATION_FAILED', '任务快照不一致', 422);
      const active = await tx.run.findFirst({
        where: { taskCycleId: cycleId, status: { notIn: RUN_END as Run['status'][] } },
      });
      if (active) return { operationId: active.id, resourceId: active.id, status: active.status };
    }
    if (scheduleId) {
      const schedule = await tx.dailySchedule.findUnique({ where: { id: scheduleId } });
      if (!schedule?.enabled || schedule.nodeId !== node.id)
        fault('SCHEDULE_DISABLED', '每日计划已关闭');
    }
    await expireNodeRun(tx, node.id);
    const config = await tx.configVersion.findUnique({ where: { id: input.configVersionId } });
    if (!config) fault('NOT_FOUND', '配置版本不存在', 404);
    const container = await tx.configuration.findUniqueOrThrow({ where: { id: config.configId } });
    if (config.archivedAt || container.archivedAt)
      fault('VERSION_ARCHIVED', '配置已归档，请恢复后使用');
    const dailyKey =
      input.purpose === 'DOWNLOAD'
        ? digest(canonical([node.id, config.configId, beijingDay(now)]))
        : null;
    if (dailyKey) {
      const existing = await tx.run.findUnique({ where: { dailyKey } });
      if (existing) {
        if (cycleId)
          await tx.managedCycle.update({
            where: { id: cycleId },
            data: { downloadRunId: existing.id, status: 'DOWNLOADING' },
          });
        return { operationId: existing.id, resourceId: existing.id, status: existing.status };
      }
    }
    await idle(tx, node.id);
    if (!node.lastSeenAt || node.lastSeenAt.getTime() < Date.now() - 45000)
      fault('NODE_OFFLINE', '节点尚未在线');
    if (node.agentReleaseId !== input.releaseId || node.deploymentStatus !== 'INSTALLED')
      fault('NODE_NOT_READY', '节点发布版本不匹配');
    const release = await tx.release.findUnique({ where: { id: input.releaseId } });
    const manifest = release?.manifest as
      | { features?: string[]; toolchain?: { systemImage?: string } }
      | undefined;
    const health = node.health as { download?: boolean; android?: boolean; kvm?: boolean } | null;
    if (
      !manifest?.features?.includes('DOWNLOAD_V1') ||
      node.downloadProtocol !== '1.0' ||
      !health?.download
    )
      fault('NODE_UPGRADE_REQUIRED', '请部署支持下载任务的 Agent 版本');
    const configuration = config.body as unknown as TestConfiguration;
    if (
      (input.purpose ||
        configuration.registrationFlows.some(
          (f) =>
            f.entryId ||
            f.packageName === '*' ||
            f.activity === '@launcher' ||
            [...f.steps.map((s) => s.locator), f.success.locator, f.failure?.locator].some((l) =>
              l?.value.includes('{packageName}'),
            ),
        ) ||
        configuration.download.landingRules.some(
          (r) => r.mode !== undefined || r.autoWaitMs !== undefined,
        )) &&
      (!manifest?.features?.includes('DAILY_V1') ||
        !['0.5.0', '0.5.1', '0.6.0'].includes(node.agentVersion ?? ''))
    )
      fault('NODE_UPGRADE_REQUIRED', '请部署支持每日下载与循环注册的 Agent');
    if (
      configuration.execution.autoRegistration !== undefined &&
      (!manifest?.features?.includes('AUTO_REGISTRATION_V1') || node.agentVersion !== '0.6.0')
    )
      fault('NODE_UPGRADE_REQUIRED', '自动识别注册入口需要 Agent 0.6.0');
    const plan = await prepareDailyPlan(tx, input, config, now);
    if (input.purpose === 'PROXY_CHECK')
      await readSecret(tx, input.proxySecretVersionId!, ['HTTP_PROXY']);
    else if (input.purpose !== 'DOWNLOAD') await configSecrets(tx, configuration);
    if (
      input.purpose === 'REGISTER' ||
      (!input.purpose && configuration.execution.mode === 'FULL')
    ) {
      if (!manifest.features?.includes('REGISTRATION_V1') || node.registrationProtocol !== '1.0')
        fault('NODE_UPGRADE_REQUIRED', '完整测试需要支持注册的 Agent 版本');
      if (!health?.android || !health.kvm) fault('NODE_NOT_READY', '安卓环境尚未就绪');
      if (
        configuration.execution.deviceProfiles.some(
          (p) => p.systemImage !== manifest.toolchain?.systemImage,
        )
      )
        fault('DEVICE_PROFILE_UNSUPPORTED', '设备镜像必须与签名工具链一致', 422);
    }
    if (input.supersedesRunId) {
      const old = await tx.run.findUnique({ where: { id: input.supersedesRunId } });
      if (!old || !RUN_END.includes(old.status) || old.nodeId !== node.id)
        fault('VALIDATION_FAILED', '关联批次无效', 422);
    }
    const run = await tx.run.create({
      data: {
        ...input,
        ...(cycleId ? { taskCycleId: cycleId } : {}),
        configHash: config.configHash,
        createdBy: actor,
        ...(plan
          ? { executionPlan: plan as unknown as Prisma.InputJsonValue, cacheDay: plan.cacheDay }
          : {}),
        ...(dailyKey ? { dailyKey } : {}),
      },
    });
    if (cycleId)
      await tx.managedCycle.update({
        where: { id: cycleId },
        data:
          input.purpose === 'DOWNLOAD'
            ? { downloadRunId: run.id, status: 'DOWNLOADING' }
            : input.purpose === 'PROXY_CHECK'
              ? { proxyRunId: run.id, status: 'CHECKING_PROXY' }
              : { status: 'REGISTERING' },
      });
    await tx.nodeSlot.update({
      where: { nodeId: node.id },
      data: { runId: run.id, fence: { increment: 1 } },
    });
    await tx.auditEvent.create({ data: { adminId: actor, action: 'RUN_CREATED', requestId } });
    return { operationId: run.id, resourceId: run.id, status: run.status };
  });
}
function message<K extends AgentMessage['kind']>(body: unknown, kind: K) {
  if (agentIssues(body).length || (body as { kind?: unknown })?.kind !== kind)
    fault('VALIDATION_FAILED', '节点消息无效', 422);
  return body as Extract<AgentMessage, { kind: K }>;
}
function deliveryView(run: Run, d: Delivery) {
  return {
    kind: 'delivery',
    protocolVersion: '1.0',
    nodeId: run.nodeId,
    deliveryId: d.id,
    runId: run.id,
    fence: d.fence,
    configVersionId: run.configVersionId,
    configHash: run.configHash,
    releaseId: run.releaseId,
    issuedAt: d.issuedAt.toISOString(),
    ackDeadline: d.ackDeadline.toISOString(),
    leaseExpiresAt: d.leaseExpiresAt.toISOString(),
  };
}
export async function claimRun(db: PrismaClient, token: string, body: unknown) {
  const input = message(body, 'claim');
  return db.$transaction(async (tx) => {
    const node = await lockNode(tx, input.nodeId);
    const auth = await nodeAuth(tx, token, node.id, input.bootId);
    await expireNodeRun(tx, node.id);
    const slot = await tx.nodeSlot.findUnique({ where: { nodeId: node.id } });
    if (slot?.quarantined) fault('NODE_QUARANTINED', '节点待核验');
    if (!slot?.runId) return null;
    const run = await tx.run.findUniqueOrThrow({
      where: { id: slot.runId },
      include: { delivery: true },
    });
    if (
      run.releaseId !== auth.releaseId ||
      run.releaseId !== node.agentReleaseId ||
      node.downloadProtocol !== '1.0'
    )
      fault('NODE_NOT_READY', '节点不满足固定任务版本');
    if (run.delivery) {
      if (run.delivery.bootId !== input.bootId) fault('AGENT_RECONCILE_REQUIRED', '旧任务需要核验');
      if (RUN_END.includes(run.status)) return null;
      return deliveryView(run, run.delivery);
    }
    if (run.status !== 'QUEUED') return null;
    const d = await tx.delivery.create({
      data: {
        runId: run.id,
        bootId: input.bootId,
        fence: slot.fence,
        ackDeadline: new Date(Date.now() + 30000),
        leaseExpiresAt: new Date(Date.now() + 120000),
      },
    });
    await tx.run.update({ where: { id: run.id }, data: { status: 'ASSIGNED' } });
    return deliveryView(run, d);
  });
}
export async function boundDelivery(
  tx: Tx,
  token: string,
  nodeId: string,
  id: string,
  fence: number,
  bootId?: string,
) {
  await lockNode(tx, nodeId);
  await nodeAuth(tx, token, nodeId, bootId);
  await expireNodeRun(tx, nodeId);
  const d = await tx.delivery.findUnique({ where: { id }, include: { run: true } });
  if (!d || d.run.nodeId !== nodeId || d.fence !== fence || (bootId && d.bootId !== bootId))
    fault('STALE_FENCE', '任务分配不匹配');
  return d;
}
const bound = boundDelivery;
function authorized(d: Delivery & { run: Run }) {
  if (
    !ACTIVE_RUNS.includes(d.run.status as (typeof ACTIVE_RUNS)[number]) ||
    d.leaseExpiresAt.getTime() <= Date.now()
  )
    fault('LEASE_EXPIRED', '任务执行权已失效');
}
export async function acceptRun(db: PrismaClient, token: string, id: string, body: unknown) {
  const input = message(body, 'accept');
  if (input.deliveryId !== id) fault('STALE_FENCE', '分配编号不一致');
  return db.$transaction(async (tx) => {
    const d = await bound(tx, token, input.nodeId, id, input.fence, input.bootId);
    authorized(d);
    if (!d.acceptedAt) {
      if (d.ackDeadline.getTime() <= Date.now()) fault('LEASE_EXPIRED', '接收期限已过');
      await tx.delivery.update({ where: { id }, data: { acceptedAt: new Date() } });
      if (d.run.status === 'ASSIGNED')
        await tx.run.update({ where: { id: d.runId }, data: { status: 'RUNNING' } });
    }
    return {
      deliveryId: id,
      fence: d.fence,
      leaseExpiresAt: d.leaseExpiresAt.toISOString(),
      desiredControl: d.run.stopRequested ? 'STOP' : 'CONTINUE',
    };
  });
}
export async function deliveryConfig(db: PrismaClient, token: string, id: string, body: unknown) {
  const input = checked<{ nodeId: string; bootId: string; deliveryId: string; fence: number }>(
    'DeliveryConfigInput',
    body,
  );
  if (input.deliveryId !== id) fault('STALE_FENCE', '分配编号不一致');
  return db.$transaction(async (tx) => {
    const d = await bound(tx, token, input.nodeId, id, input.fence, input.bootId);
    authorized(d);
    if (!d.acceptedAt || d.run.stopRequested) fault('NODE_NOT_READY', '任务尚未接收或已请求停止');
    const v = await tx.configVersion.findUniqueOrThrow({ where: { id: d.run.configVersionId! } });
    const config = v.body as unknown as TestConfiguration;
    await configSecrets(tx, config);
    const proxyId =
      d.run.purpose === 'DOWNLOAD'
        ? undefined
        : d.run.purpose === 'PROXY_CHECK'
          ? d.run.proxySecretVersionId!
          : config.execution.mode === 'FULL'
            ? config.execution.proxySecretVersionId
            : undefined;
    const secretVersions = proxyId
      ? [
          {
            id: proxyId,
            type: 'HTTP_PROXY',
            secretValue: await readSecret(tx, proxyId, ['HTTP_PROXY']),
          },
        ]
      : [];
    return {
      deliveryId: id,
      configHash: v.configHash,
      config,
      secretVersions,
      ...(d.run.executionPlan ? { executionPlan: d.run.executionPlan } : {}),
    };
  });
}
export async function closeRun(
  tx: Tx,
  run: Run,
  status: 'SUCCEEDED' | 'PARTIAL_FAILED' | 'FAILED' | 'CANCELLED',
  errorCode?: string,
) {
  await tx.run.update({
    where: { id: run.id },
    data: { status, finishedAt: new Date(), ...(errorCode ? { errorCode } : {}) },
  });
  await tx.nodeSlot.updateMany({
    where: { nodeId: run.nodeId, runId: run.id },
    data: { runId: null },
  });
}
export async function requestRunStop(tx: Tx, id: string) {
  const previous = await tx.run.findUnique({ where: { id } });
  if (!previous) fault('NOT_FOUND', '批次不存在', 404);
  await lockNode(tx, previous.nodeId);
  await expireNodeRun(tx, previous.nodeId);
  const run = await tx.run.findUniqueOrThrow({ where: { id } });
  if (run.status === 'QUEUED') await closeRun(tx, run, 'CANCELLED');
  else if (!RUN_END.includes(run.status))
    await tx.run.update({ where: { id }, data: { status: 'STOP_REQUESTED', stopRequested: true } });
  return {
    operationId: id,
    resourceId: id,
    status:
      run.status === 'QUEUED'
        ? 'CANCELLED'
        : RUN_END.includes(run.status)
          ? run.status
          : 'STOP_REQUESTED',
  };
}
export async function stopRun(
  db: PrismaClient,
  id: string,
  reason: unknown,
  actor: string,
  requestId: string,
  key: string,
) {
  return idempotent(db, actor, 'POST:/runs/' + id + '/stop', key, reason, async (tx) => {
    const result = await requestRunStop(tx, id);
    await tx.auditEvent.create({
      data: { adminId: actor, action: 'RUN_STOP_REQUESTED', requestId },
    });
    return result;
  });
}
type Event = Extract<AgentMessage, { kind: 'events' }>['events'][number];
async function applyEvent(tx: Tx, runId: string, event: Event) {
  const run = await tx.run.findUniqueOrThrow({ where: { id: runId } });
  const version = run.configVersionId
    ? await tx.configVersion.findUnique({ where: { id: run.configVersionId } })
    : null;
  const config = version?.body as unknown as TestConfiguration;
  const full =
    run.purpose === 'REGISTER' || (run.purpose === 'LEGACY' && config?.execution.mode === 'FULL');
  const plan = run.executionPlan as unknown as DailyExecutionPlan | null;
  const p = event.payload as Record<string, unknown>;
  if (event.type === 'RUN_STARTED') {
    if (event.sequence !== 1 || p.configHash !== run.configHash || p.releaseId !== run.releaseId)
      fault('EVENT_CONFLICT', '开始事件不匹配');
    return;
  }
  if (event.type === 'TARGETS_DISCOVERED') {
    if (run.purpose === 'PROXY_CHECK') fault('EVENT_CONFLICT', '代理检查不接受 APK 目标');
    if (run.discovered) fault('EVENT_CONFLICT', '目标发现不可重复');
    const targets = p.targets as {
      taskId: string;
      targetKey: string;
      label: string;
      sourceUrl: string;
      entryId?: string;
    }[];
    const config = await tx.configVersion.findUniqueOrThrow({
      where: { id: run.configVersionId! },
    });
    const max =
      run.purpose === 'REGISTER'
        ? run.attemptLimit
        : (config.body as unknown as TestConfiguration).download.maxTargets;
    const start = await tx.task.count({ where: { runId } });
    if (
      (p.startIndex ?? 0) !== start ||
      start + targets.length > max ||
      new Set(targets.map((t) => t.taskId)).size !== targets.length ||
      new Set(targets.map((t) => t.targetKey)).size !== targets.length
    )
      fault('EVENT_CONFLICT', '目标数量或编号冲突');
    for (const [offset, t] of targets.entries()) {
      if (run.purpose === 'REGISTER') {
        const asset = plan?.assets[(start + offset) % plan.assets.length];
        if (
          !asset ||
          t.targetKey !== dailyTargetKey(asset.targetKey, start + offset) ||
          t.sourceUrl !== asset.sourceUrl ||
          t.entryId !== asset.entryId
        )
          fault('EVENT_CONFLICT', '注册轮次与下载资产不一致');
      }
      const url = new URL(t.sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        fault('EVENT_CONFLICT', '目标地址无效');
      await tx.task.create({
        data: {
          id: t.taskId,
          runId,
          targetKey: t.targetKey,
          label: t.label,
          sourceUrl: t.sourceUrl,
          position: start + offset,
          ...(t.entryId ? { entryId: t.entryId } : {}),
        },
      });
    }
    const complete = p.complete !== false;
    await tx.run.update({
      where: { id: runId },
      data: {
        discovered: complete,
        ...(complete && !targets.length && !start ? { errorCode: 'NO_TARGETS' } : {}),
      },
    });
    return;
  }
  if (event.type === 'PROXY_CHECKED') {
    if (
      run.purpose !== 'PROXY_CHECK' ||
      run.proxyObservation ||
      schemaIssues('ProxyObservation', p).length ||
      (p.status === 'SUCCEEDED' &&
        (!isIP(String(p.ip ?? '')) || p.scope !== 'PROBE_ONLY' || typeof p.at !== 'string'))
    )
      fault('EVENT_CONFLICT', '代理检查结果无效');
    await tx.run.update({
      where: { id: runId },
      data: { proxyObservation: p as Prisma.InputJsonValue },
    });
    return;
  }
  if (event.type === 'SUBMISSION_INTENT') {
    const task = await tx.task.findUnique({ where: { id: event.taskId } });
    const account = await tx.accountResult.findUnique({
      where: { accountRef: String(p.accountRef) },
    });
    if (
      !full ||
      !task ||
      task.runId !== runId ||
      task.status !== 'REGISTERING' ||
      task.submissionId ||
      !account ||
      account.taskId !== task.id ||
      !task.observation
    )
      fault('EVENT_CONFLICT', '提交意图与账户或阶段不匹配');
    await tx.task.update({
      where: { id: task.id },
      data: {
        submissionId: String(p.submissionId),
        accountRef: account.accountRef,
        submittedAt: new Date(),
      },
    });
    return;
  }
  if (event.type === 'TASK_STAGE' || event.type === 'TASK_FINISHED') {
    const task = await tx.task.findUnique({ where: { id: event.taskId } });
    if (!run.discovered || !task || task.runId !== runId)
      fault('EVENT_CONFLICT', '目标不属于本批次或发现尚未完成');
    const automatic =
      full &&
      config.execution.autoRegistration?.enabled === true &&
      !registrationFlowFor(
        config,
        (task.apk as { packageName?: string } | null)?.packageName ?? '',
        task.entryId ?? undefined,
      );
    if (p.recognition) {
      const summary = p.recognition as {
        learned: boolean;
        source: string;
        cache: string;
        templateHash?: string;
        needsAdaptation: boolean;
      };
      if (
        !automatic ||
        (event.type === 'TASK_STAGE' &&
          (p.stage !== 'REGISTERING' || summary.learned || summary.needsAdaptation)) ||
        (summary.learned && (p.status !== 'SUCCEEDED' || !summary.templateHash)) ||
        (summary.source === 'LEARNED') !== (summary.cache === 'HIT') ||
        (summary.cache === 'HIT' && !summary.templateHash) ||
        (summary.needsAdaptation &&
          (p.status !== 'FAILED' || !String(p.errorCode).startsWith('AUTO_')))
      )
        fault('EVENT_CONFLICT', '自动识别摘要与任务不一致');
    }
    if (event.type === 'TASK_STAGE') {
      const stage = String(p.stage);
      if (run.purpose === 'REGISTER' && stage === 'DOWNLOADING') {
        const active = await tx.task.count({
          where: {
            runId,
            attemptStarted: true,
            status: { notIn: ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'] },
          },
        });
        if (
          task.status !== 'QUEUED' ||
          task.attemptStarted ||
          task.position !== run.attemptsStarted ||
          active ||
          run.attemptsStarted >= run.attemptLimit ||
          run.successes >= run.successTarget
        )
          fault('EVENT_CONFLICT', '上一轮尚未结束或已达到注册配额');
        await tx.run.update({ where: { id: runId }, data: { attemptsStarted: { increment: 1 } } });
        await tx.task.update({ where: { id: task.id }, data: { attemptStarted: true } });
      }
      const androidStages = [
        'DOWNLOADED',
        'PREPARING',
        'INSTALLING',
        'LAUNCHING',
        ...(automatic ? ['DISCOVERING'] : []),
        'REGISTERING',
        'VERIFYING',
      ];
      const androidForward =
        full &&
        androidStages.indexOf(task.status) >= 0 &&
        androidStages.indexOf(stage) === androidStages.indexOf(task.status) + 1;
      if (
        !(['QUEUED', 'DOWNLOADING'].includes(task.status) && stage === 'DOWNLOADING') &&
        !(task.status === 'DOWNLOADING' && stage === 'DOWNLOADED') &&
        !androidForward
      )
        fault('EVENT_CONFLICT', '任务阶段不能跳过或倒退');
      if (stage === 'DOWNLOADED' && schemaIssues('ApkMetadata', p.apk).length)
        fault('EVENT_CONFLICT', '缺少 APK 校验元数据');
      if (stage === 'DOWNLOADED' && run.purpose === 'REGISTER') {
        const expected = plan?.assets[task.position % plan.assets.length]?.apk;
        if (!expected || canonical(expected) !== canonical(p.apk))
          fault('EVENT_CONFLICT', '缓存资产元数据被修改');
      }
      if (stage === 'INSTALLING') {
        const observation = p.observation as
          | { profileId?: string; proxyObservedIp?: string }
          | undefined;
        if (
          !observation ||
          !config.execution.deviceProfiles.some((v) => v.id === observation.profileId) ||
          !isIP(observation.proxyObservedIp ?? '')
        )
          fault('EVENT_CONFLICT', '缺少设备与代理探测证据');
      }
      if (stage === 'VERIFYING' && !task.submissionId)
        fault('EVENT_CONFLICT', '核验前必须保存提交意图');
      if (p.observation && stage !== 'INSTALLING')
        fault('EVENT_CONFLICT', '设备证据只能在安装前记录');
      await tx.task.update({
        where: { id: task.id },
        data: {
          status: stage,
          lastStage: stage,
          startedAt: task.startedAt ?? new Date(),
          ...(!task.registrationStartedAt && (run.purpose === 'REGISTER' || stage === 'PREPARING')
            ? { registrationStartedAt: new Date() }
            : {}),
          ...(stage === 'DOWNLOADED'
            ? { apk: p.apk as Prisma.InputJsonValue, cacheHit: p.cacheHit === true }
            : {}),
          ...(p.observation ? { observation: p.observation as Prisma.InputJsonValue } : {}),
          ...(p.recognition ? { recognition: p.recognition as Prisma.InputJsonValue } : {}),
        },
      });
      return;
    }
    if (['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED', 'UNKNOWN'].includes(task.status))
      fault('EVENT_CONFLICT', '目标已结束');
    const status = String(p.status);
    if (
      !full &&
      status === 'SUCCEEDED' &&
      (task.status !== 'DOWNLOADED' || !task.apk || p.proof !== 'FILE_VALIDATION')
    )
      fault('EVENT_CONFLICT', '下载成功必须有文件校验证据');
    if (!full && (p.proof === 'APP_UI' || status === 'UNKNOWN'))
      fault('FEATURE_UNAVAILABLE', 'P2 不接受注册结果', 422);
    if (full) {
      const account = p.accountRef
        ? await tx.accountResult.findUnique({ where: { accountRef: String(p.accountRef) } })
        : null;
      if (p.accountRef && (!account || account.taskId !== task.id))
        fault('EVENT_CONFLICT', '账户不属于本任务');
      if (
        p.proof === 'APP_UI' &&
        (!task.submissionId || task.status !== 'VERIFYING' || !task.observation || !account)
      )
        fault('EVENT_CONFLICT', '界面结果必须有关联提交和核验阶段');
      if (
        task.submissionId &&
        (p.accountRef !== task.accountRef || !['SUCCEEDED', 'UNKNOWN', 'FAILED'].includes(status))
      )
        fault('EVENT_CONFLICT', '提交后不能跳过或取消注册结果');
      if (status === 'UNKNOWN' && !task.submissionId)
        fault('EVENT_CONFLICT', '未知注册结果必须关联提交意图');
      if (
        task.submissionId &&
        status === 'FAILED' &&
        (p.errorCode !== 'REGISTRATION_REJECTED' || p.proof !== 'APP_UI')
      )
        fault('EVENT_CONFLICT', '提交后仅明确拒绝可记为失败');
      if (
        status === 'SUCCEEDED' &&
        (!task.apk ||
          !task.observation ||
          !task.submissionId ||
          task.status !== 'VERIFYING' ||
          !account ||
          p.proof !== 'APP_UI')
      )
        fault('EVENT_CONFLICT', '注册成功缺少提交与界面证据');
      if (
        status === 'SKIPPED' &&
        (task.status !== 'DOWNLOADED' || p.errorCode !== 'FLOW_NOT_CONFIGURED')
      )
        fault('EVENT_CONFLICT', '未适配任务才能跳过');
      const ids = p.artifactIds as string[];
      if (
        ids.length &&
        (await tx.artifact.count({
          where: { id: { in: ids }, taskId: task.id, recordedForReview: false },
        })) !== ids.length
      )
        fault('EVENT_CONFLICT', '截图不属于本次有效任务');
    }
    await tx.task.update({
      where: { id: task.id },
      data: {
        status,
        finishedAt: new Date(),
        ...(full && !task.registrationStartedAt && status === 'SKIPPED'
          ? { registrationStartedAt: new Date() }
          : {}),
        proof: String(p.proof),
        errorCode: typeof p.errorCode === 'string' ? p.errorCode : null,
        ...(typeof p.accountRef === 'string' ? { accountRef: p.accountRef } : {}),
        ...(p.recognition ? { recognition: p.recognition as Prisma.InputJsonValue } : {}),
      },
    });
    if (run.purpose === 'REGISTER' && status === 'SUCCEEDED')
      await tx.run.update({ where: { id: runId }, data: { successes: { increment: 1 } } });
    return;
  }
  if (event.type === 'STOP_ACK') {
    if (p.cleanupComplete !== true) {
      await reviewRun(tx, run, 'CLEANUP_INCOMPLETE');
      return;
    }
    if (!run.stopRequested) fault('EVENT_CONFLICT', '尚未请求停止');
    const unresolved = await tx.task.count({
      where: {
        runId,
        OR: [
          { status: 'UNKNOWN' },
          { submissionId: { not: null }, status: { notIn: ['SUCCEEDED', 'FAILED'] } },
        ],
      },
    });
    if (unresolved) {
      await tx.task.updateMany({
        where: {
          runId,
          submissionId: { not: null },
          status: { notIn: ['SUCCEEDED', 'FAILED', 'UNKNOWN'] },
        },
        data: { status: 'UNKNOWN', errorCode: 'REGISTRATION_UNKNOWN' },
      });
      await reviewRun(tx, run, 'REGISTRATION_UNKNOWN');
      return;
    }
    await tx.task.updateMany({
      where: {
        runId,
        status: { notIn: ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED', 'UNKNOWN'] },
      },
      data: { status: 'CANCELLED' },
    });
    await closeRun(tx, run, 'CANCELLED');
    return;
  }
  if (event.type === 'RUN_FINISHED') {
    const tasks = await tx.task.findMany({ where: { runId } });
    if (tasks.some((t) => t.status === 'UNKNOWN') || p.errorCode === 'CLEANUP_INCOMPLETE') {
      if (p.status !== 'NEEDS_REVIEW') fault('EVENT_CONFLICT', '未知结果或清理失败必须隔离');
      await reviewRun(
        tx,
        run,
        p.errorCode === 'CLEANUP_INCOMPLETE' ? 'CLEANUP_INCOMPLETE' : 'REGISTRATION_UNKNOWN',
      );
      return;
    }
    if (run.stopRequested) return; // Acknowledge the race, but only STOP_ACK can release this slot.
    if (run.purpose === 'PROXY_CHECK') {
      const observation = run.proxyObservation as { status?: string } | null;
      const expected = observation?.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
      if (!observation || tasks.length || p.status !== expected)
        fault('EVENT_CONFLICT', '代理检查汇总不一致');
      await closeRun(tx, run, expected, expected === 'FAILED' ? 'PROXY_CHECK_FAILED' : undefined);
      return;
    }
    if (run.purpose === 'REGISTER') {
      const active = tasks.filter(
        (t) =>
          t.attemptStarted && !['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(t.status),
      );
      const reached = run.successes >= run.successTarget;
      const empty = !plan?.assets.length;
      const missing =
        p.errorCode === 'CACHE_MISSING' &&
        tasks.some((t) => t.attemptStarted && t.errorCode === 'CACHE_MISSING');
      const changed =
        p.errorCode === 'FLOW_LAYOUT_CHANGED' &&
        tasks.some(
          (t) => t.attemptStarted && !t.submissionId && t.errorCode === 'FLOW_STEP_FAILED',
        );
      const adaptation =
        p.errorCode === 'AUTO_ADAPTATION_REQUIRED' &&
        tasks.some(
          (t) =>
            t.attemptStarted &&
            !t.submissionId &&
            t.errorCode?.startsWith('AUTO_') &&
            (t.recognition as { needsAdaptation?: boolean } | null)?.needsAdaptation === true,
        );
      if (
        !run.discovered ||
        active.length ||
        (!reached &&
          !empty &&
          !missing &&
          !changed &&
          !adaptation &&
          run.attemptsStarted < run.attemptLimit)
      )
        fault('EVENT_CONFLICT', '注册循环尚未达到终止条件');
      const expected = reached ? 'SUCCEEDED' : run.successes ? 'PARTIAL_FAILED' : 'FAILED';
      const code = reached
        ? undefined
        : empty
          ? 'NO_ADAPTED_APKS'
          : adaptation
            ? 'AUTO_ADAPTATION_REQUIRED'
            : changed
              ? 'FLOW_LAYOUT_CHANGED'
              : missing
                ? 'CACHE_MISSING'
                : 'ATTEMPT_LIMIT';
      if (p.status !== expected || p.errorCode !== code)
        fault('EVENT_CONFLICT', '配额结果或原因不一致');
      await tx.task.updateMany({
        where: { runId, status: 'QUEUED', attemptStarted: false },
        data: { status: 'SKIPPED', errorCode: reached ? 'QUOTA_NOT_USED' : 'BATCH_ENDED' },
      });
      await closeRun(tx, run, expected, code);
      return;
    }
    if (tasks.some((t) => !['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(t.status)))
      fault('EVENT_CONFLICT', '目标尚未全部结束');
    const count = tasks.filter((t) => t.status === 'SUCCEEDED').length;
    const status =
      !run.discovered || !tasks.length
        ? 'FAILED'
        : count === tasks.length
          ? 'SUCCEEDED'
          : count
            ? 'PARTIAL_FAILED'
            : 'FAILED';
    if (p.status !== status) fault('EVENT_CONFLICT', '批次汇总不一致');
    await closeRun(
      tx,
      run,
      status,
      typeof p.errorCode === 'string'
        ? p.errorCode
        : (run.errorCode ?? (tasks.length ? undefined : 'NO_TARGETS')),
    );
    return;
  }
  fault('FEATURE_UNAVAILABLE', 'P2 不接受此事件', 422);
}
export async function runEvents(db: PrismaClient, token: string, body: unknown) {
  const input = message(body, 'events');
  return db.$transaction(
    async (tx) => {
      const d = await bound(tx, token, input.nodeId, input.deliveryId, input.fence);
      const late = RUN_END.includes(d.run.status) || d.leaseExpiresAt.getTime() <= Date.now();
      if (!late && !d.acceptedAt) fault('NODE_NOT_READY', '尚未确认接收');
      for (const event of input.events) {
        if (event.runId !== d.runId) fault('EVENT_CONFLICT', '事件批次不匹配');
        if (
          ![
            'RUN_STARTED',
            'TARGETS_DISCOVERED',
            'TASK_STAGE',
            'SUBMISSION_INTENT',
            'TASK_FINISHED',
            'RUN_FINISHED',
            'STOP_ACK',
            'PROXY_CHECKED',
          ].includes(event.type)
        )
          fault('FEATURE_UNAVAILABLE', 'P2 不接受此事件', 422);
        const hash = digest(canonical(event));
        const existing = await tx.runEvent.findFirst({
          where: { OR: [{ id: event.eventId }, { deliveryId: d.id, sequence: event.sequence }] },
        });
        if (existing) {
          if (
            existing.id !== event.eventId ||
            existing.deliveryId !== d.id ||
            existing.contentHash !== hash
          )
            fault('EVENT_CONFLICT', '相同事件内容冲突');
          continue;
        }
        await tx.runEvent.create({
          data: {
            id: event.eventId,
            deliveryId: d.id,
            sequence: event.sequence,
            contentHash: hash,
            body: event as unknown as Prisma.InputJsonValue,
            recordedForReview: late,
          },
        });
      }
      let applied = d.appliedThroughSequence;
      if (!late) {
        while (true) {
          const next = await tx.runEvent.findUnique({
            where: { deliveryId_sequence: { deliveryId: d.id, sequence: applied + 1 } },
          });
          if (!next || next.recordedForReview) break;
          const current = await tx.run.findUniqueOrThrow({ where: { id: d.runId } });
          if (RUN_END.includes(current.status)) break;
          await applyEvent(tx, d.runId, next.body as unknown as Event);
          applied++;
        }
        await tx.delivery.update({
          where: { id: d.id },
          data: { appliedThroughSequence: applied },
        });
      }
      const current = await tx.run.findUniqueOrThrow({ where: { id: d.runId } });
      return {
        ackedEventIds: input.events.map((e) => e.eventId),
        appliedThroughSequence: applied,
        recordedForReview: late,
        desiredControl:
          current.stopRequested || current.status === 'NEEDS_REVIEW' ? 'STOP' : 'CONTINUE',
        reconcileRequired: current.status === 'NEEDS_REVIEW',
      };
    },
    { timeout: 15000 },
  );
}
export async function reconcileAgent(db: PrismaClient, token: string, body: unknown) {
  const input = checked<AgentReconcileInput>('AgentReconcileInput', body);
  return db.$transaction(async (tx) => {
    await lockNode(tx, input.nodeId);
    await nodeAuth(tx, token, input.nodeId);
    const slot = await tx.nodeSlot.findUnique({ where: { nodeId: input.nodeId } });
    if (slot?.runId) {
      const run = await tx.run.findUniqueOrThrow({
        where: { id: slot.runId },
        include: { delivery: true },
      });
      if (run.status !== 'QUEUED' && !RUN_END.includes(run.status))
        await reviewRun(tx, run, 'AGENT_RESTARTED');
      if (run.status !== 'QUEUED') {
        const local = run.delivery
          ? input.deliveries.find(
              (d) => d.deliveryId === run.delivery!.id && d.fence === run.delivery!.fence,
            )
          : null;
        const clean =
          input.cleanupComplete && (local?.cleanupComplete ?? input.deliveries.length === 0);
        for (const submission of local?.submissions ?? []) {
          const task = await tx.task.findUnique({ where: { id: submission.taskId } });
          const account = await tx.accountResult.findUnique({
            where: { accountRef: submission.accountRef },
          });
          if (
            !task ||
            task.runId !== run.id ||
            !account ||
            account.taskId !== task.id ||
            account.deliveryId !== run.delivery?.id
          )
            fault('EVENT_CONFLICT', '恢复提交摘要不匹配');
          if (task.submissionId && task.submissionId !== submission.submissionId)
            fault('EVENT_CONFLICT', '提交编号不可替换');
          if (!['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(task.status))
            await tx.task.update({
              where: { id: task.id },
              data: {
                submissionId: submission.submissionId,
                accountRef: account.accountRef,
                status: 'UNKNOWN',
                errorCode: 'REGISTRATION_UNKNOWN',
              },
            });
        }
        await tx.task.updateMany({
          where: {
            runId: run.id,
            submissionId: { not: null },
            status: { notIn: ['SUCCEEDED', 'FAILED', 'UNKNOWN'] },
          },
          data: { status: 'UNKNOWN', errorCode: 'REGISTRATION_UNKNOWN' },
        });
        await tx.run.update({
          where: { id: run.id },
          data: {
            cleanupConfirmedAt: clean ? new Date() : null,
            cleanupBootId: clean ? input.bootId : null,
          },
        });
      }
    }
    await tx.agentCredential.update({
      where: { nodeId: input.nodeId },
      data: { bootId: input.bootId },
    });
    return { reconciled: true, mayClaim: !slot?.runId && !slot?.quarantined };
  });
}
export async function reconcileRun(
  db: PrismaClient,
  id: string,
  body: unknown,
  actor: string,
  requestId: string,
  key: string,
) {
  return idempotent(db, actor, 'POST:/runs/' + id + '/reconciliations', key, body, async (tx) => {
    const run = await tx.run.findUnique({ where: { id } });
    if (!run) fault('NOT_FOUND', '批次不存在', 404);
    const node = await lockNode(tx, run.nodeId);
    const auth = await tx.agentCredential.findUnique({ where: { nodeId: node.id } });
    const slot = await tx.nodeSlot.findUnique({ where: { nodeId: node.id } });
    if (
      await tx.task.count({
        where: {
          runId: id,
          status: 'UNKNOWN',
          reviews: { none: { outcome: { in: ['SUCCEEDED', 'FAILED'] } } },
        },
      })
    )
      fault('NODE_QUARANTINED', '须先记录未知注册任务的人工核验决议');
    if (
      run.status !== 'NEEDS_REVIEW' ||
      !run.cleanupConfirmedAt ||
      run.cleanupBootId !== auth?.bootId ||
      !node.lastSeenAt ||
      node.lastSeenAt <= run.cleanupConfirmedAt ||
      node.lastSeenAt.getTime() < Date.now() - 45000 ||
      node.currentDeliveryId ||
      slot?.runId !== run.id ||
      slot.operationId
    )
      fault('NODE_QUARANTINED', '需要节点重启核验、清理确认和新的空闲心跳');
    await tx.run.update({
      where: { id },
      data: {
        reviewResolvedAt: new Date(),
        reconciliationReason: (body as { reason: string }).reason,
        reconciledBy: actor,
      },
    });
    await tx.nodeSlot.update({
      where: { nodeId: node.id },
      data: { runId: null, quarantined: false },
    });
    await tx.auditEvent.create({ data: { adminId: actor, action: 'RUN_RECONCILED', requestId } });
    return { id, reconciled: true };
  });
}
