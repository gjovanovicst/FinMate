import { Args, ArgsType, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { toConnection } from '../../graphql/pagination';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar } from '../../graphql/scalars/uuid.scalar';
import { toClassificationDecisionModel } from '../classification/classification.resolver';
import { ClassificationService } from '../classification/classification.service';
import {
  CaptureCommitInput,
  CaptureCommitResult,
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
        rows: input.rows.map((row) => ({
          clientRowId: row.clientRowId,
          idempotencyKey: row.idempotencyKey,
          clientId: row.clientId ?? null,
          accountId: row.accountId ?? null,
          kind: row.kind,
          // The `Money` scalar already rejected a JSON number, so this `BigInt` is a widening of a
          // string and never a float being truncated (ADR-003).
          amount: { amountMinor: BigInt(row.amount.amountMinor), currency: row.amount.currency },
          categoryId: row.categoryId ?? null,
          merchantId: row.merchantId ?? null,
          counterpartyId: row.counterpartyId ?? null,
          description: row.description ?? null,
          note: row.note ?? null,
          occurredAt: row.occurredAt ?? null,
          occurredOn: row.occurredOn ?? null,
          tagIds: row.tagIds ?? [],
          acceptedProposalId: row.acceptedProposalId ?? null,
          confirmDespiteLowConfidence: row.confirmDespiteLowConfidence ?? false,
        })),
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
