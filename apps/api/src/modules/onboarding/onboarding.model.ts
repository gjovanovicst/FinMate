import { Field, Int, ObjectType } from '@nestjs/graphql';

import type {
  MerchantSelectionResultView,
  OnboardingStateView,
  StarterSeedResultView,
} from './onboarding.service';

/**
 * The GraphQL surface of F-13 onboarding (docs/02 §4.1, docs/06 §5.6).
 *
 * ## Why steps are not their own mutations
 *
 * The wizard's six steps are *client* steps: step 2 creates an account with `createAccount`, step 3
 * creates a Counterparty and (only if the user accepts) a Rule with the existing mutations, and step 5
 * sets a budget with `upsertBudget`. Only the two operations that are genuinely new live here — the
 * starter tree and the merchant selection — plus progress bookkeeping. A mutation per step would be
 * six ways to write the same kinds of row, each needing the validation the editors already have.
 *
 * ## Why every result reports what it did
 *
 * Onboarding is a screen a user steps through once, often on a phone, sometimes resumed days later.
 * "It worked" is not enough to render the next step: `reused` says whether this is a first run or a
 * return visit, `unresolved` says the catalogue moved on, and `withoutCategory` says the tree was
 * renamed so a suggestion could not be made. Each is surfaced rather than inferred, because the
 * alternative is a wizard that claims to have seeded something it did not.
 */

@ObjectType({
  description:
    'How far through onboarding this Household is, and what it already has. A step past the last ' +
    'one (7) means the wizard finished.',
})
export class OnboardingStateModel {
  @Field(() => Int, { description: 'The step to resume at: 1–6, or 7 once onboarding is complete.' })
  step!: number;

  @Field(() => Date, { nullable: true })
  completedAt!: Date | null;

  @Field(() => Int, {
    nullable: true,
    description:
      'The shipped seed version this Household accepted. Null when the starter tree was skipped — ' +
      'which a later release can tell apart from "never asked", unlike counting rows.',
  })
  seedVersion!: number | null;

  @Field(() => String, {
    description:
      'The Household ledger currency (ISO-4217, ADR-011) chosen at signup (ADR-045). The wizard ' +
      'displays it and prices its budget in it, so it is served rather than assumed.',
  })
  currency!: string;

  @Field(() => Int)
  categories!: number;

  @Field(() => Int)
  keywords!: number;

  @Field(() => Int, { description: 'Merchants this Household owns. Global seeds are not counted.' })
  merchants!: number;

  @Field(() => Int)
  accounts!: number;
}

@ObjectType({ description: 'What seeding the starter tree did. Idempotent, so `reused` matters.' })
export class StarterSeedResultModel {
  @Field(() => Int, { description: 'Categories created by this call.' })
  categories!: number;

  @Field(() => Int, { description: 'Category keywords created by this call.' })
  keywords!: number;

  @Field(() => Int, {
    description: 'Nodes that already existed and were reused — the evidence a second run is a no-op.',
  })
  reused!: number;
}

@ObjectType({ description: 'What applying a merchant selection did.' })
export class MerchantSelectionResultModel {
  @Field(() => Int, { description: 'Merchants made Household-owned, or given a default Category.' })
  applied!: number;

  @Field(() => Int, { description: 'Selected merchants the Household already owned, left as they were.' })
  alreadyOwned!: number;

  @Field(() => [String], {
    description:
      'Selected names that are not in the shipped catalogue. Reported, never silently dropped.',
  })
  unresolved!: string[];

  @Field(() => [String], {
    description:
      'Copied, but with no default Category because the Household tree has no node at the seed’s ' +
      'path (usually a rename in step 1). Not an error: the category keywords still apply.',
  })
  withoutCategory!: string[];

  @Field(() => Int, {
    description:
      'Entity vectors written for the embedding rung (docs/04 §4 rung 5). Always 0 while no local ' +
      'embedding model is configured — rung 5 is inert, so this is a fact about the deployment ' +
      'rather than about the merchants just adopted.',
  })
  embedded!: number;
}

export function toOnboardingStateModel(view: OnboardingStateView): OnboardingStateModel {
  return {
    step: view.step,
    completedAt: view.completedAt,
    seedVersion: view.seedVersion,
    currency: view.currency,
    categories: view.categories,
    keywords: view.keywords,
    merchants: view.merchants,
    accounts: view.accounts,
  };
}

export function toStarterSeedResultModel(view: StarterSeedResultView): StarterSeedResultModel {
  return { categories: view.categories, keywords: view.keywords, reused: view.reused };
}

export function toMerchantSelectionResultModel(
  view: MerchantSelectionResultView,
): MerchantSelectionResultModel {
  return {
    applied: view.applied,
    alreadyOwned: view.alreadyOwned,
    unresolved: [...view.unresolved],
    withoutCategory: [...view.withoutCategory],
    embedded: view.embedded,
  };
}
