import { Args, ArgsType, Field, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { JsonScalar } from '../../graphql/scalars/json.scalar';
import {
  RuleModel,
  RuleOriginEnum,
  type RuleConflictModel,
} from './rules.model';
import { RulesService, type RuleView } from './rules.service';

/**
 * The rules surface — docs/06 §3's `Rule` type, the `rules`/`rule` queries, and the two writes a user
 * makes directly.
 *
 * ## Why this resolver has no `householdId` argument
 *
 * Every method takes `@CurrentHouseholdId()`, which fails closed outside a `TenantContext` (ADR-008).
 * A client cannot name a Household, so it cannot probe for one.
 *
 * ## Where the learning-loop mutations live
 *
 * `correctTransaction` and `createRuleFromCorrection` are on `TransactionsResolver`, not here. Both
 * need to read and write a Transaction, and the module edge is one-directional (`ledger →
 * classification`, established by `captureCommit`); putting them here would need `ledger` imported
 * back into `classification` and make the two modules circular. The GraphQL schema does not care which
 * resolver declares a field.
 */
@ArgsType()
export class CreateRuleArgs {
  @Field(() => String)
  name!: string;

  @Field(() => Int, {
    nullable: true,
    description: 'Lower wins. Defaults to 100, the same tier a learned rule uses (docs/04 §5.3.1).',
  })
  priority?: number | null;

  @Field(() => Boolean, { nullable: true })
  isActive?: boolean | null;

  @Field(() => Boolean, { nullable: true })
  stopOnMatch?: boolean | null;

  @Field(() => JsonScalar, {
    description:
      'A condition tree: `{ all: [{ field, op, value }] }`. Validated by the rules engine before it ' +
      'is stored, so a rule this API accepts is one the pipeline can evaluate.',
  })
  conditions!: unknown;

  @Field(() => JsonScalar, {
    description: '`{ setCategoryId, setMerchantId, setCounterpartyId, setDescription, addTagIds }`.',
  })
  actions!: unknown;
}

@ArgsType()
export class UpdateRuleArgs {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  name?: string | null;

  @Field(() => Int, { nullable: true })
  priority?: number | null;

  @Field(() => Boolean, { nullable: true })
  isActive?: boolean | null;

  @Field(() => Boolean, { nullable: true })
  stopOnMatch?: boolean | null;

  @Field(() => JsonScalar, { nullable: true })
  conditions?: unknown;

  @Field(() => JsonScalar, { nullable: true })
  actions?: unknown;
}

@Resolver(() => RuleModel)
export class RulesResolver {
  constructor(private readonly rulesService: RulesService) {}

  @Query(() => [RuleModel], {
    description:
      'Every rule of this Household, active or not, ordered as the engine evaluates them ' +
      '(`priority ASC`, then newest first). `conflictsWith` is computed by running the real engine on ' +
      'an input each rule matches, so it cannot disagree with what the pipeline will do.',
  })
  async rules(@CurrentHouseholdId() householdId: string): Promise<RuleModel[]> {
    const rows = await this.rulesService.list(householdId);
    return rows.map(toRuleModel);
  }

  @Query(() => RuleModel)
  async rule(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<RuleModel> {
    return toRuleModel(await this.rulesService.get(householdId, id));
  }

  @Mutation(() => RuleModel, {
    description:
      'Save a rule. The document is validated by the rules engine, so an unevaluable rule is refused ' +
      'here rather than silently skipped on every future parse.',
  })
  async createRule(
    @CurrentHouseholdId() householdId: string,
    @Args() args: CreateRuleArgs,
  ): Promise<RuleModel> {
    return toRuleModel(
      await this.rulesService.create(householdId, {
        name: args.name,
        ...(args.priority == null ? {} : { priority: args.priority }),
        ...(args.isActive == null ? {} : { isActive: args.isActive }),
        ...(args.stopOnMatch == null ? {} : { stopOnMatch: args.stopOnMatch }),
        conditions: args.conditions,
        actions: args.actions,
        // A rule a person typed is `USER`; `LEARNED` is reserved for one synthesis proposed and the
        // user accepted, so the audit trail can tell the two apart (ADR-010).
        origin: 'USER',
      }),
    );
  }

  @Mutation(() => RuleModel)
  async updateRule(
    @CurrentHouseholdId() householdId: string,
    @Args() args: UpdateRuleArgs,
  ): Promise<RuleModel> {
    return toRuleModel(
      await this.rulesService.update(householdId, args.id, {
        ...(args.name == null ? {} : { name: args.name }),
        ...(args.priority == null ? {} : { priority: args.priority }),
        ...(args.isActive == null ? {} : { isActive: args.isActive }),
        ...(args.stopOnMatch == null ? {} : { stopOnMatch: args.stopOnMatch }),
        ...(args.conditions === undefined ? {} : { conditions: args.conditions }),
        ...(args.actions === undefined ? {} : { actions: args.actions }),
      }),
    );
  }

  @Mutation(() => Boolean, {
    description:
      'Soft-delete. A rule is a decision the user made, and F-31 has to be able to explain why a ' +
      'past Transaction was categorised the way it was.',
  })
  async deleteRule(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    await this.rulesService.remove(householdId, id);
    return true;
  }
}

/**
 * A rule as the GraphQL type, field by field.
 *
 * Written out rather than spread, so adding a column cannot silently publish it on the schema — a new
 * field is a deliberate schema change and a reviewable diff.
 */
export function toRuleModel(row: RuleView): RuleModel {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    isActive: row.isActive,
    stopOnMatch: row.stopOnMatch,
    conditions: row.conditions,
    actions: row.actions,
    origin: row.origin as RuleOriginEnum,
    sourceCorrectionId: row.sourceCorrectionId,
    // A string: `hit_count` is a BIGINT and a JSON number would lose it past 2^53 — not money, but the
    // same reasoning, and the client only ever renders it.
    hitCount: row.hitCount.toString(),
    lastHitAt: row.lastHitAt,
    isStale: row.isStale,
    conflictsWith: row.conflictsWith.map(toRuleConflictModel),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRuleConflictModel(row: {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly priority: number;
  readonly overlappingField: string;
  readonly existingValue: string | null;
  readonly proposedValue: string | null;
}): RuleConflictModel {
  return {
    ruleId: row.ruleId,
    ruleName: row.ruleName,
    priority: row.priority,
    overlappingField: row.overlappingField,
    existingValue: row.existingValue,
    proposedValue: row.proposedValue,
  };
}
