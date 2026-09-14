import { Module } from '@nestjs/common';

import { TransactionsExportController } from './transactions-export.controller';
import { TransactionsResolver } from './transactions.resolver';
import { TransactionsService } from './transactions.service';

/**
 * The ledger: the module that owns money.
 *
 * It owns every arithmetic operation on Transactions and is the only writer to that table. Balances,
 * budget consumption and insights read through it (or through a read model derived from it), so the
 * invariants in docs/03 §5 have exactly one place to be enforced.
 */
@Module({
  controllers: [TransactionsExportController],
  providers: [TransactionsResolver, TransactionsService],
  exports: [TransactionsService],
})
export class LedgerModule {}
