import type { PrismaClient, Prisma } from '@prisma/client';
import type {
  MaintenanceInput,
  MaintenanceQuery,
  MaintenanceItem,
  MaintenanceList,
} from '@apk/contracts';
import { schemaIssues } from '@apk/contracts';
import { checked } from './secrets.js';
import { idempotent } from './jobs.js';
import { lockLibrary } from './library-lock.js';
import { fault } from './errors.js';
type Tx = Prisma.TransactionClient;
type Kind = MaintenanceInput['items'][number]['kind'];
const active = ['QUEUED', 'ASSIGNED', 'RUNNING', 'STOP_REQUESTED', 'NEEDS_REVIEW'];
async function item(tx: Tx, kind: Kind, id: string): Promise<MaintenanceItem> {
  let title: string, revision: number, archivedAt: Date | null, canArchive: boolean;
  const references: { label: string; count: number }[] = [];
  const count = (label: string, value: number) => {
    if (value) references.push({ label, count: value });
  };
  if (kind === 'CONFIG_VERSION' || kind === 'CONFIGURATION') {
    const v =
      kind === 'CONFIG_VERSION'
        ? await tx.configVersion.findUnique({ where: { id }, include: { config: true } })
        : null;
    const c =
      kind === 'CONFIGURATION' ? await tx.configuration.findUnique({ where: { id } }) : v?.config;
    if (!c || (kind === 'CONFIG_VERSION' && !v)) fault('NOT_FOUND', '配置不存在', 404);
    const ids = v
      ? [v.id]
      : (await tx.configVersion.findMany({ where: { configId: id }, select: { id: true } })).map(
          (x) => x.id,
        );
    title = v ? `${c.name} · 版本 ${v.version}` : c.name;
    revision = (v ?? c).revision;
    archivedAt = (v ?? c).archivedAt;
    const [runs, current, cycles, plans, days, busy, enabledPlans] = await Promise.all([
      tx.run.count({ where: { configVersionId: { in: ids } } }),
      tx.managedTask.count({ where: v ? { currentVersionId: id } : { configId: id } }),
      tx.managedCycle.count({ where: { configVersionId: { in: ids } } }),
      tx.dailySchedule.count({
        where: { OR: ids.map((value) => ({ body: { path: ['configVersionId'], equals: value } })) },
      }),
      tx.dailyOccurrence.count({
        where: {
          OR: ids.map((value) => ({ snapshot: { path: ['configVersionId'], equals: value } })),
        },
      }),
      tx.run.count({
        where: {
          configVersionId: { in: ids },
          status: { in: active as never[] },
          reviewResolvedAt: null,
        },
      }),
      tx.dailySchedule.count({
        where: {
          enabled: true,
          OR: ids.map((value) => ({ body: { path: ['configVersionId'], equals: value } })),
        },
      }),
    ]);
    count('历史执行', runs);
    count('任务绑定', current);
    count('任务轮次', cycles);
    count('每日计划', plans);
    count('每日历史', days);
    if (kind === 'CONFIGURATION') count('配置版本', ids.length);
    const protectedTasks = await tx.managedTask.count({
      where: { archivedAt: null, ...(v ? { currentVersionId: id } : { configId: id }) },
    });
    const activeCycles = await tx.managedCycle.count({
      where: { configVersionId: { in: ids }, status: { notIn: ['DONE', 'FAILED', 'STOPPED'] } },
    });
    canArchive = !busy && !enabledPlans && !protectedTasks && !activeCycles;
  } else {
    const r = await tx.release.findUnique({ where: { id } });
    if (!r) fault('NOT_FOUND', '发布不存在', 404);
    const m = r.manifest as { agentVersion?: string; gitCommit?: string };
    title = `Agent ${m.agentVersion ?? '历史'} · ${m.gitCommit?.slice(0, 7) ?? r.id.slice(0, 8)}`;
    revision = r.revision;
    archivedAt = r.archivedAt;
    const [nodes, credentials, deployments, runs, plans, days, cycles, busy] = await Promise.all([
      tx.node.count({ where: { agentReleaseId: id } }),
      tx.agentCredential.count({ where: { releaseId: id } }),
      tx.deployment.count({ where: { releaseId: id } }),
      tx.run.count({ where: { releaseId: id } }),
      tx.dailySchedule.count({ where: { body: { path: ['releaseId'], equals: id } } }),
      tx.dailyOccurrence.count({ where: { snapshot: { path: ['releaseId'], equals: id } } }),
      tx.managedCycle.count({ where: { releaseId: id } }),
      tx.deployment.count({
        where: {
          releaseId: id,
          status: { notIn: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'NEEDS_REVIEW'] },
        },
      }),
    ]);
    count('服务器', nodes);
    count('节点身份', credentials);
    count('部署记录', deployments);
    count('执行记录', runs);
    count('每日计划', plans);
    count('每日历史', days);
    count('任务轮次', cycles);
    canArchive = !busy;
  }
  return {
    id,
    kind,
    title,
    revision,
    archivedAt: archivedAt?.toISOString() ?? null,
    references,
    canDelete: references.length === 0,
    canArchive,
  };
}
export async function maintenanceList(db: PrismaClient, query: unknown): Promise<MaintenanceList> {
  const q = checked<MaintenanceQuery>('MaintenanceQuery', query),
    limit = Number(q.limit ?? 30);
  const where = {
    ...(q.archived === 'ALL'
      ? {}
      : { archivedAt: q.archived === 'ARCHIVED' ? { not: null } : null }),
    ...(q.kind === 'CONFIG_VERSION' && q.configId ? { configId: q.configId } : {}),
  };
  const args = {
    where,
    take: limit + 1,
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    select: { id: true },
  };
  const rows =
    q.kind === 'RELEASE'
      ? await db.release.findMany(args)
      : q.kind === 'CONFIG_VERSION'
        ? await db.configVersion.findMany(args)
        : await db.configuration.findMany(args);
  const items = await db.$transaction(async (tx) =>
    Promise.all(rows.slice(0, limit).map((row) => item(tx, q.kind, row.id))),
  );
  const result = { items, nextCursor: rows.length > limit ? rows[limit - 1].id : null };
  if (schemaIssues('MaintenanceList', result).length)
    fault('INTERNAL_CONTRACT_ERROR', '历史记录暂不可用', 503);
  return result;
}
export async function maintenanceAction(
  db: PrismaClient,
  body: unknown,
  actor: string,
  requestId: string,
  key: string,
) {
  const input = checked<MaintenanceInput>('MaintenanceInput', body);
  if (new Set(input.items.map((i) => i.kind + ':' + i.id)).size !== input.items.length)
    fault('VALIDATION_FAILED', '不能重复选择同一项', 422);
  return idempotent(db, actor, 'POST:/maintenance/actions', key, input, async (tx) => {
    await lockLibrary(tx);
    for (const entry of input.items) {
      const current = await item(tx, entry.kind, entry.id);
      if (current.revision !== entry.revision) fault('STALE_VERSION', '记录已变化，请刷新后操作');
      if (input.action === 'DELETE' && !current.canDelete)
        fault('VERSION_REFERENCED', '记录仍被引用，请归档或先解除绑定');
      if (input.action === 'ARCHIVE' && !current.canArchive)
        fault('VERSION_IN_USE', '记录仍在使用，请先停止并更换当前配置');
      const data = {
        archivedAt: input.action === 'RESTORE' ? null : new Date(),
        revision: { increment: 1 },
      };
      if (entry.kind === 'RELEASE') {
        if (input.action === 'DELETE') await tx.release.delete({ where: { id: entry.id } });
        else await tx.release.update({ where: { id: entry.id }, data });
      } else if (entry.kind === 'CONFIG_VERSION') {
        if (input.action === 'DELETE') await tx.configVersion.delete({ where: { id: entry.id } });
        else await tx.configVersion.update({ where: { id: entry.id }, data });
      } else {
        if (input.action === 'DELETE') await tx.configuration.delete({ where: { id: entry.id } });
        else
          await tx.configuration.update({
            where: { id: entry.id },
            data: { ...data, version: { increment: 1 } },
          });
      }
    }
    await tx.auditEvent.create({
      data: {
        adminId: actor,
        action: 'LIBRARY_' + input.action,
        requestId,
        details: { items: input.items.map((i) => ({ id: i.id, kind: i.kind })) },
      },
    });
    return { affected: input.items.length };
  });
}
