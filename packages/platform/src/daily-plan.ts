import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  isOwnedTestPackage,
  deviceVariant,
  devicePlanIssues,
  EXECUTION_DEVICE_LIMIT,
  executionCapacitySupported,
  knownAgentAtLeast,
  MAX_DAILY_OPEN_LIMIT,
} from '@apk/contracts';
import {
  assertIdentityReady,
  identityCapacity,
  allocateIdentityModels,
  readyDeviceVariants,
  readyDeviceAbis,
  groupedAssetAbiMatcher,
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
import { workbenchAssetIssue, workbenchAssets, workbenchScope } from './apk-workbench.js';

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
  resume?: { runId: string; cycleId: string },
): Promise<DailyExecutionPlan | null> {
  if (
    (input.resourceAction && input.purpose !== 'DOWNLOAD') ||
    (input.resourceAssets && input.purpose !== 'REGISTER')
  )
    fault('VALIDATION_FAILED', '工作台操作与任务类型不一致', 422);
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
  if (input.resourceAction) {
    if (input.purpose !== 'DOWNLOAD' || input.supersedesRunId || input.resourceAssets)
      fault('VALIDATION_FAILED', '工作台操作只接受独立的扫描或下载请求', 422);
    const scope = workbenchScope(input.nodeId, version);
    plan.resourceScope = scope.sourceKey;
    if (input.resourceAction.kind === 'SCAN') plan.resourceAction = input.resourceAction;
    else {
      const { targetKey, url } = input.resourceAction;
      const parsed = new URL(url);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password)
        fault('APK_LINK_INVALID', '请填写公网 HTTP(S) APK 下载地址', 422);
      const entry = await tx.apkWorkbenchEntry.findUnique({
        where: { nodeId_configId_sourceKey_targetKey: { ...scope, targetKey } },
      });
      if (!entry?.present) fault('APK_ENTRY_MISSING', '入口未找到，请重新扫描 XPath', 422);
      plan.resourceAction = {
        ...input.resourceAction,
        label: entry.label,
        cacheKey: randomBytes(32).toString('hex'),
      };
    }
    return plan;
  }
  if (
    input.resourceAssets &&
    (input.purpose !== 'REGISTER' || input.sourceDownloadId || !config.execution.appOpen)
  )
    fault('VALIDATION_FAILED', '工作台资源仅用于 APP 启动停留', 422);
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
          ...(config.execution.appOpen.appsPerDevice &&
          knownAgentAtLeast(identityNode.agentVersion, '0.17.2')
            ? { preserveQueue: true as const }
            : {}),
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
    if (resume) {
      const old = await tx.run.findUnique({
        where: { id: resume.runId },
        include: {
          tasks: { select: { position: true, attemptStarted: true } },
        },
      });
      const original = old?.executionPlan as unknown as DailyExecutionPlan | undefined;
      if (
        !old ||
        old.taskCycleId !== resume.cycleId ||
        old.nodeId !== input.nodeId ||
        old.configVersionId !== version.id ||
        old.sourceDownloadId !== (input.sourceDownloadId ?? null) ||
        old.status !== 'NEEDS_REVIEW' ||
        old.errorCode !== 'CLEANUP_INCOMPLETE' ||
        !old.reviewResolvedAt ||
        !old.cleanupConfirmedAt ||
        !old.stopRequested ||
        !old.discovered ||
        original?.cacheDay !== plan.cacheDay ||
        !original.openPolicy?.preserveQueue ||
        !original.openPolicy.sessions ||
        !plan.openPolicy?.preserveQueue ||
        old.tasks.length !== original.attemptLimit
      )
        fault('DEVICE_QUEUE_UNAVAILABLE', '原批次队列或清理回执不完整，暂停续跑', 409);
      const started = new Set(
        old.tasks.filter((task) => task.attemptStarted).map((task) => task.position),
      );
      let position = 0;
      const variants = readyDeviceVariants(identityNode.health);
      const abiCatalog = readyDeviceAbis(identityNode.health);
      const matchesAbi = groupedAssetAbiMatcher(variants, abiCatalog);
      const sessions = original.openPolicy.sessions.flatMap((session) => {
        const assetIndexes = session.assetIndexes.filter(() => !started.has(position++));
        if (!assetIndexes.length) return [];
        if (!session.variantId) return [{ ...session, assetIndexes }];
        const compatible = (id: string) =>
          assetIndexes.every((index) => {
            const apk = original.assets[index]?.apk;
            return (
              apk &&
              (apk.minSdkVersion ?? 1) <= deviceVariant(id)!.apiLevel &&
              matchesAbi(apk.abis, abiCatalog[id] ?? [], id)
            );
          });
        if (variants.includes(session.variantId) && compatible(session.variantId))
          return [{ ...session, assetIndexes, supportedAbis: abiCatalog[session.variantId] }];
        const replacements = variants.filter(compatible);
        if (!replacements.length)
          fault(
            'APP_OPEN_IMAGE_POOL_UNAVAILABLE',
            '剩余 APK 没有共同兼容的已验证 Android 14–16 档案',
            409,
          );
        const variantId = replacements[randomInt(replacements.length)];
        return [{ ...session, assetIndexes, variantId, supportedAbis: abiCatalog[variantId] }];
      });
      const remaining: DailyExecutionPlan = {
        ...original,
        successTarget: input.successTarget!,
        attemptLimit: input.attemptLimit!,
        openPolicy: {
          ...original.openPolicy,
          dailyLimit: plan.openPolicy.dailyLimit,
          resumeOf: old.id,
          sessions,
        },
      };
      if (
        schemaIssues('DailyExecutionPlan', remaining).length ||
        devicePlanIssues(config, remaining).length
      )
        fault('DEVICE_QUEUE_UNAVAILABLE', '原批次剩余队列与执行额度不一致，暂停续跑', 409);
      return remaining;
    }
    plan.successTarget = input.successTarget!;
    plan.attemptLimit = input.attemptLimit!;
    plan.proxySecretVersionId = config.execution.proxySecretVersionId;
    if (input.resourceAssets) {
      plan.resourceAssets = true;
      const { assets, oversized } = await workbenchAssets(tx, input.nodeId, version);
      if (!assets.length) {
        const { code, message } = workbenchAssetIssue(oversized);
        fault(code, message, 422);
      }
      plan.assets = assets;
    } else {
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
      if (
        original.source.url !== config.source.url ||
        original.source.xpath !== config.source.xpath
      )
        fault('DOWNLOAD_SOURCE_INVALID', '来源网站和 XPath 与下载批次不一致', 422);
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
      fault(
        'APK_SELECTION_UNAVAILABLE',
        plan.resourceAssets
          ? '所选 APK 文件不可用，请核对 APK 资源文件名'
          : '所选 APK 文件当天不可用，请核对缓存文件名',
        422,
      );
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
      const key = plan.resourceAssets
        ? a.apk.apkSha256
        : files
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
    const matchesAbi = groupedAssetAbiMatcher(variants, abiCatalog);
    const indexesFor = (api: number, supported: string[], id?: string) =>
      plan.assets.flatMap((asset, i) =>
        (asset.apk.minSdkVersion ?? 1) <= api && matchesAbi(asset.apk.abis, supported, id)
          ? [i]
          : [],
      );
    const variantAssets = new Map(
      variants.map((id) => [id, indexesFor(deviceVariant(id)!.apiLevel, abiCatalog[id] ?? [], id)]),
    );
    if (config.execution.appOpen?.randomDeviceProfile && variants.length < 2)
      fault('APP_OPEN_IMAGE_POOL_UNAVAILABLE', '缺少已验证的 Android 14–16 型号档案', 422);
    const sessions: NonNullable<NonNullable<DailyExecutionPlan['openPolicy']>['sessions']> = [];
    let left = plan.attemptLimit;
    let modelBag = variants.slice();
    while (left > 0) {
      const compatibleVariants = variants.filter(
        (id) =>
          id !== sessions.at(-1)?.variantId && (variantAssets.get(id)?.length ?? 0) >= required,
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
      const indexes = variantId
        ? [...(variantAssets.get(variantId) ?? [])]
        : indexesFor(api, supportedAbis);
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
