import { Module } from '@nestjs/common';

import { CategoriesResolver } from './categories.resolver';
import { CategoriesService } from './categories.service';

/**
 * Taxonomy: the Household's classification vocabulary.
 *
 * Phase 1 covers Categories and their keywords. Merchants, Counterparties and Tags (tasks 1.2.1–1.2.3)
 * join this module — they are the same concern (the words a household uses for its money) and share
 * the normalisation helpers.
 */
@Module({
  providers: [CategoriesResolver, CategoriesService],
  exports: [CategoriesService],
})
export class TaxonomyModule {}
