import type { Prisma, ConfigVersion } from '@prisma/client';
import type { DailyExecutionPlan, RunInput, TestConfiguration } from '@apk/contracts';
import { schemaIssues, registrationAvailable } from '@apk/contracts';
import { digest, canonical } from './security.js';
import { fault } from './errors.js';

export function beijingDay(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function validateBudget(n: number, m: number) {
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < n || m > 1000)
    fault(
      'VALIDATION_FAILED',
      '成功目标和尝试上限需为 1–1000 的整数，且尝试上限不小于成功目标',
      422,
    );
}
export const dailyTargetKey = (key: string, index: number) => digest(canonical([key, index]));
export async function prepareDailyPlan(
  tx: Prisma.TransactionClient,
  input: RunInput,
  version: ConfigVersion,
  now: Date,
): Promise<DailyExecutionPlan | null> {
  if (!input.purpose) {
    if (
      [
        input.sourceDownloadId,
        input.successTarget,
        input.attemptLimit,
        input.proxySecretVersionId,
      ].some((x) => x !== undefined)
    )
      fault('VALIDATION_FAILED', '扩展参数需要明确选择执行内容', 422);
    return null;
  }
  const config = version.body as unknown as TestConfiguration;
  const plan: DailyExecutionPlan = {
    purpose: input.purpose,
    cacheDay: beijingDay(now),
    successTarget: 0,
    attemptLimit: 0,
    assets: [],
  };
  if (
    input.purpose !== 'REGISTER' &&
    [input.sourceDownloadId, input.successTarget, input.attemptLimit].some((x) => x !== undefined)
  )
    fault('VALIDATION_FAILED', '配额及来源只用于循环注册', 422);
  if (input.purpose !== 'PROXY_CHECK' && input.proxySecretVersionId)
    fault('VALIDATION_FAILED', '独立代理引用只用于代理检查', 422);
  if (input.purpose === 'PROXY_CHECK') plan.proxySecretVersionId = input.proxySecretVersionId;
  if (input.purpose === 'REGISTER') {
    validateBudget(input.successTarget!, input.attemptLimit!);
    if (config.execution.mode !== 'FULL')
      fault('PROXY_CONFIG_INVALID', '请在完整配置中应用代理并保存版本', 422);
    const source = await tx.run.findUnique({
      where: { id: input.sourceDownloadId! },
      include: { configVersion: true, tasks: { orderBy: { position: 'asc' } } },
    });
    if (
      !source ||
      source.nodeId !== input.nodeId ||
      source.purpose !== 'DOWNLOAD' ||
      source.cacheDay !== plan.cacheDay ||
      !['SUCCEEDED', 'PARTIAL_FAILED'].includes(source.status) ||
      source.configVersion?.configId !== version.configId
    )
      fault('DOWNLOAD_SOURCE_INVALID', '请选择本服务器、本配置当天已结束的下载批次', 422);
    const original = source.configVersion.body as unknown as TestConfiguration;
    if (original.source.url !== config.source.url || original.source.xpath !== config.source.xpath)
      fault('DOWNLOAD_SOURCE_INVALID', '来源网站和 XPath 与下载批次不一致', 422);
    plan.successTarget = input.successTarget!;
    plan.attemptLimit = input.attemptLimit!;
    plan.proxySecretVersionId = config.execution.proxySecretVersionId;
    for (const task of source.tasks) {
      if (task.status !== 'SUCCEEDED' || schemaIssues('ApkMetadata', task.apk).length) continue;
      const apk = task.apk as unknown as DailyExecutionPlan['assets'][number]['apk'];
      if (apk.cacheDay !== plan.cacheDay)
        fault('DOWNLOAD_SOURCE_INVALID', '文件日期与当天批次不一致', 422);
      if (!registrationAvailable(config, apk.packageName, task.entryId ?? undefined)) continue;
      plan.assets.push({
        targetKey: task.targetKey,
        label: task.label,
        sourceUrl: task.sourceUrl,
        apk,
        ...(task.entryId ? { entryId: task.entryId } : {}),
      });
    }
  }
  if (schemaIssues('DailyExecutionPlan', plan).length)
    fault('VALIDATION_FAILED', '执行计划无效', 422);
  return plan;
}
