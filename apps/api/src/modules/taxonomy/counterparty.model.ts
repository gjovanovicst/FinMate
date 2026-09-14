import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

import { Paginated } from '../../graphql/pagination';

export enum CounterpartyType {
  PERSON = 'PERSON',
  COMPANY = 'COMPANY',
  GOVERNMENT = 'GOVERNMENT',
  OTHER = 'OTHER',
}

registerEnumType(CounterpartyType, {
  name: 'CounterpartyType',
  description:
    'What kind of party sits on the other side of a Transaction that is not a shop. `PERSON` is ' +
    'the default because the F-11 requirement is a person ("Dejan rođa"); `GOVERNMENT` exists ' +
    'because a payment to an institution behaves differently from one to a company in reporting ' +
    'and in the classifier’s hints. It is a label for the user, not a rule input — nothing in the ' +
    'pipeline branches on it.',
});

@ObjectType({
  description:
    'An alternative spelling that resolves to this Counterparty. Stored folded (lower case, no ' +
    'diacritics) so it matches however the user types it — "Dejan rođa" and "dejan roda" are one ' +
    'person (docs/01 F-11).',
})
export class CounterpartyAliasModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  counterpartyId!: string;

  @Field(() => String)
  alias!: string;
}

@ObjectType({
  description:
    'A person or organisation in a non-merchant relationship — a relative, a landlord, an ' +
    'employer (docs/01 F-11, docs/03 §4). Distinct from a Merchant, which is where money was ' +
    'spent; a Counterparty is who it went to or came from. Always Household-owned: the table has ' +
    'no nullable `household_id`, so there are no global rows and no copy-on-write.',
})
export class CounterpartyModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => CounterpartyType)
  type!: CounterpartyType;

  @Field(() => String, { nullable: true })
  defaultCategoryId!: string | null;

  /**
   * The default Category as a breadcrumb, not a full `Category`.
   *
   * The same deviation Merchants make (docs/06 §5.0): a full `Category` carries depth, sortOrder,
   * keywords and a path resolved against the whole tree, which is a lot of machinery to attach to
   * an optional hint. The breadcrumb is what the UI renders.
   */
  @Field(() => [String], {
    nullable: true,
    description: 'Breadcrumb of the default Category, by name. Empty when none is set.',
  })
  defaultCategoryPath!: string[] | null;

  @Field(() => String, { nullable: true })
  note!: string | null;

  @Field(() => [CounterpartyAliasModel])
  aliases!: CounterpartyAliasModel[];

  @Field(() => Number, {
    description: 'Transactions in this Household that reference this Counterparty.',
  })
  transactionCount!: number;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType()
export class CounterpartyConnection extends Paginated(CounterpartyModel) {}
