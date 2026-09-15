import { Args, ArgsType, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { toConnection } from '../../graphql/pagination';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar } from '../../graphql/scalars/uuid.scalar';
import { toClassificationDecisionModel } from '../classification/classification.resolver';
import { ClassificationService } from '../classification/classification.service';
import {
  CorrectionsService,
  RuleShadowedError,
  type CorrectionRow,
} from '../classification/corrections.service';
import { toRuleConflictModel, toRuleModel } from '../classification/rules.resolver';
import {
  CorrectTransactionInput,
  CorrectTransactionSuccessModel,
  CreateRuleFromCorrectionInput,
  CreateRuleFromCorrectionResult,
  type CreateRuleFromCorrectionSuccessModel,
  type RuleConflictErrorModel,
} from '../classification/rules.model';
import {
  CaptureCommitInput,
  CaptureCommitResult,
  toCommitRow,
  type CaptureCommitRejectedModel,
  type CaptureCommitSuccessModel,
} from './capture-commit.model';
import {
  TransactionConnection,
  TransactionKind,
  TransactionModel,
  TransactionStatus,
} from './transaction.model';
import { CaptureCommitRejected, TransactionsService } from './transactions.service';

@ArgsType()
export class TransactionsPageArgs {
  @Field(() => Int, { nullable: true })
  first?: number;

  @Field(() => String, { nullable: true, description: 'Cursor from a previous page.' })
  after?: string;

  @Field(() => ID, { nullable: true })
  accountId?: string;

  @Field(() => ID, { nullable: true })
  categoryId?: string;

  @Field(() => TransactionKind, { nullable: true })
  kind?: TransactionKind;

  @Field(() => TransactionStatus, { nullable: true })
  status?: TransactionStatus;

  @Field(() => LocalDateScalar, { nullable: true, description: 'Inclusive lower bound.' })
  from?: string;

  @Field(() => LocalDateScalar, { nullable: true, description: 'Inclusive upper bound.' })
  to?: string;

  @Field(() => String, { nullable: true, description: 'Substring match on the description.' })
  search?: string;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Filter to the BLOCKING review lane only (invariant I-8).',
  })
  needsReview?: boolean;
}

@InputType({
  description:
    'One portion of a split. The amounts across all splits must sum EXACTLY to the transaction ' +
    'amount (invariant I-1).',
})
export class SplitInput {
  @Field(() => ID)
  categoryId!: string;

  @Field(() => MoneyScalar)
  amount!: { amountMinor: string; currency: string };

  @Field(() => String, { nullable: true })
  note?: string;
}

@ObjectType({
  description: 'A split the backend computed, so the client never rounds money itself (ADR-003).',
})
export class ProposedSplit {
  @Field(() => ID)
  categoryId!: string;

  @Field(() => MoneyScalar)
  amount!: { amountMinor: string; currency: string };
}

@ArgsType()
export class CreateTransactionArgs {
  @Field(() => ID)
  accountId!: string;

  @Field(() => TransactionKind)
  kind!: TransactionKind;

  @Field(() => MoneyScalar, {
    description: 'Always positive. `kind` carries the direction, never a sign (ADR-003).',
  })
  amount!: { amountMinor: string; currency: string };

  @Field(() => String)
  description!: string;

  @Field(() => Date, { nullable: true })
  occurredAt?: Date;

  @Field(() => LocalDateScalar, {
    nullable: true,
    description:
      'The calendar day the user picked. Preferred over occurredAt for date-only entry: the server derives a stable instant, so a client never has to know the Household timezone (I-2).',
  })
  occurredLocalDate?: string | null;

  @Field(() => ID, { nullable: true })
  categoryId?: string | null;

  @Field(() => ID, { nullable: true })
  merchantId?: string | null;

  @Field(() => ID, { nullable: true })
  counterpartyId?: string | null;

  @Field(() => [ID], {
    nullable: true,
    description:
      'Tags to attach (docs/01 F-12). Optional, so every existing caller keeps working. An id that ' +
      'is not a Tag of this Household is a VALIDATION_FAILED, never a silent no-op.',
  })
  tagIds?: string[];

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => [SplitInput], {
    nullable: true,
    description:
      'Divide the amount across categories. Must sum EXACTLY to `amount` (invariant I-1); use ' +
      '`proposeSplits` to allocate without losing a para.',
  })
  splits?: SplitInput[];

  @Field(() => String, {
    nullable: true,
    description:
      'Makes the write idempotent: replaying the same key returns the original row instead of ' +
      'creating a second one (invariant I-10).',
  })
  idempotencyKey?: string | null;
}

@ArgsType()
export class UpdateTransactionArgs {
  @Field(() => ID)
  id!: string;

  @Field(() => Int, {
    description: 'The version you read. A mismatch is a CONFLICT rather than a silent overwrite.',
  })
  version!: number;

  @Field(() => MoneyScalar, { nullable: true })
  amount?: { amountMinor: string; currency: string };

  @Field(() => String, { nullable: true })
  description?: string;

  @Field(() => Date, { nullable: true })
  occurredAt?: Date;

  @Field(() => LocalDateScalar, {
    nullable: true,
    description:
      'The calendar day the user picked. Preferred over occurredAt for date-only entry: the server derives a stable instant, so a client never has to know the Household timezone (I-2).',
  })
  occurredLocalDate?: string | null;

  @Field(() => ID, { nullable: true })
  categoryId?: string | null;

  @Field(() => ID, { nullable: true })
  merchantId?: string | null;

  @Field(() => ID, { nullable: true })
  counterpartyId?: string | null;

  @Field(() => [ID], {
    nullable: true,
    description:
      'REPLACES the Tag set when provided; omitted leaves the existing assignments alone, and an ' +
      'empty array removes them all. The unusual shape is deliberate: the same absent-vs-empty ' +
      'distinction the rest of this update uses.',
  })
  tagIds?: string[];

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => TransactionStatus, { nullable: true })
  status?: TransactionStatus;
}

@Resolver(() => TransactionModel)
export class TransactionsResolver {
  constructor(
    private readonly transactionsService: TransactionsService,
    // `captureCommit` returns the classification decision behind every row it wrote (F-31). The
    // ledger already depends on the classification module for its pipeline, so this is the same
    // edge, not a new one.
    private readonly classification: ClassificationService,
    private readonly corrections: CorrectionsService,
  ) {}

  @Query(() => TransactionConnection, {
    description: 'Transactions, newest first, keyset-paginated on the UUIDv7 id.',
  })
  async transactions(
    @Args() args: TransactionsPageArgs,
    @CurrentHouseholdId() householdId: string,
  ) {
    const page = await this.transactionsService.list(
      householdId,
      {
        ...(args.accountId ? { accountId: args.accountId } : {}),
        ...(args.categoryId ? { categoryId: args.categoryId } : {}),
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.status ? { status: args.status } : {}),
        ...(args.from ? { from: args.from } : {}),
        ...(args.to ? { to: args.to } : {}),
        ...(args.search ? { search: args.search } : {}),
        ...(args.needsReview !== undefined ? { needsReview: args.needsReview } : {}),
      },
      { first: args.first, after: args.after },
    );
    return toConnection(page);
  }

  @Query(() => TransactionModel)
  async transaction(
    @Args('id', { type: () => ID }) id: string,
    @CurrentHouseholdId() householdId: string,
  ): Promise<TransactionModel> {
    return this.transactionsService.getById(householdId, id);
  }

  @Mutation(() => TransactionModel)
  async createTransaction(
    @Args() args: CreateTransactionArgs,
    @CurrentHouseholdId() householdId: string,
  ): Promise<TransactionModel> {
    return this.transactionsService.create(householdId, {
      accountId: args.accountId,
      kind: args.kind,
      amountMinor: BigInt(args.amount.amountMinor),
      description: args.description,
      occurredAt: args.occurredAt ?? null,
      occurredLocalDate: args.occurredLocalDate ?? null,
      categoryId: args.categoryId ?? null,
      merchantId: args.merchantId ?? null,
      counterpartyId: args.counterpartyId ?? null,
      note: args.note ?? null,
      // `undefined` here means "no tags", which is what a create wants: there is no existing set to
      // leave alone.
      tagIds: args.tagIds ?? [],
      ...(args.splits?.length
        ? {
            splits: args.splits.map((split) => ({
              categoryId: split.categoryId,
              amountMinor: BigInt(split.amount.amountMinor),
              note: split.note ?? null,
            })),
          }
        : {}),
      idempotencyKey: args.idempotencyKey ?? null,
    });
  }

  @Mutation(() => TransactionModel)
  async updateTransaction(
    @Args() args: UpdateTransactionArgs,
    @CurrentHouseholdId() householdId: string,
  ): Promise<TransactionModel> {
    return this.transactionsService.update(householdId, args.id, {
      version: args.version,
      ...(args.amount ? { amountMinor: BigInt(args.amount.amountMinor) } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.occurredAt !== undefined ? { occurredAt: args.occurredAt } : {}),
      ...(args.occurredLocalDate != null ? { occurredLocalDate: args.occurredLocalDate } : {}),
      ...(args.categoryId !== undefined ? { categoryId: args.categoryId } : {}),
      ...(args.merchantId !== undefined ? { merchantId: args.merchantId } : {}),
      ...(args.counterpartyId !== undefined ? { counterpartyId: args.counterpartyId } : {}),
      ...(args.tagIds !== undefined ? { tagIds: args.tagIds } : {}),
      ...(args.note !== undefined ? { note: args.note } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
    });
  }

  @Mutation(() => Boolean, {
    description: 'Soft-delete. Financial rows are never hard-deleted, so history stays auditable.',
  })
  async deleteTransaction(
    @Args('id', { type: () => ID }) id: string,
    @CurrentHouseholdId() householdId: string,
  ): Promise<boolean> {
    await this.transactionsService.remove(householdId, id);
    return true;
  }

  @Mutation(() => CaptureCommitResult, {
    description:
      'The write half of the capture path (docs/06 §5.2). Validates, classifies and writes the whole ' +
      '`rows` array in ONE database transaction: if any row is structurally invalid nothing is ' +
      'written and every offending row is named. A row the confidence gate puts in the blocking lane ' +
      'is NOT a validation failure — it is written PENDING and enters the review queue, so one ' +
      'ambiguous row never blocks a batch (F-06). Idempotent per row via `idempotencyKey` (I-10).',
  })
  async captureCommit(
    @Args('input', { type: () => CaptureCommitInput }) input: CaptureCommitInput,
    @CurrentHouseholdId() householdId: string,
  ): Promise<typeof CaptureCommitResult> {
    try {
      const outcome = await this.transactionsService.captureCommit(householdId, {
        parseId: input.parseId ?? null,
        // `toCommitRow` (not an inline literal) because it is where the absent-vs-`null` distinction
        // for `merchantId`/`counterpartyId` is preserved; see its doc comment.
        rows: input.rows.map(toCommitRow),
        defaultAccountId: input.defaultAccountId ?? null,
        occurredAt: input.occurredAt ?? null,
        occurredLocalDate: input.occurredLocalDate ?? null,
        discardProposalIds: input.discardProposalIds ?? [],
        allowAi: input.allowAi ?? true,
      });

      // One batched read for the whole batch: docs/06 §5.2 puts the audit decision on every
      // `CommittedTransaction`, and a per-row read would make capture's cost scale with the batch.
      const decisions = await this.classification.decisionsForTransactions(
        householdId,
        outcome.committed.map((row) => row.transaction.id),
      );

      const success: CaptureCommitSuccessModel = {
        committed: outcome.committed.map((row) => {
          const decision = decisions.get(row.transaction.id);
          return {
            clientRowId: row.clientRowId,
            transaction: row.transaction,
            idempotencyKey: row.idempotencyKey,
            wasReplayed: row.wasReplayed,
            classification: decision ? toClassificationDecisionModel(decision) : null,
          };
        }),
        skipped: [...outcome.skipped],
        duplicateSuspects: outcome.duplicateSuspects.map((suspect) => ({
          clientRowId: suspect.clientRowId,
          transactionId: suspect.transactionId,
          existingTransactionId: suspect.existingTransactionId,
          existingTransaction: suspect.existingTransaction,
          similarity: suspect.similarity,
          matchedOn: [...suspect.matchedOn],
        })),
        replayed: outcome.replayed,
        cursor: outcome.cursor,
        reviewQueueCount: outcome.reviewQueueCount,
      };
      return success;
    } catch (error) {
      if (error instanceof CaptureCommitRejected) {
        // The rejection is a *successful* round trip carrying per-row diagnostics, not an error: the
        // client renders it inline next to the offending rows. Nothing was written.
        const rejected: CaptureCommitRejectedModel = {
          rejected: error.rows.map((row) => ({
            clientRowId: row.clientRowId,
            code: row.code,
            message: row.message,
            field: row.field,
          })),
          code: error.code,
          message: error.message,
        };
        return rejected;
      }
      throw error;
    }
  }

  @Mutation(() => Int, {
    description:
      'Soft-delete the Transactions a capture just wrote — docs/02 §3\'s undo toast, in ONE call and ' +
      'all-or-nothing, because a toast that only half-applied would leave the user unable to tell ' +
      'which rows survived. Returns how many were actually undone. Never a hard delete: ' +
      '`deleted_at` is set and the row and its audit trail survive (docs/03 §3.4). Ids outside this ' +
      'Household match nothing rather than deleting another Household\'s rows.',
  })
  async undoCapture(
    @Args('transactionIds', { type: () => [ID] }) transactionIds: string[],
    @CurrentHouseholdId() householdId: string,
  ): Promise<number> {
    return this.transactionsService.undoCapture(householdId, transactionIds);
  }

  @Mutation(() => CorrectTransactionSuccessModel, {
    description:
      'Correct one property of a Transaction and record the correction as a learning signal ' +
      '(docs/06 §5.3, F-09). The change is applied first and the Correction second, so a Correction ' +
      'never describes a change that did not happen. `synthesisedRule` is always returned when one can ' +
      'be derived, so the UI can offer "Zapamti za ubuduće"; a rule is created here only when ' +
      '`rememberForFuture` is true, the trigger is a resolved entity, and nothing shadows it.',
  })
  async correctTransaction(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => CorrectTransactionInput }) input: CorrectTransactionInput,
  ): Promise<CorrectTransactionSuccessModel> {
    const outcome = await this.transactionsService.correctTransaction(householdId, {
      transactionId: input.transactionId,
      version: input.version ?? null as unknown as number,
      field: input.field,
      categoryId: input.categoryId ?? null,
      merchantId: input.merchantId ?? null,
      counterpartyId: input.counterpartyId ?? null,
      amountMinor: input.amount === undefined || input.amount === null
        ? null
        : BigInt(input.amount.amountMinor),
      rememberForFuture: input.rememberForFuture,
    });

    return {
      transaction: outcome.transaction,
      correction: {
        id: outcome.correction.id,
        transactionId: outcome.correction.transactionId,
        field: outcome.correction.field as never,
        fromValue: outcome.correction.fromValue,
        toValue: outcome.correction.toValue,
        wasAiSuggested: outcome.correction.wasAiSuggested,
        ruleCreatedId: outcome.correction.ruleCreatedId,
        ruleCreated: outcome.correction.ruleCreated ? toRuleModel(outcome.correction.ruleCreated) : null,
        createdAt: outcome.correction.createdAt,
      },
      synthesisedRule: outcome.synthesis
        ? {
            name: outcome.synthesis.synthesis.proposal.name,
            priority: outcome.synthesis.synthesis.proposal.priority,
            conditions: outcome.synthesis.synthesis.proposal.conditions,
            actions: outcome.synthesis.synthesis.proposal.actions,
            origin: outcome.synthesis.synthesis.proposal.origin as never,
            explanation: outcome.synthesis.synthesis.proposal.explanation,
            explanationCode: outcome.synthesis.synthesis.proposal.explanationCode,
            trigger: outcome.synthesis.synthesis.proposal.trigger as never,
            confidence: outcome.synthesis.synthesis.proposal.confidence,
          }
        : null,
      // The correction WAS applied, so a proposal conflict rides on the success payload rather than
      // coming back as an error arm the client would read as "nothing happened".
      ruleConflicts: (outcome.synthesis?.check.conflicts ?? []).map(toRuleConflictModel),
    };
  }

  @Mutation(() => CreateRuleFromCorrectionResult, {
    description:
      'Save the rule a correction proposed (docs/06 §5.4). Without `overrides` the product’s own ' +
      'proposal is saved, and a proposal that would be shadowed is refused with the conflicting rules ' +
      'so the UI can offer to edit the winner instead (docs/04 §8.2). With `overrides` the user has ' +
      'authored the rule, so it is saved and any conflict is recorded on the result.',
  })
  async createRuleFromCorrection(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => CreateRuleFromCorrectionInput })
    input: CreateRuleFromCorrectionInput,
  ): Promise<typeof CreateRuleFromCorrectionResult> {
    const correction: CorrectionRow = await this.corrections.require(householdId, input.correctionId);
    const subject =
      correction.transaction_id === null
        ? null
        : await this.transactionsService.correctionSubject(
            householdId,
            correction.transaction_id,
            correction.to_value,
          );

    try {
      const outcome = await this.corrections.createRuleFromCorrection(
        householdId,
        correction,
        subject,
        {
          acceptProposal: input.acceptProposal,
          overrides: input.overrides ?? null,
        },
      );

      const success: CreateRuleFromCorrectionSuccessModel = {
        rule: toRuleModel(outcome.rule),
        correction: {
          id: outcome.correction.id,
          transactionId: outcome.correction.transactionId,
          field: outcome.correction.field as never,
          fromValue: outcome.correction.fromValue,
          toValue: outcome.correction.toValue,
          wasAiSuggested: outcome.correction.wasAiSuggested,
          ruleCreatedId: outcome.correction.ruleCreatedId,
          ruleCreated: outcome.correction.ruleCreated
            ? toRuleModel(outcome.correction.ruleCreated)
            : null,
          createdAt: outcome.correction.createdAt,
        },
        cacheInvalidatedAt: outcome.cacheInvalidatedAt,
        ruleConflicts: outcome.ruleConflicts.map(toRuleConflictModel),
      };
      return success;
    } catch (error) {
      if (error instanceof RuleShadowedError) {
        const rejected: RuleConflictErrorModel = {
          code: 'CONFLICT',
          message: error.message,
          proposal: {
            name: error.proposal.name,
            priority: error.proposal.priority,
            conditions: error.proposal.conditions,
            actions: error.proposal.actions,
            origin: error.proposal.origin as never,
            explanation: error.proposal.explanation,
            explanationCode: error.proposal.explanationCode,
            trigger: error.proposal.trigger as never,
            confidence: error.proposal.confidence,
          },
          conflicting: error.conflicts.map(toRuleConflictModel),
        };
        return rejected;
      }
      throw error;
    }
  }

  @Query(() => [ProposedSplit], {
    description:
      'Split an amount evenly across categories without losing a para. The backend computes it so ' +
      'the client never rounds money (ADR-003); the result sums exactly (invariant I-1).',
  })
  proposeEqualSplits(
    @Args('amount', { type: () => MoneyScalar }) amount: { amountMinor: string; currency: string },
    @Args('categoryIds', { type: () => [ID] }) categoryIds: string[],
  ): ProposedSplit[] {
    return this.transactionsService
      .proposeSplits(
        { amountMinor: BigInt(amount.amountMinor), currency: amount.currency },
        categoryIds,
      )
      .map((split) => ({
        categoryId: split.categoryId,
        amount: { amountMinor: split.amountMinor.toString(), currency: amount.currency },
      }));
  }
}
