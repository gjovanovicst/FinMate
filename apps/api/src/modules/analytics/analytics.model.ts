import { Field, Float, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { TIME_BUCKETS, type Balance, type Money, type TimeBucket } from '@finmate/domain';

import { BalanceScalar } from '../../graphql/scalars/balance.scalar';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar, UuidScalar } from '../../graphql/scalars/uuid.scalar';
import { CategoryModel } from '../taxonomy/category.model';
import type {
  CashflowBucketView,
  CategorySpendView,
  MerchantSpendView,
  MonthComparisonView,
  SpendBucketView,
} from './analytics.service';

/**
 * The analytics GraphQL surface — docs/06 §4.3, docs/01 F-20.
 *
 * ## Two scalars, on purpose
 *
 * A total is a `Money` (non-negative, direction carried by `kind` — ADR-003), but a **derived**
 * difference is a `Balance`: `monthComparison.delta` is negative in a month that spent less than its
 * baseline, and `cashflow.net` is negative whenever a month paid out more than it took in. docs/06 §4.3
 * wrote both as `Money`, which `Money`'s own contract makes impossible to serialise — the domain's
 * `money()` helper rejects a negative amount. The document is corrected to `Balance` rather than the
 * schema being made to lie about a sign.
 *
 * ## Enum derived from the domain, never written twice
 *
 * {@link TimeBucketEnum} is built from `TIME_BUCKETS`, the same array `bucketRanges` switches on, so a
 * fifth bucket cannot exist on one side only.
 *
 * @module apps/api/src/modules/analytics
 */

export const TimeBucketEnum = Object.freeze(
  Object.fromEntries(TIME_BUCKETS.map((bucket) => [bucket, bucket])) as Record<TimeBucket, TimeBucket>,
);

registerEnumType(TimeBucketEnum, {
  name: 'TimeBucket',
  description:
    'How the range is divided. DAY, ISO WEEK, calendar MONTH, calendar QUARTER — the boundaries come ' +
    'from @finmate/domain, which is also what labels the axis (docs/06 §4.3).',
});

@InputType({
  description: 'An inclusive range of the Household’s own days. Both ends are days, never instants.',
})
export class DateRangeInput {
  @Field(() => LocalDateScalar)
  start!: string;

  @Field(() => LocalDateScalar)
  end!: string;
}

@ObjectType({
  description: 'One bucket of the spend series. Every bucket of the range is present, empty ones included.',
})
export class SpendBucketModel {
  @Field(() => LocalDateScalar)
  bucketStart!: string;

  @Field(() => LocalDateScalar)
  bucketEnd!: string;

  @Field(() => MoneyScalar, { description: 'Confirmed expense only (I-3, I-7).' })
  expenseTotal!: Money;

  @Field(() => MoneyScalar)
  incomeTotal!: Money;

  @Field(() => Int, {
    description:
      'Transactions in the bucket. A split Transaction is counted once, on its parent’s day (I-1).',
  })
  transactionCount!: number;
}

@ObjectType({ description: 'One bucket of the cashflow series: what came in, what went out, what is left.' })
export class CashflowBucketModel {
  @Field(() => LocalDateScalar)
  bucketStart!: string;

  @Field(() => MoneyScalar)
  income!: Money;

  @Field(() => MoneyScalar)
  expense!: Money;

  @Field(() => BalanceScalar, { description: 'income − expense. **Signed**: negative is a deficit month.' })
  net!: Balance;
}

@ObjectType()
export class MerchantSpendModel {
  @Field(() => UuidScalar, {
    nullable: true,
    description: 'Null when the Transaction’s Merchant was never resolved.',
  })
  merchantId!: string | null;

  @Field(() => String, {
    description: 'The Merchant’s name, or the raw description when it was never resolved (docs/06 §4.3).',
  })
  displayName!: string;

  @Field(() => MoneyScalar, {
    description:
      'The full Transaction amount, splits included: a receipt paid to Lidl was paid to Lidl in full.',
  })
  total!: Money;

  @Field(() => Int)
  transactionCount!: number;
}

@ObjectType({
  description:
    'One Category’s spend in a range. With `includeSubcategories` the figure of a Category that has ' +
    'children includes them, and `isSubtreeAggregate` says so.',
})
export class CategorySpendModel {
  @Field(() => UuidScalar, {
    nullable: true,
    description: 'Null for the uncategorised bucket — money that landed in no Category (I-12 aside).',
  })
  categoryId!: string | null;

  @Field(() => CategoryModel, { nullable: true })
  category!: CategoryModel | null;

  @Field(() => LocalDateScalar)
  periodStart!: string;

  @Field(() => LocalDateScalar)
  periodEnd!: string;

  @Field(() => MoneyScalar)
  total!: Money;

  @Field(() => Int, {
    description:
      'Transactions that contributed to this Category, across the subtree when it is an aggregate. ' +
      'One Transaction split across two Categories counts once in each, so a parent’s figure is a sum ' +
      'of contributions rather than a distinct count of Transactions.',
  })
  transactionCount!: number;

  @Field(() => Float, {
    description: 'This row’s share of the range’s confirmed expense, 0 when the range has none.',
  })
  shareOfTotal!: number;

  @Field(() => MoneyScalar, {
    nullable: true,
    description: 'Only `monthComparison` populates this; null everywhere else.',
  })
  priorPeriodTotal!: Money | null;

  @Field(() => Float, {
    nullable: true,
    description:
      'Change against `priorPeriodTotal`, or **null when there is nothing to compare against** — no ' +
      'prior spend at all, or a prior of zero. docs/02 §4.15 renders that as “nema osnova za poređenje”.',
  })
  changeRatio!: number | null;

  @Field(() => Boolean, {
    description: 'True when this row’s figures include spend filed under a descendant Category.',
  })
  isSubtreeAggregate!: boolean;
}

@ObjectType()
export class MonthComparisonModel {
  @Field(() => String, { description: 'The `YYYY-MM` month the figures are for.' })
  period!: string;

  @Field(() => String, { description: 'The `YYYY-MM` month they are compared against.' })
  compareTo!: string;

  @Field(() => MoneyScalar)
  total!: Money;

  @Field(() => MoneyScalar)
  compareTotal!: Money;

  @Field(() => BalanceScalar, { description: 'total − compareTotal. **Signed**.' })
  delta!: Balance;

  @Field(() => Float, { nullable: true })
  deltaRatio!: number | null;

  @Field(() => [CategorySpendModel], {
    description:
      'Every Category with spend in either month, biggest current spend first. A Category that fell to ' +
      'zero is present with a total of 0 and a ratio of −1 rather than being dropped.',
  })
  categories!: CategorySpendModel[];
}

export function toSpendBucketModel(view: SpendBucketView): SpendBucketModel {
  return {
    bucketStart: view.bucketStart,
    bucketEnd: view.bucketEnd,
    expenseTotal: view.expenseTotal,
    incomeTotal: view.incomeTotal,
    transactionCount: view.transactionCount,
  };
}

export function toCashflowBucketModel(view: CashflowBucketView): CashflowBucketModel {
  return {
    bucketStart: view.bucketStart,
    income: view.income,
    expense: view.expense,
    net: view.net,
  };
}

export function toMerchantSpendModel(view: MerchantSpendView): MerchantSpendModel {
  return {
    merchantId: view.merchantId,
    displayName: view.displayName,
    total: view.total,
    transactionCount: view.transactionCount,
  };
}

export function toCategorySpendModel(view: CategorySpendView): CategorySpendModel {
  return {
    categoryId: view.categoryId,
    category: view.category,
    periodStart: view.periodStart,
    periodEnd: view.periodEnd,
    total: view.total,
    transactionCount: view.transactionCount,
    shareOfTotal: view.shareOfTotal,
    priorPeriodTotal: view.priorPeriodTotal,
    changeRatio: view.changeRatio,
    isSubtreeAggregate: view.isSubtreeAggregate,
  };
}

export function toMonthComparisonModel(view: MonthComparisonView): MonthComparisonModel {
  return {
    period: view.period,
    compareTo: view.compareTo,
    total: view.total,
    compareTotal: view.compareTotal,
    delta: view.delta,
    deltaRatio: view.deltaRatio,
    categories: view.categories.map(toCategorySpendModel),
  };
}
