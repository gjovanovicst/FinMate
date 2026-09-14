import { Args, ArgsType, Field, ID, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { CategoryKind, CategoryModel, KeywordPolarity } from './category.model';
import { CategoriesService } from './categories.service';

@ArgsType()
export class CreateCategoryArgs {
  @Field(() => String)
  name!: string;

  @Field(() => CategoryKind)
  kind!: CategoryKind;

  @Field(() => ID, { nullable: true })
  parentId?: string | null;

  @Field(() => String, { nullable: true })
  icon?: string | null;

  @Field(() => String, { nullable: true })
  color?: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'A user-authored hint passed to the classifier (docs/04 §6.3).',
  })
  aiDescription?: string | null;
}

@ArgsType()
export class UpdateCategoryArgs {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name?: string;

  @Field(() => ID, {
    nullable: true,
    description: 'Move the category. Cycles and depth-limit breaches are refused (invariant I-11).',
  })
  parentId?: string | null;

  @Field(() => String, { nullable: true })
  icon?: string | null;

  @Field(() => String, { nullable: true })
  color?: string | null;

  @Field(() => String, { nullable: true })
  aiDescription?: string | null;

  @Field(() => Number, { nullable: true })
  sortOrder?: number;
}

@ArgsType()
export class AddKeywordArgs {
  @Field(() => ID)
  categoryId!: string;

  @Field(() => String)
  keyword!: string;

  @Field(() => KeywordPolarity)
  polarity!: KeywordPolarity;

  @Field(() => String, { nullable: true, defaultValue: 'WORD' })
  matchMode?: 'WORD' | 'PREFIX' | 'SUBSTRING';
}

@Resolver(() => CategoryModel)
export class CategoriesResolver {
  // Named `categoriesService`: the query method below is itself called `categories`, and a
  // field of the same name shadows it — a mistake already made once in the accounts resolver.
  constructor(private readonly categoriesService: CategoriesService) {}

  @Query(() => [CategoryModel], {
    description:
      'The Household category tree, flat, each node carrying its depth and breadcrumb. ' +
      'Ordered by sortOrder then name.',
  })
  async categories(
    @CurrentHouseholdId() householdId: string,
    @Args('kind', { type: () => CategoryKind, nullable: true }) kind?: CategoryKind,
  ): Promise<CategoryModel[]> {
    return this.categoriesService.list(householdId, kind);
  }

  @Mutation(() => CategoryModel)
  async createCategory(
    @Args() args: CreateCategoryArgs,
    @CurrentHouseholdId() householdId: string,
  ): Promise<CategoryModel> {
    return this.categoriesService.create(householdId, {
      name: args.name,
      kind: args.kind,
      parentId: args.parentId ?? null,
      icon: args.icon ?? null,
      color: args.color ?? null,
      aiDescription: args.aiDescription ?? null,
    });
  }

  @Mutation(() => CategoryModel)
  async updateCategory(
    @Args() args: UpdateCategoryArgs,
    @CurrentHouseholdId() householdId: string,
  ): Promise<CategoryModel> {
    return this.categoriesService.update(householdId, args.id, {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
      ...(args.icon !== undefined ? { icon: args.icon } : {}),
      ...(args.color !== undefined ? { color: args.color } : {}),
      ...(args.aiDescription !== undefined ? { aiDescription: args.aiDescription } : {}),
      ...(args.sortOrder !== undefined ? { sortOrder: args.sortOrder } : {}),
    });
  }

  @Mutation(() => Boolean, {
    description:
      'Soft-delete a category. Refused while transactions, splits or subcategories still reference ' +
      'it unless `reassignToId` is given (invariant I-12).',
  })
  async deleteCategory(
    @Args('id', { type: () => ID }) id: string,
    @CurrentHouseholdId() householdId: string,
    @Args('reassignToId', { type: () => ID, nullable: true }) reassignToId?: string,
  ): Promise<boolean> {
    await this.categoriesService.remove(householdId, id, reassignToId ?? null);
    return true;
  }

  @Mutation(() => Boolean, {
    description:
      'Add an INCLUDE or EXCLUDE keyword. EXCLUDE hard-blocks the category, which is what keeps ' +
      '"ulje" out of Auto/Gorivo (docs/04 §5.4).',
  })
  async addCategoryKeyword(
    @Args() args: AddKeywordArgs,
    @CurrentHouseholdId() householdId: string,
  ): Promise<boolean> {
    await this.categoriesService.addKeyword(
      householdId,
      args.categoryId,
      args.keyword,
      args.polarity,
      args.matchMode ?? 'WORD',
    );
    return true;
  }

  @Mutation(() => Boolean)
  async removeCategoryKeyword(
    @Args('keywordId', { type: () => ID }) keywordId: string,
    @CurrentHouseholdId() householdId: string,
  ): Promise<boolean> {
    await this.categoriesService.removeKeyword(householdId, keywordId);
    return true;
  }
}
