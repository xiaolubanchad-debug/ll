import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Query,
  Body,
  Headers,
  Req,
  HttpCode,
} from '@nestjs/common';
import {
  taskPlanList,
  taskPlanDetail,
  saveTaskPlan,
  controlTaskPlan,
  maintenanceList,
  maintenanceAction,
  keyRequired,
  ifMatch,
} from '@apk/platform';
import { Database } from './database.js';
import { uuid } from './p1-controllers.js';
import type { AuthedRequest } from './auth.js';
@Controller()
export class V18Controller {
  constructor(private readonly db: Database) {}
  @Get('task-plans') list(@Query() q: Record<string, unknown>) {
    return taskPlanList(this.db, q);
  }
  @Get('task-plans/:id') detail(@Param('id') id: string) {
    return taskPlanDetail(this.db, uuid(id));
  }
  @Post('task-plans') create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return saveTaskPlan(this.db, body, req.auth!.admin.id, req.requestId, keyRequired(key));
  }
  @Put('task-plans/:id') @HttpCode(200) update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return saveTaskPlan(
      this.db,
      body,
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
      uuid(id),
      ifMatch(version),
    );
  }
  @Post('task-plans/:id/control') @HttpCode(200) control(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') version: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return controlTaskPlan(
      this.db,
      uuid(id),
      body,
      ifMatch(version),
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
    );
  }
  @Get('maintenance/items') library(@Query() q: Record<string, unknown>) {
    return maintenanceList(this.db, q);
  }
  @Post('maintenance/actions') @HttpCode(200) maintain(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return maintenanceAction(this.db, body, req.auth!.admin.id, req.requestId, keyRequired(key));
  }
}
