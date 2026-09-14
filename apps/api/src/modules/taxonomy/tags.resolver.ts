import { Args, ArgsType, Field, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { TagModel } from './tag.model';
import { TagsService } from './tags.service';

@ArgsType()
export class CreateTagArgs {
  @Field(() => String)
  name!: string;

  @Field(() => String, { nullable: true, description: 'A CSS colour for the chip.' })
  color?: string | null;
}

@ArgsType()
export class UpdateTagArgs {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name?: string;

  @Field(() => String, { nullable: true })
  color?: string | null;
}

/**
 * Tags (F-12).
 *
 * No `version` argument: the `tags` table has no `version` column — the same deviation `merchants`
 * and `counterparties` make. A Tag holds a name and a colour, so last-write-wins costs a rename.
 *
 * No `assignTags` mutation either, and that is deliberate: assignment belongs to the Transaction,
 * where the tag is written through the parent's nested write because `transaction_tags` is
 * parent-scoped and the tenancy guard refuses direct access. See the `tagIds` argument on
 * `createTransaction` / `updateTransaction` (docs/06 §5.0 records the taxonomy-shape deviation).
 */
@Resolver(() => TagModel)
export class TagsResolver {
  constructor(private readonly tagsService: TagsService) {}

  @Query(() => [TagModel], {
    description:
      'Every Tag in the Household, name-ordered. Not paginated: the transaction editor needs the ' +
      'whole set to render a chip picker, and a Household has tens of Tags rather than thousands.',
  })
  async tags(@CurrentHouseholdId() householdId: string): Promise<TagModel[]> {
    return this.tagsService.list(householdId);
  }

  @Query(() => TagModel, { nullable: true })
  async tag(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<TagModel | null> {
    // Null rather than NOT_FOUND, because the field is nullable in docs/06 §4: "does this Tag
    // exist" is a legitimate question with a legitimate negative answer.
    return this.tagsService.findById(householdId, id);
  }

  @Mutation(() => TagModel, {
    description:
      'A name that folds to an existing one is refused with CONFLICT: `#Vanredno` and `#vanredno` ' +
      'are one label.',
  })
  async createTag(
    @CurrentHouseholdId() householdId: string,
    @Args() args: CreateTagArgs,
  ): Promise<TagModel> {
    return this.tagsService.create(householdId, args);
  }

  @Mutation(() => TagModel)
  async updateTag(
    @CurrentHouseholdId() householdId: string,
    @Args() args: UpdateTagArgs,
  ): Promise<TagModel> {
    const { id, ...input } = args;
    return this.tagsService.update(householdId, id, input);
  }

  @Mutation(() => Boolean, {
    description:
      'Soft-deletes the Tag AND removes its Transaction assignments. Unlike a Merchant or a ' +
      'Category there is nothing to reassign a label to, so the analogue of reassignment is ' +
      'clearing the assignments — a dangling label is worse than a missing one.',
  })
  async deleteTag(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    await this.tagsService.remove(householdId, id);
    return true;
  }
}
