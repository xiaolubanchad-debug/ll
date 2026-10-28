import type { PrismaClient, Prisma, RunStatus } from '@prisma/client';
import type { ScheduleInput } from '@apk/contracts';
import { checked, readSecret } from './secrets.js';
import { idempotent } from './jobs.js';
import { lockNode } from './nodes.js';
import { fault, PlatformError } from './errors.js';
import { beijingDay, validateBudget } from './daily-plan.js';
import { createRun, stopRun, RUN_END } from './runs.js';

export async function saveSchedule(
  db: PrismaClient,
  body: unknown,
  actor: string,
  requestId: string,
  key: string,
  id?: string,
  version?: number,
) {
  const input = checked<ScheduleInput>('ScheduleInput', body);
  validateBudget(input.successTarget, input.attemptLimit);
  return idempotent(
    db,
    actor,
    id ? 'PUT:/schedules/' + id : 'POST:/schedules',
    key,
    { input, id, version },
    async (tx) => {
      const node = await lockNode(tx, input.nodeId);
      const previous = await tx.dailySchedule.findUnique({
        where: id ? { id } : { nodeId: input.nodeId },
      });
      if (id && (!previous || previous.version !== version))
        fault('STALE_VERSION', '计划已更新，请刷新后编辑');
      if (id && previous!.nodeId !== input.nodeId)
        fault('VALIDATION_FAILED', '已有计划不能更换服务器', 422);
      if (!id && previous) fault('SCHEDULE_EXISTS', '此服务器已有每日计划');
      const config = await tx.configVersion.findUnique({ where: { id: input.configVersionId } });
      const release = await tx.release.findUnique({ where: { id: input.releaseId } });
      if (!config || !release) fault('NOT_FOUND', '配置或发布不存在', 404);
      if (!(release.manifest as { features?: string[] }).features?.includes('DAILY_V1'))
        fault('NODE_UPGRADE_REQUIRED', '计划需要支持 1.5 的固定发布');
      if (node.archivedAt) fault('NOT_FOUND', '服务器已归档', 404);
      const c = config.body as unknown as {
        execution: { mode: string; proxySecretVersionId?: string };
      };
      if (input.autoRegister) {
        if (c.execution.mode !== 'FULL' || !c.execution.proxySecretVersionId)
          fault('PROXY_CONFIG_INVALID', '自动注册需要应用代理后的完整配置版本', 422);
        await readSecret(tx, c.execution.proxySecretVersionId, ['HTTP_PROXY']);
      }
      const data = { body: input as unknown as Prisma.InputJsonValue, enabled: input.enabled };
      const saved = id
        ? await tx.dailySchedule.update({
            where: { id },
            data: { ...data, version: { increment: 1 } },
          })
        : await tx.dailySchedule.create({
            data: { ...data, nodeId: input.nodeId, createdBy: actor },
          });
      await tx.auditEvent.create({
        data: {
          adminId: actor,
          action: id ? 'SCHEDULE_UPDATED' : 'SCHEDULE_CREATED',
          requestId,
          details: { scheduleId: saved.id, enabled: saved.enabled },
        },
      });
      return saved;
    },
  );
}

async function stopOccurrence(
  db: PrismaClient,
  occurrence: { id: string; downloadRunId: string | null; registerRunId: string | null },
  actor: string,
) {
  let review = false;
  for (const id of [occurrence.downloadRunId, occurrence.registerRunId]) {
    if (!id) continue;
    const run = await db.run.findUniqueOrThrow({ where: { id } });
    if (run.status === 'NEEDS_REVIEW') review = true;
    if (!RUN_END.includes(run.status))
      await stopRun(
        db,
        id,
        { reason: '每日计划关闭或跨日切换' },
        actor,
        'scheduler',
        'schedule-stop:' + occurrence.id + ':' + id,
      );
  }
  const ids = [occurrence.downloadRunId, occurrence.registerRunId].filter(
    (id): id is string => !!id,
  );
  const active = await db.run.count({
    where: { id: { in: ids }, status: { notIn: RUN_END as RunStatus[] } },
  });
  if (!active)
    await db.dailyOccurrence.update({
      where: { id: occurrence.id },
      data: {
        status: review ? 'PAUSED' : 'STOPPED',
        errorCode: review ? 'REGISTRATION_UNKNOWN' : null,
      },
    });
}

export async function tickSchedules(db: PrismaClient, now = new Date()) {
  const day = beijingDay(now);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  for (const schedule of await db.dailySchedule.findMany({
    take: 100,
    orderBy: { createdAt: 'asc' },
  })) {
    let occurrence: { id: string } | undefined;
    try {
      const body = schedule.body as unknown as ScheduleInput;
      if (!schedule.enabled || time >= body.time) {
        const old = await db.dailyOccurrence.findMany({
          where: {
            scheduleId: schedule.id,
            ...(schedule.enabled ? { day: { lt: day } } : {}),
            status: { notIn: ['FINISHED', 'STOPPED'] },
          },
          take: 100,
        });
        for (const row of old) await stopOccurrence(db, row, schedule.createdBy);
      }
      if (!schedule.enabled || time < body.time) continue;
      let row = await db.dailyOccurrence.upsert({
        where: { scheduleId_day: { scheduleId: schedule.id, day } },
        create: { scheduleId: schedule.id, day, snapshot: schedule.body as Prisma.InputJsonValue },
        update: {},
      });
      occurrence = row;
      if (['FINISHED', 'STOPPED'].includes(row.status)) continue;
      const input = row.snapshot as unknown as ScheduleInput;
      if (!row.downloadRunId) {
        const run = await createRun(
          db,
          {
            nodeId: input.nodeId,
            configVersionId: input.configVersionId,
            releaseId: input.releaseId,
            purpose: 'DOWNLOAD',
          },
          schedule.createdBy,
          'scheduler',
          'schedule-download:' + schedule.id + ':' + day,
          now,
          schedule.id,
        );
        row = await db.dailyOccurrence.update({
          where: { id: row.id },
          data: { downloadRunId: run.resourceId, status: 'DOWNLOADING', errorCode: null },
        });
      }
      const downloaded = await db.run.findUniqueOrThrow({ where: { id: row.downloadRunId! } });
      if (!RUN_END.includes(downloaded.status)) continue;
      if (!['SUCCEEDED', 'PARTIAL_FAILED'].includes(downloaded.status)) {
        await db.dailyOccurrence.update({
          where: { id: row.id },
          data: { status: 'PAUSED', errorCode: downloaded.errorCode ?? 'DOWNLOAD_FAILED' },
        });
        continue;
      }
      if (!input.autoRegister) {
        await db.dailyOccurrence.update({
          where: { id: row.id },
          data: { status: 'FINISHED', errorCode: null },
        });
        continue;
      }
      if (!row.registerRunId) {
        const run = await createRun(
          db,
          {
            nodeId: input.nodeId,
            configVersionId: input.configVersionId,
            releaseId: input.releaseId,
            purpose: 'REGISTER',
            sourceDownloadId: row.downloadRunId,
            successTarget: input.successTarget,
            attemptLimit: input.attemptLimit,
          },
          schedule.createdBy,
          'scheduler',
          'schedule-register:' + schedule.id + ':' + day,
          now,
          schedule.id,
        );
        row = await db.dailyOccurrence.update({
          where: { id: row.id },
          data: { registerRunId: run.resourceId, status: 'REGISTERING', errorCode: null },
        });
      }
      const registered = await db.run.findUniqueOrThrow({ where: { id: row.registerRunId! } });
      if (RUN_END.includes(registered.status))
        await db.dailyOccurrence.update({
          where: { id: row.id },
          data: {
            status: registered.status === 'NEEDS_REVIEW' ? 'PAUSED' : 'FINISHED',
            errorCode: registered.errorCode,
          },
        });
    } catch (error) {
      if (occurrence)
        await db.dailyOccurrence
          .update({
            where: { id: occurrence.id },
            data: {
              status: 'WAITING',
              errorCode: error instanceof PlatformError ? error.code : 'SCHEDULER_UNAVAILABLE',
            },
          })
          .catch(() => {});
    }
  }
}
