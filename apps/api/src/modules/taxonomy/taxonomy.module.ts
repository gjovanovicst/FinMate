import { Module } from '@nestjs/common';

import { CategoriesResolver } from './categories.resolver';
import { CategoriesService } from './categories.service';
import { CounterpartiesResolver } from './counterparties.resolver';
import { CounterpartiesService } from './counterparties.service';
import { MerchantsResolver } from './merchants.resolver';
import { MerchantsService } from './merchants.service';
import { TagsResolver } from './tags.resolver';
import { TagsService } from './tags.service';

/**
 * Taxonomy: the Household's classification vocabulary.
 *
 * Categories and their keywords, Merchants, Counterparties and Tags — the words a household uses
 * for its money. They share the normalization in `common/text/normalise` and the delete-by-refusal
 * vs delete-by-clearing distinction recorded on `CounterpartiesService.remove` and
 * `TagsService.remove`.
 */
@Module({
  providers: [
    CategoriesResolver,
    CategoriesService,
    CounterpartiesResolver,
    CounterpartiesService,
    MerchantsResolver,
    MerchantsService,
    TagsResolver,
    TagsService,
  ],
  exports: [CategoriesService, CounterpartiesService, MerchantsService, TagsService],
})
export class TaxonomyModule {}
