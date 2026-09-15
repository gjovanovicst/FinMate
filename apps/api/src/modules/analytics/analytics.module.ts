import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { AnalyticsResolver } from './analytics.resolver';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics (F-20) — docs/06 §4.3.
 *
 * ## What it imports, and why that is the whole design
 *
 * `LedgerModule` supplies `SpendReadModel`: the split-aware aggregate (I-1, I-7) that the budget tile,
 * the assistant and the insight trends already read. Analytics adds **no SQL of its own for money**, so
 * the screen cannot disagree with the budget the user set — which was the divergence 3.3.1 exists to
 * close (docs/06 §5.13).
 *
 * `TaxonomyModule` supplies `CategoriesService` (the tree, with the paths that make a chart label
 * readable and the parent links the subtree rollup walks) and `MerchantsService` (a Merchant's display
 * name, resolved in one query rather than one per row).
 *
 * `RateLimitService` needs no import: `AuthModule` is `@Global()` and exports it, which is why the
 * `READ_ANALYTICS` budget (docs/06 §11.2) can be applied here without a module edge.
 *
 * The `Money`, `Balance`, `UUID` and `LocalDate` scalars arrive with the imported modules and are never
 * re-provided: two providers for one scalar name is a boot failure, not a test failure (docs/15 §4).
 *
 * @module apps/api/src/modules/analytics
 */
@Module({
  imports: [PrismaModule, LedgerModule, TaxonomyModule],
  providers: [AnalyticsService, AnalyticsResolver],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
