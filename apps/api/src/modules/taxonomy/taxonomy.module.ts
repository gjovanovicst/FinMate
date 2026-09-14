import { Module } from '@nestjs/common';

import { CategoriesResolver } from './categories.resolver';
import { CategoriesService } from './categories.service';
import { MerchantsResolver } from './merchants.resolver';
import { MerchantsService } from './merchants.service';

/**
 * Taxonomy: the Household's classification vocabulary.
 *
 * Categories and their keywords, plus Merchants. Counterparties and Tags (tasks 1.2.2–1.2.3) join
 * this module — they are the same concern (the words a household uses for its money) and share the
 * normalisation in `common/text/normalise`.
 */
@Module({
  providers: [CategoriesResolver, CategoriesService, MerchantsResolver, MerchantsService],
  exports: [CategoriesService, MerchantsService],
})
export class TaxonomyModule {}
