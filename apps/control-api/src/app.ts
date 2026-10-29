import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import type { Response, NextFunction } from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import { AuthService, SessionGuard } from './auth.js';
import type { AuthedRequest } from './auth.js';
import { AuthController, ConsoleController } from './controllers.js';
import { Database } from './database.js';
import { ErrorFilter } from './errors.js';
import { settings } from './settings.js';
import { NodesController, DeploymentController, AgentController } from './p1-controllers.js';
import { P2Controller, P2AgentController } from './p2-controllers.js';
import { P3Controller, P3AgentController } from './p3-controllers.js';
import { V15Controller, DailyScheduler } from './v15-controllers.js';
import { V17Controller } from './v17-controllers.js';
import { V18Controller } from './v18-controllers.js';
import { digest } from '@apk/platform';
import { ApiError } from './errors.js';

@Module({
  controllers: [
    AuthController,
    ConsoleController,
    NodesController,
    DeploymentController,
    AgentController,
    P2Controller,
    P2AgentController,
    P3Controller,
    P3AgentController,
    V15Controller,
    V17Controller,
    V18Controller,
  ],
  providers: [
    Database,
    AuthService,
    DailyScheduler,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
export async function createApp() {
  const config = settings();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: false,
  });
  app.set('trust proxy', config.trustProxyHops || false);
  app.use((req: AuthedRequest, res: Response, next: NextFunction) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(helmet());
  app.use(
    '/api/v1/agent/artifacts',
    async (req: AuthedRequest, _res: Response, next: NextFunction) => {
      try {
        const token = req.get('authorization')?.match(/^Bearer ([-_A-Za-z0-9]{43})$/)?.[1];
        if (!token) throw new ApiError(401, 'UNAUTHENTICATED', '需要节点身份');
        const auth = await app
          .get(Database)
          .agentCredential.findUnique({ where: { tokenHash: digest(token) } });
        if (!auth || auth.revokedAt) throw new ApiError(401, 'UNAUTHENTICATED', '节点身份无效');
        next();
      } catch (error) {
        next(error);
      }
    },
    json({ limit: '128kb' }),
  );
  app.use(json({ limit: '256kb' }));
  app.use(cookieParser());
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ErrorFilter());
  try {
    await app.init();
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
