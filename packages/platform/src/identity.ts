import type { TestConfiguration } from '@apk/contracts';
import { IDENTITY_MODELS, identitySupported, ownedTestSupported } from '@apk/contracts';
import { randomInt } from 'node:crypto';
import { fault } from './errors.js';

export function identityCapacity(health: unknown): number {
  const value = (health as { versions?: { identityModels?: string } } | null)?.versions
    ?.identityModels;
  return value && /^[0-3]$/.test(value) ? Number(value) : 0;
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
    if (attempts > identityCapacity(health))
      fault('IDENTITY_POOL_EXHAUSTED', '可用测试型号不足；当前每批最多 3 轮，请降低尝试上限', 422);
  }
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
