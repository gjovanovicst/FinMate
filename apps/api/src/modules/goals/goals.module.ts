import { Module } from '@nestjs/common';

import { PrismaModule } from '../../prisma/prisma.module';
import { AccountsModule } from '../accounts/accounts.module';
import { GoalsResolver } from './goals.resolver';
import { GoalsService } from './goals.service';

/**
 * Saving goals (F-18) — docs/06 §4/§5.7, docs/02 §4.13.
 *
 * `AccountsModule` supplies the Account a goal is set aside in, resolved through the same service the
 * Accounts screen uses so the balance beside a goal is the derived figure I-4 describes rather than a
 * second computation. Nothing else is imported: goals do not touch the ledger (a contribution is not a
 * Transaction), so there is no `LedgerModule` edge to draw.
 *
 * `GoalsService` is **exported** so the assistant's `GOAL_PROGRESS` / `GOAL_REQUIRED_MONTHLY` templates
 * can answer from the same figures the screen shows, and so the `GOAL_REACHED` alert producer (3.1.2's
 * list of uninstrumented kinds) has one place to read progress from.
 *
 * The `Money`, `UUID` and `LocalDate` scalars arrive with the imported modules and are never
 * re-provided: two providers for one scalar name is a boot failure, not a test failure (docs/15).
 *
 * @module apps/api/src/modules/goals
 */
@Module({
  imports: [PrismaModule, AccountsModule],
  providers: [GoalsService, GoalsResolver],
  exports: [GoalsService],
})
export class GoalsModule {}
