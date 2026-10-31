import { randomInt, randomUUID } from 'node:crypto';
import {
  isOwnedTestPackage,
  deviceVariant,
  devicePlanIssues,
  EXECUTION_DEVICE_LIMIT,
} from '@apk/contracts';
import {
  assertIdentityReady,
  identityCapacity,
  allocateIdentityModels,
  readyDeviceVariants,
  readyDeviceAbis,
} from './identity.js';
import type { Prisma, ConfigVersion } from '@prisma/client';
import type { DailyExecutionPlan, RunInput, TestConfiguration } from '@apk/contracts';
import { schemaIssues, registrationAvailable } from '@apk/contracts';
import { digest, canonical } from './security.js';
import { fault } from './errors.js';
import { dailyOpenUsage, openAdmissionDeadline } from './open-budget.js';

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
    const identityNode = await tx.node.findUniqueOrThrow({
      where: { id: input.nodeId },
    });
    const identityRelease = identityNode.agentReleaseId
      ? await tx.release.findUnique({
          where: { id: identityNode.agentReleaseId },
        })
      : null;
    assertIdentityReady(
      config,
      (identityRelease?.manifest as { features?: string[] } | null)?.features,
      identityNode.agentVersion,
      identityNode.health,
      input.attemptLimit!,
    );
    if (config.execution.appOpen) {
      const budget = await dailyOpenUsage(tx, input.nodeId, plan.cacheDay);
      if (input.attemptLimit! > budget.remaining)
        fault('DAILY_OPEN_LIMIT', '当日剩余执行额度不足，请降低目标和尝试上限', 422);
      if (config.execution.appOpen.concurrency !== undefined) {
        const deadline = openAdmissionDeadline(plan.cacheDay);
        if (now.getTime() >= Date.parse(deadline))
          fault('DAY_CUTOFF', '今日停止新增轮次，请等待次日下载', 422);
        plan.openPolicy = {
          concurrency: EXECUTION_DEVICE_LIMIT,
          dailyLimit: 800,
          admissionDeadline: deadline,
          ...(config.execution.appOpen.randomDeviceProfile &&
          !config.execution.appOpen.appsPerDevice
            ? {
                variantIds: allocateIdentityModels(
                  input.attemptLimit!,
                  Math.min(3, identityCapacity(identityNode.health)),
                ),
              }
            : {}),
        };
      }
    }
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
      if (config.execution.appOpen?.ownedTestClient && !isOwnedTestPackage(apk.packageName))
        continue;
      plan.assets.push({
        targetKey: task.targetKey,
        label: task.label,
        sourceUrl: task.sourceUrl,
        apk,
        ...(task.entryId ? { entryId: task.entryId } : {}),
      });
    }
  }
  const groupPolicy = config.execution.appOpen?.appsPerDevice;
  if (groupPolicy && plan.purpose === 'REGISTER') {
    plan.assets = plan.assets.filter((a) => a.apk.minSdkVersion !== undefined);
    const seen = new Set<string>();
    plan.assets = plan.assets.filter((a) => {
      if (seen.has(a.apk.packageName)) return false;
      seen.add(a.apk.packageName);
      return true;
    });
    if (plan.assets.length < groupPolicy.max)
      fault('APK_POOL_INSUFFICIENT', '不同包名的兼容 APK 数量不足，请降低每台设备安装数量', 422);
    const node = await tx.node.findUniqueOrThrow({
      where: { id: input.nodeId },
    });
    const variants = readyDeviceVariants(node.health);
    const abiCatalog = readyDeviceAbis(node.health);
    if (config.execution.appOpen?.randomDeviceProfile && variants.length < 2)
      fault('IDENTITY_POOL_EXHAUSTED', '缺少已验证型号档案', 422);
    const sessions: NonNullable<NonNullable<DailyExecutionPlan['openPolicy']>['sessions']> = [];
    let left = plan.attemptLimit;
    let modelBag = variants.slice();
    while (left > 0) {
      const compatibleVariants = variants.filter(
        (id) =>
          id !== sessions.at(-1)?.variantId &&
          plan.assets.filter(
            (a) =>
              (a.apk.minSdkVersion ?? 1) <= (deviceVariant(id)?.apiLevel ?? 0) &&
              (!a.apk.abis.length || a.apk.abis.some((abi) => abiCatalog[id]?.includes(abi))),
          ).length >= groupPolicy.max,
      );
      let available = modelBag.filter((id) => compatibleVariants.includes(id));
      if (!available.length) {
        modelBag = variants.slice();
        available = modelBag.filter((id) => compatibleVariants.includes(id));
      }
      if (config.execution.appOpen?.randomDeviceProfile && !available.length)
        fault('APK_POOL_INSUFFICIENT', '所选 APK 与已验证系统档案不兼容', 422);
      const variantId = config.execution.appOpen?.randomDeviceProfile
        ? available[randomInt(available.length)]
        : undefined;
      modelBag = modelBag.filter((id) => id !== variantId);
      const api =
        deviceVariant(variantId ?? '')?.apiLevel ??
        Number(config.execution.deviceProfiles[0].systemImage.split(';')[1].slice(8));
      const supportedAbis =
        abiCatalog[variantId ?? variants.find((id) => deviceVariant(id)?.apiLevel === api) ?? ''] ??
        [];
      const indexes = plan.assets.flatMap((a, i) =>
        (a.apk.minSdkVersion ?? 1) <= api &&
        (!a.apk.abis.length || a.apk.abis.some((abi) => supportedAbis.includes(abi)))
          ? [i]
          : [],
      );
      if (indexes.length < groupPolicy.max)
        fault('APK_POOL_INSUFFICIENT', '兼容 APK 数量不足', 422);
      const count = Math.min(left, randomInt(groupPolicy.min, groupPolicy.max + 1));
      for (let i = indexes.length - 1; i > 0; i--) {
        const j = randomInt(i + 1);
        [indexes[i], indexes[j]] = [indexes[j], indexes[i]];
      }
      sessions.push({
        id: randomUUID(),
        assetIndexes: indexes.slice(0, count),
        ...(supportedAbis.length ? { supportedAbis } : {}),
        ...(config.execution.appOpen?.randomDeviceProfile ? { variantId } : {}),
      });
      left -= count;
    }
    plan.openPolicy!.sessions = sessions;
  }
  if (schemaIssues('DailyExecutionPlan', plan).length || devicePlanIssues(config, plan).length)
    fault('VALIDATION_FAILED', '执行计划无效', 422);
  return plan;
}
