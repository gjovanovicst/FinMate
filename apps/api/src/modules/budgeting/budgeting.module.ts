import { Module } from '@nestjs/common';

import { BudgetsResolver } from './budgets.resolver';
import { BudgetsService } from './budgets.service';

/**
 * Budgets and the dashboard.
 *
 * Owns every user-facing figure derived from the ledger: consumption, safe-to-spend and the
 * month-end projection. All of it is deterministic backend arithmetic (ADR-001) delegated to
 * `@finmate/domain`, which is pure and unit-tested against hand-computed fixtures.
 */
@Module({
  providers: [BudgetsResolver, BudgetsService],
  exports: [BudgetsService],
})
export class BudgetingModule {}
