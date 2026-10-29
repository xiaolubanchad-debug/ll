import {
  Body,
  Controller,
  Get,
  Post,
  Param,
  Headers,
  HttpCode,
  Req,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  createConfiguration,
  saveConfiguration,
  createRun,
  stopRun,
  claimRun,
  acceptRun,
  deliveryConfig,
  runEvents,
  reconcileAgent,
  reconcileRun,
  expireRuns,
  ifMatch,
  keyRequired,
  checked,
  fault,
} from '@apk/platform';
import { Database } from './database.js';
import { NodeRoute } from './auth.js';
import type { AuthedRequest } from './auth.js';
import { uuid } from './p1-controllers.js';
import { page, pageArgs } from './controllers.js';
@Controller()
export class P2Controller {
  constructor(private readonly db: Database) {}
  @Get('configs') async configs(@Query() query: Record<string, unknown>) {
    const { limit, ...args } = pageArgs(query);
    return page(
      await this.db.configuration.findMany({
        ...args,
        where: { archivedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          versions: {
            orderBy: { version: 'desc' },
            take: 1,
            select: { id: true, version: true, configHash: true, createdAt: true },
          },
        },
      }),
      limit,
    );
  }
  @Post('configs') createConfig(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return createConfiguration(this.db, body, req.auth!.admin.id, req.requestId, keyRequired(key));
  }
  @Get('configs/:id') async getConfig(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const value = await this.db.configuration.findUnique({ where: { id: uuid(id) } });
    if (!value) fault('NOT_FOUND', '配置不存在', 404);
    res.setHeader('ETag', `"${value.version}"`);
    return value;
  }
  @Get('configs/:id/versions') async versions(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    const { limit, ...args } = pageArgs(query);
    return page(
      await this.db.configVersion.findMany({
        ...args,
        where: { configId: uuid(id), archivedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, configId: true, version: true, configHash: true, createdAt: true },
      }),
      limit,
    );
  }
  @Post('configs/:id/versions') saveVersion(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return saveConfiguration(
      this.db,
      uuid(id),
      body,
      ifMatch(version),
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
    );
  }
  @Get('configs/:id/versions/:versionId') async version(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    const value = await this.db.configVersion.findFirst({
      where: { id: uuid(versionId), configId: uuid(id) },
    });
    if (!value) fault('NOT_FOUND', '配置版本不存在', 404);
    return value;
  }
  @Post('runs') @HttpCode(202) createRun(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return createRun(this.db, body, req.auth!.admin.id, req.requestId, keyRequired(key));
  }
  @Get('runs/:id') async run(@Param('id') id: string) {
    await expireRuns(this.db);
    const run = await this.db.run.findUnique({
      where: { id: uuid(id) },
      include: { delivery: true, _count: { select: { tasks: true } } },
    });
    if (!run) fault('NOT_FOUND', '批次不存在', 404);
    return run;
  }
  @Get('runs/:id/tasks') async tasks(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    const { limit, ...args } = pageArgs(query);
    return page(
      await this.db.task.findMany({
        ...args,
        where: { runId: uuid(id) },
        orderBy: [{ position: 'asc' }, { id: 'asc' }],
        include: { reviews: { orderBy: { createdAt: 'desc' }, take: 1 } },
      }),
      limit,
    );
  }
  @Get('runs/:id/events') async events(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    uuid(id);
    if (Object.keys(query).some((k) => !['afterSequence', 'limit'].includes(k)))
      fault('VALIDATION_FAILED', '参数无效', 422);
    const after = Number(query.afterSequence ?? 0),
      limit = Number(query.limit ?? 100);
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fault('VALIDATION_FAILED', '参数无效', 422);
    return {
      items: await this.db.runEvent.findMany({
        where: { delivery: { runId: id }, sequence: { gt: after } },
        orderBy: { sequence: 'asc' },
        take: limit,
        select: { id: true, sequence: true, body: true, recordedForReview: true, createdAt: true },
      }),
    };
  }
  @Post('runs/:id/stop') @HttpCode(202) stop(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    checked('ReasonInput', body);
    return stopRun(this.db, uuid(id), body, req.auth!.admin.id, req.requestId, keyRequired(key));
  }
  @Post('runs/:id/reconciliations') @HttpCode(200) reconcile(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    checked('RunReconcileInput', body);
    return reconcileRun(
      this.db,
      uuid(id),
      body,
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
    );
  }
}
@NodeRoute()
@Controller('agent')
export class P2AgentController {
  constructor(private readonly db: Database) {}
  @Post('claims') @HttpCode(200) async claim(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await claimRun(this.db, req.nodeToken!, body);
    if (!result) res.status(204);
    return result ?? undefined;
  }
  @Post('deliveries/:id/accept') @HttpCode(200) accept(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    return acceptRun(this.db, req.nodeToken!, uuid(id), body);
  }
  @Post('deliveries/:id/config') @HttpCode(200) config(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    return deliveryConfig(this.db, req.nodeToken!, uuid(id), body);
  }
  @Post('events') @HttpCode(200) events(@Body() body: unknown, @Req() req: AuthedRequest) {
    return runEvents(this.db, req.nodeToken!, body);
  }
  @Post('reconcile') @HttpCode(200) reconcile(@Body() body: unknown, @Req() req: AuthedRequest) {
    return reconcileAgent(this.db, req.nodeToken!, body);
  }
}
