import { randomInt, randomUUID } from 'node:crypto';
import {
  isOwnedTestPackage,
  deviceVariant,
  devicePlanIssues,
  EXECUTION_DEVICE_LIMIT,
  executionCapacitySupported,
  MAX_DAILY_OPEN_LIMIT,
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
import {
  schemaIssues,
  registrationAvailable,
  apkMetadataOnlySupported,
  apkFileAssetsSupported,
} from '@apk/contracts';
import { digest, canonical } from './security.js';
import { manualAssetsForRun, assertNoPendingManualApks } from './manual-apks.js';
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
export function validateBudget(n: number, m: number, maximum = 1000) {
  if (!Number.isInteger(n) || !Number.isInteger(m) || n < 1 || m < n || m > maximum)
    fault(
      'VALIDATION_FAILED',
      '目标和尝试上限需为 1–' + maximum + ' 的整数，且尝试上限不小于完成目标',
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
    validateBudget(
      input.successTarget!,
      input.attemptLimit!,
      config.execution.appOpen ? MAX_DAILY_OPEN_LIMIT : 1000,
    );
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
      const budget = await dailyOpenUsage(tx, input.nodeId, plan.cacheDay, config);
      if (input.attemptLimit! > budget.remaining)
        fault('DAILY_OPEN_LIMIT', '当日剩余执行额度不足，请降低目标和尝试上限', 422);
      if (config.execution.appOpen.concurrency !== undefined) {
        const deadline = openAdmissionDeadline(plan.cacheDay);
        if (now.getTime() >= Date.parse(deadline))
          fault('DAY_CUTOFF', '今日停止新增轮次，请等待次日下载', 422);
        plan.openPolicy = {
          concurrency: EXECUTION_DEVICE_LIMIT,
          dailyLimit: budget.limit,
          ...(executionCapacitySupported(
            (identityRelease?.manifest as { features?: string[] } | null)?.features,
            identityNode.agentVersion,
          )
            ? { capacityVersion: 1 as const }
            : {}),
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
      !['SUCCEEDED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED'].includes(source.status) ||
      source.configVersion?.configId !== version.configId
    )
      fault('DOWNLOAD_SOURCE_INVALID', '请选择本服务器、本配置当天已结束的下载批次', 422);
    const original = source.configVersion.body as unknown as TestConfiguration;
    await assertNoPendingManualApks(tx, input.nodeId, version.configId);
    const manual = new Map((await manualAssetsForRun(tx, source.id)).map((m) => [m.taskId, m]));
    if (!['SUCCEEDED', 'PARTIAL_FAILED'].includes(source.status) && !manual.size)
      fault('DOWNLOAD_SOURCE_INVALID', '下载失败且尚无已确认的补包', 422);
    if (original.source.url !== config.source.url || original.source.xpath !== config.source.xpath)
      fault('DOWNLOAD_SOURCE_INVALID', '来源网站和 XPath 与下载批次不一致', 422);
    plan.successTarget = input.successTarget!;
    plan.attemptLimit = input.attemptLimit!;
    plan.proxySecretVersionId = config.execution.proxySecretVersionId;
    for (const task of source.tasks) {
      const candidate = task.status === 'SUCCEEDED' ? task.apk : manual.get(task.id)?.apk;
      if (schemaIssues('ApkMetadata', candidate).length) continue;
      const apk = candidate as unknown as DailyExecutionPlan['assets'][number]['apk'];
      if (!config.execution.appOpen && !apk.packageName) continue;
      if (apk.cacheDay !== plan.cacheDay)
        fault('DOWNLOAD_SOURCE_INVALID', '文件日期与当天批次不一致', 422);
      if (!registrationAvailable(config, apk.packageName ?? '', task.entryId ?? undefined))
        continue;
      if (
        config.execution.appOpen?.ownedTestClient &&
        apk.packageName &&
        !isOwnedTestPackage(apk.packageName)
      )
        continue;
      plan.assets.push({
        targetKey: task.targetKey,
        label: task.label,
        sourceUrl: task.sourceUrl,
        apk:
          config.execution.appOpen &&
          !apk.fileName &&
          apkFileAssetsSupported(
            (identityRelease?.manifest as { features?: string[] } | null)?.features,
            identityNode.agentVersion,
          )
            ? { ...apk, fileName: 'history-' + task.targetKey.slice(0, 12) + '.apk' }
            : apk,
        ...(task.entryId ? { entryId: task.entryId } : {}),
      });
    }
    if (
      plan.assets.some((a) => a.apk.validationPolicy === 'FILE_NAME') &&
      !apkFileAssetsSupported(
        (identityRelease?.manifest as { features?: string[] } | null)?.features,
        identityNode.agentVersion,
      )
    )
      fault('NODE_UPGRADE_REQUIRED', '文件名资产需要 Agent 0.16.0', 422);
    if (
      plan.assets.some((a) => a.apk.validationPolicy === 'ANDROID_INSTALL') &&
      !apkMetadataOnlySupported(
        (identityRelease?.manifest as { features?: string[] } | null)?.features,
        identityNode.agentVersion,
      )
    )
      fault('NODE_UPGRADE_REQUIRED', '请先更新到支持 Android 安装判定的 Agent 0.15.1', 422);
  }
  const selectedFiles = config.execution.appOpen?.assetFileNames;
  if (plan.purpose === 'REGISTER' && selectedFiles?.length) {
    const names = new Set(selectedFiles.map((name) => name.toLowerCase()));
    plan.assets = plan.assets.filter((asset) =>
      names.has(
        (asset.apk.fileName ?? 'history-' + asset.targetKey.slice(0, 12) + '.apk').toLowerCase(),
      ),
    );
    if (
      [...names].some(
        (name) =>
          !plan.assets.some(
            (a) =>
              (a.apk.fileName ?? 'history-' + a.targetKey.slice(0, 12) + '.apk').toLowerCase() ===
              name,
          ),
      )
    )
      fault('APK_SELECTION_UNAVAILABLE', '所选 APK 文件当天不可用，请核对缓存文件名', 422);
  }
  const groupPolicy = config.execution.appOpen?.appsPerDevice;
  if (groupPolicy && plan.purpose === 'REGISTER') {
    const nodeForFiles = await tx.node.findUniqueOrThrow({ where: { id: input.nodeId } });
    const fileRelease = nodeForFiles.agentReleaseId
      ? await tx.release.findUnique({ where: { id: nodeForFiles.agentReleaseId } })
      : null;
    const files = apkFileAssetsSupported(
      (fileRelease?.manifest as { features?: string[] } | null)?.features,
      nodeForFiles.agentVersion,
    );
    if (files) plan.openPolicy!.fileAssets = true;
    else plan.assets = plan.assets.filter((a) => a.apk.minSdkVersion !== undefined);
    const seen = new Set<string>();
    plan.assets = plan.assets.filter((a) => {
      const key = files
        ? (a.apk.fileName?.toLowerCase() ?? a.targetKey)
        : (a.apk.packageName ?? a.targetKey);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const dynamic = plan.openPolicy?.capacityVersion === 1;
    const required = dynamic ? groupPolicy.min : groupPolicy.max;
    if (plan.assets.length < required)
      fault('APK_POOL_INSUFFICIENT', '可用 APK 文件数量不足，请降低每台设备安装数量', 422);
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
          ).length >= required,
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
      if (indexes.length < required) fault('APK_POOL_INSUFFICIENT', '兼容 APK 数量不足', 422);
      const count = Math.min(
        left,
        randomInt(groupPolicy.min, Math.min(groupPolicy.max, indexes.length) + 1),
      );
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
