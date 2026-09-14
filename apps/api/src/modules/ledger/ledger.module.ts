import { Module } from '@nestjs/common';

import { TaxonomyModule } from '../taxonomy/taxonomy.module';
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
 */
@Module({
  imports: [TaxonomyModule],
  controllers: [TransactionsExportController],
  providers: [TransactionsResolver, TransactionsService],
  exports: [TransactionsService],
})
export class LedgerModule {}
