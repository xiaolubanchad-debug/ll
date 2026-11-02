import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  SourceElementSummary,
  SourceElementObservation,
  SourceElementCheck,
} from '@apk/contracts';
import { sourceCheckXPath } from '@apk/contracts';
type Db = Prisma.TransactionClient | PrismaClient;
export async function sourceObservationRows(db: Db, runId: string) {
  const d = await db.delivery.findUnique({
    where: { runId },
    select: { id: true, appliedThroughSequence: true },
  });
  return d
    ? db.runEvent.findMany({
        where: {
          deliveryId: d.id,
          recordedForReview: false,
          sequence: { lte: d.appliedThroughSequence },
          body: { path: ['type'], equals: 'ELEMENT_OBSERVATION' },
        },
        orderBy: { sequence: 'asc' },
        take: 10000,
      })
    : [];
}
export async function sourceElementSummary(
  db: Db,
  runId: string,
  xpath: string,
  rules: SourceElementCheck[],
): Promise<SourceElementSummary> {
  const rows = await sourceObservationRows(db, runId),
    results = new Map<
      string,
      { status: 'FOUND' | 'NOT_FOUND' | 'READ_FAILED'; matchedCount: number; occurredAt: string }
    >();
  const issues: SourceElementSummary['issues'] = [];
  for (const row of rows) {
    const b = row.body as { payload: SourceElementObservation; occurredAt: string };
    if (b.payload.phase === 'CHECK')
      results.set(b.payload.ruleId, {
        status: b.payload.status,
        matchedCount: b.payload.matchedCount,
        occurredAt: b.occurredAt,
      });
    else {
      const { phase: _, ...issue } = b.payload;
      void _;
      issues.push({ ...issue, occurredAt: b.occurredAt });
    }
  }
  return {
    xpath,
    checks: rules.map((rule) => ({
      id: rule.id,
      label: rule.label,
      xpath: sourceCheckXPath(rule),
      ...(results.get(rule.id) ?? {
        status: 'PENDING' as const,
        matchedCount: 0,
        occurredAt: null,
      }),
    })),
    totalIssues: issues.length + [...results.values()].filter((r) => r.status !== 'FOUND').length,
    issues: issues.slice(0, 20),
  };
}
export async function taskSourceWarning(db: Db, runId: string | null | undefined) {
  if (!runId) return undefined;
  const d = await db.delivery.findUnique({
    where: { runId },
    select: { id: true, appliedThroughSequence: true },
  });
  if (!d) return undefined;
  const count = await db.runEvent.count({
    where: {
      deliveryId: d.id,
      recordedForReview: false,
      sequence: { lte: d.appliedThroughSequence },
      AND: [
        { body: { path: ['type'], equals: 'ELEMENT_OBSERVATION' } },
        {
          OR: [
            { body: { path: ['payload', 'phase'], equals: 'ISSUE' } },
            {
              AND: [
                { body: { path: ['payload', 'phase'], equals: 'CHECK' } },
                {
                  OR: [
                    { body: { path: ['payload', 'status'], equals: 'NOT_FOUND' } },
                    { body: { path: ['payload', 'status'], equals: 'READ_FAILED' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  });
  if (!count) return undefined;
  const run = await db.run.findUniqueOrThrow({ where: { id: runId }, select: { cacheDay: true } });
  return run.cacheDay ? { runId, day: run.cacheDay, count } : undefined;
}
