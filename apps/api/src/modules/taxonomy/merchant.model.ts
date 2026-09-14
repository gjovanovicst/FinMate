import { Field, ObjectType } from '@nestjs/graphql';

import { Paginated } from '../../graphql/pagination';

@ObjectType({
  description:
    'An alternative spelling that resolves to this Merchant. Stored folded (lower case, no ' +
    'diacritics) so it matches however the user types it.',
})
export class MerchantAliasModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  merchantId!: string;

  @Field(() => String)
  alias!: string;
}

@ObjectType({
  description:
    'A shop or service a Transaction was made at. The household sees the shipped platform ' +
    'catalogue plus its own rows; `isOwnedByHousehold` is the distinction (docs/01 F-10, F-13).',
})
export class MerchantModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String, { nullable: true })
  defaultCategoryId!: string | null;

  /**
   * The default Category as a breadcrumb, not a full `Category`.
   *
   * A full `Category` carries depth, sortOrder, keywords and a path resolved against the whole tree,
   * which is a lot of machinery to attach to an optional hint — and receipt-item classification
   * outranks this default anyway (docs/04 §6.3). The breadcrumb is what the UI renders.
   */
  @Field(() => [String], {
    nullable: true,
    description: 'Breadcrumb of the default Category, by name. Empty when none is set.',
  })
  defaultCategoryPath!: string[] | null;

  @Field(() => String, { nullable: true })
  aiHint!: string | null;

  @Field(() => Boolean, {
    description: 'True for a shipped seed row (`household_id IS NULL`). Global rows are read-only.',
  })
  isGlobal!: boolean;

  @Field(() => Boolean, {
    description:
      'True when this Household owns the row. False for a global seed: seeds are copy-on-write, so ' +
      'editing one creates an owned copy rather than mutating platform content.',
  })
  isOwnedByHousehold!: boolean;

  @Field(() => [MerchantAliasModel])
  aliases!: MerchantAliasModel[];

  @Field(() => Number, { description: 'Transactions in this Household that reference this Merchant.' })
  transactionCount!: number;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType()
export class MerchantConnection extends Paginated(MerchantModel) {}
