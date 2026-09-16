import { Module } from '@nestjs/common';

import { GraphqlScalarsModule } from '../../graphql/scalars/scalars.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RecurringModule } from '../recurring/recurring.module';
import { InsightsResolver } from './insights.resolver';
import { InsightsService } from './insights.service';

/**
 * Insights (F-20, F-22) — deterministic observations about the ledger.
 *
 * It composes rather than duplicates: `BudgetingModule` owns consumption, safe-to-spend and the
 * month-end projection, and this module reads those figures for the pace insight instead of writing a
 * second spend query. `LedgerModule` supplies `SpendReadModel`, which is where a split-aware category
 * total lives — the trend baseline used to count direct rows only, and that is the divergence 3.3.1
 * reconciled (docs/06 §5.13). The generators themselves are in `@finmate/domain`, so what lands in `insights`
 * is arithmetic the domain package already tests.
 *
 * `RecurringModule` supplies `RecurringService`, which answers the one question the projections were
 * missing: **what is still to be charged** in a period (docs/03 §6's `committed`). Before 3.4.2 a
 * Category budget was projected on pace alone because there was nothing to read.
 *
 * `GraphqlScalarsModule` supplies `JSON`: a custom scalar must be reachable as a provider or Nest
 * cannot resolve the field, and two modules providing the same scalar is a schema-name collision
 * (docs/15 §4).
 */
@Module({
  imports: [PrismaModule, BudgetingModule, LedgerModule, RecurringModule, GraphqlScalarsModule],
  providers: [InsightsService, InsightsResolver],
  exports: [InsightsService],
})
export class InsightsModule {}
