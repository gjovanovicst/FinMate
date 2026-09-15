import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { AuthenticatedGuard, RolesGuard } from './common/auth/guards';
import { RequestContextMiddleware } from './common/tenancy/request-context.middleware';
import { ConfigModule } from './config/config.module';
import { GraphqlModule } from './graphql/graphql.module';
import { HealthController } from './health/health.controller';
import { AccountsModule } from './modules/accounts/accounts.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AssistantModule } from './modules/assistant/assistant.module';
import { BudgetingModule } from './modules/budgeting/budgeting.module';
import { ClassificationModule } from './modules/classification/classification.module';
import { GoalsModule } from './modules/goals/goals.module';
import { InsightsModule } from './modules/insights/insights.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { OnboardingModule } from './modules/onboarding/onboarding.module';
import { RecurringModule } from './modules/recurring/recurring.module';
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
    OnboardingModule,
    BudgetingModule,
    // The capture pipeline (docs/04 §2). Imports the pure packages; imports no AI adapter directly.
    ClassificationModule,
    // Deterministic insight generation (docs/01 F-20/F-22). Composes `budgeting` rather than
    // recomputing consumption, so the feed and the dashboard cannot disagree.
    InsightsModule,
    // Saving goals (F-18). Reads Accounts for the Account a goal is set aside in; it writes no
    // Transactions, because a contribution is a `goal_contribution` and not spending (docs/02 §4.13).
    GoalsModule,
    // Recurring rules (F-16). Posts through the ledger's own create path, so a materialised row gets
    // the same validation and idempotency as a hand-typed one.
    RecurringModule,
    // Alerts and notifications (F-22). Imports `insights` — one direction only, per docs/05 §3.
    NotificationsModule,
    // Analytics (F-20). Reads `SpendReadModel` rather than aggregating again, so the chart and the
    // budget tile beside it are the same arithmetic (docs/06 §5.13).
    AnalyticsModule,
    // The assistant (F-23). Planner → fact assembly → narration, with the template fallback when no
    // provider is configured (docs/06 §8).
    AssistantModule,
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
