import { Injectable } from '@nestjs/common';

import { bucketRanges, type LocalDate, type TimeBucket } from '@finmate/domain';

import { PrismaService } from '../../prisma/prisma.service';

/**
 * The ledger's **spend read model** — one split-aware aggregation, on purpose.
 *
 * ## Why this exists
 *
 * "What did this Category cost in this range?" was answered in three places: the budget tile
 * (`BudgetsService.spendIn`), the assistant's fact assembly, and the insight generators. The first two
 * counted **splits**, the third did not — so a Household whose groceries arrived as one split receipt
 * saw a budget tile and an insight that disagreed, and (task 3.2.2) an assistant figure that agreed
 * with the tile. Two answers to one question is a bug waiting for a user to notice, and 3.3.1 is where
 * it gets reconciled (docs/06 §5.13).
 *
 * ## The two rules it encodes, once
 *
 * 1. **Invariant I-1/ADR-015: a split counts in its own Category.** A split Transaction carries no
 *    `category_id` of its own, so counting only `transactions.category_id` silently drops every split.
 *    Each Category total is therefore *direct rows in the Category* **plus** *splits filed under it*.
 * 2. **Invariant I-7: only `CONFIRMED`, non-deleted rows.** No method here takes a status parameter,
 *    deliberately — there is no correct caller that wants PENDING rows in a figure.
 *
 * ## What it does not do
 *
 * No labels, no currency conversion, no ratios: those belong to the caller (a Category path is the
 * taxonomy's, a ratio is `@finmate/domain`'s). It returns minor units and counts, so two consumers can
 * format the same number differently without ever computing it differently.
 *
 * @module apps/api/src/modules/ledger
 */

/** An inclusive range of the Household's own days (docs/03 §3.2). */
export interface SpendWindow {
  readonly from: LocalDate;
  readonly to: LocalDate;
}

/** A ledger scope. Every field is a resolved id, never free text. */
export interface SpendScope {
  readonly kind?: 'EXPENSE' | 'INCOME';
  readonly categoryIds?: readonly string[];
  readonly merchantId?: string;
  /** One Account (`accountId`, the assistant's singular slot) or several (`analytics.accountIds`). */
  readonly accountId?: string;
  readonly accountIds?: readonly string[];
  readonly tagId?: string;
}

export interface SpendTotals {
  readonly minor: bigint;
  readonly transactionCount: number;
}

export interface CategorySpendRow {
  readonly categoryId: string;
  readonly minor: bigint;
  readonly transactionCount: number;
}

export interface MerchantSpendRow {
  /** `null` when the row's Merchant was never resolved — the caller shows its description. */
  readonly merchantId: string | null;
  /** The raw description, for rows with no Merchant. `null` when the Merchant is known. */
  readonly description: string | null;
  readonly minor: bigint;
  readonly transactionCount: number;
}

export interface BucketSpendRow {
  readonly bucketStart: LocalDate;
  readonly bucketEnd: LocalDate;
  readonly expenseMinor: bigint;
  readonly incomeMinor: bigint;
  readonly transactionCount: number;
}

/**
 * A bucket scope. **No `kind`**: a bucket reports expense and income together, so scoping it to one
 * kind would be a parameter the query silently ignores.
 */
export type BucketScope = Omit<SpendScope, 'kind'>;

/** One confirmed expense row, for comparisons that are about a *transaction* rather than a total. */
export interface DirectExpenseRow {
  readonly id: string;
  readonly categoryId: string;
  readonly minor: bigint;
  readonly occurredOn: LocalDate;
}

@Injectable()
export class SpendReadModel {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Total spend (or income) over the window and scope.
   *
   * **An unscoped total is the sum of whole Transactions, not of parts.** A split Transaction carries
   * the full `amount_minor` (its splits partition it), so adding the split rows as well would count the
   * same money twice — a 2 245,00 receipt answered as 4 490,00. Splits are therefore added **only for a
   * Category scope**, where the direct rows and the split rows are disjoint by invariant I-1 (a
   * Transaction with splits has no `category_id` of its own), and the question is "how much of this
   * Category", not "how much did this Household spend". {@link byCategory} sums to the same figure.
   */
  async total(householdId: string, window: SpendWindow, scope: SpendScope = {}): Promise<SpendTotals> {
    const [direct, split, count] = await Promise.all([
      this.prisma.client.transactions.aggregate({
        where: this.directWhere(householdId, window, scope),
        _sum: { amount_minor: true },
      }),
      this.splitSum(householdId, window, scope),
      this.prisma.client.transactions.count({ where: this.countWhere(householdId, window, scope) }),
    ]);

    return { minor: (direct._sum.amount_minor ?? 0n) + split, transactionCount: count };
  }

  /**
   * Confirmed spend that landed in **no** Category — the complement of {@link byCategory}.
   *
   * A split Transaction is excluded even though its own `category_id` is null, because its money is
   * filed under its splits (I-1). Including it would report the same receipt twice and break the
   * identity that makes docs/06 §4.3's uncategorised bucket trustworthy:
   * `uncategorised.minor + Σ byCategory.minor === total.minor` (asserted in the analytics spec).
   */
  async uncategorised(
    householdId: string,
    window: SpendWindow,
    scope: SpendScope = {},
  ): Promise<SpendTotals> {
    const where = {
      ...this.directWhere(householdId, window, { ...scope, categoryIds: undefined }),
      category_id: null,
      transaction_splits: { none: {} },
    };

    const [sum, count] = await Promise.all([
      this.prisma.client.transactions.aggregate({ where, _sum: { amount_minor: true } }),
      this.prisma.client.transactions.count({ where }),
    ]);

    return { minor: sum._sum.amount_minor ?? 0n, transactionCount: count };
  }

  /**
   * Spend per Category, splits included, biggest first.
   *
   * The order is part of the answer rather than an accident of the query: charts and `TOP_CATEGORIES`
   * both read this list, and a list that reshuffles between two identical requests is one nobody can
   * compare with itself. Ties break on the Category id.
   */
  async byCategory(
    householdId: string,
    window: SpendWindow,
    scope: SpendScope = {},
  ): Promise<readonly CategorySpendRow[]> {
    const [direct, split] = await Promise.all([
      this.prisma.client.transactions.groupBy({
        by: ['category_id'],
        where: { ...this.directWhere(householdId, window, scope), category_id: { not: null } },
        _sum: { amount_minor: true },
        _count: { _all: true },
      }),
      // The split rows are read rather than grouped so the count below can be a count of distinct
      // **Transactions**. `_count._all` counts rows, and `transaction_splits` has no unique key on
      // `(transaction_id, category_id)` (verified in the DDL), so two splits of one receipt filed
      // under one Category would have been counted twice — and, the worse half, a Category whose
      // spend arrived *only* as a split was reported with a count of **zero** beside real money.
      this.prisma.client.transaction_splits.findMany({
        where: this.splitWhere(householdId, window, scope),
        select: { category_id: true, transaction_id: true, amount_minor: true },
      }),
    ]);

    const totals = new Map<string, { minor: bigint; directCount: number; transactions: Set<string> }>();
    for (const row of direct) {
      if (row.category_id === null) continue;
      totals.set(row.category_id, {
        minor: row._sum.amount_minor ?? 0n,
        directCount: row._count._all,
        transactions: new Set(),
      });
    }
    for (const row of split) {
      // I-1 makes the two sets disjoint: a Transaction with splits carries no `category_id` of its
      // own, so nothing is counted twice by adding them.
      const entry = totals.get(row.category_id) ?? { minor: 0n, directCount: 0, transactions: new Set() };
      entry.minor += row.amount_minor;
      entry.transactions.add(row.transaction_id);
      totals.set(row.category_id, entry);
    }

    return [...totals.entries()]
      .map(([categoryId, value]) => ({
        categoryId,
        minor: value.minor,
        transactionCount: value.directCount + value.transactions.size,
      }))
      .sort((left, right) =>
        right.minor > left.minor
          ? 1
          : right.minor < left.minor
            ? -1
            : left.categoryId < right.categoryId
              ? -1
              : 1,
      );
  }

  /**
   * Spend per Merchant, biggest first.
   *
   * **The full Transaction amount, not the un-split part.** A split receipt paid to Lidl was paid to
   * Lidl in full; attributing only the direct portion would understate the merchant the user is looking
   * at. A row whose Merchant was never resolved is grouped by its description instead, which is what
   * docs/06 §4.3 means by *"the merchant name, or the raw description when unresolved"*.
   */
  async byMerchant(
    householdId: string,
    window: SpendWindow,
    options: { readonly limit?: number; readonly kind?: 'EXPENSE' | 'INCOME' } = {},
  ): Promise<readonly MerchantSpendRow[]> {
    const grouped = await this.prisma.client.transactions.groupBy({
      by: ['merchant_id', 'description'],
      where: {
        ...this.directWhere(householdId, window, { kind: options.kind ?? 'EXPENSE' }),
      },
      _sum: { amount_minor: true },
      _count: { _all: true },
    });

    const totals = new Map<string, MerchantSpendRow>();
    for (const row of grouped) {
      const key = row.merchant_id ?? `description:${row.description}`;
      const existing = totals.get(key);
      totals.set(key, {
        merchantId: row.merchant_id,
        description: row.merchant_id === null ? row.description : null,
        minor: (existing?.minor ?? 0n) + (row._sum.amount_minor ?? 0n),
        transactionCount: (existing?.transactionCount ?? 0) + row._count._all,
      });
    }

    const limit = Math.min(Math.max(options.limit ?? 10, 1), 200);
    return [...totals.values()]
      .sort((left, right) =>
        right.minor > left.minor
          ? 1
          : right.minor < left.minor
            ? -1
            : (left.merchantId ?? left.description ?? '') < (right.merchantId ?? right.description ?? '')
              ? -1
              : 1,
      )
      .slice(0, limit);
  }

  /**
   * Spend and income per bucket, for the time series and the cashflow chart.
   *
   * **Every bucket in the range is present**, including empty ones: a chart with a missing month draws
   * a gap that reads as missing data rather than as a month with no spending. The buckets come from
   * `@finmate/domain`'s `bucketRanges`, which is the same code the axis labels use — so the series and
   * the axis can never disagree about where a boundary is.
   *
   * **A split lands in its parent's bucket**, on the parent's day and under the parent's kind (I-1):
   * the money was spent when the receipt was paid, not when it was divided.
   */
  async byBucket(
    householdId: string,
    window: SpendWindow,
    bucket: TimeBucket,
    scope: BucketScope = {},
  ): Promise<readonly BucketSpendRow[]> {
    const ranges = bucketRanges({ start: window.from, end: window.to }, bucket);
    if (ranges.length === 0) return [];

    const categoryScoped = scope.categoryIds !== undefined && scope.categoryIds.length > 0;

    const [rows, splits] = await Promise.all([
      this.prisma.client.transactions.groupBy({
        by: ['occurred_local_date', 'kind'],
        where: this.directWhere(householdId, window, scope),
        _sum: { amount_minor: true },
        _count: { _all: true },
      }),
      // A split's money belongs to the day and the kind of the Transaction it divides, and
      // `groupBy` cannot group by a relation's column — so the rows come back and are bucketed here.
      // Only a Category scope reaches them: without one the parent's full amount is already counted
      // (see {@link total}).
      categoryScoped
        ? this.prisma.client.transaction_splits.findMany({
            where: this.splitWhere(householdId, window, scope),
            select: {
              transaction_id: true,
              amount_minor: true,
              transactions: { select: { occurred_local_date: true, kind: true } },
            },
          })
        : Promise.resolve([]),
    ]);

    const result = new Map<
      string,
      { expenseMinor: bigint; incomeMinor: bigint; transactionCount: number; transactions: Set<string> }
    >(
      ranges.map((range) => [
        range.start,
        { expenseMinor: 0n, incomeMinor: 0n, transactionCount: 0, transactions: new Set<string>() },
      ]),
    );

    const bucketOf = (day: LocalDate) =>
      ranges.find((candidate) => day >= candidate.start && day <= candidate.end);

    for (const row of rows) {
      const range = bucketOf(this.iso(row.occurred_local_date));
      if (range === undefined) continue;
      const entry = result.get(range.start);
      if (entry === undefined) continue;
      const minor = row._sum.amount_minor ?? 0n;
      if (row.kind === 'INCOME') entry.incomeMinor += minor;
      else entry.expenseMinor += minor;
      entry.transactionCount += row._count._all;
    }

    for (const row of splits) {
      const range = bucketOf(this.iso(row.transactions.occurred_local_date));
      if (range === undefined) continue;
      const entry = result.get(range.start);
      if (entry === undefined) continue;
      if (row.transactions.kind === 'INCOME') entry.incomeMinor += row.amount_minor;
      else entry.expenseMinor += row.amount_minor;
      entry.transactions.add(row.transaction_id);
    }

    return ranges.map((range) => {
      const entry = result.get(range.start);
      return {
        bucketStart: range.start,
        bucketEnd: range.end,
        expenseMinor: entry?.expenseMinor ?? 0n,
        incomeMinor: entry?.incomeMinor ?? 0n,
        // The split Transactions of the bucket, which the direct count cannot have counted: nothing in
        // this bucket has a `category_id` of its own (I-1).
        transactionCount: (entry?.transactionCount ?? 0) + (entry?.transactions.size ?? 0),
      };
    });
  }

  /**
   * Confirmed expense rows with their Category, for a comparison that is about a **Transaction**.
   *
   * `UNUSUAL_SPEND` is the caller: it compares one purchase against a Category's history, and a split's
   * portion is not a purchase. That is why this method exists alongside {@link byCategory} rather than
   * being folded into it — the two answer different questions, and using the aggregate for the unusual
   * check would compare a split portion against whole transactions.
   */
  async directExpenseRows(
    householdId: string,
    window: SpendWindow,
    options: { readonly fromExclusive?: boolean; readonly limit?: number } = {},
  ): Promise<readonly DirectExpenseRow[]> {
    const rows = await this.prisma.client.transactions.findMany({
      where: {
        ...this.directWhere(householdId, window, { kind: 'EXPENSE' }),
        ...(options.fromExclusive === true
          ? { occurred_local_date: { gt: this.date(window.from), lte: this.date(window.to) } }
          : {}),
      },
      select: { id: true, category_id: true, amount_minor: true, occurred_local_date: true },
      orderBy: { id: 'asc' },
      ...(options.limit === undefined ? {} : { take: options.limit }),
    });

    return rows
      .filter((row): row is typeof row & { category_id: string } => row.category_id !== null)
      .map((row) => ({
        id: row.id,
        categoryId: row.category_id,
        minor: row.amount_minor,
        occurredOn: this.iso(row.occurred_local_date),
      }));
  }

  // -------------------------------------------------------------------------------------------
  // Where clauses — the two invariants, written once
  // -------------------------------------------------------------------------------------------

  private directWhere(householdId: string, window: SpendWindow, scope: SpendScope) {
    return {
      household_id: householdId,
      deleted_at: null,
      status: 'CONFIRMED' as const, // I-7
      occurred_local_date: { gte: this.date(window.from), lte: this.date(window.to) },
      ...(scope.kind === undefined ? {} : { kind: scope.kind }),
      ...this.accountFilter(scope),
      ...(scope.merchantId === undefined ? {} : { merchant_id: scope.merchantId }),
      ...(scope.categoryIds === undefined || scope.categoryIds.length === 0
        ? {}
        : { category_id: { in: [...scope.categoryIds] } }),
      ...(scope.tagId === undefined ? {} : { transaction_tags: { some: { tag_id: scope.tagId } } }),
    };
  }

  /** One Account or a set of them; an empty set matches nothing rather than everything. */
  private accountFilter(scope: SpendScope): { account_id?: { in: string[] } | string } {
    if (scope.accountId !== undefined) return { account_id: scope.accountId };
    if (scope.accountIds === undefined) return {};
    return { account_id: { in: [...scope.accountIds] } };
  }

  /**
   * A split is reached through its parent, so every predicate that belongs to the Transaction goes one
   * level down — **including the Tag**, which lives in `transaction_tags` (parent-scoped, no
   * `household_id` of its own) and does not exist on `transaction_splits` at all. Putting it on the
   * split makes Prisma reject the whole query as an unknown argument.
   */
  private splitWhere(householdId: string, window: SpendWindow, scope: SpendScope) {
    return {
      household_id: householdId,
      ...(scope.categoryIds === undefined || scope.categoryIds.length === 0
        ? {}
        : { category_id: { in: [...scope.categoryIds] } }),
      transactions: {
        household_id: householdId,
        deleted_at: null,
        status: 'CONFIRMED' as const,
        occurred_local_date: { gte: this.date(window.from), lte: this.date(window.to) },
        ...(scope.kind === undefined ? {} : { kind: scope.kind }),
        ...this.accountFilter(scope),
        ...(scope.merchantId === undefined ? {} : { merchant_id: scope.merchantId }),
        ...(scope.tagId === undefined ? {} : { transaction_tags: { some: { tag_id: scope.tagId } } }),
      },
    };
  }

  /** The count needs the OR: a Transaction reaches a Category directly **or** through a split. */
  private countWhere(householdId: string, window: SpendWindow, scope: SpendScope) {
    const scoped = scope.categoryIds !== undefined && scope.categoryIds.length > 0;
    return {
      ...this.directWhere(householdId, window, { ...scope, categoryIds: undefined }),
      ...(scoped
        ? {
            OR: [
              { category_id: { in: [...(scope.categoryIds ?? [])] } },
              { transaction_splits: { some: { category_id: { in: [...(scope.categoryIds ?? [])] } } } },
            ],
          }
        : {}),
    };
  }

  /**
   * The split money a scope adds, which is **only** ever a Category scope's (see {@link total}) — the
   * empty case included: a Household with no Category named has no Category total to complete.
   */
  private async splitSum(householdId: string, window: SpendWindow, scope: SpendScope): Promise<bigint> {
    if (scope.categoryIds === undefined || scope.categoryIds.length === 0) return 0n;
    const result = await this.prisma.client.transaction_splits.aggregate({
      where: this.splitWhere(householdId, window, scope),
      _sum: { amount_minor: true },
    });
    return result._sum.amount_minor ?? 0n;
  }

  private date(day: LocalDate): Date {
    return new Date(`${day}T00:00:00.000Z`);
  }

  private iso(value: Date): LocalDate {
    return value.toISOString().slice(0, 10) as LocalDate;
  }
}
