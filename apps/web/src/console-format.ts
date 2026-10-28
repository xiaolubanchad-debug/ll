import type { ResultCategory } from '@apk/contracts';
export const categoryLabels: Record<ResultCategory, string> = {
  SUCCESS: '注册成功',
  REJECTED: 'APP 明确拒绝',
  ERROR: '执行异常',
  ADAPTATION: '待适配',
  UNKNOWN: '结果未知',
  SKIPPED: '已跳过',
  STOPPED: '已停止',
  PENDING: '等待确定结果',
};
export const stateLabels: Record<string, string> = {
  QUEUED: '等待领取',
  ASSIGNED: '等待节点确认',
  RUNNING: '执行中',
  STOP_REQUESTED: '停止待确认',
  SUCCEEDED: '已完成',
  PARTIAL_FAILED: '部分完成',
  FAILED: '失败',
  CANCELLED: '已停止',
  NEEDS_REVIEW: '待核验',
  UNKNOWN: '结果未知',
  DOWNLOADING: '读取或下载 APK',
  DOWNLOADED: '文件已校验',
  PREPARING: '准备模拟器',
  INSTALLING: '安装 APK',
  LAUNCHING: '启动 APP',
  DISCOVERING: '寻找注册入口',
  REGISTERING: '填写注册表单',
  VERIFYING: '核验提交结果',
  SKIPPED: '已跳过',
};
export const when = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(new Date(value))
    : '—';
export const today = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
export const duration = (ms: number | null) =>
  ms === null
    ? '—'
    : ms < 1000
      ? '少于 1 秒'
      : ms < 60000
        ? Math.round(ms / 1000) + ' 秒'
        : Math.floor(ms / 60000) + ' 分 ' + Math.round((ms % 60000) / 1000) + ' 秒';
