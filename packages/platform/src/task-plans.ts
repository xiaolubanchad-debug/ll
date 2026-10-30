import { assertIdentityReady } from './identity.js';
import { Prisma } from '@prisma/client';
import type { PrismaClient, ManagedCycle, ManagedTask, Run, ConfigVersion } from '@prisma/client';
import type {
  TaskPlanInput,
  TaskPlanView,
  TaskCycleView,
  TaskPlanQuery,
  TaskPlanDetail,
  TaskControlInput,
  TestConfiguration,
} from '@apk/contracts';
import {
  schemaIssues,
  contentIsolationSupported,
  appReadinessSupported,
  appOpenSupported,
  parallelAppOpenSupported,
} from '@apk/contracts';
import { checked } from './secrets.js';
import { configBody, configSecrets } from './configurations.js';
import { canonical, digest } from './security.js';
import { idempotent } from './jobs.js';
import { lockLibrary } from './library-lock.js';
import { lockNode, idle } from './nodes.js';
import { fault, PlatformError } from './errors.js';
import { dailyOpenUsage } from './open-budget.js';
import { beijingDay, validateBudget } from './daily-plan.js';
import { createRun, stopRun, requestRunStop, downloadRetryParent, RUN_END } from './runs.js';
type Tx = Prisma.TransactionClient;
const closed = ['DONE', 'FAILED', 'STOPPED'];
const cycleInclude = { runs: { orderBy: { createdAt: 'asc' as const } } };
const planInclude = {
  node: { include: { slot: true } },
  currentVersion: true,
  cycles: { include: cycleInclude, orderBy: { createdAt: 'desc' as const }, take: 20 },
};
type PlanRow = Prisma.ManagedTaskGetPayload<{ include: typeof planInclude }>;
type CycleRow = ManagedCycle & { runs: Run[] };
function checkedOutput<T>(name: Parameters<typeof schemaIssues>[0], value: T): T {
  if (schemaIssues(name, value).length) fault('INTERNAL_CONTRACT_ERROR', '任务信息暂不可用', 503);
  return value;
}
function counts(c: CycleRow) {
  const runs = c.runs.filter((r) => r.purpose === 'REGISTER');
  return {
    successes: runs.reduce((n, r) => n + r.successes, 0),
    attemptsStarted: runs.reduce((n, r) => n + r.attemptsStarted, 0),
  };
}
async function cycleView(db: PrismaClient, c: CycleRow): Promise<TaskCycleView> {
  const snapshot = (await db.configVersion.findUniqueOrThrow({ where: { id: c.configVersionId } }))
    .body as unknown as TestConfiguration;
  const apkCount = c.downloadRunId
    ? await db.task.count({
        where: { runId: c.downloadRunId, status: 'SUCCEEDED', proof: 'FILE_VALIDATION' },
      })
    : 0;
  return {
    id: c.id,
    executionKind: snapshot.execution.appOpen
      ? 'APP_OPEN'
      : snapshot.execution.mode === 'FULL'
        ? 'REGISTRATION'
        : 'DOWNLOAD_ONLY',
    concurrency: snapshot.execution.appOpen?.concurrency ?? 1,
    day: c.day,
    round: c.round,
    status: c.status,
    errorCode: c.errorCode,
    ...counts(c),
    successTarget: c.successTarget,
    attemptLimit: c.attemptLimit,
    downloadRunId: c.downloadRunId,
    activeRunId: c.runs.find((r) => !RUN_END.includes(r.status))?.id ?? null,
    registerRunIds: c.runs.filter((r) => r.purpose === 'REGISTER').map((r) => r.id),
    deferredDownloadRules: c.deferredDownloadRules,
    downloadRetryOf: c.downloadRetryOf,
    apkCount,
  };
}
async function readiness(db: PrismaClient, p: PlanRow) {
  const result: TaskPlanView['readiness'] = [],
    add = (code: string, message: string, section: string) =>
      result.push({ code, message, section });
  const node = p.node,
    c = p.currentVersion.body as unknown as TestConfiguration;
  if (p.archivedAt) add('ARCHIVED', '任务已归档，请先恢复', 'tasks');
  if (!node.lastSeenAt || Date.now() - node.lastSeenAt.getTime() > 45000)
    add('NODE_OFFLINE', '服务器离线，请检查服务器', 'nodes');
  if (node.archivedAt || node.deploymentStatus !== 'INSTALLED' || !node.agentReleaseId)
    add('NODE_NOT_READY', '服务器尚未完成部署', 'nodes');
  const h = node.health as { download?: boolean; android?: boolean; kvm?: boolean } | null;
  if (!h?.download || node.downloadProtocol !== '1.0')
    add('NODE_UPGRADE_REQUIRED', '下载环境尚未就绪', 'nodes');
  if (node.slot?.quarantined) add('NODE_QUARANTINED', '上次执行需要核验与清理确认', 'runs');
  const own = p.cycles.some((c) => c.runs.some((r) => r.id === node.slot?.runId));
  if (node.slot?.operationId || (node.slot?.runId && !own))
    add('NODE_BUSY', '服务器正在执行其他任务', 'nodes');
  if (await db.dailySchedule.count({ where: { nodeId: p.nodeId, enabled: true } }))
    add('LEGACY_PLAN_ENABLED', '此服务器的旧每日计划仍开启，请先关闭', 'runs');
  if (await db.managedTask.count({ where: { id: { not: p.id }, nodeId: p.nodeId, enabled: true } }))
    add('NODE_BUSY', '此服务器已有其他开启的任务', 'tasks');
  if (c.execution.mode === 'FULL') {
    const release = node.agentReleaseId
      ? await db.release.findUnique({ where: { id: node.agentReleaseId } })
      : null;
    if (
      !contentIsolationSupported(
        (release?.manifest as { features?: string[] } | null)?.features,
        node.agentVersion,
      )
    )
      add(
        'NODE_UPGRADE_REQUIRED',
        '注册测试需要默认内容隔离，请升级执行环境至 Agent 0.8.0',
        'nodes',
      );
    if (!h?.android || !h.kvm || node.registrationProtocol !== '1.0')
      add('NODE_NOT_READY', '安卓环境尚未就绪', 'nodes');
    if (
      c.execution.autoRegistration?.startup &&
      !appReadinessSupported(
        (release?.manifest as { features?: string[] } | null)?.features,
        node.agentVersion,
      )
    )
      add('NODE_UPGRADE_REQUIRED', '启动准备设置需要 Agent 0.9.0', 'nodes');
    try {
      assertIdentityReady(
        c,
        (release?.manifest as { features?: string[] } | null)?.features,
        node.agentVersion,
        node.health,
        p.attemptLimit,
      );
    } catch (e) {
      const x = e as { code?: string; message?: string };
      add(x.code ?? 'NODE_NOT_READY', x.message ?? '测试档案尚未就绪', 'tasks');
    }
    if (c.execution.appOpen) {
      if (
        c.execution.appOpen.concurrency !== undefined &&
        !parallelAppOpenSupported(
          (release?.manifest as { features?: string[] } | null)?.features,
          node.agentVersion,
        )
      )
        add('NODE_UPGRADE_REQUIRED', '并发与每日额度需要 Agent 0.11.0', 'nodes');
      const budget = await dailyOpenUsage(db, node.id);
      if (!p.enabled && p.attemptLimit > budget.remaining)
        add('DAILY_OPEN_LIMIT', '当日剩余额度不足，请降低目标及尝试上限', 'tasks');
    }
    const proxy = c.execution.proxySecretVersionId;
    if (
      !proxy ||
      !(await db.secretVersion.count({ where: { id: proxy, type: 'HTTP_PROXY', revokedAt: null } }))
    )
      add('PROXY_REQUIRED', '请选择有效代理', 'proxies');
    if (
      c.execution.appOpen &&
      !appOpenSupported(
        (release?.manifest as { features?: string[] } | null)?.features,
        node.agentVersion,
      )
    )
      add('NODE_UPGRADE_REQUIRED', '启动停留需要 Agent 0.10.0', 'nodes');
    if (
      !c.execution.appOpen &&
      !c.execution.autoRegistration?.enabled &&
      !c.registrationFlows.some((f) => f.enabled)
    )
      add('NEEDS_ADAPTATION', '请选择自动识别或补充注册规则', 'tasks');
    if (
      c.execution.autoRegistration?.enabled &&
      ![
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
      ].includes(node.agentVersion ?? '')
    )
      add('NODE_UPGRADE_REQUIRED', '自动识别需要升级执行环境', 'nodes');
  }
  return result;
}
async function view(db: PrismaClient, p: PlanRow): Promise<TaskPlanView> {
  const now = new Date(),
    day = beijingDay(now);
  let next = new Date(day + 'T' + p.time + ':00+08:00');
  if (next <= now || p.cycles.some((c) => c.day === day))
    next = new Date(next.getTime() + 86400000);
  return checkedOutput('TaskPlanView', {
    id: p.id,
    executionKind: (p.currentVersion.body as unknown as TestConfiguration).execution.appOpen
      ? 'APP_OPEN'
      : (p.currentVersion.body as unknown as TestConfiguration).execution.mode === 'FULL'
        ? 'REGISTRATION'
        : 'DOWNLOAD_ONLY',
    concurrency:
      (p.currentVersion.body as unknown as TestConfiguration).execution.appOpen?.concurrency ?? 1,
    dailyUsage: await dailyOpenUsage(db, p.nodeId),
    name: p.name,
    nodeId: p.nodeId,
    nodeName: p.node.name,
    version: p.version,
    configId: p.configId,
    currentVersionId: p.currentVersionId,
    automatic: p.automatic,
    enabled: p.enabled,
    time: p.time,
    successTarget: p.successTarget,
    attemptLimit: p.attemptLimit,
    archivedAt: p.archivedAt?.toISOString() ?? null,
    latestCycle: p.cycles[0] ? await cycleView(db, p.cycles[0]) : null,
    readiness: await readiness(db, p),
    nextRunAt: p.enabled && p.automatic ? next.toISOString() : null,
  });
}
export async function taskPlanDetail(db: PrismaClient, id: string): Promise<TaskPlanDetail> {
  const p = await db.managedTask.findUnique({ where: { id }, include: planInclude });
  if (!p) fault('NOT_FOUND', '任务不存在', 404);
  return checkedOutput('TaskPlanDetail', {
    task: await view(db, p),
    configuration: p.currentVersion.body as unknown as TestConfiguration,
    cycles: await Promise.all(p.cycles.map((c) => cycleView(db, c))),
  });
}
export async function taskPlanList(db: PrismaClient, query: unknown) {
  const q = checked<TaskPlanQuery>('TaskPlanQuery', query),
    limit = Number(q.limit ?? 30);
  const rows = await db.managedTask.findMany({
    where:
      q.archived === 'ALL' ? {} : { archivedAt: q.archived === 'ARCHIVED' ? { not: null } : null },
    include: planInclude,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  return checkedOutput('TaskPlanList', {
    items: await Promise.all(rows.slice(0, limit).map((p) => view(db, p))),
    nextCursor: rows.length > limit ? rows[limit - 1].id : null,
  });
}
async function saveVersion(
  tx: Tx,
  configId: string,
  body: TestConfiguration,
  actor: string,
): Promise<ConfigVersion> {
  const config = await tx.configuration.findUniqueOrThrow({ where: { id: configId } });
  if (config.archivedAt) fault('VERSION_ARCHIVED', '方案已归档');
  const saved = await tx.configVersion.create({
    data: {
      configId,
      version: config.version,
      body: body as unknown as Prisma.InputJsonValue,
      configHash: digest(canonical(body)),
      createdBy: actor,
    },
  });
  await tx.configuration.update({
    where: { id: configId },
    data: { version: { increment: 1 }, revision: { increment: 1 } },
  });
  return saved;
}
export async function saveTaskPlan(
  db: PrismaClient,
  body: unknown,
  actor: string,
  requestId: string,
  key: string,
  id?: string,
  version?: number,
) {
  const input = checked<TaskPlanInput>('TaskPlanInput', body),
    config = configBody(input.configuration);
  validateBudget(input.successTarget, input.attemptLimit);
  const result = await idempotent(
    db,
    actor,
    id ? 'PUT:/task-plans/' + id : 'POST:/task-plans',
    key,
    { input, id, version },
    async (tx) => {
      await lockLibrary(tx);
      const node = await lockNode(tx, input.nodeId);
      if (node.archivedAt) fault('NOT_FOUND', '服务器已归档', 404);
      const previous = id ? await tx.managedTask.findUnique({ where: { id } }) : null;
      if (id && (!previous || previous.version !== version))
        fault('STALE_VERSION', '任务已更新，请刷新后编辑');
      if (previous?.archivedAt) fault('TASK_ARCHIVED', '请先恢复任务');
      if (previous && input.configId && input.configId !== previous.configId)
        fault('VALIDATION_FAILED', '任务不能更换配置容器', 422);
      if (
        previous &&
        previous.nodeId !== node.id &&
        (await tx.managedCycle.count({ where: { taskId: id, status: { notIn: closed } } }))
      )
        fault('TASK_ACTIVE', '请先停止并确认旧节点清理');
      await configSecrets(tx, config);
      let configId = previous?.configId ?? input.configId;
      if (configId) {
        if (await tx.managedTask.count({ where: { configId, ...(id ? { id: { not: id } } : {}) } }))
          fault('CONFIG_ALREADY_LINKED', '此方案已经接入任务中心');
      } else configId = (await tx.configuration.create({ data: { name: input.name } })).id;
      const saved = await saveVersion(tx, configId, config, actor);
      await tx.configuration.update({ where: { id: configId }, data: { name: input.name } });
      const data = {
        name: input.name,
        nodeId: input.nodeId,
        currentVersionId: saved.id,
        automatic: input.automatic,
        time: input.time,
        successTarget: input.successTarget,
        attemptLimit: input.attemptLimit,
      };
      const p = previous
        ? await tx.managedTask.update({
            where: { id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.managedTask.create({ data: { ...data, configId, createdBy: actor } });
      await tx.auditEvent.create({
        data: {
          adminId: actor,
          action: previous ? 'TASK_PLAN_UPDATED' : 'TASK_PLAN_CREATED',
          requestId,
          details: { taskId: p.id },
        },
      });
      return { id: p.id };
    },
  );
  return (await taskPlanDetail(db, result.id)).task;
}
async function effectiveVersion(tx: Tx, p: ManagedTask, nodeId: string, now: Date) {
  let version = await tx.configVersion.findUniqueOrThrow({ where: { id: p.currentVersionId } }),
    deferred = false;
  const downloaded = await tx.run.findFirst({
    where: {
      nodeId: nodeId,
      purpose: 'DOWNLOAD',
      cacheDay: beijingDay(now),
      configVersion: { configId: p.configId },
    },
    include: { configVersion: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  if (downloaded?.configVersion) {
    const original = downloaded.configVersion.body as unknown as TestConfiguration,
      current = version.body as unknown as TestConfiguration;
    if (
      canonical([original.source, original.download]) !==
      canonical([current.source, current.download])
    ) {
      deferred = true;
      version = await saveVersion(
        tx,
        p.configId,
        { ...current, source: original.source, download: original.download },
        p.createdBy,
      );
    }
  }
  return { version, deferred };
}
async function createCycle(
  tx: Tx,
  p: ManagedTask,
  node: { id: string; agentReleaseId: string | null },
  now: Date,
  round: number,
  retryOf?: string,
) {
  if (!node.agentReleaseId) fault('NODE_NOT_READY', '服务器尚未部署');
  const { version, deferred } = retryOf
    ? {
        version: await tx.configVersion.findUniqueOrThrow({ where: { id: p.currentVersionId } }),
        deferred: false,
      }
    : await effectiveVersion(tx, p, node.id, now);
  const full = (version.body as unknown as TestConfiguration).execution.mode === 'FULL';
  return tx.managedCycle.create({
    data: {
      taskId: p.id,
      nodeId: node.id,
      configVersionId: version.id,
      releaseId: node.agentReleaseId,
      day: beijingDay(now),
      round,
      successTarget: full ? p.successTarget : 0,
      attemptLimit: full ? p.attemptLimit : 0,
      deferredDownloadRules: deferred,
      ...(retryOf ? { downloadRetryOf: retryOf } : {}),
    },
  });
}
export async function controlTaskPlan(
  db: PrismaClient,
  id: string,
  body: unknown,
  version: number,
  actor: string,
  requestId: string,
  key: string,
  now = new Date(),
) {
  const input = checked<TaskControlInput>('TaskControlInput', body);
  await idempotent(
    db,
    actor,
    'POST:/task-plans/' + id + '/control',
    key,
    { input, version },
    async (tx) => {
      await lockLibrary(tx);
      const p = await tx.managedTask.findUnique({ where: { id } });
      if (!p) fault('NOT_FOUND', '任务不存在', 404);
      await tx.$queryRaw`SELECT "id" FROM "Node" WHERE "id"=${p.nodeId}::uuid FOR UPDATE`;
      const node = await tx.node.findUniqueOrThrow({ where: { id: p.nodeId } });
      if (p.version !== version && input.action !== 'STOP')
        fault('STALE_VERSION', '任务状态已变化，请刷新');
      const latest = await tx.managedCycle.findFirst({
        where: { taskId: id, day: beijingDay(now) },
        orderBy: { round: 'desc' },
        include: cycleInclude,
      });
      if (input.action === 'RESTORE') {
        await tx.managedTask.update({
          where: { id },
          data: { archivedAt: null, enabled: false, version: { increment: 1 } },
        });
      } else if (input.action === 'STOP') {
        await tx.managedTask.update({
          where: { id },
          data: { enabled: false, version: { increment: 1 } },
        });
        await tx.managedCycle.updateMany({
          where: { taskId: id, status: { notIn: closed } },
          data: { stopRequested: true, status: 'STOPPING' },
        });
        const pending = await tx.run.findMany({
          where: { taskCycle: { taskId: id }, status: { notIn: RUN_END as Run['status'][] } },
          select: { id: true },
        });
        for (const run of pending) await requestRunStop(tx, run.id);
      } else if (input.action === 'DISABLE_DAILY') {
        await tx.managedTask.update({
          where: { id },
          data: { automatic: false, version: { increment: 1 } },
        });
      } else if (input.action === 'ARCHIVE') {
        if (
          p.enabled ||
          (await tx.managedCycle.count({ where: { taskId: id, status: { notIn: closed } } }))
        )
          fault('TASK_ACTIVE', '请先停止并等待清理确认');
        await tx.managedTask.update({
          where: { id },
          data: { archivedAt: now, version: { increment: 1 } },
        });
      } else {
        if (p.archivedAt) fault('TASK_ARCHIVED', '请先恢复任务');
        const selected = await tx.configVersion.findUniqueOrThrow({
          where: { id: p.currentVersionId },
          include: { config: true },
        });
        if (selected.archivedAt || selected.config.archivedAt)
          fault('VERSION_ARCHIVED', '当前配置已归档，请恢复后开始');
        const settings = selected.body as unknown as TestConfiguration;
        if (
          settings.execution.mode === 'FULL' &&
          !settings.execution.appOpen &&
          !settings.execution.autoRegistration?.enabled &&
          !settings.registrationFlows.some((f) => f.enabled)
        )
          fault('NEEDS_ADAPTATION', '请选择自动识别或补充注册规则');
        if (await tx.dailySchedule.count({ where: { nodeId: p.nodeId, enabled: true } }))
          fault('LEGACY_PLAN_ENABLED', '请先关闭旧每日计划');
        if (
          await tx.managedTask.count({
            where: { id: { not: id }, nodeId: p.nodeId, enabled: true },
          })
        )
          fault('NODE_BUSY', '此服务器已有开启的任务');
        if (
          ['NEW_ROUND', 'RETRY_DOWNLOAD'].includes(input.action) &&
          latest &&
          !closed.includes(latest.status)
        )
          fault('TASK_ACTIVE', '请先结束当前轮次');
        if (latest?.status === 'STOPPING') fault('STOP_PENDING', '正在等待停止与清理确认');
        if (
          latest &&
          input.action === 'START' &&
          !closed.includes(latest.status) &&
          latest.status !== 'NEEDS_REVIEW'
        ) {
          if (latest.stopRequested) fault('STOP_PENDING', '正在等待停止确认');
        } else {
          await idle(tx, node.id);
          if (
            !node.lastSeenAt ||
            Date.now() - node.lastSeenAt.getTime() > 45000 ||
            node.archivedAt ||
            node.deploymentStatus !== 'INSTALLED'
          )
            fault('NODE_NOT_READY', '服务器尚未就绪，请检查服务器');
          if (latest && input.action === 'START') {
            const prior = await tx.configVersion.findUniqueOrThrow({
              where: { id: latest.configVersionId },
            });
            if (
              !!(prior.body as unknown as TestConfiguration).execution.appOpen !==
              !!settings.execution.appOpen
            )
              fault('NEW_ROUND_REQUIRED', '执行模式已变更，请新增一轮，历史计数保留');
            if (latest.nodeId !== p.nodeId)
              fault('NEW_ROUND_REQUIRED', '更换服务器后请显式新增一轮');
            if (latest.runs.some((r) => r.status === 'NEEDS_REVIEW' && !r.reviewResolvedAt))
              fault('REVIEW_REQUIRED', '请先核验未知结果并确认清理');
            const totals = counts(latest);
            if (
              totals.successes < latest.successTarget &&
              totals.attemptsStarted < latest.attemptLimit
            ) {
              const effective = await effectiveVersion(tx, p, node.id, now);
              await tx.managedCycle.update({
                where: { id: latest.id },
                data: {
                  stopRequested: false,
                  status: 'QUEUED',
                  errorCode: null,
                  generation: { increment: 1 },
                  proxyRunId: null,
                  configVersionId: effective.version.id,
                  deferredDownloadRules: effective.deferred,
                },
              });
            }
          } else {
            let retryOf: string | undefined;
            if (input.action === 'RETRY_DOWNLOAD') {
              const source = await tx.run.findFirst({
                where: {
                  nodeId: p.nodeId,
                  purpose: 'DOWNLOAD',
                  cacheDay: beijingDay(now),
                  configVersion: { configId: p.configId },
                },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              });
              if (!source) fault('DOWNLOAD_RETRY_INVALID', '当天没有可关联复跑的下载批次', 422);
              await downloadRetryParent(tx, source.id, p.nodeId, p.configId, beijingDay(now));
              retryOf = source.id;
            }
            await createCycle(tx, p, node, now, (latest?.round ?? 0) + 1, retryOf);
          }
        }
        const completed =
          latest &&
          closed.includes(latest.status) &&
          (counts(latest).successes >= latest.successTarget ||
            counts(latest).attemptsStarted >= latest.attemptLimit);
        await tx.managedTask.update({
          where: { id },
          data: {
            enabled: input.action === 'START' && completed ? p.automatic : true,
            version: { increment: 1 },
          },
        });
      }
      await tx.auditEvent.create({
        data: {
          adminId: actor,
          action: 'TASK_' + input.action,
          requestId,
          details: { taskId: id },
        },
      });
      return { id };
    },
  );
  return (await taskPlanDetail(db, id)).task;
}
async function updateCycle(
  db: PrismaClient,
  cycle: ManagedCycle,
  status: string,
  errorCode: string | null = null,
) {
  await db.managedCycle.updateMany({
    where: {
      id: cycle.id,
      generation: cycle.generation,
      stopRequested: false,
      status: { notIn: ['DONE', 'STOPPED', 'NEEDS_REVIEW'] },
    },
    data: { status, errorCode },
  });
}
async function advance(db: PrismaClient, p: ManagedTask, c: CycleRow, now: Date) {
  const active = c.runs.filter((r) => !RUN_END.includes(r.status));
  if (c.stopRequested || !p.enabled || c.day !== beijingDay(now)) {
    const stopping = await db.managedCycle.updateMany({
      where: {
        id: c.id,
        generation: c.generation,
        status: { notIn: closed },
        ...(c.day !== beijingDay(now)
          ? {}
          : { OR: [{ stopRequested: true }, { task: { enabled: false } }] }),
      },
      data: { stopRequested: true, status: 'STOPPING' },
    });
    if (!stopping.count) return;
    for (const run of active)
      await stopRun(
        db,
        run.id,
        { reason: '统一任务停止或跨日切换' },
        p.createdBy,
        'task-center',
        'task-stop:' + c.id + ':' + run.id,
      );
    const owned = await db.run.findMany({ where: { taskCycleId: c.id } });
    const shared = c.downloadRunId
      ? await db.run.findUnique({ where: { id: c.downloadRunId } })
      : null;
    const all = [...owned, ...(shared && !owned.some((r) => r.id === shared.id) ? [shared] : [])];
    if (all.some((r) => r.status === 'NEEDS_REVIEW' && !r.reviewResolvedAt))
      await db.managedCycle.updateMany({
        where: { id: c.id, generation: c.generation, stopRequested: true },
        data: { status: 'NEEDS_REVIEW', errorCode: 'REVIEW_REQUIRED' },
      });
    else if (all.every((r) => RUN_END.includes(r.status)))
      await db.managedCycle.updateMany({
        where: { id: c.id, generation: c.generation, stopRequested: true },
        data: { status: 'STOPPED' },
      });
    return;
  }
  if (['DONE', 'STOPPED', 'FAILED', 'NEEDS_REVIEW'].includes(c.status)) return;
  if (c.runs.some((r) => r.status === 'NEEDS_REVIEW' && !r.reviewResolvedAt)) {
    await updateCycle(db, c, 'NEEDS_REVIEW', 'REVIEW_REQUIRED');
    return;
  }
  if (active.length) return;
  const total = counts(c),
    config = (await db.configVersion.findUniqueOrThrow({ where: { id: c.configVersionId } }))
      .body as unknown as TestConfiguration;
  const common = { nodeId: c.nodeId, configVersionId: c.configVersionId, releaseId: c.releaseId };
  if (config.execution.mode === 'FULL' && !config.execution.appOpen && !c.proxyRunId) {
    await createRun(
      db,
      {
        ...common,
        purpose: 'PROXY_CHECK',
        proxySecretVersionId: config.execution.proxySecretVersionId,
      },
      p.createdBy,
      'task-center',
      `task:${c.id}:proxy:${c.generation}`,
      now,
      undefined,
      c.id,
      c.generation,
    );
    return;
  }
  if (c.proxyRunId) {
    const proxy = await db.run.findUniqueOrThrow({ where: { id: c.proxyRunId } });
    if (!RUN_END.includes(proxy.status)) return;
    if (proxy.status !== 'SUCCEEDED') {
      await updateCycle(db, c, 'FAILED', 'PROXY_CHECK_FAILED');
      return;
    }
  }
  if (!c.downloadRunId) {
    await createRun(
      db,
      {
        ...common,
        purpose: 'DOWNLOAD',
        ...(c.downloadRetryOf ? { supersedesRunId: c.downloadRetryOf } : {}),
      },
      p.createdBy,
      'task-center',
      'task:' + c.id + ':download',
      now,
      undefined,
      c.id,
      c.generation,
    );
    return;
  }
  const downloaded = await db.run.findUniqueOrThrow({ where: { id: c.downloadRunId } });
  if (!RUN_END.includes(downloaded.status)) return;
  if (c.runs.some((r) => RUN_END.includes(r.status) && r.errorCode === 'NO_REGISTERABLE_APK')) {
    await updateCycle(db, c, 'DONE', 'NO_REGISTERABLE_APK');
    return;
  }
  if (!['SUCCEEDED', 'PARTIAL_FAILED'].includes(downloaded.status)) {
    await updateCycle(
      db,
      c,
      downloaded.errorCode === 'NO_APK_AVAILABLE'
        ? 'DONE'
        : downloaded.status === 'NEEDS_REVIEW'
          ? 'NEEDS_REVIEW'
          : downloaded.status === 'CANCELLED'
            ? 'STOPPED'
            : 'FAILED',
      downloaded.errorCode ??
        (downloaded.status === 'CANCELLED' ? 'DOWNLOAD_STOPPED' : 'DOWNLOAD_FAILED'),
    );
    return;
  }
  if (
    config.execution.mode !== 'FULL' ||
    total.successes >= c.successTarget ||
    total.attemptsStarted >= c.attemptLimit
  ) {
    await updateCycle(
      db,
      c,
      'DONE',
      config.execution.mode === 'FULL' && total.successes < c.successTarget
        ? 'ATTEMPT_LIMIT'
        : null,
    );
    return;
  }
  const receipt = await db.idempotencyRecord.findUnique({
    where: {
      actorId_scope_key: {
        actorId: p.createdBy,
        scope: 'POST:/runs',
        key: `task:${c.id}:register:${c.generation}`,
      },
    },
  });
  const registeredId = (receipt?.response as { resourceId?: string } | undefined)?.resourceId;
  const previous = registeredId ? c.runs.find((r) => r.id === registeredId) : undefined;
  if (previous) {
    await updateCycle(
      db,
      c,
      previous.errorCode === 'NO_REGISTERABLE_APK'
        ? 'DONE'
        : previous.status === 'NEEDS_REVIEW'
          ? 'NEEDS_REVIEW'
          : 'FAILED',
      previous.errorCode,
    );
    return;
  }
  await createRun(
    db,
    {
      ...common,
      purpose: 'REGISTER',
      sourceDownloadId: c.downloadRunId,
      successTarget: c.successTarget - total.successes,
      attemptLimit: c.attemptLimit - total.attemptsStarted,
    },
    p.createdBy,
    'task-center',
    `task:${c.id}:register:${c.generation}`,
    now,
    undefined,
    c.id,
    c.generation,
  );
}
export async function tickTaskPlans(db: PrismaClient, now = new Date()) {
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  let cursor: string | undefined;
  for (;;) {
    const plans = await db.managedTask.findMany({
      where: { OR: [{ enabled: true }, { cycles: { some: { status: { notIn: closed } } } }] },
      orderBy: { id: 'asc' },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!plans.length) break;
    cursor = plans.at(-1)!.id;
    for (let p of plans) {
      try {
        let cycles = await db.managedCycle.findMany({
          where: { taskId: p.id, status: { notIn: closed } },
          include: cycleInclude,
          orderBy: { createdAt: 'asc' },
        });
        for (const c of cycles) await advance(db, p, c, now);
        p = await db.managedTask.findUniqueOrThrow({ where: { id: p.id } });
        if (p.enabled && p.automatic && !p.archivedAt && time >= p.time) {
          await db.$transaction(async (tx) => {
            await lockLibrary(tx);
            const node = await lockNode(tx, p.nodeId),
              current = await tx.managedTask.findUniqueOrThrow({ where: { id: p.id } });
            if (!current.enabled || !current.automatic || current.archivedAt) return;
            if (await tx.managedCycle.count({ where: { taskId: p.id, day: beijingDay(now) } }))
              return;
            if (await tx.managedCycle.count({ where: { taskId: p.id, status: { notIn: closed } } }))
              return;
            await createCycle(tx, current, node, now, 1);
          });
        }
        cycles = await db.managedCycle.findMany({
          where: { taskId: p.id, day: beijingDay(now) },
          include: cycleInclude,
          orderBy: { round: 'desc' },
          take: 1,
        });
        if (cycles[0] && ['DONE', 'FAILED', 'STOPPED'].includes(cycles[0].status) && !p.automatic)
          await db.managedTask.updateMany({
            where: { id: p.id, enabled: true, version: p.version },
            data: { enabled: false, version: { increment: 1 } },
          });
      } catch (error) {
        if (error instanceof PlatformError && ['TASK_STOPPED', 'TASK_CHANGED'].includes(error.code))
          continue;
        await db.managedCycle
          .updateMany({
            where: {
              taskId: p.id,
              day: beijingDay(now),
              stopRequested: false,
              status: { notIn: [...closed, 'NEEDS_REVIEW'] },
            },
            data: {
              status: 'WAITING',
              errorCode: error instanceof PlatformError ? error.code : 'TASK_SCHEDULER_UNAVAILABLE',
            },
          })
          .catch(() => {});
      }
    }
  }
}
