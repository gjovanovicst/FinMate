import { Args, ArgsType, Field, Float, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { toConnection } from '../../graphql/pagination';
import { LocalDateScalar } from '../../graphql/scalars/uuid.scalar';
import type { CorrectionView } from '../classification/corrections.service';
import {
  ReviewQueueItemModel,
  ReviewQueuePage,
  ReviewReasonEnum,
  ReviewSortEnum,
  ResolveReviewItemInput,
  ResolveReviewItemSuccessModel,
  toItemModel,
} from '../classification/review.model';
import { toRuleModel } from '../classification/rules.resolver';
import { ReviewService } from '../classification/review.service';
import { CorrectionModel } from '../classification/rules.model';
import {
  TransactionsService,
  type ReviewAction,
  type TransactionSort,
} from './transactions.service';

/**
 * The review queue's GraphQL surface — docs/06 §4.2 (the query), §5.5 (`resolveReviewItem`).
 *
 * ## Why the resolver is on the ledger, not on classification
 *
 * It needs **both**: the ledger's `list` (the rows are Transactions, and the ledger owns how they are
 * filtered, paged and written) and the classification module's `ReviewService` (the decision behind
 * each row). The module edge is one-directional — `ledger → classification`, established by
 * `captureCommit` — so this is the only side that can compose them. The GraphQL schema does not care
 * which resolver declares a field.
 *
 * ## Deviations from the SDL, recorded in docs/06 §5.5
 *
 * - **The filter and sort are plain arguments**, not a `ReviewQueueFilterInput`/`ReviewQueueSortInput`
 *   object. Two enums and four scalars do not need a layer with no contract of its own.
 * - **`ReviewItemKind` is `TRANSACTION` only.** `RECEIPT_ITEM` needs the receipts module, which does
 *   not exist; declaring the arm without a producer is the empty-list problem `duplicateSuspects`
 *   avoided.
 * - **`ReviewReason` is `LOW_CONFIDENCE | UNCATEGORISED`.** These are I-8's two disjuncts and the only
 *   reasons the gate can produce. `AMBIGUOUS_AMOUNT`, `RECEIPT_MISMATCH` and `OFFLINE_RECLASSIFIED`
 *   have no producer yet.
 * - **`resolveReviewItem` returns the success type directly.** The resolution has already been applied
 *   by the time a proposal conflict is known, so an error arm would tell the client nothing happened —
 *   the same reasoning as `correctTransaction` (§5.3.1). `bulkResolveReviewItems` is not built:
 *   `applyToSimilar` is the bulk affordance, and a second bulk path with its own conflict semantics is
 *   its own task. `dashboardDelta` is absent as everywhere else (§5.2.4).
 * - **`CONFIDENCE` and `AMOUNT` sorts are not implemented.** A keyset page on a non-unique sort key
 *   needs a composite cursor, and a page boundary placed on one silently repeats or skips rows.
 */

@ArgsType()
export class ReviewQueueArgs {
  @Field(() => Int, { nullable: true })
  first?: number;

  @Field(() => String, { nullable: true, description: 'Cursor from a previous page.' })
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

@Resolver(() => ReviewQueueItemModel)
export class ReviewResolver {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly review: ReviewService,
  ) {}

  @Query(() => ReviewQueuePage, {
    description:
      'The blocking lane (invariant I-8): Transactions with no category or a calibrated confidence ' +
      'below 0.60, oldest-recorded first so nothing starves. The advisory band is not here — those ' +
      'rows are applied and valid (docs/04 §7).',
  })
  async reviewQueue(@CurrentHouseholdId() householdId: string, @Args() args: ReviewQueueArgs) {
    const page = await this.transactions.list(householdId, { needsReview: true }, {
      ...(args.first === undefined ? {} : { first: args.first }),
      ...(args.after === undefined ? {} : { after: args.after }),
      // Oldest-recorded first by default: a row entered late for an old date would otherwise sit
      // behind everything, and a queue that can starve is a queue that stops being cleared.
      sort: (args.sort ?? ReviewSortEnum.RECORDED_ASC) as TransactionSort,
    });

    // The decision join is classification's; the rows are the ledger's. One query each.
    const enriched = await this.review.enrich(householdId, page.items);
    const filtered = this.review.filter(enriched, {
      ...(args.reason === undefined ? {} : { reason: args.reason as never }),
      ...(args.confidenceBelow === undefined ? {} : { confidenceBelow: args.confidenceBelow }),
      ...(args.occurredOnOrAfter === undefined ? {} : { occurredOnOrAfter: args.occurredOnOrAfter }),
      ...(args.occurredOnOrBefore === undefined ? {} : { occurredOnOrBefore: args.occurredOnOrBefore }),
      ...(args.categoryIds === undefined ? {} : { categoryIds: args.categoryIds }),
    });

    return toConnection({
      items: filtered.map(toItemModel),
      totalCount: page.totalCount,
      hasNextPage: page.hasNextPage,
      endCursor: page.endCursor,
    });
  }

  @Query(() => Int, {
    description:
      'The BLOCKING lane count (invariant I-8) — the nav badge. A scoped COUNT, so the shell can ask ' +
      'on every screen without loading rows.',
  })
  async reviewQueueCount(@CurrentHouseholdId() householdId: string): Promise<number> {
    return this.review.count(householdId);
  }

  @Mutation(() => ResolveReviewItemSuccessModel, {
    description:
      'Resolve one queued row (docs/06 §5.5). Choosing a category goes through the correction path, so ' +
      'it records a Correction and can create a rule — the queue is a learning surface, not a dismiss ' +
      'button. Resolving an already-resolved row is a NO-OP rather than a conflict: two devices ' +
      'clearing the same queue is not an error.',
  })
  async resolveReviewItem(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => ResolveReviewItemInput }) input: ResolveReviewItemInput,
  ): Promise<ResolveReviewItemSuccessModel> {
    const outcome = await this.transactions.resolveReviewItem(householdId, {
      id: input.id,
      action: input.action as ReviewAction,
      categoryId: input.categoryId ?? null,
      rememberForFuture: input.rememberForFuture,
      applyToSimilar: input.applyToSimilar,
    });

    const refreshed = await this.review.enrich(householdId, [outcome.transaction]);

    return {
      item: refreshed[0] === undefined ? null : toItemModel(refreshed[0]),
      transaction: outcome.transaction,
      correction: outcome.correction === null ? null : toCorrectionModel(outcome.correction),
      synthesisedRule:
        outcome.synthesis === null
          ? null
          : {
              name: outcome.synthesis.synthesis.proposal.name,
              priority: outcome.synthesis.synthesis.proposal.priority,
              conditions: outcome.synthesis.synthesis.proposal.conditions,
              actions: outcome.synthesis.synthesis.proposal.actions,
              origin: outcome.synthesis.synthesis.proposal.origin as never,
              explanation: outcome.synthesis.synthesis.proposal.explanation,
              explanationCode: outcome.synthesis.synthesis.proposal.explanationCode,
              trigger: outcome.synthesis.synthesis.proposal.trigger as never,
              confidence: outcome.synthesis.synthesis.proposal.confidence,
            },
      ruleCreated: outcome.ruleCreated === null ? null : toRuleModel(outcome.ruleCreated),
      resolvedSimilarCount: outcome.resolvedSimilarCount,
      reviewQueueCount: await this.review.count(householdId),
    };
  }
}

/** A correction as the GraphQL type, field by field — the same shape `correctTransaction` returns. */
export function toCorrectionModel(row: CorrectionView): CorrectionModel {
  return {
    id: row.id,
    transactionId: row.transactionId,
    field: row.field as never,
    fromValue: row.fromValue,
    toValue: row.toValue,
    wasAiSuggested: row.wasAiSuggested,
    ruleCreatedId: row.ruleCreatedId,
    ruleCreated: row.ruleCreated === null ? null : toRuleModel(row.ruleCreated),
    createdAt: row.createdAt,
  };
}
