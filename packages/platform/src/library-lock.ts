import type { Prisma } from '@prisma/client';
export async function lockLibrary(tx: Prisma.TransactionClient) {
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('managed-library-v18',0))`;
}
