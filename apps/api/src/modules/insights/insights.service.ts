import { Injectable } from '@nestjs/common';

import {
  addDays,
  addMonths,
  elapsedDays,
  generateInsights,
  monthPeriod,
  periodBounds,
  todayIn,
  totalDays,
  uuidv7,
  type BudgetPeriod,
  type BudgetPaceFact,
  type CategoryTrendFact,
  type LocalDate,
  type PeriodSpend,
  type UnusualSpendFact,
} from '@finmate/domain';

import type { CursorPage } from '../../graphql/pagination';
import { normalisePageSize } from '../../graphql/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { BudgetsService } from '../budgeting/budgets.service';

/**
 * Insight generation and the insight feed — docs/01 §6 (F-20, F-22), docs/06 §4.1/§5.10/§5.13.
 *
 * ## This service does no arithmetic
 *
 * Every figure in an insight comes from `@finmate/domain`'s generators or from `BudgetsService`; this
 * class loads rows and writes them. That split is ADR-001's, and it is what makes the feed auditable:
 * the insight a user reads and the budget tile beside it are the same calculation.
 *
 * ## Facts, not queries-per-category
 *
 * The trend generators need per-category, per-period sums, and the obvious implementation is a query
 * per category per period. Instead the window is fetched **once** as `(category, date, amount)` rows
 * and bucketed in memory: a beta Household's four months fit in a few thousand rows, and the cost of
 * getting this wrong (a daily job that fans out to hundreds of aggregate queries) is a job that
 * cannot run per household. The cap is explicit rather than silent.
 *
 * ## What is deliberately not loaded
 *
 * **Split rows.** `BudgetsService.spendIn` includes them, so a budget's `spent` is split-aware, but a
 * `UNUSUAL_SPEND` candidate is a *transaction*: comparing a direct purchase against a split's portion
 * would compare two different things. Splits are therefore excluded from the unusual-spend history and
 * from the category trend baseline, and that is recorded as a known gap in docs/06 §5.13 rather than
 * hidden — 3.3.1's analytics work is where a split-aware trend belongs.
 *
 * @module apps/api/src/modules/insights
 */

/** Hard cap on the rows one generation run reads, so a large Household cannot OOM the job. */
export const MAX_FACT_ROWS = 20_000;

/** How many days of history an unusual-spend comparison looks back over (docs/01 §6 F-22). */
export const UNUSUAL_HISTORY_DAYS = 90;

export interface InsightView {
  readonly id: string;
  readonly kind: string;
  readonly severity: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly payload: Record<string, unknown>;
  readonly narrative: string | null;
  readonly isDismissed: boolean;
  readonly createdAt: Date;
}

export interface InsightFilter {
  readonly kind?: readonly string[];
  readonly severity?: readonly string[];
  readonly includeDismissed?: boolean;
  readonly periodStartOnOrAfter?: string;
}

export interface GenerateResult {
  readonly created: number;
  readonly alreadyRecorded: number;
  readonly drafts: number;
}

interface TransactionRow {
  readonly id: string;
  readonly category_id: string | null;
  readonly amount_minor: bigint;
  readonly occurred_local_date: Date;
}

@Injectable()
export class InsightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly budgets: BudgetsService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------------------------

  /**
   * Generate and persist the insights for one Household's current period.
   *
   * Idempotent per `(dedupeKey, period)`: a condition already recorded for the period is not written
   * again, so the daily job can run as often as it likes. It is **writer-enforced** — `insights` has no
   * unique constraint on the key, which lives inside `payload` (docs/06 §5.13) — so a concurrent
   * double-run could duplicate; the job is single-run, and 3.1.2's notification `dedupe_key` work is
   * where a real constraint belongs.
   */
  async generate(householdId: string, asOf?: string): Promise<GenerateResult> {
    const zone = await this.timeZoneFor(householdId);
    const today = (asOf ?? todayIn(zone)) as LocalDate;
    const period = monthPeriod(today);

    const [budgets, categoryNames, rows, existing] = await Promise.all([
      this.budgets.list(householdId, today),
      this.categoryNames(householdId),
      this.transactionRows(householdId, addMonths(period.start, -3), period.end),
      this.prisma.client.insights.findMany({
        where: { household_id: householdId, period_start: this.date(period.start) },
        select: { payload: true },
      }),
    ]);

    const currency = await this.ledgerCurrency(householdId);
    const drafts = generateInsights(
      this.buildFacts(budgets, currency, today, period, categoryNames, rows),
    );

    const recorded = new Set(
      existing
        .map((row) => (row.payload as { dedupeKey?: unknown } | null)?.dedupeKey)
        .filter((key): key is string => typeof key === 'string'),
    );
    const fresh = drafts.filter((draft) => !recorded.has(draft.dedupeKey));

    for (const draft of fresh) {
      await this.prisma.client.insights.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          kind: draft.kind,
          severity: draft.severity,
          period_start: this.date(draft.periodStart),
          period_end: this.date(draft.periodEnd),
          // The key is stored with the facts so the next run can recognise the condition.
          payload: { ...draft.payload, dedupeKey: draft.dedupeKey } as object,
        },
      });
    }

    return {
      created: fresh.length,
      alreadyRecorded: drafts.length - fresh.length,
      drafts: drafts.length,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------------------------

  /** The feed: newest first, keyset-paged on the UUIDv7 id (docs/06 §1). */
  async list(
    householdId: string,
    filter: InsightFilter,
    first?: number,
    after?: string,
  ): Promise<CursorPage<InsightView>> {
    const take = normalisePageSize(first);
    const where = {
      household_id: householdId,
      ...(filter.includeDismissed === true ? {} : { is_dismissed: false }),
      ...(filter.kind !== undefined && filter.kind.length > 0 ? { kind: { in: [...filter.kind] } } : {}),
      ...(filter.severity !== undefined && filter.severity.length > 0
        ? { severity: { in: [...filter.severity] } }
        : {}),
      ...(filter.periodStartOnOrAfter !== undefined
        ? { period_start: { gte: this.date(filter.periodStartOnOrAfter) } }
        : {}),
      ...(after !== undefined ? { id: { lt: after } } : {}),
    };

    const [rows, totalCount] = await Promise.all([
      this.prisma.client.insights.findMany({
        where,
        orderBy: { id: 'desc' },
        take: take + 1,
      }),
      this.prisma.client.insights.count({ where }),
    ]);

    const hasNextPage = rows.length > take;
    const page = hasNextPage ? rows.slice(0, take) : rows;
    return {
      items: page.map((row) => this.toView(row)),
      totalCount,
      hasNextPage,
      endCursor: hasNextPage ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /** The dashboard rail: the newest few, undismissed, worst-first is the UI's job (docs/02 §2.2). */
  async latest(householdId: string, limit = 3): Promise<readonly InsightView[]> {
    const rows = await this.prisma.client.insights.findMany({
      where: { household_id: householdId, is_dismissed: false },
      orderBy: { id: 'desc' },
      take: Math.min(Math.max(limit, 1), 20),
    });
    return rows.map((row) => this.toView(row));
  }

  /** `dismissInsight` — sets the flag; insights are never deleted (docs/06 §5.10). */
  async dismiss(householdId: string, id: string): Promise<InsightView | null> {
    // `updateMany` scoped by household, not `update` by id: a client cannot dismiss another
    // Household's insight, and the scoped predicate is what enforces it (ADR-008).
    const result = await this.prisma.client.insights.updateMany({
      where: { id, household_id: householdId },
      data: { is_dismissed: true },
    });
    if (result.count === 0) return null;
    const row = await this.prisma.client.insights.findFirst({ where: { id, household_id: householdId } });
    return row === null ? null : this.toView(row);
  }

  // -------------------------------------------------------------------------------------------
  // Facts
  // -------------------------------------------------------------------------------------------

  private buildFacts(
    budgets: Awaited<ReturnType<BudgetsService['list']>>,
    currency: string,
    today: LocalDate,
    period: { start: LocalDate; end: LocalDate },
    paths: ReadonlyMap<string, string>,
    rows: readonly TransactionRow[],
  ): {
    budgets: readonly BudgetPaceFact[];
    categories: readonly CategoryTrendFact[];
    unusual: readonly UnusualSpendFact[];
  } {
    // ---- budgets: only the ones whose period *is* the current month, and only expense-side ones.
    const budgetFacts: BudgetPaceFact[] = budgets
      .filter(
        (budget) =>
          budget.period === 'MONTHLY' &&
          budget.periodStart === period.start &&
          budget.amount.amountMinor > 0n,
      )
      .map((budget) => {
        const bounds = periodBounds('MONTHLY' as BudgetPeriod, period.start);
        const daysElapsed = Math.max(1, elapsedDays(bounds, today));
        return {
          budgetId: budget.id,
          categoryId: budget.categoryId,
          categoryPath:
            budget.categoryId === null ? null : (paths.get(budget.categoryId)?.split(' / ') ?? null),
          currency,
          limitMinor: budget.amount.amountMinor,
          spentMinor: budget.spent.amountMinor,
          // Per-budget committed charges are not attributable yet: recurring rules arrive in 3.3.3, so
          // a category budget is projected on pace alone. The Household-level budget does have a
          // figure — `dashboard().reserved` — but it belongs to the Household scope, so it is passed
          // only there (docs/06 §5.13).
          committedMinor: 0n,
          periodStart: period.start,
          periodEnd: period.end,
          daysElapsed,
          daysInMonth: totalDays(bounds),
        };
      });

    // ---- categories: current period + the three complete periods before it.
    const baselineStarts = [3, 2, 1].map((months) => monthPeriod(addMonths(period.start, -months)));
    const byCategory = new Map<string, { current: bigint; baseline: PeriodSpend[] }>();
    for (const row of rows) {
      if (row.category_id === null) continue;
      const bucket = byCategory.get(row.category_id) ?? {
        current: 0n,
        baseline: baselineStarts.map((month) => ({ periodStart: month.start, spentMinor: 0n })),
      };
      const day = this.iso(row.occurred_local_date);
      if (day >= period.start && day <= period.end) {
        bucket.current += row.amount_minor;
      } else {
        const index = baselineStarts.findIndex((month) => day >= month.start && day <= month.end);
        const target = index === -1 ? undefined : bucket.baseline[index];
        if (target !== undefined) {
          bucket.baseline[index] = { periodStart: target.periodStart, spentMinor: target.spentMinor + row.amount_minor };
        }
      }
      byCategory.set(row.category_id, bucket);
    }

    const trendFacts: CategoryTrendFact[] = [...byCategory.entries()]
      .filter(([categoryId]) => paths.has(categoryId))
      .map(([categoryId, bucket]) => ({
        categoryId,
        categoryPath: (paths.get(categoryId) ?? '').split(' / '),
        currency,
        periodStart: period.start,
        periodEnd: period.end,
        currentMinor: bucket.current,
        baseline: bucket.baseline,
        // The generators decide what to do with this; the service only reports the fact.
        periodComplete: today >= period.end,
      }));

    // ---- unusual: transactions in the current period against their category's 90-day history.
    const historyCutoff = addDays(today, -UNUSUAL_HISTORY_DAYS);
    const historyByCategory = new Map<string, { id: string; amountMinor: bigint }[]>();
    for (const row of rows) {
      if (row.category_id === null) continue;
      if (this.iso(row.occurred_local_date) < historyCutoff) continue;
      const bucket = historyByCategory.get(row.category_id) ?? [];
      bucket.push({ id: row.id, amountMinor: row.amount_minor });
      historyByCategory.set(row.category_id, bucket);
    }

    const unusualFacts: UnusualSpendFact[] = [];
    for (const row of rows) {
      if (row.category_id === null || !paths.has(row.category_id)) continue;
      const day = this.iso(row.occurred_local_date);
      if (day < period.start || day > period.end) continue;
      const history = (historyByCategory.get(row.category_id) ?? []).filter(
        (entry) => entry.id !== row.id,
      );
      unusualFacts.push({
        transactionId: row.id,
        categoryId: row.category_id,
        categoryPath: (paths.get(row.category_id) ?? '').split(' / '),
        currency,
        amountMinor: row.amount_minor,
        occurredOn: day,
        periodStart: period.start,
        periodEnd: period.end,
        historyMinor: history.map((entry) => entry.amountMinor),
      });
    }

    return { budgets: budgetFacts, categories: trendFacts, unusual: unusualFacts };
  }

  /** Confirmed, non-deleted EXPENSE rows in the window, with their category. Capped, loudly. */
  private async transactionRows(
    householdId: string,
    from: LocalDate,
    to: LocalDate,
  ): Promise<readonly TransactionRow[]> {
    return this.prisma.client.transactions.findMany({
      where: {
        household_id: householdId,
        deleted_at: null,
        status: 'CONFIRMED', // I-7: PENDING never contributes
        kind: 'EXPENSE',
        category_id: { not: null },
        occurred_local_date: { gte: this.date(from), lte: this.date(to) },
      },
      select: { id: true, category_id: true, amount_minor: true, occurred_local_date: true },
      orderBy: { id: 'asc' },
      take: MAX_FACT_ROWS,
    });
  }

  private async categoryNames(householdId: string): Promise<ReadonlyMap<string, string>> {
    const rows = await this.prisma.client.categories.findMany({
      where: { household_id: householdId, deleted_at: null },
      select: { id: true, name: true, parent_id: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const paths = new Map<string, string>();
    const pathOf = (id: string): string => {
      const cached = paths.get(id);
      if (cached !== undefined) return cached;
      const row = byId.get(id);
      if (row === undefined) return '';
      const path = row.parent_id === null ? row.name : `${pathOf(row.parent_id)} / ${row.name}`;
      paths.set(id, path);
      return path;
    };
    for (const row of rows) pathOf(row.id);
    return paths;
  }

  private async ledgerCurrency(householdId: string): Promise<string> {
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { ledger_currency: true },
    });
    return household?.ledger_currency ?? 'RSD';
  }

  private async timeZoneFor(householdId: string): Promise<string> {
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { iana_timezone: true },
    });
    return household?.iana_timezone ?? 'Europe/Belgrade';
  }

  private toView(row: {
    id: string;
    kind: string;
    severity: string;
    period_start: Date;
    period_end: Date;
    payload: unknown;
    narrative: string | null;
    is_dismissed: boolean;
    created_at: Date;
  }): InsightView {
    return {
      id: row.id,
      kind: row.kind,
      severity: row.severity,
      periodStart: this.iso(row.period_start),
      periodEnd: this.iso(row.period_end),
      payload: (row.payload ?? {}) as Record<string, unknown>,
      narrative: row.narrative,
      isDismissed: row.is_dismissed,
      createdAt: row.created_at,
    };
  }

  /** `@db.Date` columns arrive as a `Date` at UTC midnight; the calendar day is what we stored. */
  private date(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
  }

  private iso(value: Date): LocalDate {
    return value.toISOString().slice(0, 10);
  }
}

