import { Body, Controller, Get, Post, Put, Param, Query, Req, Res, HttpCode } from '@nestjs/common';
import type { Response } from 'express';
import {
  testDataPage,
  viewTestCredentials,
  testClientInfo,
  testClientSuite,
  testClientArtifact,
  issueTestBootstrap,
  testClientReceipt,
  enrollTestClient,
  checked,
} from '@apk/platform';
import { NodeRoute, Public, TestAppRoute } from './auth.js';
import type { AuthedRequest } from './auth.js';
import { Database } from './database.js';
import { uuid } from './p1-controllers.js';

@Controller()
export class V114Controller {
  constructor(private readonly db: Database) {}
  @Get('test-data') list(@Query() query: Record<string, unknown>) {
    return testDataPage(this.db, query);
  }
  @Post('test-data/:id/credentials') @HttpCode(200) credentials(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    return viewTestCredentials(this.db, uuid(id), body, req.auth!.admin.id, req.requestId);
  }
  @Get('test-client/info') info() {
    return testClientInfo();
  }
  @Public() @Get('test-client') async page(@Query() query: unknown, @Res() res: Response) {
    const input = checked<{ sha256?: string; suite?: '1' }>('TestClientQuery', query);
    if (input.suite) {
      const apps = await testClientSuite();
      for (const app of apps) await testClientArtifact(app.sha256);
      res
        .type('html')
        .send(
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>十个独立测试 APP</title><body><h1>十个独立测试 APP</h1>' +
            apps
              .map(
                (a) =>
                  '<p><a class="test-apk" id="test-apk-' +
                  a.number +
                  '" href="/api/v1/test-client/apk?sha256=' +
                  a.sha256 +
                  '">测试 APP ' +
                  a.number +
                  '</a></p>',
              )
              .join('') +
            '</body></html>',
        );
      return;
    }
    const artifact = await testClientArtifact(input.sha256);
    res
      .type('html')
      .send(
        '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>自有测试 APK</title><body><h1>中台自有测试 APK</h1><p>用于中台模拟器任务的设备观测和测试账户上报。</p><a id="test-apk" href="/api/v1/test-client/apk?sha256=' +
          artifact.sha256 +
          '">下载测试 APK</a></body></html>',
      );
  }
  @Public() @Get('test-client/apk') async apk(@Query() query: unknown, @Res() res: Response) {
    const input = checked<{ sha256?: string }>('TestClientQuery', query);
    const artifact = await testClientArtifact(input.sha256);
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="' + artifact.filename + '"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(artifact.bytes);
  }
  @NodeRoute()
  @Put('agent/tasks/:taskId/test-bootstrap')
  @HttpCode(200)
  bootstrap(@Param('taskId') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    return issueTestBootstrap(this.db, req.nodeToken!, uuid(id), body);
  }
  @NodeRoute() @Post('agent/tasks/:taskId/test-receipt') @HttpCode(200) receipt(
    @Param('taskId') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    return testClientReceipt(this.db, req.nodeToken!, uuid(id), body);
  }
  @TestAppRoute() @Post('test-data/enroll') @HttpCode(200) enroll(
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    return enrollTestClient(
      this.db,
      req.testAppToken!,
      body,
      req.ip ?? '',
      req.get('user-agent') ?? '',
    );
  }
}
