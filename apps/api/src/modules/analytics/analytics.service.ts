import { Injectable } from '@nestjs/common';

import {
  balance,
  changeRatio,
  money,
  monthPeriod,
  previousMonthRange,
  shareOfTotal,
  type Balance,
  type CurrencyCode,
  type LocalDate,
  type Money,
  type TimeBucket,
} from '@finmate/domain';

import { ledgerCurrencyOf } from '../../common/households/ledger-currency';
import { ApiError } from '../../common/filters/all-exceptions.filter';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SpendReadModel, type SpendScope, type SpendWindow } from '../ledger/spend-read-model';
import { CategoriesService } from '../taxonomy/categories.service';
import { MerchantsService } from '../taxonomy/merchants.service';
import type { CategoryModel } from '../taxonomy/category.model';

/**
 * Analytics — docs/01 F-20, docs/06 §4.3.
 *
 * ## Composed, never recomputed
 *
 * Every figure comes from {@link SpendReadModel}, the one split-aware aggregate (I-1, I-7), so this
 * screen cannot disagree with the budget tile or the assistant about what a Category cost. What this
 * service owns is what a *chart* needs on top of a sum: the Category rollup, shares, month-over-month
 * ratios and bucketed series. The arithmetic of those is `@finmate/domain`'s (`rollUp` aside, which
 * needs the tree), and this file is the SQL-free layer between them.
 *
 * ## Ranges are inclusive days, and the client always says which
 *
 * No method here guesses a period from "today": `DateRangeInput` and the `YYYY-MM` month key are the
 * caller's, and every response carries the range it was computed over (docs/06 §4.3). docs/02 §4.15
 * draws a period picker, not a "this month" button.
 *
 * ## The uncategorised bucket
 *
 * `spendByCategory` returns a row with `categoryId: null` for money that landed in no Category, and the
 * shares are of the **whole** range's expense — so the leaf rows' shares add up to 1 including that
 * bucket. Omitting it would make a Household with 30 % uncategorised spend see shares that silently
 * describe only the other 70 %, which is the one thing an analytics screen must not do (F-20's whole
 * purpose is to show where the money went).
 *
 * @module apps/api/src/modules/analytics
 */

/** docs/06 §4.3's `CategorySpend`, before the GraphQL mapping. */
export interface CategorySpendView {
  readonly categoryId: string | null;
  readonly category: CategoryModel | null;
  readonly periodStart: LocalDate;
  readonly periodEnd: LocalDate;
  readonly total: Money;
  readonly transactionCount: number;
  readonly shareOfTotal: number;
  readonly priorPeriodTotal: Money | null;
  readonly changeRatio: number | null;
  readonly isSubtreeAggregate: boolean;
}

export interface SpendBucketView {
  readonly bucketStart: LocalDate;
  readonly bucketEnd: LocalDate;
  readonly expenseTotal: Money;
  readonly incomeTotal: Money;
  readonly transactionCount: number;
}

export interface CashflowBucketView {
  readonly bucketStart: LocalDate;
  readonly income: Money;
  readonly expense: Money;
  readonly net: Balance;
}

export interface MerchantSpendView {
  readonly merchantId: string | null;
  readonly displayName: string;
  readonly total: Money;
  readonly transactionCount: number;
}

export interface MonthComparisonView {
  readonly period: string;
  readonly compareTo: string;
  readonly total: Money;
  readonly compareTotal: Money;
  readonly delta: Balance;
  readonly deltaRatio: number | null;
  readonly categories: readonly CategorySpendView[];
}

export interface SpendByCategoryInput {
  readonly range: { readonly start: string; readonly end: string };
  /** `null` as well as absent: a nullable GraphQL argument arrives as an explicit `null`. */
  readonly accountIds?: readonly string[] | null;
  readonly includeSubcategories?: boolean | null;
}

export interface SpendOverTimeInput {
  readonly range: { readonly start: string; readonly end: string };
  readonly bucket: TimeBucket;
  readonly categoryIds?: readonly string[] | null;
}

export interface MonthComparisonInput {
  readonly period: string;
  readonly compareTo?: string | null;
}

/** docs/06 §11.2's `READ_ANALYTICS` class. */
const READ_ANALYTICS_PER_MINUTE = 120;

/** The month key `spendByCategory`'s sibling `monthComparison` takes: `2026-09`. */
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

/** One Category's rolled-up figure: its own spend plus its descendants'. */
interface RolledSpend {
  minor: bigint;
  transactionCount: number;
  /** True once a descendant Category has contributed — i.e. this row is a subtree aggregate. */
  aggregated: boolean;
}

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly spend: SpendReadModel,
    private readonly categories: CategoriesService,
    private readonly merchants: MerchantsService,
    private readonly rateLimit: RateLimitService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Spend per Category over a range, biggest first.
   *
   * The row set is **every Category with spend, plus every ancestor that aggregates it**, so a client
   * can draw a tree; a flat chart should read the roots (a root's figure covers its whole subtree and
   * the roots partition the categorised spend). `includeSubcategories: false` returns the leaves only,
   * each with its own spend.
   */
  async spendByCategory(
    householdId: string,
    input: SpendByCategoryInput,
  ): Promise<readonly CategorySpendView[]> {
    await this.consumeReadBudget(householdId, 'spendByCategory');

    const window = this.windowOf(input.range);
    const scope: SpendScope = {
      kind: 'EXPENSE',
      ...(input.accountIds === undefined || input.accountIds === null
        ? {}
        : { accountIds: input.accountIds }),
    };

    const [currency, leaves, whole, uncategorised, categoryList] = await Promise.all([
      ledgerCurrencyOf(this.prisma, householdId),
      this.spend.byCategory(householdId, window, scope),
      this.spend.total(householdId, window, scope),
      this.spend.uncategorised(householdId, window, scope),
      this.categories.list(householdId),
    ]);

    const own = new Map<string, { minor: bigint; transactionCount: number }>(
      leaves.map((row) => [row.categoryId, { minor: row.minor, transactionCount: row.transactionCount }]),
    );
    const rolled = this.rollUp(own, categoryList);

    const rows: CategorySpendView[] = [...rolled.entries()].map(([categoryId, value]) =>
      this.categoryView({
        categoryId,
        category: categoryList.find((node) => node.id === categoryId) ?? null,
        period: { start: window.from, end: window.to },
        minor: value.minor,
        transactionCount: value.transactionCount,
        totalMinor: whole.minor,
        currency,
        prior: null,
        aggregated: value.aggregated,
      }),
    );

    // The whole-range total minus what landed in a Category. `uncategorised` returns exactly the
    // complement of the categorised money (and of the count: it excludes split Transactions, whose
    // money is filed under their splits), so the two figures cannot drift apart.
    if (uncategorised.minor > 0n || uncategorised.transactionCount > 0) {
      rows.push(
        this.categoryView({
          categoryId: null,
          category: null,
          period: { start: window.from, end: window.to },
          minor: uncategorised.minor,
          transactionCount: uncategorised.transactionCount,
          totalMinor: whole.minor,
          currency,
          prior: null,
          aggregated: false,
        }),
      );
    }

    if (input.includeSubcategories === false) {
      // Only the Categories that carry spend of their own (the leaves of the spend tree) plus the
      // uncategorised bucket, which sits outside the tree and would otherwise vanish from a chart that
      // claims to show where the money went.
      return rows.filter((row) => row.categoryId === null || own.has(row.categoryId));
    }

    return this.rank(rows);
  }

  /**
   * The spend series over a range, one row per bucket, empty buckets included.
   *
   * `categoryIds` scopes the series to a Category **subtree** — the ids given plus every descendant —
   * because a parent Category with no spending of its own is the normal case, and a series that
   * answered zero for it would be a chart that contradicts the bar beside it (the rollup
   * {@link spendByCategory} does, and I-5's spend-in-subtree rule). A split counts on the day its
   * parent was paid, not the day it was divided (I-1).
   */
  async spendOverTime(
    householdId: string,
    input: SpendOverTimeInput,
  ): Promise<readonly SpendBucketView[]> {
    await this.consumeReadBudget(householdId, 'spendOverTime');

    const window = this.windowOf(input.range);
    const scopeIds = this.categoryScopeIds(input.categoryIds);
    const [currency, buckets] = await Promise.all([
      ledgerCurrencyOf(this.prisma, householdId),
      scopeIds === null
        ? this.spend.byBucket(householdId, window, input.bucket)
        : this.subtreeScope(householdId, scopeIds).then((categoryIds) =>
            this.spend.byBucket(householdId, window, input.bucket, { categoryIds }),
          ),
    ]);

    return buckets.map((bucket) => ({
      bucketStart: bucket.bucketStart,
      bucketEnd: bucket.bucketEnd,
      expenseTotal: money(bucket.expenseMinor, currency),
      incomeTotal: money(bucket.incomeMinor, currency),
      transactionCount: bucket.transactionCount,
    }));
  }

  /** The cashflow series: what came in, what went out, and the signed difference, per bucket. */
  async cashflow(
    householdId: string,
    input: { readonly range: { start: string; end: string }; readonly bucket: TimeBucket },
  ): Promise<readonly CashflowBucketView[]> {
    await this.consumeReadBudget(householdId, 'cashflow');

    const window = this.windowOf(input.range);
    const [currency, buckets] = await Promise.all([
      ledgerCurrencyOf(this.prisma, householdId),
      this.spend.byBucket(householdId, window, input.bucket),
    ]);

    return buckets.map((bucket) => ({
      bucketStart: bucket.bucketStart,
      income: money(bucket.incomeMinor, currency),
      expense: money(bucket.expenseMinor, currency),
      net: balance(bucket.incomeMinor - bucket.expenseMinor, currency),
    }));
  }

  /**
   * The biggest Merchants of a range, full Transaction amounts.
   *
   * A Merchant that was never resolved is listed under the raw description rather than dropped: the
   * person looking at the chart is trying to recognise where the money went (docs/06 §4.3), and "the
   * row with no merchant" is not an answer to that.
   */
  async topMerchants(
    householdId: string,
    input: { readonly range: { start: string; end: string }; readonly limit?: number | null },
  ): Promise<readonly MerchantSpendView[]> {
    await this.consumeReadBudget(householdId, 'topMerchants');

    const window = this.windowOf(input.range);
    const [currency, rows] = await Promise.all([
      ledgerCurrencyOf(this.prisma, householdId),
      this.spend.byMerchant(householdId, window, {
        kind: 'EXPENSE',
        // `byMerchant` clamps to 1…200 itself; the default belongs to the SDL.
        ...(input.limit === undefined || input.limit === null ? {} : { limit: input.limit }),
      }),
    ]);

    const names = await this.merchants.displayNames(
      rows.map((row) => row.merchantId).filter((id): id is string => id !== null),
    );

    return rows.map((row) => ({
      merchantId: row.merchantId,
      displayName:
        row.merchantId === null
          ? (row.description ?? '—')
          : (names.get(row.merchantId) ?? row.description ?? '—'),
      total: money(row.minor, currency),
      transactionCount: row.transactionCount,
    }));
  }

  /**
   * One month against another — the "how does this month compare" figure.
   *
   * Both months are rolled up the same way {@link spendByCategory} rolls up, so the two halves of
   * docs/02 §4.15's screen describe the same Categories with the same boundaries. A Category that had
   * spend only in the baseline month is **present with a total of 0** and a ratio of −1: disappearing
   * is the most interesting thing a Category can do, and dropping the row would hide it.
   */
  async monthComparison(
    householdId: string,
    input: MonthComparisonInput,
  ): Promise<MonthComparisonView> {
    await this.consumeReadBudget(householdId, 'monthComparison');

    const period = this.monthKey(input.period, 'period');
    const current = monthPeriod(`${period}-01` as LocalDate);
    const compareTo =
      input.compareTo === undefined || input.compareTo === null || input.compareTo.trim() === ''
        ? monthKeyOf(previousMonthRange(current))
        : this.monthKey(input.compareTo, 'compareTo');
    const baseline =
      compareTo === monthKeyOf(previousMonthRange(current))
        ? previousMonthRange(current)
        : monthPeriod(`${compareTo}-01` as LocalDate);

    const scope: SpendScope = { kind: 'EXPENSE' };
    const [currency, currentLeaves, baselineLeaves, currentWhole, baselineWhole, currentUncat, baselineUncat, categoryList] =
      await Promise.all([
        ledgerCurrencyOf(this.prisma, householdId),
        this.spend.byCategory(householdId, windowOf(current), scope),
        this.spend.byCategory(householdId, windowOf(baseline), scope),
        this.spend.total(householdId, windowOf(current), scope),
        this.spend.total(householdId, windowOf(baseline), scope),
        this.spend.uncategorised(householdId, windowOf(current), scope),
        this.spend.uncategorised(householdId, windowOf(baseline), scope),
        this.categories.list(householdId),
      ]);

    const rolledCurrent = this.rollUp(
      new Map(currentLeaves.map((row) => [row.categoryId, { minor: row.minor, transactionCount: row.transactionCount }])),
      categoryList,
    );
    const rolledBaseline = this.rollUp(
      new Map(baselineLeaves.map((row) => [row.categoryId, { minor: row.minor, transactionCount: row.transactionCount }])),
      categoryList,
    );

    const ids = new Set<string>([...rolledCurrent.keys(), ...rolledBaseline.keys()]);
    const rows: CategorySpendView[] = [...ids].map((categoryId) => {
      const now = rolledCurrent.get(categoryId) ?? { minor: 0n, transactionCount: 0, aggregated: false };
      return this.categoryView({
        categoryId,
        category: categoryList.find((node) => node.id === categoryId) ?? null,
        period: current,
        minor: now.minor,
        transactionCount: now.transactionCount,
        totalMinor: currentWhole.minor,
        currency,
        prior: rolledBaseline.get(categoryId)?.minor ?? 0n,
        aggregated: now.aggregated,
      });
    });

    if (currentUncat.minor > 0n || baselineUncat.minor > 0n) {
      rows.push(
        this.categoryView({
          categoryId: null,
          category: null,
          period: current,
          minor: currentUncat.minor,
          transactionCount: currentUncat.transactionCount,
          totalMinor: currentWhole.minor,
          currency,
          prior: baselineUncat.minor,
          aggregated: false,
        }),
      );
    }

    return {
      period,
      compareTo,
      total: money(currentWhole.minor, currency),
      compareTotal: money(baselineWhole.minor, currency),
      delta: balance(currentWhole.minor - baselineWhole.minor, currency),
      deltaRatio: changeRatio(currentWhole.minor, baselineWhole.minor),
      categories: this.rank(rows),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------------------------

  /**
   * Add every Category's own spend to each of its ancestors.
   *
   * The tree walk is bounded by a visited set: `CategoriesService` refuses to create a cycle (I-11),
   * but an infinite loop inside a request is an outage, so a tree that somehow contained one would
   * terminate here rather than hang.
   */
  private rollUp(
    own: ReadonlyMap<string, { minor: bigint; transactionCount: number }>,
    categoryList: readonly CategoryModel[],
  ): Map<string, RolledSpend> {
    const parentOf = new Map(categoryList.map((node) => [node.id, node.parentId]));
    const rolled = new Map<string, RolledSpend>();

    const entryFor = (id: string): RolledSpend => {
      const existing = rolled.get(id);
      if (existing !== undefined) return existing;
      const created: RolledSpend = { minor: 0n, transactionCount: 0, aggregated: false };
      rolled.set(id, created);
      return created;
    };

    for (const [categoryId, leaf] of own) {
      const self = entryFor(categoryId);
      self.minor += leaf.minor;
      self.transactionCount += leaf.transactionCount;

      const seen = new Set<string>([categoryId]);
      let cursor = parentOf.get(categoryId) ?? null;
      while (cursor !== null && !seen.has(cursor)) {
        seen.add(cursor);
        const ancestor = entryFor(cursor);
        ancestor.minor += leaf.minor;
        ancestor.transactionCount += leaf.transactionCount;
        // The ancestor's figure now includes a descendant's spend, which is what
        // `isSubtreeAggregate` promises the client. A Category with its own spend and children ends up
        // with both, and the flag is set by the descendant rather than inferred from the shape.
        ancestor.aggregated = true;
        cursor = parentOf.get(cursor) ?? null;
      }
    }

    return rolled;
  }

  private categoryView(input: {
    categoryId: string | null;
    category: CategoryModel | null;
    period: { readonly start: LocalDate; readonly end: LocalDate };
    minor: bigint;
    transactionCount: number;
    totalMinor: bigint;
    currency: CurrencyCode;
    prior: bigint | null;
    aggregated: boolean;
  }): CategorySpendView {
    return {
      categoryId: input.categoryId,
      category: input.category,
      periodStart: input.period.start,
      periodEnd: input.period.end,
      total: money(input.minor, input.currency),
      transactionCount: input.transactionCount,
      shareOfTotal: shareOfTotal(input.minor, input.totalMinor),
      priorPeriodTotal: input.prior === null ? null : money(input.prior, input.currency),
      changeRatio: input.prior === null ? null : changeRatio(input.minor, input.prior),
      isSubtreeAggregate: input.aggregated,
    };
  }

  /** Biggest first, then by id, with the uncategorised bucket last among equals (it has no id). */
  private rank(rows: readonly CategorySpendView[]): CategorySpendView[] {
    return [...rows].sort((left, right) => {
      const leftMinor = BigInt(left.total.amountMinor);
      const rightMinor = BigInt(right.total.amountMinor);
      if (leftMinor !== rightMinor) return rightMinor > leftMinor ? 1 : -1;
      return (left.categoryId ?? '~').localeCompare(right.categoryId ?? '~');
    });
  }

  private categoryScopeIds(categoryIds: readonly string[] | null | undefined): string[] | null {
    return categoryIds === undefined || categoryIds === null || categoryIds.length === 0
      ? null
      : [...categoryIds];
  }

  /** The given Categories plus every descendant of theirs, as one scope (I-11's tree). */
  private async subtreeScope(householdId: string, categoryIds: readonly string[]): Promise<string[]> {
    const categoryList = await this.categories.list(householdId);
    return this.withDescendants(categoryIds, categoryList);
  }

  /**
   * A fixpoint over the parent links rather than a recursive walk per id: the tree is small, a
   * `Category` may be named twice, and only *adding* a node can change the answer, so this terminates
   * even if the links were somehow cyclic.
   */
  private withDescendants(
    categoryIds: readonly string[],
    categoryList: readonly CategoryModel[],
  ): string[] {
    const wanted = new Set(categoryIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of categoryList) {
        if (node.parentId !== null && wanted.has(node.parentId) && !wanted.has(node.id)) {
          wanted.add(node.id);
          changed = true;
        }
      }
    }
    return [...wanted];
  }

  /**
   * The one place a range becomes the read model's window.
   *
   * `LocalDate`'s scalar has already rejected anything that is not `YYYY-MM-DD`, so only the order is
   * checked here — an inverted range would otherwise come back as an empty chart, which reads as "you
   * spent nothing" rather than as the client bug it is.
   */
  private windowOf(range: { readonly start: string; readonly end: string }): SpendWindow {
    if (range.start > range.end) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `The range ends before it starts (${range.start} → ${range.end}).`,
      );
    }
    return { from: range.start as LocalDate, to: range.end as LocalDate };
  }

  private monthKey(value: string, field: string): string {
    const key = value.trim();
    if (!MONTH_KEY.test(key)) {
      throw new ApiError('VALIDATION_FAILED', `${field} must be a month formatted YYYY-MM (received "${value}").`);
    }
    return key;
  }

  /**
   * docs/06 §11.2's `READ_ANALYTICS` class, counted per Household.
   *
   * `spendByCategory` is included although the table's row lists only the other four: it is the most
   * expensive of the five (it runs two reads per Category set plus the tree), and a limit that skipped
   * the priciest query would not be a limit on anything. Recorded as a correction in docs/06 §11.2.
   */
  private async consumeReadBudget(householdId: string, operation: string): Promise<void> {
    const verdict = await this.rateLimit.consume(
      'analytics:read',
      householdId,
      READ_ANALYTICS_PER_MINUTE,
      60,
    );
    if (!verdict.allowed) {
      throw new ApiError(
        'RATE_LIMITED',
        `Too many analytics queries (${operation}). Please try again in a minute.`,
        true,
      );
    }
  }
}

/** A month's range as the read model's window. */
function windowOf(range: { readonly start: LocalDate; readonly end: LocalDate }): SpendWindow {
  return { from: range.start, to: range.end };
}

function monthKeyOf(range: { readonly start: LocalDate }): string {
  return range.start.slice(0, 7);
}
