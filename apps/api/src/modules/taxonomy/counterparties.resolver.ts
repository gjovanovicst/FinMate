import { Args, ArgsType, Field, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import {
  CounterpartyConnection,
  CounterpartyModel,
  CounterpartyType,
} from './counterparty.model';
import { CounterpartiesService } from './counterparties.service';

@ArgsType()
export class CounterpartiesPageArgs {
  @Field(() => String, { nullable: true, description: 'Substring match on the name.' })
  search?: string;

  @Field(() => Int, { nullable: true })
  first?: number;

  @Field(() => String, { nullable: true })
  after?: string;
}

@ArgsType()
export class CreateCounterpartyArgs {
  @Field(() => String)
  name!: string;

  @Field(() => CounterpartyType, {
    nullable: true,
    description: 'Defaults to `PERSON`, which is what F-11 is about ("Dejan rođa").',
  })
  type?: CounterpartyType;

  @Field(() => ID, { nullable: true })
  defaultCategoryId?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;
}

@ArgsType()
export class UpdateCounterpartyArgs {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name?: string;

  @Field(() => CounterpartyType, { nullable: true })
  type?: CounterpartyType;

  @Field(() => ID, { nullable: true })
  defaultCategoryId?: string | null;

  @Field(() => String, { nullable: true })
  note?: string | null;
}

@ArgsType()
export class SetCounterpartyAliasesArgs {
  @Field(() => ID)
  counterpartyId!: string;

  @Field(() => [String], {
    description:
      'The complete alias set, not a delta. Values are folded (lower case, no diacritics) before ' +
      'storage, so what is stored may differ from what was sent. This is the supported way to ' +
      'record a second spelling of one person ("dejan roda" for "Dejan rođa").',
  })
  aliases!: string[];
}

@ArgsType()
export class MergeCounterpartiesArgs {
  @Field(() => ID, { description: 'The counterparty to fold away.' })
  sourceId!: string;

  @Field(() => ID, { description: 'The counterparty to keep.' })
  targetId!: string;
}

/**
 * Counterparties (F-11).
 *
 * No `version` argument anywhere, unlike Transactions and Categories: the `counterparties` table has
 * no `version` column, so optimistic concurrency is not available here — the same deviation
 * `merchants` makes and for the same reason. Two devices editing one Counterparty therefore
 * last-write-wins, which is acceptable because the row holds no money — a name, a type, a note and
 * an optional default Category. Adding a column to change that is a migration, and not worth one
 * until the concurrency actually bites.
 */
@Resolver(() => CounterpartyModel)
export class CounterpartiesResolver {
  constructor(private readonly counterpartiesService: CounterpartiesService) {}

  @Query(() => CounterpartyConnection, {
    description:
      'The Household’s Counterparties, name-ordered. Keyset-paginated on the UUIDv7 id. There is ' +
      'no global/shareable set: every Counterparty is the Household’s own row.',
  })
  async counterparties(
    @CurrentHouseholdId() householdId: string,
    @Args() args: CounterpartiesPageArgs,
  ): Promise<CounterpartyConnection> {
    const page = await this.counterpartiesService.list(
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

  @Query(() => CounterpartyModel)
  async counterparty(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<CounterpartyModel> {
    return this.counterpartiesService.getById(householdId, id);
  }

  @Mutation(() => CounterpartyModel, {
    description:
      'A name that folds to an existing one is refused with CONFLICT: "Dejan rođa" and "dejan roda" ' +
      'are one person (docs/01 F-11).',
  })
  async createCounterparty(
    @CurrentHouseholdId() householdId: string,
    @Args() args: CreateCounterpartyArgs,
  ): Promise<CounterpartyModel> {
    return this.counterpartiesService.create(householdId, args);
  }

  @Mutation(() => CounterpartyModel)
  async updateCounterparty(
    @CurrentHouseholdId() householdId: string,
    @Args() args: UpdateCounterpartyArgs,
  ): Promise<CounterpartyModel> {
    const { id, ...input } = args;
    return this.counterpartiesService.update(householdId, id, input);
  }

  @Mutation(() => CounterpartyModel)
  async setCounterpartyAliases(
    @CurrentHouseholdId() householdId: string,
    @Args() args: SetCounterpartyAliasesArgs,
  ): Promise<CounterpartyModel> {
    return this.counterpartiesService.setAliases(householdId, args.counterpartyId, args.aliases);
  }

  @Mutation(() => Boolean, {
    description:
      'Soft-delete, refusing with CONFLICT while Transactions still reference it. Merging is the ' +
      'reassignment path — there is no "no counterparty" answer for money that changed hands.',
  })
  async deleteCounterparty(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    await this.counterpartiesService.remove(householdId, id);
    return true;
  }

  @Mutation(() => CounterpartyModel, {
    description:
      'Move every Transaction from one counterparty to another, union their aliases, then delete ' +
      'the source. This is how a duplicate created before the fold rule existed is cleaned up.',
  })
  async mergeCounterparties(
    @CurrentHouseholdId() householdId: string,
    @Args() args: MergeCounterpartiesArgs,
  ): Promise<CounterpartyModel> {
    return this.counterpartiesService.merge(householdId, args.sourceId, args.targetId);
  }
}
