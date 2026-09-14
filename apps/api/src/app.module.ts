import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { RequestContextMiddleware } from './common/tenancy/request-context.middleware';
import { ConfigModule } from './config/config.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Application root.
 *
 * Everything is wired explicitly rather than by convention: the tenancy middleware must run
 * before any controller, and the exception filter must be global, so both are registered here
 * where a reader can see them.
 */
@Module({
  imports: [ConfigModule.forRoot(), PrismaModule],
  controllers: [HealthController],
  providers: [AllExceptionsFilter],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Applied to every route so no future controller can bypass tenancy establishment.
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
