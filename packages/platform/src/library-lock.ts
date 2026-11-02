import type { Prisma } from '@prisma/client';
import { fault } from './errors.js';
export async function lockLibrary(tx: Prisma.TransactionClient) {
  const gate = await tx.$queryRaw<
    { ready: boolean }[]
  >`SELECT pg_try_advisory_xact_lock_shared(hashtextextended('apk-hub-release-v1',0)) AS ready`;
  if (!gate[0]?.ready) fault('HUB_UPDATING', '中台正在更新，请稍后操作', 503);
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('managed-library-v18',0))`;
}
