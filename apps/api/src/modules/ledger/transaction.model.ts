import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import type { Money } from '@finmate/domain';

import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar, UuidScalar } from '../../graphql/scalars/uuid.scalar';
import { Paginated } from '../../graphql/pagination';
import { CategoryKind } from '../taxonomy/category.model';
import { TagModel } from '../taxonomy/tag.model';

export enum TransactionKind {
  EXPENSE = 'EXPENSE',
  INCOME = 'INCOME',
}

registerEnumType(TransactionKind, {
  name: 'TransactionKind',
  description:
    'Direction of money movement. `amount_minor` is ALWAYS non-negative; the direction lives here, ' +
    'never in a sign (ADR-003).',
});

export enum TransactionStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  VOID = 'VOID',
}

registerEnumType(TransactionStatus, {
  name: 'TransactionStatus',
  description:
    'PENDING rows are invisible to every balance, budget and insight (invariant I-7), so a capture ' +
    'the user has not accepted can never move a number.',
});

export enum TransactionSource {
  MANUAL = 'MANUAL',
  NATURAL_LANGUAGE = 'NATURAL_LANGUAGE',
  RECEIPT = 'RECEIPT',
  RECURRING = 'RECURRING',
  IMPORT = 'IMPORT',
}

registerEnumType(TransactionSource, { name: 'TransactionSource' });

export enum CategorySource {
  USER = 'USER',
  RULE = 'RULE',
  AI = 'AI',
  IMPORT = 'IMPORT',
  DEFAULT = 'DEFAULT',
}

registerEnumType(CategorySource, {
  name: 'CategorySource',
  description: 'Which layer chose the category — the audit trail behind every classification.',
});

@ObjectType({
  description:
    'A portion of a Transaction attributed to a different Category. Splits must sum exactly to the ' +
    'parent amount (invariant I-1) — the allocation algorithm guarantees it.',
})
export class SplitModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID)
  categoryId!: string;

  @Field(() => MoneyScalar)
  amount!: Money;

  @Field(() => String, { nullable: true })
  note!: string | null;

  @Field(() => Float, { nullable: true })
  confidence!: number | null;

  @Field(() => CategorySource, { nullable: true })
  categorySource!: CategorySource | null;
}

@ObjectType()
export class TransactionModel {
  @Field(() => ID)
  id!: string;

  @Field(() => TransactionKind)
  kind!: TransactionKind;

  /** Always positive. `extensions.code` carries direction instead (ADR-003). */
  @Field(() => MoneyScalar)
  amount!: Money;

  @Field(() => ID)
  accountId!: string;

  @Field(() => ID, { nullable: true })
  categoryId!: string | null;

  @Field(() => ID, { nullable: true })
  merchantId!: string | null;

  @Field(() => ID, { nullable: true })
  counterpartyId!: string | null;

  @Field(() => [SplitModel])
  splits!: SplitModel[];

  @Field(() => [TagModel], {
    description:
      'Labels attached to this Transaction, orthogonal to its Category (docs/01 F-12). Reached ' +
      'through the parent because `transaction_tags` carries no household_id of its own.',
  })
  tags!: TagModel[];

  @Field(() => String)
  description!: string;

  @Field(() => String, { nullable: true })
  note!: string | null;

  @Field(() => String, { nullable: true, description: 'The verbatim natural-language input.' })
  rawInput!: string | null;

  @Field(() => Date)
  occurredAt!: Date;

  @Field(() => LocalDateScalar, {
    description:
      'The calendar day in the Household timezone. Distinct from occurredAt on purpose: month ' +
      'boundaries are a local-calendar question (docs/03 §3.2).',
  })
  occurredLocalDate!: string;

  @Field(() => TransactionStatus)
  status!: TransactionStatus;

  @Field(() => TransactionSource)
  source!: TransactionSource;

  @Field(() => UuidScalar, {
    nullable: true,
    description:
      'The RecurringRule that generated this row, when one did (`source: RECURRING`). It is what links ' +
      'a posted bill back to the standing order that produced it (F-16).',
  })
  recurringRuleId!: string | null;

  @Field(() => UuidScalar, {
    nullable: true,
    description:
      'The Attachment on this row — a Receipt photo (F-34). Set only by `commitAttachment`, which ' +
      'verifies the upload first; the raw `storage_key` is never exposed, so a client resolves the ' +
      'image through the `attachment` query, whose `downloadUrl` is a short-lived presigned GET.',
  })
  attachmentId!: string | null;

  @Field(() => CategorySource, { nullable: true })
  categorySource!: CategorySource | null;

  @Field(() => Float, {
    nullable: true,
    description: 'Calibrated confidence, not the model’s self-reported number (ADR-009).',
  })
  confidence!: number | null;

  @Field(() => Boolean, {
    description:
      'The BLOCKING review lane only: confidence < 0.60 or no category (invariant I-8). The ' +
      'advisory lane (0.60–0.89) is derived and does not set this.',
  })
  needsReview!: boolean;

  @Field(() => Int, {
    description: 'Optimistic concurrency. Send it back on update; a mismatch is a CONFLICT.',
  })
  version!: number;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType()
export class TransactionConnection extends Paginated(TransactionModel) {}

/** Re-exported so the resolver can accept a category kind filter without a second import. */
export { CategoryKind };
