import { Args, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { SUGGESTED_QUESTIONS } from './assistant-intents';
import { AssistantService } from './assistant.service';
import { AssistantAnswerModel, toAssistantAnswerModel } from './assistant.model';

/**
 * The assistant query — docs/06 §4.4, §8.
 *
 * A `Query` rather than a `Mutation`: asking a question writes nothing. `costMicros` on the answer is
 * what makes the spend visible without inventing a ledger for it (docs/05 §3's "writes
 * `classification_decisions` for cost" does **not** hold in this build — a narration is not a
 * classification decision, and writing one into a table whose `decided_by` enum means "how was this
 * category chosen" would corrupt every accuracy metric built on it; docs/05 §3 is corrected).
 *
 * `conversationId` from docs/06 §4.4 is deliberately **absent**: there is no conversation store, so a
 * parameter nothing honours would be a contract the API cannot keep. The chat transcript lives in the
 * client until a store is designed (docs/06 §8.7).
 *
 * The Household comes from the session (ADR-008) — `assertAuthenticated`/the tenancy middleware makes
 * a `TenantContext` mandatory before this runs. `locale` is the one client-controlled input, and the
 * service validates it before it can reach a prompt.
 *
 * @module apps/api/src/modules/assistant
 */
@Resolver(() => AssistantAnswerModel)
export class AssistantResolver {
  constructor(private readonly assistant: AssistantService) {}

  @Query(() => AssistantAnswerModel, {
    description:
      'Answer a question about this Household\'s own ledger. The backend computes the facts; the ' +
      'model only narrates them, and every numeral it writes must exist in `facts` (ADR-017).',
  })
  async assistantAnswer(
    @CurrentHouseholdId() householdId: string,
    @Args('question', { type: () => String }) question: string,
    @Args('locale', { type: () => String, nullable: true }) locale?: string,
  ): Promise<AssistantAnswerModel> {
    const answer = await this.assistant.answer(householdId, {
      question,
      // An omitted nullable argument arrives as `null` at runtime, not `undefined`.
      ...(locale === undefined || locale === null ? {} : { locale }),
    });
    return toAssistantAnswerModel(answer);
  }

  /**
   * The canonical questions a Household can be offered — the same closed set a refusal returns.
   *
   * It exists so the screen has **one** source for its starter chips: a client that hardcoded its own
   * list would be a second copy of the planner's question set, and the first one to drift would send a
   * user to a question the planner cannot route (docs/06 §8.1).
   *
   * No Household state is read, and it is a `Query` for the same reason `assistantAnswer` is: asking
   * what can be asked writes nothing.
   */
  @Query(() => [String], {
    description: 'The answerable starter questions (docs/06 §8.1), for the assistant screen.',
  })
  assistantSuggestions(): readonly string[] {
    return SUGGESTED_QUESTIONS.map((suggestion) => suggestion.question);
  }
}
