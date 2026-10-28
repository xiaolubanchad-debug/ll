import { randomUUID } from 'node:crypto';
import type { PrismaClient, Prisma } from '@prisma/client';
import { schemaIssues } from '@apk/contracts';
import type { SecretInput } from '@apk/contracts';
import ssh2 from 'ssh2';
const { utils } = ssh2;
import { encrypt, decrypt } from './security.js';
import { fault } from './errors.js';
export function checked<T>(name: Parameters<typeof schemaIssues>[0], input: unknown): T {
  if (schemaIssues(name, input).length) fault('VALIDATION_FAILED', '输入内容不符合要求', 422);
  return input as T;
}
export async function createSecret(
  db: PrismaClient,
  body: unknown,
  adminId: string,
  requestId: string,
) {
  const input = checked<SecretInput>('SecretInput', body);
  if (input.type === 'SSH_KEY') {
    const key = utils.parseKey(input.secretValue.privateKey!, input.secretValue.passphrase);
    if (key instanceof Error || Array.isArray(key) || !key.isPrivateKey())
      fault('SSH_KEY_INVALID', '私钥或私钥口令无效', 422);
  }
  const id = randomUUID();
  const encrypted = encrypt(input.secretValue, `secret:${id}:${input.type}:v1`);
  return db.$transaction(async (tx) => {
    const result = await tx.secretVersion.create({
      data: {
        id,
        type: input.type,
        name: input.name ?? null,
        encrypted: encrypted as unknown as Prisma.InputJsonValue,
        keyId: 'local-v1',
        createdBy: adminId,
      },
      select: { id: true, type: true, name: true, createdAt: true, revokedAt: true },
    });
    await tx.auditEvent.create({ data: { adminId, action: 'SECRET_CREATED', requestId } });
    return result;
  });
}
export async function readSecret(
  db: PrismaClient | Prisma.TransactionClient,
  id: string,
  types: string[],
) {
  const secret = await db.secretVersion.findUnique({ where: { id } });
  if (!secret || secret.revokedAt) fault('SECRET_REVOKED', '凭据不存在或已吊销', 410);
  if (!types.includes(secret.type)) fault('VALIDATION_FAILED', '凭据类型不匹配', 422);
  return decrypt(secret.encrypted, `secret:${secret.id}:${secret.type}:v1`) as {
    privateKey?: string;
    passphrase?: string;
    password?: string;
    host?: string;
    port?: number;
    username?: string;
  };
}
