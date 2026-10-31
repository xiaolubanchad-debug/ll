import type { NodeView, TaskPlanView } from '@apk/contracts';

export const activeCycle = (task: TaskPlanView) =>
  !!task.latestCycle && !['DONE', 'FAILED', 'STOPPED'].includes(task.latestCycle.status);
export const currentFlow = (task: TaskPlanView) =>
  task.executionKind === 'APP_OPEN' || task.executionKind === 'DOWNLOAD_ONLY';
export const finishedCycle = (task: TaskPlanView) => {
  const c = task.latestCycle;
  return (
    !!c &&
    !activeCycle(task) &&
    (c.successes >= c.successTarget || c.attemptsStarted >= c.attemptLimit)
  );
};
export function ownsRun(task: TaskPlanView, id: string | null | undefined) {
  const c = task.latestCycle;
  return (
    !!id && !!c && (c.activeRunId === id || c.downloadRunId === id || c.registerRunIds.includes(id))
  );
}
export function preferredTask(node: NodeView, tasks: TaskPlanView[], chosen?: string) {
  const candidates = tasks.filter((t) => t.nodeId === node.id && !t.archivedAt);
  return (
    candidates.find((t) => ownsRun(t, node.activeRunId)) ??
    candidates.find((t) => t.enabled || activeCycle(t)) ??
    candidates.find((t) => t.id === chosen) ??
    candidates[0]
  );
}
export function executionLabel(node: NodeView, task?: TaskPlanView) {
  if (node.occupancy === 'QUARANTINED') return '待核验';
  if (node.activeStopRequested) return '等待清理';
  if (node.activeOperationId) return '部署 / 检查中';
  if (node.connection === 'OFFLINE') return node.occupancy === 'BUSY' ? '离线 · 等待确认' : '离线';
  const c = task?.latestCycle;
  if (c?.status === 'STOPPING') return '等待清理';
  if (task && activeCycle(task))
    return (
      (
        {
          QUEUED: '准备执行',
          CHECKING_PROXY: '准备网络',
          DOWNLOADING: '下载中',
          REGISTERING: currentFlow(task) ? 'APP 测试中' : '历史流程执行中',
          NEEDS_REVIEW: '待核验',
          WAITING: '等待处理',
        } as Record<string, string>
      )[c!.status] ?? '执行中'
    );
  if (node.occupancy === 'BUSY') return '执行中';
  if (task?.enabled && task.automatic) return '等待每日执行';
  return '空闲';
}
export function startReason(node: NodeView, task?: TaskPlanView) {
  if (!task) return '请先配置任务';
  if (!currentFlow(task)) return '历史流程，请先在配置中转换为 APP 打开测试';
  if (node.connection !== 'ONLINE') return '服务器离线';
  if (node.occupancy !== 'IDLE')
    return node.occupancy === 'QUARANTINED' ? '请先核验服务器' : '服务器操作中';
  if (activeCycle(task)) return '任务正在执行或等待清理';
  return task.readiness[0]?.message ?? '';
}
export function logRun(node: NodeView, task?: TaskPlanView) {
  const c = task?.latestCycle;
  return node.activeRunId ?? c?.activeRunId ?? c?.registerRunIds.at(-1) ?? c?.downloadRunId ?? null;
}
