import { Body, Controller, Get, HttpCode, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { readFileSync } from 'node:fs';
import { configurationIssues, loginIssues, passwordChangeIssues } from '@apk/contracts';
import type { LoginInput, PasswordChangeInput } from '@apk/contracts';
import { AuthService, COOKIE, Public, sessionView } from './auth.js';
import type { AuthedRequest } from './auth.js';
import { Database } from './database.js';
import { settings } from './settings.js';
import { ApiError, validated } from './errors.js';
import { expireRuns } from '@apk/platform';

const cookieOptions = () => ({
  httpOnly: true,
  secure: settings().secureCookie,
  sameSite: 'strict' as const,
  path: '/',
});
function setSession(res: Response, token: string) {
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: 12 * 60 * 60 * 1000 });
}
export function pageArgs(query: Record<string, unknown>) {
  if (Object.keys(query).some((k) => !['limit', 'cursor'].includes(k)))
    throw new ApiError(422, 'VALIDATION_FAILED', '列表参数无效');
  const limit = query.limit === undefined ? 20 : Number(query.limit),
    cursor = query.cursor;
  if (
    (query.limit !== undefined && typeof query.limit !== 'string') ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== undefined &&
      (typeof cursor !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(cursor)))
  )
    throw new ApiError(422, 'VALIDATION_FAILED', '分页参数无效');
  return {
    take: limit + 1,
    limit,
    ...(typeof cursor === 'string' ? { cursor: { id: cursor }, skip: 1 } : {}),
  };
}
export function page<T extends { id: string }>(items: T[], limit: number) {
  return {
    items: items.slice(0, limit),
    nextCursor: items.length > limit ? items[limit - 1].id : null,
  };
}

@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}
  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = validated<LoginInput>(body, loginIssues);
    const result = await this.service.login(
      input.username,
      input.password,
      req.ip ?? 'unknown',
      req.requestId,
    );
    setSession(res, result.token);
    return result.view;
  }
  @Get('me') me(@Req() req: AuthedRequest) {
    return sessionView(req.auth!.admin, req.auth!.token);
  }
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (
      body !== undefined &&
      (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
    )
      throw new ApiError(422, 'VALIDATION_FAILED', '退出请求不接受额外字段');
    await this.service.logout(req.auth!, req.requestId);
    res.clearCookie(COOKIE, cookieOptions());
  }
  @Put('password')
  async password(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = validated<PasswordChangeInput>(body, passwordChangeIssues);
    const result = await this.service.changePassword(
      req.auth!,
      input.currentPassword,
      input.newPassword,
      req.requestId,
    );
    setSession(res, result.token);
    return result.view;
  }
}

@Controller()
export class ConsoleController {
  constructor(private readonly db: Database) {}
  @Get('runs') async runs(@Query() query: Record<string, unknown>) {
    await expireRuns(this.db);
    const { limit, ...args } = pageArgs(query);
    return page(
      await this.db.run.findMany({
        ...args,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, nodeId: true, status: true, createdAt: true },
      }),
      limit,
    );
  }
  @Get('audit-events') async audit(@Query() query: Record<string, unknown>) {
    const { limit, ...args } = pageArgs(query);
    return page(
      await this.db.auditEvent.findMany({
        ...args,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, action: true, createdAt: true },
      }),
      limit,
    );
  }
  @Post('configs/validate')
  @HttpCode(200)
  validateConfig(@Body() body: unknown) {
    validated(body, configurationIssues);
    return { valid: true };
  }
  @Get('openapi.json') openapi() {
    return JSON.parse(
      readFileSync(new URL('../../../contracts/openapi.json', import.meta.url), 'utf8'),
    ) as unknown;
  }
  @Public() @Get('health/live') live() {
    return { status: 'ok' };
  }
  @Public() @Get('health/ready') async ready(@Req() req: AuthedRequest) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? ''))
      throw new ApiError(403, 'INTERNAL_ONLY', '仅供本机健康检查');
    try {
      await this.db.admin.count();
      return { status: 'ready' };
    } catch {
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', '数据库或迁移暂不可用');
    }
  }
}
