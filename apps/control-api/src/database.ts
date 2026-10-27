import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { settings } from './settings.js';
@Injectable()
export class Database extends PrismaClient {
  constructor() {
    super({ datasources: { db: { url: settings().databaseUrl } }, log: [] });
  }
  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
