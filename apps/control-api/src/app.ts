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

@Module({
  controllers: [
    AuthController,
    ConsoleController,
    NodesController,
    DeploymentController,
    AgentController,
    P2Controller,
    P2AgentController,
  ],
  providers: [Database, AuthService, { provide: APP_GUARD, useClass: SessionGuard }],
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
