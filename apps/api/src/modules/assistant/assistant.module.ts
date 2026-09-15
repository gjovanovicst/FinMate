import { Module } from '@nestjs/common';

import { GraphqlScalarsModule } from '../../graphql/scalars/scalars.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AccountsModule } from '../accounts/accounts.module';
import { BudgetingModule } from '../budgeting/budgeting.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { NARRATOR, UNCONFIGURED_NARRATOR, type AssistantNarrator } from './assistant-narrator';
import { AssistantResolver } from './assistant.resolver';
import { AssistantService } from './assistant.service';
import { FactAssemblyService } from './fact-assembly.service';

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
 * ADR-015) are arithmetic that already exists in exactly one place. `TaxonomyModule` for the
 * Household's own vocabulary, which the planner matches a question's names against — a second copy of
 * that vocabulary is how `Lidl` stops resolving after somebody renames the Merchant.
 *
 * `RateLimitService` needs no import: `AuthModule` is `@Global()` and exports it for this purpose.
 *
 * ## The scalars are imported, never re-provided
 *
 * `MoneyScalar`, `UuidScalar` and `LocalDateScalar` come with `AccountsModule`; `JSON` comes from
 * `GraphqlScalarsModule`. Providing any of them again gives the schema two types with one name,
 * which is a boot failure rather than a test failure (the 3.1.2 lesson in docs/15).
 *
 * ## The narrator is unconfigured in this build
 *
 * No AI provider is configured at all, so `NARRATOR` resolves to {@link UNCONFIGURED_NARRATOR} and
 * every answer is the deterministic template rendering — with `narrationMode = TEMPLATE_FALLBACK`
 * reported honestly rather than pretending a model ran. `RoutedNarrator` is built and tested against
 * a stub router, so registering a provider is what switches it on (ADR-021's seam, one layer up).
 *
 * @module apps/api/src/modules/assistant
 */
@Module({
  imports: [PrismaModule, GraphqlScalarsModule, AccountsModule, BudgetingModule, TaxonomyModule],
  providers: [
    FactAssemblyService,
    AssistantService,
    AssistantResolver,
    { provide: NARRATOR, useValue: UNCONFIGURED_NARRATOR satisfies AssistantNarrator },
  ],
  exports: [FactAssemblyService, AssistantService],
})
export class AssistantModule {}
