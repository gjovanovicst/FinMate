import { Args, ArgsType, Field, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { MerchantConnection, MerchantModel } from './merchant.model';
import { MerchantsService } from './merchants.service';

@ArgsType()
export class MerchantsPageArgs {
  @Field(() => String, { nullable: true, description: 'Substring match on the name.' })
  search?: string;

  @Field(() => Int, { nullable: true })
  first?: number;

  @Field(() => String, { nullable: true })
  after?: string;
}

@ArgsType()
export class CreateMerchantArgs {
  @Field(() => String)
  name!: string;

  @Field(() => ID, { nullable: true })
  defaultCategoryId?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'A user-authored hint for the classifier. Receipt-item classification outranks it.',
  })
  aiHint?: string | null;
}

@ArgsType()
export class UpdateMerchantArgs {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name?: string;

  @Field(() => ID, { nullable: true })
  defaultCategoryId?: string | null;

  @Field(() => String, { nullable: true })
  aiHint?: string | null;
}

@ArgsType()
export class SetMerchantAliasesArgs {
  @Field(() => ID)
  merchantId!: string;

  @Field(() => [String], {
    description:
      'The complete alias set, not a delta. Values are folded (lower case, no diacritics) before ' +
      'storage, so what is stored may differ from what was sent.',
  })
  aliases!: string[];
}

@ArgsType()
export class MergeMerchantsArgs {
  @Field(() => ID, { description: 'The merchant to fold away. Must be Household-owned.' })
  sourceId!: string;

  @Field(() => ID, { description: 'The merchant to keep. May be a shipped one.' })
  targetId!: string;
}

/**
 * Merchants (F-10, F-13).
 *
 * No `version` argument anywhere, unlike Transactions and Categories: the `merchants` table has no
 * `version` column, so optimistic concurrency is not available here. Two devices editing one
 * Merchant therefore last-write-wins, which is acceptable because the row holds no money — only a
 * name, an alias list and an optional default Category. Adding a column to change that is a
 * migration, and not worth one until the concurrency actually bites.
 */
@Resolver(() => MerchantModel)
export class MerchantsResolver {
  constructor(private readonly merchantsService: MerchantsService) {}

  @Query(() => MerchantConnection, {
    description:
      'Merchants visible to this Household: its own rows plus the shipped catalogue, own rows ' +
      'first. Keyset-paginated on the UUIDv7 id.',
  })
  async merchants(
    @CurrentHouseholdId() householdId: string,
    @Args() args: MerchantsPageArgs,
  ): Promise<MerchantConnection> {
    const page = await this.merchantsService.list(
      householdId,
      { search: args.search },
      { first: args.first, after: args.after },
    );
    return {
      edges: page.items.map((node) => ({ node, cursor: node.id })),
      pageInfo: { endCursor: page.endCursor, hasNextPage: page.hasNextPage },
      totalCount: page.totalCount,
    };
  }

  @Query(() => MerchantModel)
  async merchant(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<MerchantModel> {
    return this.merchantsService.getById(householdId, id);
  }

  @Mutation(() => MerchantModel)
  async createMerchant(
    @CurrentHouseholdId() householdId: string,
    @Args() args: CreateMerchantArgs,
  ): Promise<MerchantModel> {
    return this.merchantsService.create(householdId, args);
  }

  @Mutation(() => MerchantModel, {
    description:
      'Editing a shipped merchant creates a Household-owned copy and moves this Household’s ' +
      'references onto it, so the platform catalogue is never mutated (seeds are copy-on-write).',
  })
  async updateMerchant(
    @CurrentHouseholdId() householdId: string,
    @Args() args: UpdateMerchantArgs,
  ): Promise<MerchantModel> {
    const { id, ...input } = args;
    return this.merchantsService.update(householdId, id, input);
  }

  @Mutation(() => MerchantModel)
  async setMerchantAliases(
    @CurrentHouseholdId() householdId: string,
    @Args() args: SetMerchantAliasesArgs,
  ): Promise<MerchantModel> {
    return this.merchantsService.setAliases(householdId, args.merchantId, args.aliases);
  }

  @Mutation(() => Boolean, {
    description:
      'Soft-delete, refusing while Transactions, Receipts or RecurringRules still reference it. ' +
      'Merging is the reassignment path.',
  })
  async deleteMerchant(@Args('id', { type: () => ID }) id: string): Promise<boolean> {
    await this.merchantsService.remove(id);
    return true;
  }

  @Mutation(() => MerchantModel, {
    description:
      'Move every Transaction, Receipt and RecurringRule from one merchant to another, union their ' +
      'aliases, then delete the source.',
  })
  async mergeMerchants(
    @CurrentHouseholdId() householdId: string,
    @Args() args: MergeMerchantsArgs,
  ): Promise<MerchantModel> {
    return this.merchantsService.merge(householdId, args.sourceId, args.targetId);
  }
}
