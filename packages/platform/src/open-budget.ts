import type { Prisma, PrismaClient } from '@prisma/client';
import type { TestConfiguration } from '@apk/contracts';
import { capacityState } from './capacity.js';
import { beijingDay } from './daily-plan.js';
export const DAILY_OPEN_LIMIT = 800;
export async function dailyOpenUsage(
  db: PrismaClient | Prisma.TransactionClient,
  nodeId: string,
  day = beijingDay(new Date()),
  config?: TestConfiguration,
) {
  const state = await capacityState(
    db,
    nodeId,
    day,
    config?.execution.appOpen?.appsPerDevice?.min ?? 1,
    new Date(),
    false,
  );
  return { day, limit: state.limit, used: state.used, remaining: state.remaining };
}
export const openAdmissionDeadline = (day: string) =>
  new Date(day + 'T23:55:00+08:00').toISOString();
