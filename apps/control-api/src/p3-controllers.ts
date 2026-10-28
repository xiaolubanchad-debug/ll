import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Param,
  Req,
  Res,
  Headers,
  HttpCode,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  storeAccount,
  uploadArtifact,
  viewAccount,
  artifactContent,
  reconcileTask,
  keyRequired,
} from '@apk/platform';
import { NodeRoute } from './auth.js';
import type { AuthedRequest } from './auth.js';
import { Database } from './database.js';
import { uuid } from './p1-controllers.js';

@NodeRoute()
@Controller('agent')
export class P3AgentController {
  constructor(private readonly db: Database) {}
  @Put('tasks/:taskId/account') @HttpCode(200) account(
    @Param('taskId') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    return storeAccount(this.db, req.nodeToken!, uuid(id), body);
  }
  @Post('artifacts') @HttpCode(200) artifact(@Body() body: unknown, @Req() req: AuthedRequest) {
    return uploadArtifact(this.db, req.nodeToken!, body);
  }
}
@Controller()
export class P3Controller {
  constructor(private readonly db: Database) {}
  @Get('tasks/:taskId/artifacts') async artifacts(@Param('taskId') id: string) {
    return {
      items: await this.db.artifact.findMany({
        where: { taskId: uuid(id) },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kind: true,
          sha256: true,
          bytes: true,
          recordedForReview: true,
          createdAt: true,
        },
      }),
    };
  }
  @Get('artifacts/:artifactId/content') async content(
    @Param('artifactId') id: string,
    @Res() res: Response,
  ) {
    const bytes = await artifactContent(this.db, uuid(id));
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'inline; filename="screenshot.png"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(bytes);
  }
  @Post('tasks/:taskId/account-view') @HttpCode(200) account(
    @Param('taskId') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    return viewAccount(this.db, uuid(id), body, req.auth!.admin.id, req.requestId);
  }
  @Post('tasks/:taskId/reconciliations') @HttpCode(200) review(
    @Param('taskId') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return reconcileTask(
      this.db,
      uuid(id),
      body,
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
    );
  }
}
