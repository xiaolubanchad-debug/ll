import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  consoleOverview,
  consoleRuns,
  registrationRecords,
  registrationRecord,
  runSummary,
  runTimeline,
  apkAssets,
  fault,
} from '@apk/platform';
import { schemaIssues } from '@apk/contracts';
import type { ValidationListView } from '@apk/contracts';
import { Database } from './database.js';
import { uuid } from './p1-controllers.js';
import { pageArgs, page } from './controllers.js';

@Controller()
export class V17Controller {
  constructor(private readonly db: Database) {}
  @Get('console/overview') overview(@Query() q: Record<string, unknown>) {
    return consoleOverview(this.db, q);
  }
  @Get('console/runs') runs(@Query() q: Record<string, unknown>) {
    return consoleRuns(this.db, q);
  }
  @Get('registrations') registrations(@Query() q: Record<string, unknown>) {
    return registrationRecords(this.db, q);
  }
  @Get('registrations/:id') registration(@Param('id') id: string) {
    return registrationRecord(this.db, uuid(id));
  }
  @Get('runs/:id/summary') summary(@Param('id') id: string) {
    return runSummary(this.db, uuid(id));
  }
  @Get('runs/:id/timeline') timeline(@Param('id') id: string, @Query() q: Record<string, unknown>) {
    return runTimeline(this.db, uuid(id), q);
  }
  @Get('apk-assets') assets(@Query() q: Record<string, unknown>) {
    return apkAssets(this.db, q);
  }
  @Get('console/validations') async validations(@Query() q: Record<string, unknown>) {
    const { limit, ...args } = pageArgs(q);
    const rows = await this.db.deployment.findMany({
      ...args,
      where: { result: { path: ['ownedFixtureValidation'], equals: true } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        status: true,
        createdAt: true,
        result: true,
        node: { select: { name: true } },
      },
    });
    const view: ValidationListView = page(
      rows.map((r) => {
        const result = r.result as {
          passed?: boolean;
          cleanupComplete?: boolean;
          cases?: { case?: string; status?: string; proof?: string; requests?: number }[];
        };
        return {
          id: r.id,
          nodeName: r.node.name,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          passed: result.passed === true,
          cleanupComplete: result.cleanupComplete === true,
          cases: Array.isArray(result.cases)
            ? result.cases.map((c) => ({
                name: typeof c.case === 'string' ? c.case : '自有 APK 用例',
                status: typeof c.status === 'string' ? c.status : 'UNKNOWN',
                proof: typeof c.proof === 'string' ? c.proof : 'NONE',
                requests: Number.isSafeInteger(c.requests) && c.requests! >= 0 ? c.requests! : 0,
              }))
            : [],
        };
      }),
      limit,
    );
    if (schemaIssues('ValidationListView', view).length)
      fault('INTERNAL_CONTRACT_ERROR', '验收记录暂不可用', 503);
    return view;
  }
}
