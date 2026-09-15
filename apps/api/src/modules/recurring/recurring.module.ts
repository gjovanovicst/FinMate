import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RecurringResolver } from './recurring.resolver';
import { RecurringService } from './recurring.service';

/**
 * Recurring rules (F-16) — docs/06 §4/§5.8, docs/02 §4.14.
 *
 * `LedgerModule` supplies `TransactionsService`, and that is the whole point: a materialised
 * occurrence is written through the **same** create path as a row the user typed, so it gets I-3's
 * category/kind check, ADR-011's currency, the local-day derivation and I-10's idempotency instead of a
 * second insert that could drift from them. The edge is one-directional — the ledger knows nothing
 * about recurrence — so there is no cycle to break.
 *
 * The algorithm itself is `@finmate/domain`'s (`recurring.ts`), so what lands in this module is dates
 * the domain package already tests.
 *
 * `RecurringService` is exported for the `recurring.materialise` job and for 3.3.4's subscription
 * detection, which reads the same rules; the `Money`, `UUID` and `LocalDate` scalars arrive with the
 * imported modules and are never re-provided (docs/15).
 *
 * @module apps/api/src/modules/recurring
 */
@Module({
  imports: [PrismaModule, LedgerModule],
  providers: [RecurringService, RecurringResolver],
  exports: [RecurringService],
})
export class RecurringModule {}
