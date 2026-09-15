import { Module } from '@nestjs/common';

import { GraphqlScalarsModule } from '../../graphql/scalars/scalars.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { InsightsResolver } from './insights.resolver';
import { InsightsService } from './insights.service';

/**
 * Insights (F-20, F-22) — deterministic observations about the ledger.
 *
 * It composes rather than duplicates: `BudgetingModule` owns consumption, safe-to-spend and the
 * month-end projection, and this module reads those figures for the pace insight instead of writing a
 * second spend query. The generators themselves are in `@finmate/domain`, so what lands in `insights`
 * is arithmetic the domain package already tests.
 *
 * `GraphqlScalarsModule` supplies `JSON`: a custom scalar must be reachable as a provider or Nest
 * cannot resolve the field, and two modules providing the same scalar is a schema-name collision
 * (docs/15 §4).
 */
@Module({
  imports: [PrismaModule, BudgetingModule, GraphqlScalarsModule],
  providers: [InsightsService, InsightsResolver],
  exports: [InsightsService],
})
export class InsightsModule {}
