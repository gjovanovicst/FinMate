import { Module } from '@nestjs/common';

import { ClassificationModule } from '../classification/classification.module';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { OnboardingResolver } from './onboarding.resolver';
import { OnboardingService } from './onboarding.service';

/**
 * Onboarding (F-13): turning the shipped starter knowledge into a Household's own rows.
 *
 * It owns no tables. It writes categories, their keywords and merchants — all of which
 * `TaxonomyModule` owns — and it records its progress in `households.settings`, so it composes rather
 * than duplicates. The imports are one-directional (`onboarding → taxonomy`, `onboarding →
 * classification`); the category and merchant editors must not learn about onboarding.
 *
 * `ClassificationModule` is here for exactly one call: `applyMerchantSelection` indexes the Household's
 * newly created Merchants so docs/04 §4 rung 5 has vectors to compare against (2.3.4). Importing it
 * rather than re-providing `EntityEmbeddingsService` is what keeps the rung-5 provider decision in one
 * module — a second provider would be a second model to configure and a second `entity_embeddings`
 * population to keep in step.
 */
@Module({
  imports: [TaxonomyModule, ClassificationModule],
  providers: [OnboardingResolver, OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
