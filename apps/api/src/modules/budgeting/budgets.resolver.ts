import { Args, ArgsType, Field, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { MoneyScalar } from '../../graphql/scalars/money.scalar';
import { LocalDateScalar } from '../../graphql/scalars/uuid.scalar';
import { BudgetModel, BudgetPeriodEnum, DashboardModel } from './budget.model';
import { BudgetsService } from './budgets.service';

@ArgsType()
export class UpsertBudgetArgs {
  @Field(() => ID, {
    nullable: true,
    description: 'Omit for the whole-Household budget, which is what drives safe-to-spend.',
  })
  categoryId?: string | null;

  @Field(() => BudgetPeriodEnum)
  period!: BudgetPeriodEnum;

  @Field(() => MoneyScalar)
  amount!: { amountMinor: string; currency: string };

  @Field(() => LocalDateScalar, {
    nullable: true,
    description: 'Defaults to the first day of the current month in the Household timezone.',
  })
  periodStart?: string;

  @Field(() => Boolean, { nullable: true, defaultValue: true })
  includeSubcategories?: boolean;

  @Field(() => Boolean, { nullable: true, defaultValue: false })
  rollover?: boolean;
}

@Resolver(() => BudgetModel)
export class BudgetsResolver {
  constructor(private readonly budgetsService: BudgetsService) {}

  @Query(() => [BudgetModel], {
    description:
      'Budgets with consumption for their CURRENT period. Spend includes splits and the whole ' +
      'Category subtree, and counts only CONFIRMED transactions (invariants I-5, I-7).',
  })
  async budgets(
    @CurrentHouseholdId() householdId: string,
    @Args('today', { type: () => LocalDateScalar, nullable: true }) today?: string,
  ): Promise<BudgetModel[]> {
    return this.budgetsService.list(householdId, today);
  }

  @Query(() => DashboardModel, {
    description:
      'Every dashboard tile in one round trip. All figures are computed by the backend from the ' +
      'ledger and every input is returned, so the UI can show its working (ADR-001).',
  })
  async dashboard(@CurrentHouseholdId() householdId: string): Promise<DashboardModel> {
    return this.budgetsService.dashboard(householdId);
  }

  @Mutation(() => BudgetModel, {
    description: 'Create or replace the budget for a scope and period.',
  })
  async upsertBudget(
    @Args() args: UpsertBudgetArgs,
    @CurrentHouseholdId() householdId: string,
  ): Promise<BudgetModel> {
    return this.budgetsService.upsert(householdId, {
      categoryId: args.categoryId ?? null,
      period: args.period,
      amountMinor: BigInt(args.amount.amountMinor),
      ...(args.periodStart ? { periodStart: args.periodStart } : {}),
      ...(args.includeSubcategories !== undefined
        ? { includeSubcategories: args.includeSubcategories }
        : {}),
      ...(args.rollover !== undefined ? { rollover: args.rollover } : {}),
    });
  }

  @Mutation(() => Boolean)
  async deleteBudget(
    @Args('id', { type: () => ID }) id: string,
    @CurrentHouseholdId() householdId: string,
  ): Promise<boolean> {
    await this.budgetsService.remove(householdId, id);
    return true;
  }
}
