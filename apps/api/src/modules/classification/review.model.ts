import { ArgsType, Field, Float, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { Paginated } from '../../graphql/pagination';
import { LocalDateScalar } from '../../graphql/scalars/uuid.scalar';
import { TransactionModel } from '../ledger/transaction.model';
import { CorrectionModel, RuleModel, RuleProposalModel } from './rules.model';
import type { ReviewItemView } from './review.service';

/**
 * The review queue's GraphQL surface — docs/06 §4.2 (the query), §5.5 (`resolveReviewItem`).
 *
 * ## Deviations, recorded in docs/06 §5.5
 *
 * - **`reviewQueue` is not a `ReviewQueueConnection` with a `filter`/`sort` INPUT object.** The filter
 *   and sort are plain arguments. A separate input type for two enums and four scalars adds a layer
 *   with no contract of its own, and the arguments are the same fields.
 * - **`ReviewItemKind` is `TRANSACTION` only.** `RECEIPT_ITEM` needs the receipts module, which does
 *   not exist; returning the arm without a producer is the empty-list problem `duplicateSuspects`
 *   avoided.
 * - **`ReviewReason` is `LOW_CONFIDENCE | UNCATEGORISED`.** These are I-8's two disjuncts, and they are
 *   the only reasons the gate can produce. `AMBIGUOUS_AMOUNT`, `RECEIPT_MISMATCH` and
 *   `OFFLINE_RECLASSIFIED` have no producer yet.
 * - **`resolveReviewItem` returns the success type directly**, with conflicts on it — the same
 *   reasoning as `correctTransaction` (§5.3.1): the resolution was applied, so an error arm would tell
 *   the client nothing happened. `bulkResolveReviewItems` is **not built**: `applyToSimilar` is the
 *   bulk affordance this UI uses, and a second bulk path with its own conflict semantics is its own
 *   task.
 * - **`dashboardDelta` is absent**, as everywhere else (§5.2.4).
 */

/** docs/06 §4.2's `ReviewReason`, restricted to what I-8 produces. */
export enum ReviewReasonEnum {
  LOW_CONFIDENCE = 'LOW_CONFIDENCE',
  UNCATEGORISED = 'UNCATEGORISED',
}

registerEnumType(ReviewReasonEnum, {
  name: 'ReviewReason',
  description:
    'Why this row is in the blocking lane (invariant I-8): it has no category at all, or its ' +
    'calibrated confidence is below 0.60. The advisory band (0.60–0.89) is never in this queue.',
});

/** docs/06 §5.5's `ReviewResolveAction`. */
export enum ReviewActionEnum {
  ACCEPT_SUGGESTION = 'ACCEPT_SUGGESTION',
  SET_CATEGORY = 'SET_CATEGORY',
  MARK_AS_DUPLICATE = 'MARK_AS_DUPLICATE',
  VOID = 'VOID',
  DELETE = 'DELETE',
  KEEP_AS_IS = 'KEEP_AS_IS',
}

registerEnumType(ReviewActionEnum, {
  name: 'ReviewResolveAction',
  description:
    'What the user decided. `SET_CATEGORY` and `ACCEPT_SUGGESTION` are the learning-loop paths — ' +
    'choosing a category records a Correction and can create a rule (ADR-010).',
});

/** docs/06 §3.1's `ReviewItemKind`, as far as this build produces. */
export enum ReviewItemKindEnum {
  TRANSACTION = 'TRANSACTION',
}

registerEnumType(ReviewItemKindEnum, {
  name: 'ReviewItemKind',
  description: '`RECEIPT_ITEM` is declared in docs/06 §3.2 but needs the receipts module, which is not built.',
});

/** The queue's sort. Only the two id-aligned orders exist; see `ReviewSortEnum`. */
export enum ReviewSortEnum {
  RECORDED_ASC = 'RECORDED_ASC',
  RECORDED_DESC = 'RECORDED_DESC',
  OCCURRED_DESC = 'OCCURRED_DESC',
  OCCURRED_ASC = 'OCCURRED_ASC',
}

registerEnumType(ReviewSortEnum, {
  name: 'ReviewSort',
  description:
    '`RECORDED_ASC` (the default) is oldest-recorded first, so no row starves. docs/06 §4.2 also ' +
    'declares CONFIDENCE and AMOUNT sorts; those are **not** implemented, because a keyset page on a ' +
    'non-unique sort key needs a composite cursor and would silently repeat or skip rows.',
});

@ObjectType({ description: 'One losing proposal, for the numbered alternatives in docs/02 §4.6.' })
export class ReviewCandidateModel {
  @Field(() => ID)
  categoryId!: string;

  @Field(() => Float, { description: 'The **raw** model confidence — recorded, not gated (docs/04 §6.4).' })
  confidence!: number;
}

@ObjectType({
  description:
    'A Transaction awaiting a decision (F-08). It is in the BLOCKING lane: `needs_review = true` ' +
    'because it has no category or a calibrated confidence below 0.60 (invariant I-8).',
})
export class ReviewQueueItemModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ReviewItemKindEnum)
  kind!: ReviewItemKindEnum;

  @Field(() => TransactionModel)
  transaction!: TransactionModel;

  @Field(() => ReviewReasonEnum)
  reason!: ReviewReasonEnum;

  @Field(() => Float, {
    nullable: true,
    description: 'The calibrated confidence. Null when nothing was recorded, which is not the same as zero.',
  })
  confidence!: number | null;

  @Field(() => ID, {
    nullable: true,
    description:
      'The category to accept. Null for an uncategorised row — there is nothing to suggest, and ' +
      'inventing one is what the queue exists to avoid.',
  })
  suggestedCategoryId!: string | null;

  @Field(() => [ReviewCandidateModel])
  candidates!: ReviewCandidateModel[];

  @Field(() => Int, { description: 'Hours since the row was recorded — the queue’s sort key.' })
  ageHours!: number;
}

/** `Paginated(...)` builds `ReviewQueueItemModelConnection`; the SDL calls it `ReviewQueueConnection`. */
export const ReviewQueuePage = Paginated(ReviewQueueItemModel);

@ArgsType()
export class ReviewQueueArgs {
  @Field(() => Int, { nullable: true })
  first?: number;

  @Field(() => String, { nullable: true })
  after?: string;

  @Field(() => ReviewSortEnum, { nullable: true })
  sort?: ReviewSortEnum;

  @Field(() => [ReviewReasonEnum], { nullable: true })
  reason?: ReviewReasonEnum[];

  @Field(() => Float, { nullable: true, description: 'Only rows below this calibrated confidence.' })
  confidenceBelow?: number;

  @Field(() => LocalDateScalar, { nullable: true })
  occurredOnOrAfter?: string;

  @Field(() => LocalDateScalar, { nullable: true })
  occurredOnOrBefore?: string;

  @Field(() => [ID], { nullable: true })
  categoryIds?: string[];
}

@InputType()
export class ResolveReviewItemInput {
  @Field(() => ID)
  id!: string;

  @Field(() => ReviewActionEnum)
  action!: ReviewActionEnum;

  @Field(() => ID, { nullable: true, description: 'Required for `SET_CATEGORY`.' })
  categoryId?: string | null;

  @Field(() => Boolean, {
    defaultValue: false,
    description:
      'The "Zapamti za ubuduće" checkbox (F-09). Records the Correction either way; a rule is ' +
      'created only when the trigger is a resolved entity and nothing shadows it (docs/06 §5.3).',
  })
  rememberForFuture!: boolean;

  @Field(() => Boolean, {
    defaultValue: false,
    description:
      'Resolve every queued row sharing the same resolved entity AND the same suggestion in one ' +
      'operation (F-08’s power affordance). One decision, one Correction — the peers are an ' +
      'application of that decision, not N decisions.',
  })
  applyToSimilar!: boolean;
}

@ObjectType()
export class ResolveReviewItemSuccessModel {
  @Field(() => ReviewQueueItemModel, {
    nullable: true,
    description: 'The item refreshed after resolution — null when the action removed it (DELETE, VOID).',
  })
  item!: ReviewQueueItemModel | null;

  @Field(() => TransactionModel, { nullable: true })
  transaction!: TransactionModel | null;

  @Field(() => CorrectionModel, { nullable: true })
  correction!: CorrectionModel | null;

  @Field(() => RuleProposalModel, { nullable: true })
  synthesisedRule!: RuleProposalModel | null;

  @Field(() => RuleModel, { nullable: true })
  ruleCreated!: RuleModel | null;

  @Field(() => Int, {
    description:
      'How many rows this resolution actually cleared, including the one acted on. 1 when ' +
      '`applyToSimilar` was not asked for or found no peers.',
  })
  resolvedSimilarCount!: number;

  @Field(() => Int, { description: 'The blocking-lane count after this resolution — the nav badge.' })
  reviewQueueCount!: number;
}

/**
 * `resolveReviewItem` returns the success type directly.
 *
 * docs/06 §5.5 declares a union with a `RuleConflictError` arm. As with `correctTransaction`
 * (§5.3.1), the resolution has already been applied by the time a proposal conflict is known, so an
 * error arm would tell the client nothing happened. Conflicts are not part of this payload either:
 * the action is what the user asked for, and the proposal is a side effect they can answer on the
 * rules screen.
 */
/**
 * The queue item as the GraphQL type, field by field.
 *
 * `Money` and `LocalDate` ride on the Transaction itself, so the item does not repeat them —
 * docs/06 §3.2's `ReviewQueueItem.amount`/`occurredOn` are the Transaction's, and a second copy is a
 * second thing that can disagree.
 */
export function toItemModel(item: ReviewItemView): ReviewQueueItemModel {
  return {
    id: item.id,
    kind: ReviewItemKindEnum.TRANSACTION,
    transaction: item.transaction,
    reason: item.reason as ReviewReasonEnum,
    confidence: item.confidence,
    suggestedCategoryId: item.suggestedCategoryId,
    candidates: item.candidates.map((candidate) => ({
      categoryId: candidate.categoryId,
      confidence: candidate.confidence,
    })),
    ageHours: item.ageHours,
  };
}

