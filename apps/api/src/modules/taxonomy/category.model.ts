import { Field, ObjectType, registerEnumType } from '@nestjs/graphql';

import { Paginated } from '../../graphql/pagination';

export enum CategoryKind {
  EXPENSE = 'EXPENSE',
  INCOME = 'INCOME',
}

registerEnumType(CategoryKind, {
  name: 'CategoryKind',
  description:
    'Whether a Category classifies money going out or coming in. A Category never classifies both ' +
    '(invariant I-3), which is what stops an expense landing in an income category.',
});

export enum KeywordPolarity {
  INCLUDE = 'INCLUDE',
  EXCLUDE = 'EXCLUDE',
}

registerEnumType(KeywordPolarity, {
  name: 'KeywordPolarity',
  description:
    'INCLUDE routes input toward a Category; EXCLUDE hard-blocks it. Exclusions are not optional: ' +
    'without them "ulje" routes engine oil into Auto/Gorivo (docs/04 §5.4).',
});

@ObjectType()
export class CategoryKeywordModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  keyword!: string;

  @Field(() => KeywordPolarity)
  polarity!: KeywordPolarity;

  @Field(() => String, { description: 'WORD, PREFIX or SUBSTRING (docs/04 §5.4).' })
  matchMode!: string;

  @Field(() => Number)
  weight!: number;
}

@ObjectType({
  description:
    'A node in the Household classification tree. Fully user-defined structure — the product does ' +
    'not impose a fixed taxonomy (docs/01 F-02).',
})
export class CategoryModel {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => CategoryKind)
  kind!: CategoryKind;

  @Field(() => String, { nullable: true })
  parentId!: string | null;

  @Field(() => String, { nullable: true })
  icon!: string | null;

  @Field(() => String, { nullable: true })
  color!: string | null;

  @Field(() => String, {
    nullable: true,
    description: 'A user-authored hint fed to the classifier (docs/04 §6.3).',
  })
  aiDescription!: string | null;

  @Field(() => Boolean, { description: 'True for a Category created by the onboarding seed.' })
  isSystem!: boolean;

  @Field(() => Number)
  sortOrder!: number;

  /** 1-based. The tree is capped at 5 (invariant I-11). */
  @Field(() => Number)
  depth!: number;

  @Field(() => [String], {
    description: 'Breadcrumb from the root down to this Category, by name. Used for display.',
  })
  path!: string[];

  @Field(() => [CategoryKeywordModel])
  keywords!: CategoryKeywordModel[];

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType()
export class CategoryConnection extends Paginated(CategoryModel) {}
