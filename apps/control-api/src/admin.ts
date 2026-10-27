/* eslint-disable preserve-caught-error -- Replace database errors so connection details cannot escape through CLI errors. */
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { loginIssues } from '@apk/contracts';
import { randomUUID } from 'node:crypto';
import { passwordHash } from './auth.js';
export async function initializeAdmin(db: PrismaClient, username: string, password: string) {
  if (loginIssues({ username, password }).length || [...password].length < 12)
    throw new Error('用户名需为3–64位字母、数字或._-；管理员密码需为12–128位');
  const encoded = await passwordHash(password);
  try {
    return await db.$transaction(async (tx) => {
      const admin = await tx.admin.create({
        data: { username: username.toLowerCase(), passwordHash: encoded },
        select: { id: true, username: true },
      });
      await tx.auditEvent.create({
        data: { adminId: admin.id, action: 'ADMIN_INITIALIZED', requestId: randomUUID() },
      });
      return admin;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw new Error('超级管理员已存在，初始化命令不会覆盖现有密码');
    throw new Error('管理员初始化失败，请检查数据库迁移和连接');
  }
}
