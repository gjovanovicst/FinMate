import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

/**
 * The GraphQL surface for the classification pipeline (docs/06 §5.1, §5.2).
 *
 * Two shapes matter here and both are contracts, not conveniences:
 *
 * - **{@link ProposalModel}** is docs/06 §5.1's `Proposal!`. It carries `decidedBy` and `confidence`
 *   (F-07's acceptance criterion) plus the losing candidates, so the capture preview can explain a
 *   choice instead of asserting one (docs/04 P-3).
 * - **{@link ClassificationDecisionModel}** is F-31's audit trail, read straight from
 *   `classification_decisions`. It is exposed as the decided column values, not a recomputed story.
 *
 * **`amountMinor` is a `String`.** It is minor units, it comes from a `bigint`, and a JSON number is a
 * float — which ADR-003 forbids in the money path. The `Money` scalar is used wherever a *currency* is
 * also in play; here the amount is a bare reading from the parser with no ledger context yet.
 */

/** `classification_decisions.decided_by` — the CHECK constraint's closed list (docs/03 §4). */
export enum DecidedByEnum {
  USER = 'USER',
  RULE = 'RULE',
  AI = 'AI',
  MERCHANT_DEFAULT = 'MERCHANT_DEFAULT',
  COUNTERPARTY_DEFAULT = 'COUNTERPARTY_DEFAULT',
  KEYWORD = 'KEYWORD',
  FALLBACK = 'FALLBACK',
}

registerEnumType(DecidedByEnum, {
  name: 'DecidedBy',
  description:
    'Which layer produced the category, cheapest first: RULE, KEYWORD, MERCHANT_DEFAULT, ' +
    'COUNTERPARTY_DEFAULT, AI, USER, FALLBACK. The pipeline never guesses: an unavailable model ' +
    'records FALLBACK, never AI (docs/04 §9).',
});

/** docs/04 §9's degradation ladder, as the client renders it. */
export enum DegradationRungEnum {
  FULL_PIPELINE = 'FULL_PIPELINE',
  RULES_KEYWORDS_ONLY = 'RULES_KEYWORDS_ONLY',
  DETERMINISTIC_ONLY = 'DETERMINISTIC_ONLY',
  MANUAL_ENTRY = 'MANUAL_ENTRY',
}

registerEnumType(DegradationRungEnum, {
  name: 'DegradationRung',
  description:
    'How much of the pipeline actually ran. Rules and keywords are untouched by a provider outage, ' +
    'so capture still succeeds — the user can always record a transaction (docs/04 §9).',
});

/** docs/04 §3.2's direction, on a fragment that has not been committed yet. */
export enum FragmentKindEnum {
  EXPENSE = 'EXPENSE',
  INCOME = 'INCOME',
  UNKNOWN = 'UNKNOWN',
}

registerEnumType(FragmentKindEnum, {
  name: 'FragmentKind',
  description:
    'Direction as the parser read it. `UNKNOWN` means no direction signal at all, and ' +
    '`needsDirectionConfirmation` marks a refund/storno word where the sign must be asked about ' +
    'rather than guessed (docs/04 §3.1).',
});

@ObjectType({
  description:
    'One losing candidate from rules-engine or the keyword tier, recorded on every decision so a ' +
    'choice can be explained after the fact (docs/04 §5.3.5, P-3).',
})
export class AuditCandidateModel {
  @Field(() => String, { description: '`RULE`, `KEYWORD`, `ENTITY`, `DEFAULT` or `AMOUNT`.' })
  kind!: string;

  @Field(() => ID, { nullable: true })
  id!: string | null;

  @Field(() => String, { nullable: true, description: 'A rule name, an entity name, a keyword.' })
  name!: string | null;

  @Field(() => ID, { nullable: true, description: 'The category this candidate would have chosen.' })
  categoryId!: string | null;

  @Field(() => Float, { nullable: true })
  score!: number | null;

  @Field(() => Int, { nullable: true })
  matchedTokens!: number | null;

  @Field(() => String, { nullable: true })
  reason!: string | null;

  @Field(() => String, { nullable: true, description: '`INCLUDE` or `EXCLUDE`.' })
  polarity!: string | null;

  @Field(() => String, { nullable: true })
  matchMode!: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description: 'True when an EXCLUDE keyword hard-blocked this category (docs/04 §5.4).',
  })
  blocked!: boolean | null;

  @Field(() => Float, { nullable: true, description: 'An AI alternative’s raw confidence.' })
  confidence!: number | null;
}

@ObjectType({
  description: 'One AI alternative the model ranked below its choice (docs/04 §6.2, top 2–3).',
})
export class AlternativeModel {
  @Field(() => ID)
  categoryId!: string;

  @Field(() => Float, { description: 'Raw model confidence — not gated, not calibrated.' })
  confidence!: number;
}

@ObjectType({
  description:
    'One classified fragment (docs/06 §5.1). `needsReview` is the BLOCKING lane only — a null ' +
    'category or a calibrated confidence below 0.60 (docs/04 §7, invariant I-8). `advisory` is the ' +
    'derived 0.60–0.89 AI lane, which the nav badge must NOT count.',
})
export class ProposalModel {
  @Field(() => ID, { description: 'Echo this back as `acceptedProposalId` on captureCommit.' })
  id!: string;

  @Field(() => String)
  rawText!: string;

  @Field(() => ID, { nullable: true })
  categoryId!: string | null;

  @Field(() => DecidedByEnum)
  decidedBy!: DecidedByEnum;

  @Field(() => Float, {
    description:
      'The CALIBRATED confidence, three decimals — the gate consumes this, never the model’s ' +
      'self-reported number (ADR-009, docs/04 §6.4).',
  })
  confidence!: number;

  @Field(() => String, { description: 'Machine-readable reason; the UI localises its own copy.' })
  rationale!: string;

  @Field(() => Boolean, {
    description: 'The blocking review lane: `confidence < 0.60` OR no category (I-8).',
  })
  needsReview!: boolean;

  @Field(() => Boolean, {
    description:
      'The advisory lane: an AI suggestion at 0.60–0.89. Applied and valid, shown on a secondary ' +
      'tab, never counted by the nav badge (docs/04 §7).',
  })
  advisory!: boolean;

  @Field(() => ID, { nullable: true, description: 'The deciding rule, when one did.' })
  ruleId!: string | null;

  @Field(() => ID, { nullable: true, description: 'The Merchant/Counterparty the decision came from.' })
  merchantId!: string | null;

  @Field(() => ID, { nullable: true })
  counterpartyId!: string | null;

  @Field(() => [AlternativeModel])
  alternatives!: AlternativeModel[];

  @Field(() => String, {
    nullable: true,
    description: 'Minor units as a STRING. A JSON number would be a float (ADR-003).',
  })
  amountMinor!: string | null;

  @Field(() => String, { nullable: true })
  currency!: string | null;

  @Field(() => FragmentKindEnum)
  kind!: FragmentKindEnum;

  @Field(() => String, { nullable: true, description: 'ISO calendar day, `YYYY-MM-DD`.' })
  occurredOn!: string | null;

  @Field(() => String)
  description!: string;

  @Field(() => [String], { description: 'Folded content tokens, as the matcher saw them.' })
  tokens!: string[];

  @Field(() => Boolean, {
    description:
      'A refund/storno word was present, so the direction must be asked about rather than guessed ' +
      '(docs/04 §3.1).',
  })
  needsDirectionConfirmation!: boolean;

  @Field(() => [AuditCandidateModel], {
    description: 'Everything considered and rejected, with its score or reason.',
  })
  candidates!: AuditCandidateModel[];
}

@ObjectType({
  description:
    'A `classification_decisions` row (F-31): who or what chose this category, with what ' +
    'confidence, and — when a model was involved — which provider, model and prompt version.',
})
export class ClassificationDecisionModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { nullable: true, description: 'Set once captureCommit writes the Transaction.' })
  transactionId!: string | null;

  @Field(() => String)
  rawInput!: string;

  @Field(() => String, { description: 'The folded form matching actually compared.' })
  normalizedInput!: string;

  @Field(() => DecidedByEnum)
  decidedBy!: DecidedByEnum;

  @Field(() => ID, { nullable: true })
  ruleId!: string | null;

  @Field(() => ID, { nullable: true })
  categoryId!: string | null;

  @Field(() => Float, {
    nullable: true,
    description: 'Calibrated, `numeric(4,3)`. The raw value lives in `candidates.rawConfidence`.',
  })
  confidence!: number | null;

  @Field(() => String, { nullable: true, description: '`OPENAI`, `ANTHROPIC`, … when a model ran.' })
  aiProvider!: string | null;

  @Field(() => String, { nullable: true })
  aiModel!: string | null;

  @Field(() => Int, { nullable: true })
  promptVersion!: number | null;

  @Field(() => Int, {
    nullable: true,
    description: 'Null when no model call shipped — never 0, so “no model” stays distinguishable.',
  })
  latencyMs!: number | null;

  @Field(() => String, {
    nullable: true,
    description: 'Integer micro-units as a string, for the same reason Money is a string.',
  })
  costMicros!: string | null;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => String, {
    description: 'The `candidates` JSONB blob, verbatim — losing candidates and parse metadata.',
  })
  candidatesJson!: string;
}
