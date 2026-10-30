import { Injectable, CanActivate, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Admin, Prisma, Session } from '@prisma/client';
import type { SessionView } from '@apk/contracts';
import { Database } from './database.js';
import { ApiError } from './errors.js';
import { settings } from './settings.js';

export const COOKIE = 'apk_session';
export const Public = () => SetMetadata('public', true);
export const NodeRoute = () => SetMetadata('nodeRoute', true);
export const TestAppRoute = () => SetMetadata('testAppRoute', true);
export interface AuthedRequest extends Request {
  requestId: string;
  nodeToken?: string;
  testAppToken?: string;
  auth?: { admin: Admin; session: Session; token: string };
}
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const passwordHash = (text: string) =>
  hash(text, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  });
export const sessionView = (admin: Admin, token: string): SessionView => ({
  admin: { id: admin.id, username: admin.username, role: 'SUPER_ADMIN' as const },
  csrfToken: createHmac('sha256', settings().csrfKey).update(token).digest('hex'),
});

@Injectable()
export class AuthService {
  private dummyHash = '';
  constructor(private readonly db: Database) {}
  async onModuleInit() {
    this.dummyHash = await passwordHash(randomBytes(32).toString('base64'));
  }
  private async rateLimit(username: string, ip: string) {
    const now = new Date();
    for (const [suffix, max] of [
      [username, settings().loginMaxAttempts],
      ['*', settings().loginMaxAttempts * 5],
    ] as const) {
      const key = digest(ip + '\0' + suffix);
      const rows = await this.db.$queryRaw<{ attempts: number }[]>`
        INSERT INTO "LoginBucket" ("key","windowStart","attempts") VALUES (${key},${now},1)
        ON CONFLICT ("key") DO UPDATE SET
          "attempts"=CASE WHEN "LoginBucket"."windowStart" < ${new Date(now.getTime() - 900000)} THEN 1 ELSE "LoginBucket"."attempts"+1 END,
          "windowStart"=CASE WHEN "LoginBucket"."windowStart" < ${new Date(now.getTime() - 900000)} THEN ${now} ELSE "LoginBucket"."windowStart" END
        RETURNING "attempts"`;
      if (rows[0].attempts > max)
        throw new ApiError(429, 'LOGIN_RATE_LIMITED', '登录尝试过于频繁，请稍后再试');
    }
  }
  private async createSession(tx: Prisma.TransactionClient, admin: Admin) {
    const token = randomBytes(32).toString('base64url');
    const session = await tx.session.create({
      data: {
        adminId: admin.id,
        tokenHash: digest(token),
        credentialVersion: admin.credentialVersion,
        expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
      },
    });
    return { token, session, view: sessionView(admin, token) };
  }
  async login(username: string, password: string, ip: string, requestId: string) {
    const normalized = username.toLowerCase();
    await this.rateLimit(normalized, ip);
    const admin = await this.db.admin.findUnique({ where: { username: normalized } });
    const ok = await verify(admin?.passwordHash ?? this.dummyHash, password);
    if (!admin || !ok) {
      await this.db.auditEvent.create({ data: { action: 'LOGIN_FAILED', requestId } });
      throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确');
    }
    return this.db.$transaction(async (tx) => {
      const current = await tx.$queryRaw<
        Admin[]
      >`SELECT * FROM "Admin" WHERE "id"=${admin.id}::uuid FOR UPDATE`;
      if (current[0]?.passwordHash !== admin.passwordHash)
        throw new ApiError(401, 'INVALID_CREDENTIALS', '用户名或密码不正确');
      const result = await this.createSession(tx, current[0]);
      await tx.auditEvent.create({
        data: { adminId: admin.id, action: 'LOGIN_SUCCEEDED', requestId },
      });
      return result;
    });
  }
  async authenticate(token: unknown) {
    if (typeof token !== 'string' || !/^[-_a-zA-Z0-9]{43}$/.test(token))
      throw new ApiError(401, 'UNAUTHENTICATED', '请先登录');
    const session = await this.db.session.findUnique({
      where: { tokenHash: digest(token) },
      include: { admin: true },
    });
    if (
      !session ||
      session.revokedAt ||
      session.expiresAt.getTime() <= Date.now() ||
      session.credentialVersion !== session.admin.credentialVersion
    )
      throw new ApiError(401, 'UNAUTHENTICATED', '登录已失效，请重新登录');
    return { session, admin: session.admin, token };
  }
  async logout(auth: NonNullable<AuthedRequest['auth']>, requestId: string) {
    await this.db.$transaction([
      this.db.session.update({ where: { id: auth.session.id }, data: { revokedAt: new Date() } }),
      this.db.auditEvent.create({ data: { adminId: auth.admin.id, action: 'LOGOUT', requestId } }),
    ]);
  }
  async changePassword(
    auth: NonNullable<AuthedRequest['auth']>,
    currentPassword: string,
    newPassword: string,
    requestId: string,
  ) {
    if (currentPassword === newPassword)
      throw new ApiError(422, 'VALIDATION_FAILED', '新密码不能与当前密码相同');
    const encoded = await passwordHash(newPassword);
    return this.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          Admin[]
        >`SELECT * FROM "Admin" WHERE "id"=${auth.admin.id}::uuid FOR UPDATE`;
        const current = rows[0];
        if (
          !current ||
          current.credentialVersion !== auth.session.credentialVersion ||
          !(await verify(current.passwordHash, currentPassword))
        )
          throw new ApiError(401, 'INVALID_CREDENTIALS', '当前密码不正确或会话已失效');
        const admin = await tx.admin.update({
          where: { id: current.id },
          data: { passwordHash: encoded, credentialVersion: { increment: 1 } },
        });
        await tx.session.updateMany({
          where: { adminId: admin.id, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        const result = await this.createSession(tx, admin);
        await tx.auditEvent.create({
          data: { adminId: admin.id, action: 'PASSWORD_CHANGED', requestId },
        });
        return result;
      },
      { timeout: 15000 },
    );
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (
      this.reflector.getAllAndOverride<boolean>('testAppRoute', [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      const token = req.get('authorization')?.match(/^Bearer ([-_A-Za-z0-9]{43})$/)?.[1];
      if (!token) throw new ApiError(401, 'UNAUTHENTICATED', '需要本轮测试凭据');
      if (!req.is('application/json')) throw new ApiError(400, 'JSON_REQUIRED', '请使用 JSON 请求');
      req.testAppToken = token;
      return true;
    }
    if (
      this.reflector.getAllAndOverride<boolean>('nodeRoute', [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      const token = req.get('authorization')?.match(/^Bearer ([-_A-Za-z0-9]{43})$/)?.[1];
      if (!token) throw new ApiError(401, 'UNAUTHENTICATED', '需要节点身份');
      if (!req.is('application/json')) throw new ApiError(400, 'JSON_REQUIRED', '请使用 JSON 请求');
      req.nodeToken = token;
      return true;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('origin') !== settings().origin || req.get('sec-fetch-site') === 'cross-site')
        throw new ApiError(403, 'CSRF_REJECTED', '请求来源校验失败');
      if (!req.is('application/json')) throw new ApiError(400, 'JSON_REQUIRED', '请使用 JSON 请求');
    }
    if (
      this.reflector.getAllAndOverride<boolean>('public', [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    req.auth = await this.auth.authenticate((req.cookies as Record<string, unknown>)[COOKIE]);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const actual = req.get('x-csrf-token') ?? '';
      const expected = sessionView(req.auth.admin, req.auth.token).csrfToken;
      if (
        !/^[a-f0-9]{64}$/.test(actual) ||
        !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
      )
        throw new ApiError(403, 'CSRF_REJECTED', '请求校验已失效，请刷新页面');
    }
    return true;
  }
}
