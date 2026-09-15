import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';

import type { Money } from '@finmate/domain';

import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar, UuidScalar } from '../../graphql/scalars/uuid.scalar';
import { TransactionModel } from '../ledger/transaction.model';
import type { MaterialiseResultView, OccurrenceView, RecurringRuleView } from './recurring.service';

/**
 * Recurring rules — F-16, docs/06 §4 (`RecurringRule`), §5.8 (`materialiseRecurring`), docs/02 §4.14.
 *
 * ## `version` is omitted rather than invented
 *
 * docs/06's sketch declares `version: Int!` on `RecurringRule`; `recurring_rules` has no such column
 * (only `transactions` does), so it is left out and recorded in §5.8's notes — the same call as
 * `SavingGoal.version` (§5.7) and `AlertRule.version` (§5.14).
 *
 * ## The RRULE travels as a string, and the words are the client's
 *
 * `rrule` is the canonical RFC 5545 text the API stores, and `upcomingOccurrences` is the **expanded**
 * list (docs/02 §4.14 draws "the next 30 days"), so a client never has to implement recurrence to
 * render a date. Rendering the rule *in words* is presentation: the web app parses the same string with
 * `@finmate/domain`'s own `parseRRule` and maps the parts onto catalogue keys, so the sentence is
 * translated and the arithmetic is not duplicated.
 *
 * @module apps/api/src/modules/recurring
 */

@ObjectType({
  description: 'One occurrence a rule would post, as a preview — nothing exists in the ledger yet.',
})
export class RecurringPreviewModel {
  @Field(() => String)
  ruleId!: string;

  @Field(() => LocalDateScalar)
  occurredOn!: string;

  @Field(() => UuidScalar)
  accountId!: string;

  @Field(() => MoneyScalar)
  amount!: Money;

  @Field(() => String)
  description!: string;

  @Field(() => String, {
    description:
      'The status the row would be written with: CONFIRMED when `autoConfirm`, else PENDING and ' +
      'flagged for review (I-7, I-8).',
  })
  status!: string;
}

@ObjectType()
export class RecurringSkipModel {
  @Field(() => UuidScalar)
  ruleId!: string;

  @Field(() => String, {
    description: 'Why nothing was posted: NOT_DUE, INACTIVE, ENDED or ALREADY_MATERIALISED.',
  })
  reason!: string;
}

@ObjectType()
export class RecurringOccurrenceModel {
  @Field(() => UuidScalar)
  ruleId!: string;

  @Field(() => LocalDateScalar, { nullable: true, description: 'Null when the rule has finished.' })
  nextOccurrenceOn!: string | null;
}

@ObjectType()
export class MaterialiseRecurringResultModel {
  @Field(() => [TransactionModel], { description: 'The rows that were written.' })
  created!: TransactionModel[];

  @Field(() => [RecurringPreviewModel], {
    description: 'What a `dryRun` **would** write. A preview is not a Transaction — it has no id and no ' +
      'createdAt — so it is modelled as one rather than faking a ledger row (docs/06 §5.8.1).',
  })
  previewed!: RecurringPreviewModel[];

  @Field(() => [RecurringSkipModel])
  skipped!: RecurringSkipModel[];

  @Field(() => [RecurringOccurrenceModel])
  newNextOccurrences!: RecurringOccurrenceModel[];

  @Field(() => Boolean, {
    description:
      'True when every due occurrence had already been posted. Idempotency is per (rule, occurrence) ' +
      'through `transactions.idempotency_key`, which is stronger than a batch key: any retry of the ' +
      'same date cannot double-post.',
  })
  wasReplayed!: boolean;
}

@ObjectType({
  description:
    'A standing order: an amount that repeats on an RRULE, and the next date it will be posted. ' +
    'Materialised Transactions are `source = RECURRING` and carry this rule’s id.',
})
export class RecurringRuleModel {
  @Field(() => String)
  id!: string;

  @Field(() => UuidScalar)
  accountId!: string;

  @Field(() => String, { nullable: true, description: 'The Account’s name, for the card.' })
  accountName!: string | null;

  @Field(() => String, { description: 'EXPENSE or INCOME (I-3).' })
  kind!: string;

  @Field(() => MoneyScalar)
  amount!: Money;

  @Field(() => UuidScalar, { nullable: true })
  categoryId!: string | null;

  @Field(() => UuidScalar, { nullable: true })
  merchantId!: string | null;

  @Field(() => String)
  description!: string;

  @Field(() => String, { description: 'Canonical RFC 5545, restricted to the subset the API expands.' })
  rrule!: string;

  @Field(() => LocalDateScalar)
  nextOccurrenceOn!: string;

  @Field(() => LocalDateScalar, { nullable: true, description: 'The last date this rule may post.' })
  endsOn!: string | null;

  @Field(() => Boolean, {
    description:
      'When true a materialised row is CONFIRMED; when false it is PENDING **and** flagged for review, ' +
      'because a subscription the household did not pay must not silently consume budget.',
  })
  autoConfirm!: boolean;

  @Field(() => Boolean, { description: 'Inferred from history rather than created by the user (3.3.4).' })
  isDetected!: boolean;

  @Field(() => Boolean)
  isActive!: boolean;

  @Field(() => Int, { description: 'How many Transactions this rule has posted.' })
  generatedCount!: number;

  @Field(() => [LocalDateScalar], { description: 'The next few dates, expanded server-side.' })
  upcomingOccurrences!: string[];

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@InputType()
export class RecurringRuleCreateInput {
  @Field(() => UuidScalar)
  accountId!: string;

  @Field(() => String, { description: 'EXPENSE or INCOME.' })
  kind!: string;

  @Field(() => MoneyScalar, { description: 'The currency must be the Household ledger currency (ADR-011).' })
  amount!: Money;

  @Field(() => String)
  description!: string;

  @Field(() => String, {
    description:
      'RFC 5545, restricted to FREQ (DAILY/WEEKLY/MONTHLY/YEARLY), INTERVAL, BYMONTHDAY, BYDAY, COUNT ' +
      'and UNTIL. Anything else is refused rather than silently ignored.',
  })
  rrule!: string;

  @Field(() => LocalDateScalar, {
    nullable: true,
    description: 'The first occurrence. Defaults to the first occurrence on or after today.',
  })
  startsOn?: string | null;

  @Field(() => LocalDateScalar, { nullable: true })
  endsOn?: string | null;

  @Field(() => UuidScalar, { nullable: true })
  categoryId?: string | null;

  @Field(() => UuidScalar, { nullable: true })
  merchantId?: string | null;

  @Field(() => Boolean, { nullable: true, defaultValue: false })
  autoConfirm?: boolean | null;
}

@InputType()
export class RecurringRuleUpdateInput {
  @Field(() => UuidScalar)
  ruleId!: string;

  @Field(() => MoneyScalar, { nullable: true })
  amount?: Money | null;

  @Field(() => String, { nullable: true })
  description?: string | null;

  @Field(() => String, { nullable: true })
  rrule?: string | null;

  @Field(() => LocalDateScalar, { nullable: true })
  startsOn?: string | null;

  @Field(() => LocalDateScalar, { nullable: true })
  endsOn?: string | null;

  @Field(() => Boolean, { nullable: true, description: 'Remove the end date.' })
  clearEndsOn?: boolean | null;

  @Field(() => UuidScalar, { nullable: true })
  categoryId?: string | null;

  @Field(() => Boolean, { nullable: true, description: 'Detach the Category.' })
  clearCategory?: boolean | null;

  @Field(() => Boolean, { nullable: true })
  autoConfirm?: boolean | null;

  @Field(() => Boolean, { nullable: true, description: 'Deactivating keeps the history (docs/02 §4.14).' })
  isActive?: boolean | null;
}

@InputType()
export class MaterialiseRecurringInput {
  @Field(() => [UuidScalar], {
    nullable: true,
    description: 'Empty or absent means every due rule of the Household.',
  })
  ruleIds?: string[] | null;

  @Field(() => LocalDateScalar, { nullable: true, description: 'Defaults to today in the Household timezone.' })
  asOf?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    defaultValue: false,
    description: 'Show what would be posted and write nothing.',
  })
  dryRun?: boolean | null;
}

export function toRecurringRuleModel(view: RecurringRuleView): RecurringRuleModel {
  return {
    id: view.id,
    accountId: view.accountId,
    accountName: view.accountName,
    kind: view.kind,
    amount: { amountMinor: view.amountMinor, currency: view.currency },
    categoryId: view.categoryId,
    merchantId: view.merchantId,
    description: view.description,
    rrule: view.rrule,
    nextOccurrenceOn: view.nextOccurrenceOn,
    endsOn: view.endsOn,
    autoConfirm: view.autoConfirm,
    isDetected: view.isDetected,
    isActive: view.isActive,
    generatedCount: view.generatedCount,
    upcomingOccurrences: [...view.upcomingOccurrences],
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

export function toOccurrenceModel(view: OccurrenceView): RecurringOccurrenceModel {
  return { ruleId: view.ruleId, nextOccurrenceOn: view.nextOccurrenceOn };
}

export function toPreviewModel(view: MaterialiseResultView['previewed'][number]): RecurringPreviewModel {
  return {
    ruleId: view.ruleId,
    occurredOn: view.occurredOn,
    accountId: view.accountId,
    amount: { amountMinor: view.amountMinor, currency: view.currency },
    description: view.description,
    status: view.status,
  };
}
