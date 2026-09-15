import { Module } from '@nestjs/common';

import { ClassificationModule } from '../classification/classification.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { ReviewResolver } from './review.resolver';
import { SpendReadModel } from './spend-read-model';
import { TransactionsExportController } from './transactions-export.controller';
import { TransactionsResolver } from './transactions.resolver';
import { TransactionsService } from './transactions.service';

/**
 * The ledger: the module that owns money.
 *
 * It owns every arithmetic operation on Transactions and is the only writer to that table. Balances,
 * budget consumption and insights read through it (or through a read model derived from it), so the
 * invariants in docs/03 §5 have exactly one place to be enforced.
 *
 * It imports `TaxonomyModule` for one reason: attaching a Tag to a Transaction has to validate that
 * the Tag is one this Household can see, and `tags` is Taxonomy's table. The edge goes through the
 * owning module's service rather than a direct query (docs/05 §3).
 *
 * `ClassificationModule` is imported for `captureCommit`: a captured row's category comes from the
 * pipeline, and the audit row that records *why* is `classification_decisions`, which classification
 * owns. The edge is one-directional — classification imports nothing from the ledger — so the
 * capture write path never becomes a cycle.
 */
@Module({
  imports: [TaxonomyModule, ClassificationModule],
  controllers: [TransactionsExportController],
  providers: [TransactionsResolver, TransactionsService, ReviewResolver, SpendReadModel],
  // `SpendReadModel` is exported because **every** consumer of a spend total must use it: analytics,
  // insights and the assistant. A second split-aware sum is how two screens start disagreeing about
  // the same Category (docs/06 §5.13).
  exports: [TransactionsService, SpendReadModel],
})
export class LedgerModule {}
