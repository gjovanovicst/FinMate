import { Module } from '@nestjs/common';

import { AccountsModule } from '../accounts/accounts.module';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { FactAssemblyService } from './fact-assembly.service';

/**
 * The assistant — docs/06 §8, ADR-017, docs/09 tasks 3.2.1–3.2.5.
 *
 * ## What is wired here, and what deliberately is not
 *
 * This module currently provides **fact assembly only** (3.2.2). There is no resolver yet: docs/06 §4.4
 * declares `assistantAnswer` with a required `answerText` and a `narrationMode`, and neither can be
 * produced honestly until 3.2.3's narrator and template fallback exist. Shipping the operation with a
 * placeholder answer would publish a contract the API cannot keep — the same mistake as wiring a
 * mutation before its service.
 *
 * ## Why it imports rather than recomputes
 *
 * `AccountsModule` and `BudgetingModule` are imported because a balance (I-4) and budget consumption
 * (I-5, ADR-015) are arithmetic that already exists in exactly one place. Re-deriving either here is how
 * the assistant and the tile the user is looking at start disagreeing — which is the failure ADR-001
 * exists to prevent, one layer down from the model itself.
 *
 * @module apps/api/src/modules/assistant
 */
@Module({
  imports: [AccountsModule, BudgetingModule],
  providers: [FactAssemblyService],
  exports: [FactAssemblyService],
})
export class AssistantModule {}
