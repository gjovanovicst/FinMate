import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { withTenancy } from '../common/tenancy/tenancy.extension';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The single Prisma client for the process, wrapped with the tenancy guard.
 *
 * Two things are deliberate:
 *
 *  - **The guard is applied here, once.** Consumers inject `PrismaService` and cannot obtain an
 *    unguarded client, so household scoping is not something a feature author can forget to opt
 *    into (ADR-008).
 *  - **Prisma 7 uses a driver adapter.** There is no `url` in `schema.prisma`; the connection is
 *    supplied here via `@prisma/adapter-pg`. `prisma.config.ts` holds the URL for CLI commands
 *    only.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  /** Tenancy-guarded client. Always use this — never construct a bare `PrismaClient`. */
  readonly client: PrismaClient;

  constructor(@Inject(CONFIG) config: AppConfig) {
    const adapter = new PrismaPg({ connectionString: config.DATABASE_URL });
    this.client = withTenancy(new PrismaClient({ adapter }));
  }

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /** Readiness probe: a trivial query proves the connection is usable, not merely open. */
  async ping(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error('database ping failed', error instanceof Error ? error.stack : undefined);
      return false;
    }
  }
}
