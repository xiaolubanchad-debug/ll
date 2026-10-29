import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type {
  ResultCategory,
  ResultsQuery,
  RegistrationRecordView,
  RegistrationDetailView,
  OverviewView,
  OverviewQuery,
  RunSummaryView,
  TimelinePage,
  TimelineQuery,
  AssetQuery,
  AssetListView,
  RunQuery,
  ConsoleRunListView,
} from '@apk/contracts';
import { schemaIssues } from '@apk/contracts';
import { checked } from './secrets.js';
import { fault } from './errors.js';
import { canonical, digest } from './security.js';

export const resultCategories: ResultCategory[] = [
  'SUCCESS',
  'REJECTED',
  'ERROR',
  'ADAPTATION',
  'UNKNOWN',
  'SKIPPED',
  'STOPPED',
  'PENDING',
];
const terminal = ['SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED', 'UNKNOWN'];
const activeStatuses = ['QUEUED', 'ASSIGNED', 'RUNNING', 'STOP_REQUESTED', 'NEEDS_REVIEW'] as const;
const nowDay = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export function consoleDay(day: string) {
  const parsed = new Date(day + 'T00:00:00Z');
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== day
  )
    fault('VALIDATION_FAILED', '请选择有效日期', 422);
  return new Date(day + 'T00:00:00+08:00');
}
function range(from?: string, to?: string) {
  const start = consoleDay(from ?? to ?? nowDay()),
    end = new Date(consoleDay(to ?? from ?? nowDay()).getTime() + 86400000);
  if (end <= start || end.getTime() - start.getTime() > 31 * 86400000)
    fault('VALIDATION_FAILED', '日期范围需为 1–31 天', 422);
  return { gte: start, lt: end };
}
function output<T>(name: Parameters<typeof schemaIssues>[0], value: T): T {
  if (schemaIssues(name, value).length)
    fault('INTERNAL_CONTRACT_ERROR', '结果暂时无法显示，请联系维护人员', 503);
  return value;
}
const adaptation: Prisma.TaskWhereInput = {
  status: 'FAILED',
  OR: [
    { errorCode: { startsWith: 'AUTO_' } },
    { recognition: { path: ['needsAdaptation'], equals: true } },
  ],
};
const rejection: Prisma.TaskWhereInput = {
  status: 'FAILED',
  proof: 'APP_UI',
  submissionId: { not: null },
};
export function resultWhere(category: ResultCategory): Prisma.TaskWhereInput {
  switch (category) {
    case 'SUCCESS':
      return { status: 'SUCCEEDED' };
    case 'REJECTED':
      return rejection;
    case 'ADAPTATION':
      return adaptation;
    case 'ERROR':
      return {
        status: 'FAILED',
        AND: [
          { OR: [{ proof: { not: 'APP_UI' } }, { submissionId: null }] },
          { OR: [{ errorCode: null }, { errorCode: { not: { startsWith: 'AUTO_' } } }] },
          {
            OR: [
              { recognition: { equals: Prisma.DbNull } },
              { recognition: { equals: Prisma.JsonNull } },
              { recognition: { path: ['needsAdaptation'], equals: Prisma.AnyNull } },
              { recognition: { path: ['needsAdaptation'], equals: false } },
            ],
          },
        ],
      };
    case 'UNKNOWN':
      return { status: 'UNKNOWN' };
    case 'SKIPPED':
      return { status: 'SKIPPED' };
    case 'STOPPED':
      return { status: 'CANCELLED' };
    case 'PENDING':
      return { status: { notIn: terminal } };
  }
}
export function resultCategory(task: {
  status: string;
  proof: string;
  submissionId: string | null;
  errorCode: string | null;
  recognition: unknown;
}): ResultCategory {
  if (task.status === 'SUCCEEDED') return 'SUCCESS';
  if (task.status === 'UNKNOWN') return 'UNKNOWN';
  if (task.status === 'SKIPPED') return 'SKIPPED';
  if (task.status === 'CANCELLED') return 'STOPPED';
  if (task.status !== 'FAILED') return 'PENDING';
  if (task.proof === 'APP_UI' && task.submissionId) return 'REJECTED';
  if (
    task.errorCode?.startsWith('AUTO_') ||
    (task.recognition as { needsAdaptation?: boolean } | null)?.needsAdaptation === true
  )
    return 'ADAPTATION';
  return 'ERROR';
}
const select = {
  id: true,
  runId: true,
  position: true,
  label: true,
  entryId: true,
  status: true,
  proof: true,
  errorCode: true,
  lastStage: true,
  startedAt: true,
  registrationStartedAt: true,
  finishedAt: true,
  apk: true,
  submissionId: true,
  recognition: true,
  observation: true,
  account: { select: { accountRef: true } },
  reviews: {
    orderBy: { createdAt: 'desc' },
    take: 1,
    select: { outcome: true, reason: true, createdAt: true },
  },
  run: {
    select: {
      nodeId: true,
      purpose: true,
      createdAt: true,
      finishedAt: true,
      node: { select: { name: true } },
      configVersion: { select: { version: true, config: { select: { name: true } } } },
    },
  },
} satisfies Prisma.TaskSelect;
type RecordRow = Prisma.TaskGetPayload<{ select: typeof select }>;
function apkView(apk: unknown) {
  return schemaIssues('ApkMetadata', apk).length
    ? null
    : (apk as NonNullable<RegistrationRecordView['apk']>);
}
function record(row: RecordRow): RegistrationRecordView {
  const start = row.registrationStartedAt ?? row.startedAt ?? row.run.createdAt;
  const finish = row.finishedAt ?? (terminal.includes(row.status) ? row.run.finishedAt : null);
  return {
    id: row.id,
    runId: row.runId,
    nodeId: row.run.nodeId,
    nodeName: row.run.node.name,
    configName: row.run.configVersion?.config.name ?? '历史配置',
    configVersion: row.run.configVersion?.version ?? 0,
    purpose: row.run.purpose,
    position: row.position + 1,
    label: row.label,
    entryId: row.entryId,
    status: row.status,
    category: resultCategory(row),
    proof: row.proof,
    errorCode: row.errorCode,
    lastStage: row.lastStage,
    startedAt: start.toISOString(),
    finishedAt: finish?.toISOString() ?? null,
    elapsedMs: finish && finish >= start ? finish.getTime() - start.getTime() : null,
    apk: apkView(row.apk),
    hasAccount: !!row.account,
    reviewOutcome: (row.reviews[0]?.outcome as 'SUCCEEDED' | 'FAILED' | undefined) ?? null,
  };
}
function cursorValue(cursor: string | undefined, scope: string) {
  if (!cursor) return undefined;
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
      at: string;
      id: string;
      scope: string;
    };
    if (
      value.scope !== scope ||
      typeof value.id !== 'string' ||
      schemaIssues('ResultsQuery', { runId: value.id }).length ||
      typeof value.at !== 'string' ||
      !Number.isFinite(Date.parse(value.at)) ||
      new Date(value.at).toISOString() !== value.at
    )
      throw Error();
    return { at: new Date(value.at), id: value.id };
  } catch {
    fault('VALIDATION_FAILED', '分页标记已失效，请重新查询', 422);
  }
}
function nextCursor(at: Date, id: string, scope: string) {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id, scope })).toString('base64url');
}
function search(q?: string): Prisma.TaskWhereInput {
  return q
    ? {
        OR: [
          { label: { contains: q, mode: 'insensitive' } },
          { apk: { path: ['packageName'], string_contains: q, mode: 'insensitive' } },
        ],
      }
    : {};
}
export async function registrationRecords(db: PrismaClient, query: unknown) {
  const q = checked<ResultsQuery>('ResultsQuery', query),
    { cursor, limit = '20', ...filters } = q;
  const dates = range(q.from, q.to),
    scope = digest(
      canonical({
        kind: 'REGISTRATIONS',
        ...filters,
        fromInstant: dates.gte.toISOString(),
        toInstant: dates.lt.toISOString(),
      }),
    ),
    after = cursorValue(cursor, scope),
    n = Number(limit);
  const where: Prisma.TaskWhereInput = {
    AND: [
      { registrationStartedAt: dates },
      q.nodeId ? { run: { nodeId: q.nodeId } } : {},
      q.runId ? { runId: q.runId } : {},
      search(q.q),
      q.category ? resultWhere(q.category) : {},
      q.review
        ? { status: 'UNKNOWN', reviews: q.review === 'OPEN' ? { none: {} } : { some: {} } }
        : {},
      after
        ? {
            OR: [
              { registrationStartedAt: { lt: after.at } },
              { registrationStartedAt: after.at, id: { lt: after.id } },
            ],
          }
        : {},
    ],
  };
  const rows = await db.task.findMany({
    where,
    orderBy: [{ registrationStartedAt: 'desc' }, { id: 'desc' }],
    take: n + 1,
    select,
  });
  return output('RegistrationListView', {
    items: rows.slice(0, n).map(record),
    nextCursor:
      rows.length > n
        ? nextCursor(rows[n - 1].registrationStartedAt!, rows[n - 1].id, scope)
        : null,
  });
}
export async function registrationRecord(
  db: PrismaClient,
  id: string,
): Promise<RegistrationDetailView> {
  const row = await db.task.findFirst({
    where: { id, registrationStartedAt: { not: null } },
    select,
  });
  if (!row) fault('NOT_FOUND', '注册记录不存在', 404);
  const o = row.observation as RegistrationDetailView['observation'];
  const view: RegistrationDetailView = {
    record: record(row),
    recognition: schemaIssues('RegistrationRecognition', row.recognition).length
      ? null
      : (row.recognition as RegistrationDetailView['recognition']),
    observation: o
      ? {
          model: o.model,
          locale: o.locale,
          shellAndroidIdHash: o.shellAndroidIdHash,
          proxyObservedIp: o.proxyObservedIp,
          proxyObservedAt: o.proxyObservedAt,
        }
      : null,
    reviews: row.reviews.map((r) => ({
      outcome: r.outcome as 'SUCCEEDED' | 'FAILED',
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    })),
  };
  return output('RegistrationDetailView', view);
}
async function categoryCounts(db: Prisma.TransactionClient, where: Prisma.TaskWhereInput) {
  return Object.fromEntries(
    await Promise.all(
      resultCategories.map(async (category) => [
        category,
        await db.task.count({ where: { AND: [where, resultWhere(category)] } }),
      ]),
    ),
  ) as OverviewView['registrations'];
}
const runSelect = {
  id: true,
  nodeId: true,
  purpose: true,
  status: true,
  createdAt: true,
  finishedAt: true,
  errorCode: true,
  releaseId: true,
  successes: true,
  successTarget: true,
  attemptsStarted: true,
  attemptLimit: true,
  cacheDay: true,
  configVersionId: true,
  node: { select: { name: true } },
  configVersion: { select: { version: true, config: { select: { name: true } } } },
} satisfies Prisma.RunSelect;
type RunRow = Prisma.RunGetPayload<{ select: typeof runSelect }>;
const runView = (r: RunRow) => ({
  id: r.id,
  nodeName: r.node.name,
  configName: r.configVersion?.config.name ?? '历史配置',
  purpose: r.purpose,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  successes: r.successes,
  successTarget: r.successTarget,
  attemptsStarted: r.attemptsStarted,
  attemptLimit: r.attemptLimit,
  errorCode: r.errorCode,
});
export async function consoleRuns(db: PrismaClient, query: unknown): Promise<ConsoleRunListView> {
  const q = checked<RunQuery>('RunQuery', query),
    { cursor, limit = '20', ...filters } = q,
    n = Number(limit),
    scope = digest(canonical({ kind: 'RUNS', ...filters })),
    after = cursorValue(cursor, scope);
  if (q.cacheDay) consoleDay(q.cacheDay);
  const rows = await db.run.findMany({
    where: {
      AND: [
        filters,
        after
          ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] }
          : {},
      ],
    },
    select: runSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: n + 1,
  });
  return output('ConsoleRunListView', {
    items: rows.slice(0, n).map((r) => ({
      ...runView(r),
      nodeId: r.nodeId,
      configVersionId: r.configVersionId,
      configVersion: r.configVersion?.version ?? 0,
      cacheDay: r.cacheDay,
    })),
    nextCursor: rows.length > n ? nextCursor(rows[n - 1].createdAt, rows[n - 1].id, scope) : null,
  });
}
export async function consoleOverview(db: PrismaClient, query: unknown): Promise<OverviewView> {
  const q = checked<OverviewQuery>('OverviewQuery', query),
    day = q.day ?? nowDay(),
    dates = range(day, day);
  return db.$transaction(
    async (tx) => {
      const scope: Prisma.TaskWhereInput = {
        registrationStartedAt: dates,
        ...(q.nodeId ? { run: { nodeId: q.nodeId } } : {}),
      };
      const [
        total,
        online,
        busy,
        quarantined,
        validated,
        failed,
        registrations,
        reviewedUnknown,
        active,
      ] = await Promise.all([
        tx.node.count({ where: { archivedAt: null } }),
        tx.node.count({
          where: { archivedAt: null, lastSeenAt: { gte: new Date(Date.now() - 45000) } },
        }),
        tx.nodeSlot.count({
          where: {
            node: { archivedAt: null },
            OR: [{ operationId: { not: null } }, { runId: { not: null } }],
          },
        }),
        tx.nodeSlot.count({ where: { node: { archivedAt: null }, quarantined: true } }),
        tx.task.count({
          where: {
            run: { purpose: 'DOWNLOAD', cacheDay: day, ...(q.nodeId ? { nodeId: q.nodeId } : {}) },
            status: 'SUCCEEDED',
            proof: 'FILE_VALIDATION',
          },
        }),
        tx.task.count({
          where: {
            run: { purpose: 'DOWNLOAD', cacheDay: day, ...(q.nodeId ? { nodeId: q.nodeId } : {}) },
            status: 'FAILED',
          },
        }),
        categoryCounts(tx, scope),
        tx.task.count({ where: { ...scope, status: 'UNKNOWN', reviews: { some: {} } } }),
        tx.run.findMany({
          where: { status: { in: [...activeStatuses] }, ...(q.nodeId ? { nodeId: q.nodeId } : {}) },
          select: runSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 10,
        }),
      ]);
      return output('OverviewView', {
        day,
        generatedAt: new Date().toISOString(),
        servers: { total, online, busy, quarantined },
        downloads: { validated, failed },
        registrations,
        reviewedUnknown,
        activeRuns: active.map(runView),
      });
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
export async function runSummary(db: PrismaClient, id: string): Promise<RunSummaryView> {
  return db.$transaction(
    async (tx) => {
      const row = await tx.run.findUnique({ where: { id }, select: runSelect });
      if (!row) fault('NOT_FOUND', '执行批次不存在', 404);
      const [counts, taskCount, activeTask, automaticIdentityCount] = await Promise.all([
        categoryCounts(tx, { runId: id }),
        tx.task.count({ where: { runId: id } }),
        tx.task.findFirst({
          where: { runId: id, status: { notIn: terminal } },
          orderBy: { position: 'asc' },
          select: { id: true, position: true, label: true, status: true, apk: true },
        }),
        tx.task.count({
          where: {
            runId: id,
            recognition: { path: ['automaticIdentity', 'scope'], equals: 'APP_UI_ONLY' },
          },
        }),
      ]);
      return output('RunSummaryView', {
        run: runView(row),
        nodeId: row.nodeId,
        configVersion: row.configVersion?.version ?? 0,
        releaseId: row.releaseId,
        finishedAt: row.finishedAt?.toISOString() ?? null,
        counts,
        automaticIdentityCount,
        taskCount,
        cleanup:
          row.status === 'NEEDS_REVIEW' ? 'NEEDS_REVIEW' : row.finishedAt ? 'CONFIRMED' : 'PENDING',
        activeTask: activeTask
          ? {
              id: activeTask.id,
              position: activeTask.position + 1,
              label: activeTask.label,
              stage: activeTask.status,
              packageName: apkView(activeTask.apk)?.packageName ?? null,
            }
          : null,
      });
    },
    { isolationLevel: 'RepeatableRead' },
  );
}
const stageTitles: Record<string, string> = {
  DOWNLOADING: '读取或下载 APK',
  DOWNLOADED: 'APK 文件校验完成',
  PREPARING: '准备独立模拟器',
  INSTALLING: '安装 APK',
  LAUNCHING: '启动 APP',
  DISCOVERING: '寻找注册入口',
  REGISTERING: '填写注册表单',
  VERIFYING: '核验已提交的注册结果',
};
function title(type: string, p: Record<string, unknown>) {
  if (type === 'BROWSER_ENVIRONMENT')
    return p.role === 'SOURCE' ? '网站安卓手机环境已确认' : '落地页安卓手机环境已确认';
  if (type === 'APP_OBSTRUCTION')
    return (
      (
        {
          SKIP_AD: '已跳过开屏广告',
          CLOSE_AD: '已关闭广告',
          CLOSE_POPUP: '已关闭弹窗',
          ACK_NOTICE: '已确认公告',
          WAIT_SPLASH: '等待开屏广告倒计时',
        } as Record<string, string>
      )[String(p.action)] ?? '处理 APP 遮挡页面'
    );
  if (type === 'TASK_STAGE') return stageTitles[String(p.stage)] ?? '执行阶段更新';
  if (type === 'TASK_FINISHED')
    return (
      (
        {
          SUCCEEDED: p.proof === 'APP_UI' ? 'APP 已确认注册成功' : 'APK 下载校验成功',
          FAILED: p.proof === 'APP_UI' ? 'APP 明确拒绝注册' : '本轮执行未完成',
          UNKNOWN: '提交结果未知，等待人工核验；不会重复提交',
          SKIPPED: '本轮已跳过',
          CANCELLED: '本轮已停止',
        } as Record<string, string>
      )[String(p.status)] ?? '本轮结束'
    );
  return (
    (
      {
        RUN_STARTED: '批次已由节点接收并开始执行',
        TARGETS_DISCOVERED: '执行目标已登记',
        SUBMISSION_INTENT: '已保存提交意图，随后只允许一次提交',
        RUN_FINISHED: p.status === 'NEEDS_REVIEW' ? '批次等待核验或清理确认' : '批次已结束',
        STOP_ACK: p.cleanupComplete === true ? '节点已确认停止并完成清理' : '节点尚未确认清理完成',
        PROXY_CHECKED: p.status === 'SUCCEEDED' ? '本次代理连通检查通过' : '本次代理连通检查失败',
      } as Record<string, string>
    )[type] ?? '执行记录'
  );
}
export async function runTimeline(
  db: PrismaClient,
  id: string,
  query: unknown,
): Promise<TimelinePage> {
  const q = checked<TimelineQuery>('TimelineQuery', query),
    n = Number(q.limit ?? 100);
  const d = await db.delivery.findUnique({
    where: { runId: id },
    select: { id: true, appliedThroughSequence: true },
  });
  if (!d) {
    if (!(await db.run.findUnique({ where: { id }, select: { id: true } })))
      fault('NOT_FOUND', '执行批次不存在', 404);
    return {
      items: [],
      hasEarlier: false,
      hasLater: false,
      firstSequence: null,
      lastSequence: null,
    };
  }
  if (
    q.taskId &&
    !(await db.task.findFirst({ where: { id: q.taskId, runId: id }, select: { id: true } }))
  )
    fault('NOT_FOUND', '目标不属于此批次', 404);
  const base: Prisma.RunEventWhereInput = {
      deliveryId: d.id,
      ...(q.taskId ? { body: { path: ['taskId'], equals: q.taskId } } : {}),
    },
    forward = q.afterSequence !== undefined;
  const rows = await db.runEvent.findMany({
    where: {
      ...base,
      ...(q.afterSequence !== undefined
        ? { sequence: { gt: Number(q.afterSequence) } }
        : q.beforeSequence
          ? { sequence: { lt: Number(q.beforeSequence) } }
          : {}),
    },
    orderBy: { sequence: forward ? 'asc' : 'desc' },
    take: n,
    select: { id: true, sequence: true, body: true, createdAt: true, recordedForReview: true },
  });
  if (!forward) rows.reverse();
  const first = rows[0]?.sequence ?? null,
    last = rows.at(-1)?.sequence ?? null;
  const [earlier, later] = await Promise.all([
    first === null ? 0 : db.runEvent.count({ where: { ...base, sequence: { lt: first } } }),
    last === null ? 0 : db.runEvent.count({ where: { ...base, sequence: { gt: last } } }),
  ]);
  return output('TimelinePage', {
    items: rows.map((r) => {
      const b = r.body as {
          type: string;
          taskId?: string;
          occurredAt?: string;
          payload?: Record<string, unknown>;
        },
        p = b.payload ?? {};
      return {
        id: r.id,
        sequence: r.sequence,
        taskId: b.taskId ?? null,
        occurredAt:
          typeof b.occurredAt === 'string' && Number.isFinite(Date.parse(b.occurredAt))
            ? new Date(b.occurredAt).toISOString()
            : r.createdAt.toISOString(),
        receivedAt: r.createdAt.toISOString(),
        type: b.type,
        stage: typeof p.stage === 'string' ? p.stage : null,
        title: title(b.type, p),
        errorCode: typeof p.errorCode === 'string' ? p.errorCode : null,
        recordedForReview: r.recordedForReview,
        applied: !r.recordedForReview && r.sequence <= d.appliedThroughSequence,
      };
    }),
    hasEarlier: earlier > 0,
    hasLater: later > 0,
    firstSequence: first,
    lastSequence: last,
  });
}
export async function apkAssets(db: PrismaClient, query: unknown): Promise<AssetListView> {
  const q = checked<AssetQuery>('AssetQuery', query),
    { cursor, limit = '20', ...filters } = q,
    day = q.day ?? nowDay();
  consoleDay(day);
  const scope = digest(canonical({ kind: 'ASSETS', ...filters, day })),
    after = cursorValue(cursor, scope),
    n = Number(limit);
  const rows = await db.task.findMany({
    where: {
      AND: [
        {
          run: { purpose: 'DOWNLOAD', cacheDay: day, ...(q.nodeId ? { nodeId: q.nodeId } : {}) },
          apk: { not: Prisma.DbNull },
        },
        search(q.q),
        after
          ? {
              OR: [
                { run: { createdAt: { lt: after.at } } },
                { run: { createdAt: after.at }, id: { lt: after.id } },
              ],
            }
          : {},
      ],
    },
    select,
    orderBy: [{ run: { createdAt: 'desc' } }, { id: 'desc' }],
    take: n + 1,
  });
  return output('AssetListView', {
    items: rows.slice(0, n).map((r) => ({
      id: r.id,
      runId: r.runId,
      nodeId: r.run.nodeId,
      nodeName: r.run.node.name,
      configName: r.run.configVersion?.config.name ?? '历史配置',
      label: r.label,
      entryId: r.entryId,
      status: r.status,
      errorCode: r.errorCode,
      createdAt: r.run.createdAt.toISOString(),
      apk: apkView(r.apk),
    })),
    nextCursor:
      rows.length > n ? nextCursor(rows[n - 1].run.createdAt, rows[n - 1].id, scope) : null,
  });
}
