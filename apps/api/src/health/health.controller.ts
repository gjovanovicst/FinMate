import { Controller, Get, HttpCode, HttpStatus, Inject } from '@nestjs/common';

import { Public } from '../common/auth/guards';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness and readiness probes (docs/11 §9).
 *
 * Deliberately unauthenticated and side-effect free. `/health` must not touch the database: it
 * answers "is this process alive", and a restart loop caused by a transient database blip is
 * worse than useless. `/health/ready` does check the database, because that is what gates
 * traffic.
 */
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  liveness(): { status: string; version: string } {
    return { status: 'ok', version: '0.0.0' };
  }

  @Get('ready')
  async readiness(): Promise<{
    status: string;
    environment: string;
    dependencies: { database: string };
  }> {
    const databaseUp = await this.prisma.ping();
    return {
      status: databaseUp ? 'ok' : 'degraded',
      environment: this.config.NODE_ENV,
      dependencies: { database: databaseUp ? 'up' : 'down' },
    };
  }
}
