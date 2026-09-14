import { Args, ArgsType, Field, ID, InputType, Int, Mutation, ObjectType, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { toConnection } from '../../graphql/pagination';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar } from '../../graphql/scalars/uuid.scalar';
import {
  TransactionConnection,
  TransactionKind,
  TransactionModel,
  TransactionStatus,
} from './transaction.model';
import { TransactionsService } from './transactions.service';

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

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => TransactionStatus, { nullable: true })
  status?: TransactionStatus;
}

@Resolver(() => TransactionModel)
export class TransactionsResolver {
  constructor(private readonly transactionsService: TransactionsService) {}

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
