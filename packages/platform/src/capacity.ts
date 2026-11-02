import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { NodeCapacityInput, NodeCapacityQuery, NodeCapacityView } from '@apk/contracts';
import { executionCapacitySupported, MAX_DAILY_OPEN_LIMIT } from '@apk/contracts';
import { checked } from './secrets.js';
import { fault } from './errors.js';
import { idempotent } from './jobs.js';
import { lockNode, idle } from './nodes.js';

type Db = PrismaClient | Prisma.TransactionClient;
export interface CapacitySample {
  setupMs: number;
  appMs: number;
  apps: number;
  owned: boolean;
}
const quantile = (xs: number[]) =>
  xs.slice().sort((a, b) => a - b)[Math.ceil(xs.length * 0.75) - 1];
export function estimateOpenCapacity(samples: CapacitySample[], groupSize: number) {
  const group = Math.max(1, Math.min(1000, Math.floor(groupSize)));
  const valid = samples.filter(
    (s) =>
      Number.isFinite(s.setupMs) &&
      s.setupMs >= 0 &&
      Number.isFinite(s.appMs) &&
      s.appMs >= 10000 &&
      s.apps >= 10,
  );
  const deviceSetupMs = Math.ceil(valid.length ? quantile(valid.map((s) => s.setupMs)) : 180000);
  const appMs = Math.ceil(valid.length ? quantile(valid.map((s) => s.appMs)) : 35000);
  const perApp = deviceSetupMs / group + appMs;
  const raw = Math.floor((85800000 * 0.75) / perApp);
  const recommendedLimit = Math.max(
    1,
    Math.min(MAX_DAILY_OPEN_LIMIT, raw >= 100 ? Math.floor(raw / 50) * 50 : raw),
  );
  return {
    recommendedLimit,
    deviceSetupMs,
    appMs,
    appsPerDeviceMin: group,
    reservePercent: 25 as const,
    sampleRuns: valid.length,
    sampleApps: valid.reduce((n, s) => n + s.apps, 0),
    sampleScope: valid.length
      ? valid.every((s) => s.owned)
        ? ('OWNED_TEST_ONLY' as const)
        : ('NODE_HISTORY' as const)
      : ('CONSERVATIVE_REFERENCE' as const),
  };
}
export async function capacitySamples(
  db: Db,
  nodeId: string,
  now = new Date(),
): Promise<CapacitySample[]> {
  const rows = await db.run.findMany({
    where: {
      nodeId,
      purpose: 'REGISTER',
      status: 'SUCCEEDED',
      successes: { gte: 10 },
      finishedAt: { gte: new Date(now.getTime() - 14 * 86400000) },
      executionPlan: { path: ['openPolicy', 'concurrency'], equals: 1 },
    },
    orderBy: { finishedAt: 'desc' },
    take: 12,
    select: {
      id: true,
      createdAt: true,
      finishedAt: true,
      successes: true,
      attemptsStarted: true,
      executionPlan: true,
      configVersion: { select: { body: true } },
      delivery: { select: { id: true, appliedThroughSequence: true } },
    },
  });
  const result: CapacitySample[] = [];
  for (const r of rows) {
    const plan = r.executionPlan as { openPolicy?: { sessions?: { id: string }[] } } | null;
    const groups = plan?.openPolicy?.sessions?.length;
    if (!groups || !r.delivery || !r.finishedAt || r.attemptsStarted !== r.successes) continue;
    const [sum] = await db.$queryRaw<{ proofs: bigint; setup: bigint; closed: bigint }[]>`
      SELECT COUNT(DISTINCT e.id) FILTER (WHERE e.body->>'type'='TASK_FINISHED' AND e.body#>>'{payload,status}'='SUCCEEDED' AND e.body#>>'{payload,proof}'='APP_OPEN' AND e.body#>'{payload,openTimings,steps}' IS NOT NULL) AS proofs,
      COALESCE(SUM(CASE WHEN st.value->>'name' IN ('AVD_CREATE','EMULATOR_BOOT','APPIUM_PREPARE','DEVICE_CHECK') THEN (st.value->>'elapsedMs')::bigint ELSE 0 END),0)::bigint AS setup,
      COUNT(DISTINCT e.id) FILTER (WHERE e.body->>'type'='DEVICE_SESSION' AND e.body#>>'{payload,phase}'='CLOSED' AND e.body#>>'{payload,cleanupComplete}'='true') AS closed
      FROM "RunEvent" e LEFT JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.body#>'{payload,openTimings,steps}')='array' THEN e.body#>'{payload,openTimings,steps}' ELSE '[]'::jsonb END) st ON true
      WHERE e."deliveryId"=${r.delivery.id}::uuid AND e.sequence<=${r.delivery.appliedThroughSequence} AND NOT e."recordedForReview"`;
    if (Number(sum.proofs) !== r.successes || Number(sum.closed) !== groups) continue;
    const receipts = await db.runEvent.findMany({
      where: {
        deliveryId: r.delivery.id,
        sequence: { lte: r.delivery.appliedThroughSequence },
        recordedForReview: false,
        body: { path: ['type'], equals: 'DEVICE_SESSION' },
      },
      orderBy: { sequence: 'asc' },
      select: { body: true },
    });
    const expected = new Set(plan!.openPolicy!.sessions!.map((s) => s.id)),
      completed = new Set<string>();
    let active: string | undefined,
      serial = true;
    for (const receipt of receipts) {
      const p = (
        receipt.body as {
          payload?: { phase?: string; sessionId?: string; cleanupComplete?: boolean };
        }
      ).payload;
      if (!p?.sessionId || !expected.has(p.sessionId)) {
        serial = false;
        break;
      }
      if (p.phase === 'STARTED') {
        if (active || completed.has(p.sessionId)) {
          serial = false;
          break;
        }
        active = p.sessionId;
      } else if (p.phase === 'CLOSED' && p.cleanupComplete && active === p.sessionId) {
        completed.add(active);
        active = undefined;
      } else {
        serial = false;
        break;
      }
    }
    if (!serial || active || completed.size !== groups) continue;
    const wall = r.finishedAt.getTime() - r.createdAt.getTime(),
      setup = Number(sum.setup);
    if (wall <= setup || wall > 3 * 86400000) continue;
    result.push({
      setupMs: setup / groups,
      appMs: Math.max(10000, (wall - setup) / r.successes),
      apps: r.successes,
      owned:
        (
          r.configVersion?.body as
            | { execution?: { appOpen?: { ownedTestClient?: boolean } } }
            | undefined
        )?.execution?.appOpen?.ownedTestClient === true,
    });
  }
  return result;
}
export async function capacityState(
  db: Db,
  nodeId: string,
  day: string,
  groupSize = 1,
  now = new Date(),
  withEstimate = true,
) {
  const node = await db.node.findUnique({ where: { id: nodeId } });
  // Historical task views retain the day's usage even after a node is archived.
  if (!node) fault('NOT_FOUND', '服务器不存在', 404);
  const release = node.agentReleaseId
    ? await db.release.findUnique({
        where: { id: node.agentReleaseId },
        select: { manifest: true },
      })
    : null;
  const supported = executionCapacitySupported(
    (release?.manifest as { features?: string[] } | null)?.features,
    node.agentVersion,
  );
  const [usedRow, frozenRows] = await Promise.all([
    db.run.aggregate({
      where: {
        nodeId,
        purpose: 'REGISTER',
        cacheDay: day,
        configVersion: { body: { path: ['execution', 'appOpen', 'dwellMs'], equals: 10000 } },
      },
      _sum: { attemptsStarted: true },
    }),
    db.$queryRaw<
      { limit: number | null }[]
    >`SELECT MAX(("executionPlan"#>>'{openPolicy,dailyLimit}')::integer) AS "limit" FROM "Run" WHERE "nodeId"=${nodeId}::uuid AND "cacheDay"=${day} AND purpose='REGISTER' AND "executionPlan"#>>'{openPolicy,capacityVersion}'='1'`,
  ]);
  const frozenLimit = frozenRows[0]?.limit ?? 0,
    manual = node.dailyOpenLimitOverride;
  const needEstimate = withEstimate || (supported && !frozenLimit && manual === null);
  const estimate = estimateOpenCapacity(
    needEstimate ? await capacitySamples(db, nodeId, now) : [],
    groupSize,
  );
  const limit = supported
    ? frozenLimit
      ? Math.max(frozenLimit, manual ?? 0)
      : (manual ?? estimate.recommendedLimit)
    : 800;
  const used = usedRow._sum.attemptsStarted ?? 0;
  const deadline = new Date(day + 'T23:55:00+08:00').toISOString();
  return {
    nodeId,
    version: node.version,
    day,
    supported,
    mode: manual === null ? ('AUTO' as const) : ('MANUAL' as const),
    manualLimit: manual,
    ...estimate,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    frozen: frozenLimit > 0,
    remainingTimeEstimate: Math.min(
      MAX_DAILY_OPEN_LIMIT,
      Math.max(
        0,
        Math.floor(
          ((Date.parse(deadline) - now.getTime()) * 0.75) /
            (estimate.deviceSetupMs / estimate.appsPerDeviceMin + estimate.appMs),
        ),
      ),
    ),
    admissionDeadline: deadline,
  };
}
export async function nodeCapacity(
  db: PrismaClient,
  nodeId: string,
  query: unknown,
): Promise<NodeCapacityView> {
  const q = checked<NodeCapacityQuery>('NodeCapacityQuery', query),
    now = new Date();
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return checked<NodeCapacityView>(
    'NodeCapacityView',
    await capacityState(db, nodeId, day, Number(q.appsPerDeviceMin ?? 1), now),
  );
}
export async function updateNodeCapacity(
  db: PrismaClient,
  nodeId: string,
  body: unknown,
  version: number,
  actor: string,
  requestId: string,
  key: string,
): Promise<NodeCapacityView> {
  const input = checked<NodeCapacityInput>('NodeCapacityInput', body);
  await idempotent(
    db,
    actor,
    'PUT:/nodes/' + nodeId + '/execution-capacity',
    key,
    { input, version },
    async (tx) => {
      const node = await lockNode(tx, nodeId);
      if (node.version !== version) fault('STALE_VERSION', '服务器状态已变化，请刷新后再应用额度');
      await idle(tx, nodeId);
      await tx.node.update({
        where: { id: nodeId },
        data: { dailyOpenLimitOverride: input.dailyLimit, version: { increment: 1 } },
      });
      await tx.auditEvent.create({
        data: {
          adminId: actor,
          action: 'NODE_EXECUTION_CAPACITY_UPDATED',
          requestId,
          details: {
            nodeId,
            mode: input.dailyLimit === null ? 'AUTO' : 'MANUAL',
            dailyLimit: input.dailyLimit,
          },
        },
      });
      return { id: nodeId };
    },
  );
  return nodeCapacity(db, nodeId, {});
}
