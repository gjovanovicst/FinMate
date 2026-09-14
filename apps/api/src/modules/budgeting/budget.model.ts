import { Field, Float, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import type { Balance, Money } from '@finmate/domain';

import { BalanceScalar } from '../../graphql/scalars/balance.scalar';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar } from '../../graphql/scalars/uuid.scalar';

export enum BudgetPeriodEnum {
  WEEKLY = 'WEEKLY',
  MONTHLY = 'MONTHLY',
  QUARTERLY = 'QUARTERLY',
  YEARLY = 'YEARLY',
  CUSTOM = 'CUSTOM',
}

registerEnumType(BudgetPeriodEnum, { name: 'BudgetPeriod' });

@ObjectType({
  description:
    'A spending limit for a period, scoped either to the whole Household (categoryId null) or to a ' +
    'Category subtree.',
})
export class BudgetModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, {
    nullable: true,
    description: 'Null means the whole Household — the budget that drives safe-to-spend.',
  })
  categoryId!: string | null;

  @Field(() => String, { nullable: true })
  categoryName!: string | null;

  @Field(() => BudgetPeriodEnum)
  period!: BudgetPeriodEnum;

  @Field(() => LocalDateScalar)
  periodStart!: string;

  @Field(() => LocalDateScalar)
  periodEnd!: string;

  @Field(() => MoneyScalar)
  amount!: Money;

  @Field(() => Boolean, {
    description: 'When true, a Budget counts Transactions in the whole Category subtree (I-5).',
  })
  includeSubcategories!: boolean;

  @Field(() => Boolean)
  rollover!: boolean;

  // ---- computed for the active period (never stored) ----

  @Field(() => BalanceScalar, {
    description: 'Confirmed spend in the period, including splits and the subtree (invariants I-5, I-7).',
  })
  spent!: Balance;

  @Field(() => BalanceScalar, {
    description: 'amount − spent. **Signed**: negative means the budget is blown.',
  })
  remaining!: Balance;

  @Field(() => Float)
  usedRatio!: number;

  @Field(() => Float, {
    description:
      'Share of the period elapsed. Comparing it with usedRatio is the useful signal: "82 % used ' +
      'with 60 % of the month gone".',
  })
  elapsedRatio!: number;

  @Field(() => Boolean)
  isOverspent!: boolean;

  @Field(() => Boolean, {
    description: 'Always false before enough days have elapsed for the pace to mean anything.',
  })
  isAheadOfPace!: boolean;
}

/**
 * The dashboard payload.
 *
 * One round trip for every tile, and **every input is exposed** so the UI can show its working
 * rather than presenting a number the user has to take on faith (docs/01 F-19).
 */
@ObjectType()
export class DashboardModel {
  @Field(() => LocalDateScalar)
  today!: string;

  @Field(() => LocalDateScalar)
  periodStart!: string;

  @Field(() => LocalDateScalar)
  periodEnd!: string;

  @Field(() => Int)
  daysElapsed!: number;

  @Field(() => Int)
  daysInMonth!: number;

  @Field(() => BalanceScalar, {
    description: 'The headline figure: what can be spent today without breaching the budget.',
  })
  safeToSpendToday!: Balance;

  @Field(() => BalanceScalar, { description: 'May be negative, which is the overspend.' })
  available!: Balance;

  @Field(() => Boolean)
  isOverspent!: boolean;

  @Field(() => BalanceScalar)
  spentThisMonth!: Balance;

  @Field(() => BalanceScalar)
  incomeThisMonth!: Balance;

  @Field(() => MoneyScalar, { nullable: true, description: 'Null when no Household budget is set.' })
  monthlyBudget!: Money | null;

  @Field(() => BalanceScalar, { description: 'Recurring charges still due this period.' })
  reserved!: Balance;

  @Field(() => BalanceScalar, { description: 'What the Household still wants to put aside.' })
  savingsTarget!: Balance;

  @Field(() => BalanceScalar, { description: 'Projected month-end spend.' })
  projectedTotal!: Balance;

  @Field(() => BalanceScalar, {
    nullable: true,
    description: 'Projection minus budget. Null without a budget.',
  })
  projectedOverrun!: Balance | null;

  @Field(() => BalanceScalar)
  dailyPace!: Balance;

  @Field(() => Boolean, {
    description: 'False early in the month: the UI should say "not enough data yet" rather than warn.',
  })
  paceIsReliable!: boolean;

  @Field(() => Int, { description: 'The BLOCKING review lane only (invariant I-8).' })
  needsReviewCount!: number;
}
