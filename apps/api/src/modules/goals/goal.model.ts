import { Field, Float, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { GOAL_STATUSES, type GoalStatus, type Money } from '@finmate/domain';

import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar, UuidScalar } from '../../graphql/scalars/uuid.scalar';
import { Account } from '../accounts/account.model';
import type { ContributionView, GoalView } from './goals.service';

/**
 * Saving goals — F-18, docs/06 §4 (`SavingGoal`), §5.7 (`contributeToGoal`), docs/02 §4.13.
 *
 * ## Derived figures are read-only fields
 *
 * `contributed`, `remaining`, `progress`, `requiredPerMonth` and `monthsRemaining` are computed by
 * `@finmate/domain`'s `goalProgress` on every read (docs/03 §6, ADR-001). None of them is a column and
 * none is accepted as input — the "required monthly" amount is never editable, which is docs/02
 * §4.13's rule stated as a type.
 *
 * ## Two corrections to docs/06's sketch
 *
 * `targetDate` and `contributedOn` are written as `Date` there; the schema has no `Date` scalar and a
 * Household day is `LocalDate` (docs/03 §3.2) — the same correction §4.3 needed. And `version` is
 * declared on `SavingGoal` while `saving_goals` has no such column (only `transactions` does), so it
 * is **omitted rather than invented**: optimistic concurrency is not built for goals, exactly as
 * recorded for `AlertRule.version`.
 *
 * @module apps/api/src/modules/goals
 */

export const GoalStatusEnum = Object.freeze(
  Object.fromEntries(GOAL_STATUSES.map((status) => [status, status])) as Record<GoalStatus, GoalStatus>,
);

registerEnumType(GoalStatusEnum, {
  name: 'GoalStatus',
  description:
    'ACTIVE while saving, ACHIEVED once the contributions reach the target (the backend sets this — ' +
    'it is recomputed, never a flag a client sends), ARCHIVED when the user stops tracking it.',
});

@ObjectType()
export class GoalContributionModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  goalId!: string;

  @Field(() => MoneyScalar, { description: 'Always positive; a contribution only adds.' })
  amount!: Money;

  @Field(() => LocalDateScalar)
  contributedOn!: string;

  @Field(() => String, { nullable: true })
  note!: string | null;

  @Field(() => Date)
  createdAt!: Date;
}

@ObjectType({
  description:
    'A target amount by a target date, with its contributions. Progress is the sum of the ' +
    'contributions — **not** of Transactions (docs/02 §4.13) — so nothing here talks to the ledger.',
})
export class SavingGoalModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => MoneyScalar)
  target!: Money;

  @Field(() => LocalDateScalar, { nullable: true, description: 'Null for a goal with no deadline.' })
  targetDate!: string | null;

  @Field(() => UuidScalar, { nullable: true, description: 'The Account the goal is set aside in.' })
  accountId!: string | null;

  @Field(() => Account, { nullable: true, description: 'Null when the Account was archived or removed.' })
  account!: Account | null;

  @Field(() => GoalStatusEnum)
  status!: GoalStatus;

  @Field(() => MoneyScalar, { description: 'Σ contributions, computed on read.' })
  contributed!: Money;

  @Field(() => MoneyScalar, { description: 'target − contributed, never negative.' })
  remaining!: Money;

  @Field(() => Float, { description: '0…1, capped so a bar cannot be more than full.' })
  progress!: number;

  @Field(() => MoneyScalar, {
    nullable: true,
    description:
      'What to put aside each month from now on, rounded **up** so the plan reaches the target. Null ' +
      'only when the goal has no target date; when the date has passed it is the whole remainder.',
  })
  requiredPerMonth!: Money | null;

  @Field(() => Int, {
    nullable: true,
    description: 'Whole months to the target month. Null when there is no target date; 0 means "due now".',
  })
  monthsRemaining!: number | null;

  @Field(() => [GoalContributionModel], { description: 'Newest first.' })
  contributions!: GoalContributionModel[];

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@InputType()
export class SavingGoalCreateInput {
  @Field(() => String)
  name!: string;

  @Field(() => MoneyScalar, {
    description: 'The target. The currency must be the Household ledger currency (ADR-011).',
  })
  target!: Money;

  @Field(() => LocalDateScalar, { nullable: true })
  targetDate?: string | null;

  @Field(() => UuidScalar, { nullable: true })
  accountId?: string | null;
}

@InputType()
export class SavingGoalUpdateInput {
  @Field(() => String)
  goalId!: string;

  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => MoneyScalar, { nullable: true })
  target?: Money | null;

  @Field(() => LocalDateScalar, { nullable: true })
  targetDate?: string | null;

  @Field(() => Boolean, {
    nullable: true,
    description: 'Remove the target date. An absent `targetDate` leaves it unchanged (docs/06 §5.6).',
  })
  clearTargetDate?: boolean | null;

  @Field(() => UuidScalar, { nullable: true })
  accountId?: string | null;

  @Field(() => Boolean, { nullable: true, description: 'Detach the Account.' })
  clearAccount?: boolean | null;

  @Field(() => GoalStatusEnum, {
    nullable: true,
    description: 'Archive or restore a goal. ACHIEVED is recomputed from the contributions either way.',
  })
  status?: GoalStatus | null;
}

@InputType()
export class ContributeToGoalInput {
  @Field(() => String)
  goalId!: string;

  @Field(() => MoneyScalar)
  amount!: Money;

  @Field(() => LocalDateScalar, {
    nullable: true,
    description: 'The day the money was put aside. Defaults to today in the Household timezone.',
  })
  contributedOn?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;

  @Field(() => String, {
    description:
      'Required: a contribution is money, so a retry must not add it twice (invariant I-10). A replay ' +
      'returns the original contribution with `wasReplayed: true`.',
  })
  idempotencyKey!: string;
}

@ObjectType()
export class GoalContributionResultModel {
  @Field(() => SavingGoalModel, { description: 'The goal with refreshed progress and required monthly.' })
  goal!: SavingGoalModel;

  @Field(() => GoalContributionModel)
  contribution!: GoalContributionModel;

  @Field(() => Boolean, { description: 'True when the idempotency key had already been used.' })
  wasReplayed!: boolean;
}

export function toGoalContributionModel(view: ContributionView): GoalContributionModel {
  return {
    id: view.id,
    goalId: view.goalId,
    amount: { amountMinor: view.amountMinor, currency: view.currency },
    contributedOn: view.contributedOn,
    note: view.note,
    createdAt: view.createdAt,
  };
}

export function toSavingGoalModel(view: GoalView): SavingGoalModel {
  return {
    id: view.id,
    name: view.name,
    target: { amountMinor: view.targetMinor, currency: view.currency },
    targetDate: view.targetDate,
    accountId: view.accountId,
    account: view.account,
    status: view.status,
    contributed: { amountMinor: view.contributedMinor, currency: view.currency },
    remaining: { amountMinor: view.remainingMinor, currency: view.currency },
    progress: view.progress,
    requiredPerMonth:
      view.requiredPerMonthMinor === null
        ? null
        : { amountMinor: view.requiredPerMonthMinor, currency: view.currency },
    monthsRemaining: view.monthsRemaining,
    contributions: view.contributions.map(toGoalContributionModel),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}
