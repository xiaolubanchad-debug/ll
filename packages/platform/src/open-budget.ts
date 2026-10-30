import type { Prisma, PrismaClient } from '@prisma/client';
import { beijingDay } from './daily-plan.js';
export const DAILY_OPEN_LIMIT = 800;
export async function dailyOpenUsage(
  db: PrismaClient | Prisma.TransactionClient,
  nodeId: string,
  day = beijingDay(new Date()),
) {
  const value = await db.run.aggregate({
    where: {
      nodeId,
      purpose: 'REGISTER',
      cacheDay: day,
      configVersion: { body: { path: ['execution', 'appOpen', 'dwellMs'], equals: 10000 } },
    },
    _sum: { attemptsStarted: true },
  });
  const used = value._sum.attemptsStarted ?? 0;
  return {
    day,
    limit: DAILY_OPEN_LIMIT as 800,
    used,
    remaining: Math.max(0, DAILY_OPEN_LIMIT - used),
  };
}
export const openAdmissionDeadline = (day: string) =>
  new Date(day + 'T23:55:00+08:00').toISOString();
