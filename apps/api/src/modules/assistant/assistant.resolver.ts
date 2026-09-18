import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId, CurrentTenant } from '../../common/auth/current-tenant.decorator';
import { ApiError } from '../../common/filters/all-exceptions.filter';
import type { MemberRole, TenantContext } from '../../common/tenancy/tenant-context';
import { CategoryKind } from '../taxonomy/category.model';
import { ACTION_TEMPLATES, type ActionTemplate } from './assistant-actions';
import { planAction, missingActionSlots } from './action-planner';
import { AssistantActionService } from './assistant-action.service';
import { SUGGESTED_QUESTIONS } from './assistant-intents';
import { AssistantService } from './assistant.service';
import { UuidScalar } from '../../graphql/scalars/uuid.scalar';
import {
  AssistantActionProposalModel,
  AssistantActionResultModel,
  AssistantAnswerModel,
  toActionProposalModel,
  toActionResultModel,
  toAssistantAnswerModel,
} from './assistant.model';

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
  constructor(
    private readonly assistant: AssistantService,
    private readonly actions: AssistantActionService,
  ) {}

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

  /**
   * Turn a question into a **proposal** — a `Query`, because proposing writes nothing to the ledger.
   *
   * The proposal itself is stored server-side (Redis, short TTL) so that the confirmation can carry
   * only its id: the executed action is then byte-for-byte the action the card showed (ADR-035
   * decision 2). `proposed: false` is a **refusal**, not an error — the question asked for nothing
   * this registry does, or did not say what — which mirrors `assistantAnswer`'s `answered: false`.
   *
   * Real failures do throw: a name that is invalid, one that already exists, or a store that could not
   * hold the proposal.
   */
  @Mutation(() => AssistantActionProposalModel, {
    description:
      'Propose a write from a question (e.g. "dodaj kategoriju Putovanja"). Changes nothing in the ' +
      'ledger; the returned `proposalId` is the only argument the execute mutation accepts (ADR-035). ' +
      'A **Mutation**, not a Query, and the reason is `ADD_TRANSACTION`: proposing one runs the ' +
      'classification pipeline, which records a `classification_decisions` row and may call a model — ' +
      '`captureParse` is a Mutation for exactly that reason. A Query that spends money is a lie about ' +
      'itself, and the operation type must cover an operation at its worst, not its cheapest.',
  })
  async assistantProposeAction(
    @CurrentTenant() tenant: TenantContext,
    @Args('question', { type: () => String }) question: string,
    @Args('kind', { type: () => CategoryKind, nullable: true }) kind?: CategoryKind,
    @Args('accountId', { type: () => ID, nullable: true }) accountId?: string,
    @Args('locale', { type: () => String, nullable: true }) locale?: string,
  ): Promise<AssistantActionProposalModel> {
    const plan = planAction(question);
    if (plan === null) {
      return toActionProposalModel({ proposed: false, reason: 'NOT_AN_ACTION' });
    }

    const missing = missingActionSlots(plan.action, plan.slots);
    if (missing.length > 0) {
      // The question is unmistakably a request for this action but does not say what to write. A
      // silent fall-through to the read planner would answer a question nobody asked.
      return toActionProposalModel({
        proposed: false,
        reason: `UNRUNNABLE:${missing.join(',')}`,
      });
    }

    assertCanPerform(tenant.role, ACTION_TEMPLATES[plan.action]);

    const outcome = await this.actions.propose({
      householdId: tenant.householdId,
      userId: tenant.userId,
      action: plan.action,
      // These are the card's editable defaults, and supplying one **re-proposes** rather than changing
      // an existing proposal — which is what keeps the confirmation honest: the id a person confirms
      // always names the action they were shown. Which of them the action even has is the registry's
      // business, and the service drops the rest.
      slots: {
        ...plan.slots,
        ...(kind === undefined || kind === null ? {} : { kind }),
        ...(accountId === undefined || accountId === null ? {} : { accountId }),
      },
      ...(locale === undefined || locale === null ? {} : { locale }),
    });

    if (!outcome.proposed) {
      // A refusal is not an error: the question asked for nothing this registry does, or asked for
      // something the pipeline could not build a row from (`NO_AMOUNT`, `AMBIGUOUS_AMOUNT`, …).
      return toActionProposalModel({ proposed: false, reason: outcome.reason });
    }

    return toActionProposalModel({
      proposed: true,
      proposalId: outcome.proposalId,
      action: outcome.action,
      preview: outcome.preview,
      // The service speaks ISO strings (it stores them); the wire type speaks `Date`, which
      // `@Field(() => Date)` renders as the `DateTime` scalar.
      expiresAt: new Date(outcome.expiresAt),
    });
  }

  /**
   * Perform the action the human approved.
   *
   * A `Mutation`, and the only place the assistant can change the ledger. It reads a proposal and
   * performs **that**; the arguments the human approved are never sent back by the client, so a
   * changed-args race cannot exist. `idempotencyKey` makes a retry safe: the outcome is remembered
   * against it, so a repeated call answers the same result instead of writing twice.
   */
  @Mutation(() => AssistantActionResultModel, {
    description:
      'Execute a proposal by id. The action performed is the one the proposal stored — never one ' +
      'supplied with this call (ADR-035 decision 2).',
  })
  async assistantExecuteAction(
    @CurrentTenant() tenant: TenantContext,
    @Args('proposalId', { type: () => UuidScalar }) proposalId: string,
    @Args('idempotencyKey', { type: () => String }) idempotencyKey: string,
  ): Promise<AssistantActionResultModel> {
    const executed = await this.actions.execute({
      householdId: tenant.householdId,
      proposalId,
      idempotencyKey,
    });
    return toActionResultModel(executed);
  }
}

/**
 * A rank, so a requirement can be "at least this". `VIEWER` is the one that matters: it exists as a
 * role and **nothing enforces it today**, so this is the first write path that refuses one.
 */
const RANK: Readonly<Record<MemberRole, number>> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

function assertCanPerform(role: MemberRole, template: ActionTemplate): void {
  if (RANK[role] < RANK[template.role]) {
    throw new ApiError('FORBIDDEN', 'Your role cannot perform that action.');
  }
}
