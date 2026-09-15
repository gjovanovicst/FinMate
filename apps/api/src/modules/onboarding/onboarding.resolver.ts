import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import {
  MerchantSelectionResultModel,
  OnboardingStateModel,
  StarterSeedResultModel,
  toMerchantSelectionResultModel,
  toOnboardingStateModel,
  toStarterSeedResultModel,
} from './onboarding.model';
import { OnboardingService } from './onboarding.service';

/**
 * F-13 onboarding (docs/02 §4.1, FL-01).
 *
 * Every operation here is scoped from the session — no `householdId` argument exists, per ADR-008 —
 * and every one is safe to call twice, because the wizard is re-enterable from settings (docs/01 F-13).
 */
@Resolver(() => OnboardingStateModel)
export class OnboardingResolver {
  constructor(private readonly onboarding: OnboardingService) {}

  @Query(() => OnboardingStateModel, {
    description:
      'How far through onboarding this Household is, and what it already has. The wizard resumes ' +
      'from `step`; the counts let it say what a re-run would do before doing it.',
  })
  async onboardingState(@CurrentHouseholdId() householdId: string): Promise<OnboardingStateModel> {
    return toOnboardingStateModel(await this.onboarding.state(householdId));
  }

  @Mutation(() => OnboardingStateModel, {
    description:
      'Record the step to resume at, so a killed app or a closed tab comes back to the same place. ' +
      'Clamped rather than refused: this is progress bookkeeping, and a 500 on "step 8" would be a ' +
      'worse failure than resuming at the last real step.',
  })
  async setOnboardingStep(
    @CurrentHouseholdId() householdId: string,
    @Args('step', { type: () => Int }) step: number,
  ): Promise<OnboardingStateModel> {
    return toOnboardingStateModel(await this.onboarding.setStep(householdId, step));
  }

  @Mutation(() => StarterSeedResultModel, {
    description:
      'Write the shipped starter category tree and its keywords into this Household (F-13 step 1). ' +
      'One transaction, and idempotent by (parent, name) — a second call reuses what is already ' +
      'there instead of creating a duplicate tree.',
  })
  async seedStarterCategories(
    @CurrentHouseholdId() householdId: string,
  ): Promise<StarterSeedResultModel> {
    return toStarterSeedResultModel(await this.onboarding.seedStarterCategories(householdId));
  }

  @Mutation(() => MerchantSelectionResultModel, {
    description:
      'Make the selected shipped merchants this Household’s own, with a default Category resolved ' +
      'from the starter tree (F-13 step 4). A merchant already owned is left alone, so re-running ' +
      'never mints a second one.',
  })
  async applyMerchantSelection(
    @CurrentHouseholdId() householdId: string,
    @Args('names', { type: () => [String] }) names: string[],
  ): Promise<MerchantSelectionResultModel> {
    return toMerchantSelectionResultModel(
      await this.onboarding.applyMerchantSelection(householdId, names),
    );
  }

  @Mutation(() => OnboardingStateModel, {
    description:
      'Mark onboarding complete and stamp the time. Separate from `setOnboardingStep` so completion ' +
      'is a fact of its own rather than an inference from reaching step 7.',
  })
  async completeOnboarding(@CurrentHouseholdId() householdId: string): Promise<OnboardingStateModel> {
    return toOnboardingStateModel(await this.onboarding.complete(householdId));
  }
}
