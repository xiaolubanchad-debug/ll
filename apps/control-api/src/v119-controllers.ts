import { Controller, Get, Post, Put, Param, Body, Req, Headers, HttpCode } from '@nestjs/common';
import {
  createManualApk,
  receiveManualApk,
  retryManualApk,
  cancelManualApk,
  manualApkView,
  fault,
  keyRequired,
} from '@apk/platform';
import { BinaryUpload } from './auth.js';
import type { AuthedRequest } from './auth.js';
import { Database } from './database.js';
import { uuid } from './p1-controllers.js';

@Controller()
export class V119Controller {
  constructor(private readonly db: Database) {}
  @Post('apk-assets/:id/uploads') @HttpCode(201) create(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return createManualApk(
      this.db,
      uuid(id),
      body,
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
    );
  }
  @Get('apk-uploads/:id') async status(@Param('id') id: string) {
    const row = await this.db.manualApkUpload.findUnique({ where: { id: uuid(id) } });
    if (!row) fault('NOT_FOUND', '上传会话不存在', 404);
    return manualApkView(row);
  }
  @BinaryUpload() @Put('apk-uploads/:id/file') @HttpCode(200) file(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ) {
    return receiveManualApk(this.db, uuid(id), req, req.auth!.admin.id, req.requestId);
  }
  @Post('apk-uploads/:id/retry') @HttpCode(200) retry(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return retryManualApk(
      this.db,
      uuid(id),
      body,
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
    );
  }
  @Post('apk-uploads/:id/cancel') @HttpCode(200) cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return cancelManualApk(
      this.db,
      uuid(id),
      body,
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
    );
  }
}
