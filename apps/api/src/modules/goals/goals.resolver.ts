import { Args, Mutation, Query, Resolver } from '@nestjs/graphql';

import { type GoalStatus } from '@finmate/domain';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import {
  ContributeToGoalInput,
  GoalContributionResultModel,
  GoalStatusEnum,
  SavingGoalCreateInput,
  SavingGoalModel,
  SavingGoalUpdateInput,
  toSavingGoalModel,
} from './goal.model';
import { GoalsService } from './goals.service';

/**
 * Saving goals — F-18, docs/06 §4 (`savingGoals`, `savingGoal`) and §5 (the five mutations).
 *
 * Every operation takes `@CurrentHouseholdId()`, which fails closed without a `TenantContext`
 * (ADR-008): there is no `householdId` argument anywhere, so a client cannot name another Household's
 * goal. The mutations return `SavingGoalModel` **directly** rather than through docs/06's
 * `SavingGoalPayload` union — a deliberate deviation, recorded in docs/06 §5.7: the arms the helper
 * types would declare (`NotFoundError`, `ValidationError`, `ConflictError`) are already the typed
 * `ApiError` codes this API returns from every other module, and declaring union arms with no distinct
 * producer is the pattern this repo has declined twice (docs/06 §5.5, §5.13).
 *
 * @module apps/api/src/modules/goals
 */
@Resolver(() => SavingGoalModel)
export class GoalsResolver {
  constructor(private readonly goalsService: GoalsService) {}

  @Query(() => [SavingGoalModel], {
    description:
      'The Household’s goals, oldest first. `status` filters; omitting it (or sending an empty list) ' +
      'returns every status.',
  })
  async savingGoals(
    @CurrentHouseholdId() householdId: string,
    @Args('status', { type: () => [GoalStatusEnum], nullable: true }) status?: GoalStatus[] | null,
  ): Promise<SavingGoalModel[]> {
    const goals = await this.goalsService.list(householdId, status);
    return goals.map(toSavingGoalModel);
  }

  @Query(() => SavingGoalModel, {
    nullable: true,
    description: 'One goal, or null when the id is not this Household’s.',
  })
  async savingGoal(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => String }) id: string,
  ): Promise<SavingGoalModel | null> {
    const goal = await this.goalsService.getById(householdId, id);
    return toSavingGoalModel(goal);
  }

  @Mutation(() => SavingGoalModel, {
    description:
      'Create a goal. The currency is the Household ledger currency (ADR-011); the client does not ' +
      'choose it, exactly as for an Account’s opening balance and a Budget’s amount.',
  })
  async createSavingGoal(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => SavingGoalCreateInput }) input: SavingGoalCreateInput,
  ): Promise<SavingGoalModel> {
    const goal = await this.goalsService.create(householdId, {
      name: input.name,
      targetMinor: input.target.amountMinor,
      targetDate: input.targetDate ?? null,
      accountId: input.accountId ?? null,
    });
    return toSavingGoalModel(goal);
  }

  @Mutation(() => SavingGoalModel, {
    description:
      'Patch a goal. An absent field is left alone; use `clearTargetDate` / `clearAccount` to unset ' +
      'one. `ACHIEVED` is recomputed from the contributions on every write.',
  })
  async updateSavingGoal(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => SavingGoalUpdateInput }) input: SavingGoalUpdateInput,
  ): Promise<SavingGoalModel> {
    const goal = await this.goalsService.update(householdId, {
      goalId: input.goalId,
      name: input.name ?? null,
      targetMinor: input.target?.amountMinor ?? null,
      targetDate: input.targetDate ?? null,
      clearTargetDate: input.clearTargetDate ?? null,
      accountId: input.accountId ?? null,
      clearAccount: input.clearAccount ?? null,
      status: input.status ?? null,
    });
    return toSavingGoalModel(goal);
  }

  @Mutation(() => SavingGoalModel, {
    description: 'Soft-delete a goal. Its contributions are kept and become unreachable with it.',
  })
  async deleteSavingGoal(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => String }) id: string,
  ): Promise<SavingGoalModel> {
    // The goal is read **before** it is deleted so the mutation can answer with what was removed
    // rather than `null`; a second read after the soft delete would be a NOT_FOUND.
    const existing = await this.goalsService.getById(householdId, id);
    await this.goalsService.remove(householdId, id);
    return toSavingGoalModel(existing);
  }

  @Mutation(() => GoalContributionResultModel, {
    description:
      'Put money aside. Idempotent on `idempotencyKey` (invariant I-10): a replay returns the ' +
      'original contribution with `wasReplayed: true` instead of saving it twice.',
  })
  async contributeToGoal(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => ContributeToGoalInput }) input: ContributeToGoalInput,
  ): Promise<GoalContributionResultModel> {
    const result = await this.goalsService.contribute(householdId, {
      goalId: input.goalId,
      amountMinor: input.amount.amountMinor,
      contributedOn: input.contributedOn ?? null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey,
    });

    return {
      goal: toSavingGoalModel(result.goal),
      contribution: {
        id: result.contribution.id,
        goalId: result.contribution.goalId,
        amount: {
          amountMinor: result.contribution.amountMinor,
          currency: result.contribution.currency,
        },
        contributedOn: result.contribution.contributedOn,
        note: result.contribution.note,
        createdAt: result.contribution.createdAt,
      },
      wasReplayed: result.wasReplayed,
    };
  }

  @Mutation(() => SavingGoalModel, {
    description: 'Remove a contribution and return the goal with its status recomputed.',
  })
  async deleteGoalContribution(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => String }) id: string,
  ): Promise<SavingGoalModel> {
    const goal = await this.goalsService.removeContribution(householdId, id);
    return toSavingGoalModel(goal);
  }
}
