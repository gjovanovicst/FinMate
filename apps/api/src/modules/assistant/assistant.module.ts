import { Module } from '@nestjs/common';

import { GraphqlScalarsModule } from '../../graphql/scalars/scalars.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AccountsModule } from '../accounts/accounts.module';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { ClassificationModule } from '../classification/classification.module';
import { GoalsModule } from '../goals/goals.module';
import { LedgerModule } from '../ledger/ledger.module';
import { RecurringModule } from '../recurring/recurring.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { AiModule } from '../ai/ai.module';
import { AssistantResolver } from './assistant.resolver';
import { AssistantActionService } from './assistant-action.service';
import { AssistantService } from './assistant.service';
import { FactAssemblyService } from './fact-assembly.service';
import { PendingActionStore } from './pending-action.store';

/**
 * The assistant — docs/06 §8, ADR-017, docs/09 tasks 3.2.1–3.2.5.
 *
 * ## What is wired
 *
 * 3.2.1 the planner, 3.2.2 fact assembly, 3.2.3 narration with the numeric validator and the template
 * fallback, exposed as docs/06 §4.4's `assistantAnswer`. 3.2.4 is the UI and 3.2.5 the savings
 * proposal.
 *
 * ## Why it imports rather than recomputes
 *
 * `AccountsModule` and `BudgetingModule` because a balance (I-4) and budget consumption (I-5,
 * ADR-015) are arithmetic that already exists in exactly one place. `LedgerModule` supplies
 * `SpendReadModel`, the split-aware aggregate the assistant shares with analytics and the insight
 * trends since 3.3.1 — a second copy of I-1/I-7 in this module is exactly what that removed.
 * `TaxonomyModule` for the
 * Household's own vocabulary, which the planner matches a question's names against — a second copy of
 * that vocabulary is how `Lidl` stops resolving after somebody renames the Merchant. `GoalsModule` and
 * `RecurringModule` are the same argument one step further: `GOAL_PROGRESS` and the two recurring
 * templates answer from `GoalsService`/`RecurringService`, the very methods the `/goals` and
 * `/recurring` screens read, so the assistant cannot disagree with the screen beside it.
 *
 * `RateLimitService` needs no import: `AuthModule` is `@Global()` and exports it for this purpose.
 *
 * ## The scalars are imported, never re-provided
 *
 * `MoneyScalar`, `UuidScalar` and `LocalDateScalar` come with `AccountsModule`; `JSON` comes from
 * `GraphqlScalarsModule`. Providing any of them again gives the schema two types with one name,
 * which is a boot failure rather than a test failure (the 3.1.2 lesson in docs/15).
 *
 * ## The narrator comes from the AI composition root
 *
 * `NARRATOR` is provided by `AiModule` (ADR-031 decision 6), not here: whether a model can narrate is
 * a property of the deployment's configuration, and the assistant must not be the second place that
 * decides it. With no `NARRATE` endpoint the token is `UNCONFIGURED_NARRATOR`, `available` is `false`,
 * and every answer is the deterministic template rendering — with `narrationMode = TEMPLATE_FALLBACK`
 * reported honestly rather than pretending a model ran. A live provider switches it on with no change
 * to this file.
 *
 * @module apps/api/src/modules/assistant
 */
@Module({
  imports: [
    PrismaModule,
    GraphqlScalarsModule,
    AccountsModule,
    BudgetingModule,
    // `ADD_TRANSACTION` runs the capture pipeline at **propose** time, through the same
    // `ClassificationService` the `/capture` screen calls (docs/16 B.3): a second classification path
    // is how a card starts disagreeing with the screen beside it.
    ClassificationModule,
    GoalsModule,
    LedgerModule,
    RecurringModule,
    TaxonomyModule,
    AiModule,
  ],
  providers: [
    FactAssemblyService,
    AssistantService,
    // The write side (ADR-035): the registry's only executor and where a proposal lives between
    // propose and confirm. `RedisService` is injected without an import — `AuthModule` is `@Global()`
    // and exports it for exactly this kind of consumer.
    AssistantActionService,
    PendingActionStore,
    AssistantResolver,
  ],
  exports: [FactAssemblyService, AssistantService, AssistantActionService],
})
export class AssistantModule {}
