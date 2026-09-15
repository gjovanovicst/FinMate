import { Module } from '@nestjs/common';

import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { OnboardingResolver } from './onboarding.resolver';
import { OnboardingService } from './onboarding.service';

/**
 * Onboarding (F-13): turning the shipped starter knowledge into a Household's own rows.
 *
 * It owns no tables. It writes categories, their keywords and merchants — all of which
 * `TaxonomyModule` owns — and it records its progress in `households.settings`, so it composes rather
 * than duplicates. The import is one-directional (`onboarding → taxonomy`); the category and merchant
 * editors must not learn about onboarding.
 */
@Module({
  imports: [TaxonomyModule],
  providers: [OnboardingResolver, OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
