import type { TestConfiguration } from '@apk/contracts';
import {
  IDENTITY_MODELS,
  identitySupported,
  ownedTestSupported,
  deviceSessionsSupported,
  deviceVariant,
} from '@apk/contracts';
import { randomInt } from 'node:crypto';
import { fault } from './errors.js';

export function identityCapacity(health: unknown): number {
  const value = (health as { versions?: { identityModels?: string } } | null)?.versions
    ?.identityModels;
  return value && /^([0-9]|[12][0-9]|30)$/.test(value) ? Number(value) : 0;
}
export function assertIdentityReady(
  config: TestConfiguration,
  features: readonly string[] | undefined,
  version: string | null,
  health: unknown,
  attempts: number,
) {
  if (config.execution.appOpen?.randomDeviceProfile) {
    if (!identitySupported(features, version))
      fault('NODE_UPGRADE_REQUIRED', '测试型号需要 Agent 0.12.0', 422);
    if (!config.execution.appOpen.appsPerDevice && attempts > Math.min(3, identityCapacity(health)))
      fault('IDENTITY_POOL_EXHAUSTED', '可用测试型号不足；当前每批最多 3 轮，请降低尝试上限', 422);
  }
  if (config.execution.appOpen?.appsPerDevice && !deviceSessionsSupported(features, version))
    fault('NODE_UPGRADE_REQUIRED', '多 APP 设备会话需要 Agent 0.13.0', 422);
  if (config.execution.appOpen?.ownedTestClient && !ownedTestSupported(features, version))
    fault('NODE_UPGRADE_REQUIRED', '自有测试 APK 需要 Agent 0.12.0', 422);
}
export function allocateIdentityModels(count: number, capacity: number): string[] {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    count > capacity ||
    capacity > IDENTITY_MODELS.length
  )
    fault('IDENTITY_POOL_EXHAUSTED', '本批次可用测试型号不足', 422);
  const pool: string[] = IDENTITY_MODELS.slice(0, capacity);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

export function readyDeviceVariants(health: unknown): string[] {
  try {
    const text = (health as { versions?: { identityCatalog?: string } }).versions?.identityCatalog;
    const ids: unknown = JSON.parse(text ?? '[]');
    return Array.isArray(ids) &&
      ids.every((x) => typeof x === 'string' && deviceVariant(x)) &&
      new Set(ids).size === ids.length
      ? ids
      : [];
  } catch {
    return [];
  }
}

export function readyDeviceAbis(health: unknown): Record<string, string[]> {
  try {
    const text = (health as { versions?: { identityAbis?: string } }).versions?.identityAbis;
    const value: unknown = JSON.parse(text ?? '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') return {};
    const result: Record<string, string[]> = {};
    for (const [id, abis] of Object.entries(value)) {
      if (
        !deviceVariant(id) ||
        !Array.isArray(abis) ||
        !abis.length ||
        abis.length > 8 ||
        abis.some((a) => typeof a !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(a))
      )
        return {};
      result[id] = abis;
    }
    return result;
  } catch {
    return {};
  }
}
