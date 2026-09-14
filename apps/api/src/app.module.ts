import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuthenticatedGuard, RolesGuard } from './common/auth/guards';
import { RequestContextMiddleware } from './common/tenancy/request-context.middleware';
import { ConfigModule } from './config/config.module';
import { GraphqlModule } from './graphql/graphql.module';
import { HealthController } from './health/health.controller';
import { AccountsModule } from './modules/accounts/accounts.module';
import { BudgetingModule } from './modules/budgeting/budgeting.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { TaxonomyModule } from './modules/taxonomy/taxonomy.module';
import { AuthModule } from './modules/auth/auth.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Application root.
 *
 * Everything is wired explicitly rather than by convention, because the ordering is security
 * relevant: the tenancy middleware must resolve the session before any guard runs, and the
 * exception filter must be global so tenancy violations are logged and surfaced consistently.
 */
@Module({
  imports: [
    ConfigModule.forRoot(),
    PrismaModule,
    AuthModule,
    GraphqlModule,
    AccountsModule,
    TaxonomyModule,
    LedgerModule,
    BudgetingModule,
  ],
  controllers: [HealthController],
  providers: [
    AllExceptionsFilter,
    // Applied globally so a new controller cannot silently opt out of authentication. Routes that
    // are genuinely public will be marked with `@Public()` and the guard taught to honour it when
    // the first such route appears — until then, deny-by-default is the correct stance.
    { provide: APP_GUARD, useClass: AuthenticatedGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
