import { Field, ObjectType } from '@nestjs/graphql';

/**
 * A Tag: a free-form label orthogonal to the Category tree (docs/01 F-12).
 *
 * Categories answer "what was this for"; Tags answer "what else was true about it" — `#vanredno`,
 * `#dejan`, `#održavanje`. They cross-cut the tree, so a Tag never affects a budget or a balance;
 * it exists to be filtered and grouped by.
 */
@ObjectType({
  description:
    'A free-form label orthogonal to Categories (docs/01 F-12). Never affects a budget or a ' +
    'balance — a Tag is a second axis for filtering, not a classification.',
})
export class TagModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String, {
    nullable: true,
    description: 'A CSS colour for the chip, chosen by the user. Never interpreted by the server.',
  })
  color!: string | null;

  @Field(() => Number, {
    description:
      'Non-deleted Transactions in this Household carrying this Tag. Counted through the parent ' +
      'Transaction, because `transaction_tags` carries no `household_id` of its own.',
  })
  transactionCount!: number;

  @Field(() => Date)
  createdAt!: Date;
}
