import { Args, ArgsType, Field, ID, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { LocalDateScalar } from '../../graphql/scalars/uuid.scalar';
import {
  ClassificationDecisionModel,
  DecidedByEnum,
  DegradationRungEnum,
  ProposalModel,
} from './classification.model';
import { ClassificationService, type FragmentResult } from './classification.service';

/**
 * The capture-preview resolver — docs/06 §5.1 (`captureParse`) and the F-31 audit read.
 *
 * ## `householdId` never comes from the client
 *
 * Every method takes `@CurrentHouseholdId()`, which fails closed when no `TenantContext` is active
 * (ADR-008). There is deliberately no `householdId` argument on any input type: a client cannot name
 * a Household, so it cannot probe for one.
 *
 * ## Why `captureParse` is a mutation
 *
 * It is read-only with respect to the ledger, but it **writes** a `classification_decisions` row per
 * fragment for audit and cost (docs/06 §5.1). A GraphQL `query` that inserts rows would be invisible
 * to every client-side cache and retry policy, so the mutation is the honest classification.
 */

@ArgsType()
export class CaptureParseArgs {
  @Field(() => String, {
    description:
      'One or more fragments separated by comma, `;`, newline, `+`, ` i ` or ` pa ` — ' +
      '`Lidl 2000, gorivo 3500, plata 150000` is three fragments (docs/04 §3).',
  })
  text!: string;

  @Field(() => String, { nullable: true, description: 'Defaults to the Household locale.' })
  locale?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description:
      '`false` ⇒ rules and keywords only, no egress. The user-level consent switch (docs/08 §6.7).',
  })
  allowAi?: boolean;

  @Field(() => Date, { nullable: true, description: 'Defaults to now.' })
  occurredAt?: Date | null;

  @Field(() => LocalDateScalar, {
    nullable: true,
    description:
      'The Household local day, when the client knows it. Derived from the instant and the ' +
      'Household timezone otherwise (docs/03 §3.2).',
  })
  occurredLocalDate?: string | null;
}

@ObjectType({
  description:
    'The capture preview (docs/06 §5.1). Nothing in the ledger changed; one audit row per fragment ' +
    'was written.',
})
export class CaptureParseResultModel {
  @Field(() => ID, { description: 'Binds this preview to a later captureCommit.' })
  parseId!: string;

  @Field(() => String)
  rawText!: string;

  @Field(() => [ProposalModel], { description: 'One per detected fragment, in input order.' })
  fragments!: ProposalModel[];

  @Field(() => [String], { description: 'Text the segmenter could not attach to a fragment.' })
  unresolvedSegments!: string[];

  @Field(() => Boolean, { description: 'True when a model contributed to at least one decision.' })
  usedAi!: boolean;

  @Field(() => Boolean, {
    description: 'True when the run was not the full pipeline — an outage, not an error (docs/04 §9).',
  })
  degraded!: boolean;

  @Field(() => DegradationRungEnum)
  rung!: DegradationRungEnum;

  @Field(() => Int)
  latencyMs!: number;
}

@Resolver(() => ProposalModel)
export class ClassificationResolver {
  constructor(private readonly classification: ClassificationService) {}

  @Mutation(() => CaptureParseResultModel, {
    description:
      'Parse and classify without touching the ledger — writes one `classification_decisions` row ' +
      'per fragment for audit and cost (F-07, F-31). Safe to call on every keystroke pause.',
  })
  async captureParse(
    @CurrentHouseholdId() householdId: string,
    @Args() args: CaptureParseArgs,
  ): Promise<CaptureParseResultModel> {
    const result = await this.classification.parse(householdId, {
      text: args.text,
      locale: args.locale ?? null,
      allowAi: args.allowAi ?? true,
      occurredAt: args.occurredAt ?? null,
      localDay: args.occurredLocalDate ?? null,
    });

    return {
      parseId: result.parseId,
      rawText: result.rawText,
      fragments: result.fragments.map(toProposal),
      unresolvedSegments: [...result.unresolvedSegments],
      usedAi: result.usedAi,
      degraded: result.degraded,
      rung: result.rung as DegradationRungEnum,
      latencyMs: result.latencyMs,
    };
  }

  @Query(() => [ClassificationDecisionModel], {
    description:
      'The classification audit trail for one Transaction (F-31): which layer chose the category, ' +
      'with what confidence, and — when a model was involved — which provider and prompt version.',
  })
  async classificationDecisions(
    @CurrentHouseholdId() householdId: string,
    @Args('transactionId', { type: () => ID }) transactionId: string,
  ): Promise<ClassificationDecisionModel[]> {
    const rows = await this.classification.decisionsForTransaction(householdId, transactionId);
    return rows.map((row) => ({
      id: row.id,
      transactionId: row.transaction_id,
      rawInput: row.raw_input,
      normalizedInput: row.normalized_input,
      decidedBy: row.decided_by as DecidedByEnum,
      ruleId: row.rule_id,
      categoryId: row.category_id,
      // `numeric(4,3)` comes back as a Prisma Decimal; `Number` is correct here because a confidence
      // is a probability, not money (ADR-003 governs `amount_minor`).
      confidence: row.confidence === null ? null : Number(row.confidence),
      aiProvider: row.ai_provider,
      aiModel: row.ai_model,
      promptVersion: row.prompt_version,
      latencyMs: row.latency_ms,
      costMicros: row.cost_micros === null ? null : row.cost_micros.toString(),
      createdAt: row.created_at,
      candidatesJson: JSON.stringify(row.candidates ?? {}),
    }));
  }
}

/**
 * Service fragment → GraphQL proposal.
 *
 * Written field by field rather than spread, so adding a field to the service result cannot silently
 * publish it on the schema — a new field is a deliberate schema change and a reviewable diff.
 */
export function toProposal(fragment: FragmentResult): ProposalModel {
  return {
    id: fragment.decisionId,
    rawText: fragment.rawText,
    categoryId: fragment.categoryId,
    decidedBy: fragment.decidedBy as DecidedByEnum,
    confidence: fragment.confidence,
    rationale: fragment.rationale,
    needsReview: fragment.needsReview,
    advisory: fragment.advisory,
    ruleId: fragment.ruleId,
    merchantId: fragment.merchantId,
    counterpartyId: fragment.counterpartyId,
    alternatives: fragment.alternatives.map((alternative) => ({
      categoryId: alternative.categoryId,
      confidence: alternative.confidence,
    })),
    amountMinor: fragment.amountMinor,
    currency: fragment.currency,
    kind: fragment.kind as ProposalModel['kind'],
    occurredOn: fragment.occurredOn,
    description: fragment.description,
    tokens: [...fragment.tokens],
    needsDirectionConfirmation: fragment.needsDirectionConfirmation,
    candidates: fragment.candidates.map((candidate) => ({
      kind: candidate.kind,
      id: candidate.id ?? null,
      name: candidate.name ?? null,
      categoryId: candidate.categoryId ?? null,
      score: candidate.score ?? null,
      matchedTokens: candidate.matchedTokens ?? null,
      reason: candidate.reason ?? null,
      polarity: candidate.polarity ?? null,
      matchMode: candidate.matchMode ?? null,
      blocked: candidate.blocked ?? null,
      confidence: candidate.confidence ?? null,
    })),
  };
}
