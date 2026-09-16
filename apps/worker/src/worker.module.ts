import { Module } from '@nestjs/common';

import { AuthModule } from '@finmate/api/modules/auth/auth.module';
import { ConfigModule } from '@finmate/api/config/config.module';
import { PrismaModule } from '@finmate/api/prisma/prisma.module';
import { BudgetingModule } from '@finmate/api/modules/budgeting/budgeting.module';
import { InsightsModule } from '@finmate/api/modules/insights/insights.module';
import { LedgerModule } from '@finmate/api/modules/ledger/ledger.module';
import { NotificationsModule } from '@finmate/api/modules/notifications/notifications.module';
import { RecurringModule } from '@finmate/api/modules/recurring/recurring.module';
import { TaxonomyModule } from '@finmate/api/modules/taxonomy/taxonomy.module';

/**
 * The worker's module graph — ADR-022.
 *
 * **Deliberately not `AppModule`.** Booting the application root would drag in `GraphqlModule` (an
 * HTTP-shaped provider graph) and `AuthModule`'s controllers, none of which a background process
 * serves. This is the same reasoning `run-evals.ts` uses for its own test context, and it means the
 * worker's boot fails loudly on a missing provider instead of silently starting a half-graph.
 *
 * What is here is exactly what the four jobs reach: the ledger and taxonomy for
 * `RecurringService.materialise` (which writes Transactions), budgeting for the pace figures the
 * insight generators read, mail for the notification drain's email channel, and the three feature
 * modules whose exported services the jobs call.
 *
 * @module @finmate/worker
 */
@Module({
  imports: [
    ConfigModule.forRoot(),
    PrismaModule,
    TaxonomyModule,
    LedgerModule,
    BudgetingModule,
    // `AuthModule` is the module that owns `MailService` (and Redis), and it is `@Global()`, so the
    // notification drain's email channel resolves without a second provider for it.
    AuthModule,
    InsightsModule,
    NotificationsModule,
    RecurringModule,
  ],
})
export class WorkerModule {}
