import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Headers,
  Req,
  Query,
  HttpCode,
  Injectable,
} from '@nestjs/common';
import type { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { saveSchedule, tickSchedules, expireRuns, keyRequired, ifMatch } from '@apk/platform';
import { Database } from './database.js';
import type { AuthedRequest } from './auth.js';
import { uuid } from './p1-controllers.js';
import { page, pageArgs } from './controllers.js';

@Controller()
export class V15Controller {
  constructor(private readonly db: Database) {}
  @Get('schedules') async schedules(@Query() query: Record<string, unknown>) {
    const { limit, ...args } = pageArgs(query);
    return page(
      await this.db.dailySchedule.findMany({
        ...args,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      limit,
    );
  }
  @Post('schedules') @HttpCode(201) createSchedule(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return saveSchedule(this.db, body, req.auth!.admin.id, req.requestId, keyRequired(key));
  }
  @Put('schedules/:id') @HttpCode(200) updateSchedule(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return saveSchedule(
      this.db,
      body,
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
      uuid(id),
      ifMatch(version),
    );
  }
  @Get('schedules/:id/days') async scheduleDays(
    @Param('id') id: string,
    @Query() query: Record<string, unknown>,
  ) {
    const { limit, ...args } = pageArgs(query);
    return page(
      await this.db.dailyOccurrence.findMany({
        ...args,
        where: { scheduleId: uuid(id) },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      limit,
    );
  }
}
@Injectable()
export class DailyScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;
  constructor(private readonly db: Database) {}
  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    const tick = () => {
      if (!this.running)
        this.running = expireRuns(this.db)
          .then(() => tickSchedules(this.db))
          .catch(() => {
            console.error('每日计划检查暂未完成');
          })
          .finally(() => {
            this.running = undefined;
          });
    };
    this.timer = setInterval(tick, 15000);
    tick();
  }
  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.running;
  }
}
