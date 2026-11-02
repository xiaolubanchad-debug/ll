import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
try {
  await db.$transaction(
    async (tx) => {
      const gate =
        await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(hashtextextended('apk-hub-release-v1',0)) AS ready`;
      if (!gate[0]?.ready) throw Error('HUB_RELEASE_BUSY');
      await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended('managed-library-v18',0))`;
      const [tasks, runs, jobs, slots] = await Promise.all([
        db.managedTask.count({ where: { enabled: true } }),
        db.run.count({
          where: {
            status: {
              notIn: ['SUCCEEDED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'],
            },
          },
        }),
        db.deployment.count({
          where: { status: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'] } },
        }),
        db.nodeSlot.count({
          where: {
            OR: [{ quarantined: true }, { operationId: { not: null } }, { runId: { not: null } }],
          },
        }),
      ]);
      const [table] = await db.$queryRaw`SELECT to_regclass('"ManualApkUpload"')::text AS name`;
      const uploads = table?.name
        ? await db.$queryRaw`SELECT count(*)::int AS n FROM "ManualApkUpload" WHERE "status" IN ('UPLOADING','RECEIVING','QUEUED','IMPORTING','NEEDS_REVIEW')`
        : [{ n: 0 }];
      if (tasks || runs || jobs || slots || uploads[0]?.n) throw Error('HUB_NOT_IDLE');
      console.log('RELEASE_LOCK_READY');
      await new Promise((resolve, reject) => {
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', (value) =>
          value.trim() === 'RELEASE' ? resolve() : reject(Error('RELEASE_ABORTED')),
        );
        process.stdin.once('end', () => reject(Error('RELEASE_ABORTED')));
      });
    },
    { timeout: 1200000, maxWait: 15000 },
  );
} catch {
  console.error('RELEASE_LOCK_FAILED');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
