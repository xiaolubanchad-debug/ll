import { Prisma } from '@prisma/client';
import type { PrismaClient, Prisma as P } from '@prisma/client';
import { configurationIssues } from '@apk/contracts';
import type { TestConfiguration, ConfigInput } from '@apk/contracts';
import { checked, readSecret } from './secrets.js';
import { canonical, digest } from './security.js';
import { idempotent } from './jobs.js';
import { fault } from './errors.js';
export function configBody(body: unknown): TestConfiguration {
  if (configurationIssues(body).length) fault('VALIDATION_FAILED', '测试配置不符合要求', 422);
  return body as TestConfiguration;
}
export async function configSecrets(tx: P.TransactionClient, body: TestConfiguration) {
  if (body.execution.proxySecretVersionId)
    await readSecret(tx, body.execution.proxySecretVersionId, ['HTTP_PROXY']);
}
export async function createConfiguration(
  db: PrismaClient,
  body: unknown,
  actor: string,
  requestId: string,
  key: string,
) {
  const input = checked<ConfigInput>('ConfigInput', body);
  return idempotent(db, actor, 'POST:/configs', key, input, async (tx) => {
    const config = await tx.configuration.create({ data: input });
    await tx.auditEvent.create({ data: { adminId: actor, action: 'CONFIG_CREATED', requestId } });
    return config;
  });
}
export async function saveConfiguration(
  db: PrismaClient,
  id: string,
  body: unknown,
  version: number,
  actor: string,
  requestId: string,
  key: string,
) {
  const input = configBody(body);
  return idempotent(
    db,
    actor,
    'POST:/configs/' + id + '/versions',
    key,
    { input, version },
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Configuration" WHERE "id"=${id}::uuid FOR UPDATE`;
      const config = await tx.configuration.findUnique({ where: { id } });
      if (!config) fault('NOT_FOUND', '配置不存在', 404);
      if (config.version !== version) fault('STALE_VERSION', '配置已有新版本，请刷新');
      await configSecrets(tx, input);
      const saved = await tx.configVersion.create({
        data: {
          configId: id,
          version: config.version,
          body: input as unknown as Prisma.InputJsonValue,
          configHash: digest(canonical(input)),
          createdBy: actor,
        },
      });
      await tx.configuration.update({ where: { id }, data: { version: { increment: 1 } } });
      await tx.auditEvent.create({
        data: { adminId: actor, action: 'CONFIG_VERSION_SAVED', requestId },
      });
      return saved;
    },
  );
}
