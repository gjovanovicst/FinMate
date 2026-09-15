import { Args, Int, Query, Resolver } from '@nestjs/graphql';

import { type TimeBucket } from '@finmate/domain';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import { UuidScalar } from '../../graphql/scalars/uuid.scalar';
import {
  CashflowBucketModel,
  CategorySpendModel,
  DateRangeInput,
  MerchantSpendModel,
  MonthComparisonModel,
  SpendBucketModel,
  TimeBucketEnum,
  toCashflowBucketModel,
  toCategorySpendModel,
  toMerchantSpendModel,
  toMonthComparisonModel,
  toSpendBucketModel,
} from './analytics.model';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics — docs/06 §4.3, docs/01 F-20.
 *
 * Five queries, no mutations: analytics reads the ledger and never writes to it. Every one takes
 * `@CurrentHouseholdId()`, which fails closed without a `TenantContext` (ADR-008) — there is no
 * `householdId` argument anywhere in this file, so a client cannot ask about another Household's
 * spending.
 *
 * The `range`/`period` arguments are **required** rather than defaulted to "this month": a figure whose
 * period the client did not choose is a figure the client cannot label, and docs/02 §4.15's screen
 * exists to compare periods the user picked.
 *
 * @module apps/api/src/modules/analytics
 */
@Resolver()
export class AnalyticsResolver {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Query(() => [CategorySpendModel], {
    description:
      'Spend per Category over an inclusive range, biggest first, splits included (invariants I-1, ' +
      'I-7). With `includeSubcategories` a Category that has children carries their spend too and ' +
      '`isSubtreeAggregate` says so; the money in no Category is a row with a null `categoryId`, so ' +
      'the leaf rows’ shares add up to the whole range.',
  })
  async spendByCategory(
    @CurrentHouseholdId() householdId: string,
    @Args('range', { type: () => DateRangeInput }) range: DateRangeInput,
    @Args('accountIds', { type: () => [UuidScalar], nullable: true }) accountIds?: string[] | null,
    @Args('includeSubcategories', { type: () => Boolean, nullable: true, defaultValue: true })
    includeSubcategories?: boolean | null,
  ): Promise<CategorySpendModel[]> {
    const rows = await this.analyticsService.spendByCategory(householdId, {
      range,
      accountIds,
      includeSubcategories,
    });
    return rows.map(toCategorySpendModel);
  }

  @Query(() => [SpendBucketModel], {
    description:
      'The spend series over a range, one row per bucket — empty buckets included, so a month with no ' +
      'spending draws a zero rather than a gap. `categoryIds` scopes the series to those Categories’ ' +
      'subtree money, splits included, on the day the receipt was paid.',
  })
  async spendOverTime(
    @CurrentHouseholdId() householdId: string,
    @Args('range', { type: () => DateRangeInput }) range: DateRangeInput,
    @Args('bucket', { type: () => TimeBucketEnum }) bucket: TimeBucket,
    @Args('categoryIds', { type: () => [UuidScalar], nullable: true }) categoryIds?: string[] | null,
  ): Promise<SpendBucketModel[]> {
    const rows = await this.analyticsService.spendOverTime(householdId, { range, bucket, categoryIds });
    return rows.map(toSpendBucketModel);
  }

  @Query(() => [MerchantSpendModel], {
    description:
      'The biggest Merchants of a range, full Transaction amounts (a split receipt counts under the ' +
      'shop that was paid). A Merchant that was never resolved is listed under its raw description.',
  })
  async topMerchants(
    @CurrentHouseholdId() householdId: string,
    @Args('range', { type: () => DateRangeInput }) range: DateRangeInput,
    @Args('limit', { type: () => Int, nullable: true, defaultValue: 10 }) limit?: number | null,
  ): Promise<MerchantSpendModel[]> {
    const rows = await this.analyticsService.topMerchants(householdId, { range, limit });
    return rows.map(toMerchantSpendModel);
  }

  @Query(() => MonthComparisonModel, {
    description:
      'One month against another (`YYYY-MM`; `compareTo` defaults to the month before). Each Category ' +
      'carries its baseline figure and a change ratio that is **null when there is nothing to compare ' +
      'against**, which docs/02 §4.15 renders as “nema osnova za poređenje”.',
  })
  async monthComparison(
    @CurrentHouseholdId() householdId: string,
    @Args('period', { type: () => String }) period: string,
    @Args('compareTo', { type: () => String, nullable: true }) compareTo?: string | null,
  ): Promise<MonthComparisonModel> {
    const view = await this.analyticsService.monthComparison(householdId, { period, compareTo });
    return toMonthComparisonModel(view);
  }

  @Query(() => [CashflowBucketModel], {
    description: 'What came in, what went out and the signed net, per bucket, over a range.',
  })
  async cashflow(
    @CurrentHouseholdId() householdId: string,
    @Args('range', { type: () => DateRangeInput }) range: DateRangeInput,
    @Args('bucket', { type: () => TimeBucketEnum }) bucket: TimeBucket,
  ): Promise<CashflowBucketModel[]> {
    const rows = await this.analyticsService.cashflow(householdId, { range, bucket });
    return rows.map(toCashflowBucketModel);
  }
}
