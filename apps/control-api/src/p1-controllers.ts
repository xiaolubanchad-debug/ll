import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Req,
  Headers,
  HttpCode,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { DeploymentInput, ReasonInput, ReconcileInput } from '@apk/contracts';
import {
  createNode,
  updateNode,
  archiveNode,
  trustNode,
  nodeView,
  ifMatch,
  createSecret,
  checked,
  enqueue,
  stopJob,
  idempotent,
  lockNode,
  idle,
  registerRelease,
  enrollAgent,
  agentHeartbeat,
  fault,
} from '@apk/platform';
import { Database } from './database.js';
import { NodeRoute } from './auth.js';
import type { AuthedRequest } from './auth.js';
import { pageArgs, page } from './controllers.js';
import { keyRequired } from '@apk/platform';
export function uuid(id: string) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))
    fault('VALIDATION_FAILED', '编号无效', 422);
  return id;
}
function empty(value: unknown) {
  if (
    value !== undefined &&
    (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length)
  )
    fault('VALIDATION_FAILED', '该操作不接受额外参数', 422);
}
@Controller('nodes')
export class NodesController {
  constructor(private readonly db: Database) {}
  @Get() async list(@Query() query: Record<string, unknown>) {
    const { limit, ...args } = pageArgs(query);
    const ids = await this.db.node.findMany({
      ...args,
      where: { archivedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    return page(await Promise.all(ids.map((n) => nodeView(this.db, n.id))), limit);
  }
  @Post() create(@Body() body: unknown, @Req() req: AuthedRequest) {
    return createNode(this.db, body, req.auth!.admin.id, req.requestId);
  }
  @Get(':id') async get(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const node = await nodeView(this.db, uuid(id));
    res.setHeader('ETag', `"${node.version}"`);
    return node;
  }
  @Patch(':id') update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') version: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return updateNode(this.db, uuid(id), body, ifMatch(version), req.auth!.admin.id, req.requestId);
  }
  @Delete(':id') @HttpCode(204) archive(
    @Param('id') id: string,
    @Headers('if-match') version: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return archiveNode(this.db, uuid(id), ifMatch(version), req.auth!.admin.id, req.requestId);
  }
  @Post(':id/fingerprint-probes') @HttpCode(202) probe(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    empty(body);
    return enqueue(
      this.db,
      uuid(id),
      'PROBE',
      null,
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
    );
  }
  @Put(':id/host-key') trust(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') version: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return trustNode(this.db, uuid(id), body, ifMatch(version), req.auth!.admin.id, req.requestId);
  }
  @Post(':id/checks') @HttpCode(202) check(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    empty(body);
    return enqueue(
      this.db,
      uuid(id),
      'CHECK',
      null,
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
    );
  }
  @Post(':id/reconciliations') @HttpCode(200) reconcile(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    uuid(id);
    const input = checked<ReconcileInput>('ReconcileInput', body);
    return idempotent(
      this.db,
      req.auth!.admin.id,
      'reconcile:' + id,
      keyRequired(key),
      input,
      async (tx) => {
        const node = await lockNode(tx, id);
        const slot = await idle(tx, id, true);
        const evidence = await tx.deployment.findFirst({
          where: {
            id: input.checkId,
            nodeId: id,
            nodeVersion: node.version,
            kind: 'CHECK',
            status: { in: ['SUCCEEDED', 'FAILED'] },
          },
        });
        const last = await tx.deployment.findFirst({
          where: { nodeId: id, status: 'NEEDS_REVIEW' },
          orderBy: { finishedAt: 'desc' },
        });
        const result = evidence?.result as { markerPresent?: unknown } | null;
        if (
          !slot.quarantined ||
          !evidence?.finishedAt ||
          result?.markerPresent !== false ||
          (last?.finishedAt && evidence.createdAt <= last.finishedAt)
        )
          fault('NODE_QUARANTINED', '需要新的远程检查确认安装标记已清除');
        await tx.nodeSlot.update({ where: { nodeId: id }, data: { quarantined: false } });
        await tx.auditEvent.create({
          data: {
            adminId: req.auth!.admin.id,
            action: 'NODE_RECONCILED',
            requestId: req.requestId,
          },
        });
        return { id, reconciled: true };
      },
    );
  }
}
@Controller()
export class DeploymentController {
  constructor(private readonly db: Database) {}
  @Post('secrets/versions') secret(@Body() body: unknown, @Req() req: AuthedRequest) {
    return createSecret(this.db, body, req.auth!.admin.id, req.requestId);
  }
  @Get('secrets') async secrets(@Query() query: Record<string, unknown>) {
    const { limit, ...args } = pageArgs(query);
    return page(
      await this.db.secretVersion.findMany({
        ...args,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, type: true, createdAt: true, revokedAt: true },
      }),
      limit,
    );
  }
  @Post('secrets/:id/revoke') @HttpCode(200) async revoke(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: AuthedRequest,
  ) {
    uuid(id);
    checked<ReasonInput>('ReasonInput', body);
    return this.db.$transaction(async (tx) => {
      const nodes = await tx.node.findMany({
        where: {
          OR: [{ credentialVersionId: id }, { sudoCredentialVersionId: id }],
          archivedAt: null,
        },
        orderBy: { id: 'asc' },
      });
      for (const node of nodes) {
        await lockNode(tx, node.id);
        await idle(tx, node.id, true);
      }
      if (!(await tx.secretVersion.findUnique({ where: { id } })))
        fault('NOT_FOUND', '凭据不存在', 404);
      await tx.secretVersion.update({ where: { id }, data: { revokedAt: new Date() } });
      await tx.auditEvent.create({
        data: { adminId: req.auth!.admin.id, action: 'SECRET_REVOKED', requestId: req.requestId },
      });
      return { id, revoked: true };
    });
  }
  @Post('releases') release(@Body() body: unknown, @Req() req: AuthedRequest) {
    return registerRelease(this.db, body, req.auth!.admin.id, req.requestId);
  }
  @Get('releases') async releases(@Query() query: Record<string, unknown>) {
    const { limit, ...args } = pageArgs(query);
    return page(
      await this.db.release.findMany({
        ...args,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true, manifest: true, createdAt: true },
      }),
      limit,
    );
  }
  @Post('deployments') @HttpCode(202) deploy(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    const input = checked<DeploymentInput>('DeploymentInput', body);
    return enqueue(
      this.db,
      input.nodeId,
      'DEPLOY',
      input.releaseId,
      req.auth!.admin.id,
      req.requestId,
      keyRequired(key),
    );
  }
  @Get('deployments') async list(@Query() query: Record<string, unknown>) {
    const { nodeId, status, ...rest } = query;
    const { limit, ...args } = pageArgs(rest);
    if (nodeId !== undefined && (typeof nodeId !== 'string' || !uuid(nodeId)))
      fault('VALIDATION_FAILED', '服务器编号无效', 422);
    if (
      status !== undefined &&
      (typeof status !== 'string' ||
        ![
          'QUEUED',
          'CONNECTING',
          'CHECKING',
          'INSTALLING',
          'CONFIGURING',
          'STARTING',
          'VERIFYING',
          'SUCCEEDED',
          'FAILED',
          'CANCELLED',
          'NEEDS_REVIEW',
        ].includes(status))
    )
      fault('VALIDATION_FAILED', '状态无效', 422);
    return page(
      await this.db.deployment.findMany({
        ...args,
        where: {
          ...(typeof nodeId === 'string' ? { nodeId } : {}),
          ...(typeof status === 'string' ? { status } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      limit,
    );
  }
  @Get('deployments/:id') async get(@Param('id') id: string) {
    const value = await this.db.deployment.findUnique({ where: { id: uuid(id) } });
    if (!value) fault('NOT_FOUND', '操作不存在', 404);
    return value;
  }
  @Get('deployments/:id/events') async events(
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
      items: await this.db.deploymentEvent.findMany({
        where: { deploymentId: id, sequence: { gt: after } },
        orderBy: { sequence: 'asc' },
        take: limit,
      }),
    };
  }
  @Post('deployments/:id/stop') @HttpCode(202) stop(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    checked<ReasonInput>('ReasonInput', body);
    return stopJob(this.db, uuid(id), req.auth!.admin.id, req.requestId, keyRequired(key), body);
  }
}
@NodeRoute()
@Controller('agent')
export class AgentController {
  constructor(private readonly db: Database) {}
  @Post('enroll') @HttpCode(200) enroll(@Body() body: unknown, @Req() req: AuthedRequest) {
    return enrollAgent(this.db, req.nodeToken!, body);
  }
  @Post('heartbeats') @HttpCode(200) heartbeat(@Body() body: unknown, @Req() req: AuthedRequest) {
    return agentHeartbeat(this.db, req.nodeToken!, body);
  }
}
