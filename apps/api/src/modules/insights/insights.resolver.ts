import { Args, ArgsType, Field, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { toConnection } from '../../graphql/pagination';
import {
  InsightConnection,
  InsightGenerationModel,
  InsightModel,
  InsightPageArgs,
  toInsightModel,
} from './insight.model';
import { InsightsService } from './insights.service';

/**
 * The insight feed's GraphQL surface — docs/06 §4.1 (`insights`), §5.10 (`dismissInsight`).
 *
 * Every method takes `@CurrentHouseholdId()`, which fails closed without a `TenantContext` (ADR-008):
 * there is no `householdId` argument anywhere, so a client cannot name another Household's insights.
 *
 * `generateInsights` is exposed as a mutation in this build because the `insights.generate` job
 * (docs/05 §8) needs the worker and its scheduler, which does not exist yet. It is the same method the
 * job will call, so wiring the job later changes nothing here — and leaving it unreachable would make
 * the whole feature unverifiable end to end.
 *
 * @module apps/api/src/modules/insights
 */

@ArgsType()
export class GenerateInsightsArgs {
  @Field(() => String, {
    nullable: true,
    description:
      'The local day to generate for. Defaults to today in the Household timezone; a past date is ' +
      'how a backfill or a test pins the run.',
  })
  asOf?: string;
}

@Resolver(() => InsightModel)
export class InsightsResolver {
  // Named `insightsService`: the query method below is itself called `insights`, and a field of the
  // same name shadows it — a mistake already made once in the accounts resolver (docs/15 §4).
  constructor(private readonly insightsService: InsightsService) {}

  @Query(() => InsightConnection, {
    description: 'The insight feed, newest first, keyset-paged on the UUIDv7 id (docs/06 §4.1).',
  })
  async insights(
    @CurrentHouseholdId() householdId: string,
    @Args() args: InsightPageArgs,
  ): Promise<unknown> {
    const page = await this.insightsService.list(
      householdId,
      {
        ...(args.filter?.kind !== undefined ? { kind: args.filter.kind } : {}),
        ...(args.filter?.severity !== undefined ? { severity: args.filter.severity } : {}),
        ...(args.filter?.includeDismissed !== undefined
          ? { includeDismissed: args.filter.includeDismissed }
          : {}),
        ...(args.filter?.periodStartOnOrAfter !== undefined
          ? { periodStartOnOrAfter: args.filter.periodStartOnOrAfter }
          : {}),
      },
      args.first,
      args.after,
    );
    return toConnection({
      items: page.items.map(toInsightModel),
      totalCount: page.totalCount,
      hasNextPage: page.hasNextPage,
      endCursor: page.endCursor,
    });
  }

  @Query(() => [InsightModel], {
    description:
      'The newest few undismissed insights — the dashboard rail (docs/06 §4.1). A limit rather than ' +
      'a page: the rail shows three and has no "next".',
  })
  async latestInsights(
    @CurrentHouseholdId() householdId: string,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 3 }) limit?: number,
  ): Promise<InsightModel[]> {
    const rows = await this.insightsService.latest(householdId, limit ?? 3);
    return rows.map(toInsightModel);
  }

  @Mutation(() => InsightGenerationModel, {
    description:
      'Run the deterministic generators for one period. Idempotent per condition and period, so it ' +
      'is safe to call repeatedly; the `insights.generate` job calls the same service method.',
  })
  async generateInsights(
    @CurrentHouseholdId() householdId: string,
    @Args() args: GenerateInsightsArgs,
  ): Promise<InsightGenerationModel> {
    const result = await this.insightsService.generate(householdId, args.asOf);
    return { created: result.created, alreadyRecorded: result.alreadyRecorded, drafts: result.drafts };
  }

  @Mutation(() => InsightModel, {
    nullable: true,
    description:
      'Dismiss an insight. Returns null when the id is not this Household\'s — the scoped predicate ' +
      'is the tenancy check, not a lookup the caller could race.',
  })
  async dismissInsight(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => String }) id: string,
  ): Promise<InsightModel | null> {
    const row = await this.insightsService.dismiss(householdId, id);
    return row === null ? null : toInsightModel(row);
  }
}
