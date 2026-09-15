import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  formatMoney,
  money,
  monthPeriod,
  addMonths,
  type CurrencyCode,
  type LocalDate,
} from '@finmate/domain';

import { CONFIG, type AppConfig } from '../../config/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { BudgetsService } from '../budgeting/budgets.service';
import type { AssistantIntent } from './assistant-intents';
import { isRunnable, missingSlots, type Plan } from './query-planner';

/**
 * Fact assembly — docs/06 §8.2 (the payload), §8.3 (provenance), ADR-017.
 *
 * ## This is the only place a number the assistant says is created
 *
 * Every builder runs a parameterised, household-scoped query through the tenancy-guarded client and
 * returns **formatted strings** alongside their machine values. The narrator is handed those strings and
 * forbidden to introduce new ones (3.2.3 enforces it), so a hallucinated figure is not merely
 * discouraged here: nothing else is available to say.
 *
 * ## Why a `Record<AssistantIntent, …>` again
 *
 * The same reason as the intent registry: a builder for every intent, or `tsc` fails. An intent whose
 * data does not exist yet returns {@link unavailable} — a **typed** refusal with a reason — rather than
 * being absent, because "we do not have goals yet" and "somebody forgot to write the builder" must not
 * look the same from the outside.
 *
 * ## Splits are included, and that is a deliberate difference from the insight feed
 *
 * A Transaction with splits contributes each split's amount to its own Category (invariant I-1), and
 * `BudgetsService.spendIn` is split-aware for exactly that reason. The assistant's category figures
 * therefore match the **budget tile** the user is looking at. The insight generators (3.1.1) count
 * direct rows only, which is recorded as a gap: those two must be made to agree, and 3.3.1's analytics
 * work is where the split-aware aggregate belongs.
 *
 * @module apps/api/src/modules/assistant
 */

export interface FactRowView {
  readonly label: string;
  /** The machine value: minor units as a string for money, a count otherwise (docs/06 §8.2). */
  readonly value: string;
  readonly formatted: string;
  readonly categoryId?: string;
  readonly merchantId?: string;
}

export interface FactTotalView {
  readonly label: string;
  readonly money: { readonly amountMinor: string; readonly currency: string };
  readonly formatted: string;
}

export interface AssistantFactsView {
  readonly template: AssistantIntent;
  readonly rows: readonly FactRowView[];
  readonly totals: readonly FactTotalView[];
  /** Locale- and currency-formatted strings the narrator must reproduce (docs/06 §8.2). */
  readonly formatted: Readonly<Record<string, string>>;
}

export interface ProvenanceView {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly transactionCount: number;
  readonly sourceQuery: string;
  readonly filters: Readonly<Record<string, string>>;
  readonly computedAt: Date;
  readonly ledgerCurrency: string;
}

export interface AssemblyResult {
  readonly available: boolean;
  /** Why it is unavailable, when it is — e.g. `NOT_BUILT:goals`. */
  readonly reason?: string;
  readonly facts: AssistantFactsView;
  readonly provenance: ProvenanceView;
}

interface Built {
  readonly rows: readonly FactRowView[];
  readonly totals: readonly FactTotalView[];
  readonly formatted: Readonly<Record<string, string>>;
  readonly transactionCount: number;
  readonly filters: Readonly<Record<string, string>>;
  /** Set by a builder that cannot answer in this build, e.g. `NOT_BUILT:goals`. */
  readonly unavailable?: string;
  /**
   * The range the figures were **actually** computed over, when that is not the plan's period.
   *
   * docs/06 §8.3 requires provenance to describe the aggregated range, and three families of template
   * aggregate something else: a balance is the whole ledger, the review queue is a current state, and
   * the dashboard-backed figures use the current month rather than the period the question named.
   * Reporting the plan's period for those would be a claim about the number that is not true — the one
   * kind of provenance that is worse than none.
   */
  readonly period?: { readonly start: LocalDate; readonly end: LocalDate };
}

/** A scope a spend aggregate can carry. Every field is a resolved slot, never free text. */
interface SpendScope {
  readonly categoryIds?: readonly string[];
  readonly merchantId?: string;
  readonly accountId?: string;
  readonly tagId?: string;
}

const MAX_ROWS = 50;

@Injectable()
export class FactAssemblyService {
  private readonly logger = new Logger(FactAssemblyService.name);
  private readonly locale: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly budgets: BudgetsService,
    private readonly accounts: AccountsService,
    @Inject(CONFIG) config: AppConfig,
  ) {
    // The catalogue's primary language is English; money is rendered in the Serbian locale by
    // `formatMoney`'s default, which is what every other surface in the product already shows.
    this.locale = config.APP_DEFAULT_LOCALE;
  }

  /** Assemble the facts for one plan. Never throws for a template that is merely unimplemented. */
  async assemble(
    householdId: string,
    plan: Plan,
    options: { readonly today: LocalDate },
  ): Promise<AssemblyResult> {
    const currency = await this.ledgerCurrency(householdId);
    const context: Context = {
      householdId,
      currency,
      today: options.today,
      period: plan.slots.period,
      plan,
    };

    // The refusal is enforced **here**, not only by the caller. `isRunnable` is the planner's own
    // statement that a required slot is unresolved, and the templates that need one are the ones whose
    // absence is invisible: `SPEND_BY_CATEGORY` with no category aggregates *everything*, which is a
    // true figure answering a question nobody asked (ADR-017). 3.2.4's UI is a caller that can forget;
    // this is the layer that must not.
    const built =
      plan.intent !== 'NO_TEMPLATE_MATCH' && !isRunnable(plan)
        ? this.unavailable(context, `UNRUNNABLE:${missingSlots(plan).join(',')}`)
        : await this.builders[plan.intent](context);

    // The plan's period is the default statement of what was aggregated; a builder that used a
    // different range says so (see {@link Built.period}).
    const period = built.period ?? plan.slots.period;

    return {
      available: built.unavailable === undefined,
      ...(built.unavailable === undefined ? {} : { reason: built.unavailable }),
      facts: {
        template: plan.intent,
        rows: built.rows,
        totals: built.totals,
        formatted: built.formatted,
      },
      provenance: {
        periodStart: period.start,
        periodEnd: period.end,
        transactionCount: built.transactionCount,
        sourceQuery: plan.template.sourceQuery,
        filters: built.filters,
        computedAt: new Date(),
        ledgerCurrency: currency,
      },
    };
  }

  /**
   * A typed refusal for a template whose data does not exist in this build.
   *
   * The facts are **empty**, not plausible: an unavailable template must not be narratable, and the
   * `reason` is what 3.2.4 shows in place of an answer.
   */
  private unavailable(context: Context, reason: string): Built {
    this.logger.debug(`${context.plan.intent} unavailable: ${reason}`);
    return {
      rows: [],
      totals: [],
      formatted: {},
      transactionCount: 0,
      filters: {},
      unavailable: reason,
    };
  }

  // -------------------------------------------------------------------------------------------
  // The builders — one per intent, enforced by the type
  // -------------------------------------------------------------------------------------------

  private readonly builders: Readonly<
    Record<AssistantIntent, (context: Context) => Promise<Built>>
  > = {
    SPEND_TOTAL: (context) => this.spend(context, {}, 'EXPENSE'),
    SPEND_BY_CATEGORY: async (context) => {
      const categoryIds = await this.subtree(context.householdId, context.plan.slots.categoryId);
      return this.spend(context, { categoryIds }, 'EXPENSE');
    },
    SPEND_BY_MERCHANT: (context) =>
      this.spend(context, { merchantId: context.plan.slots.merchantId }, 'EXPENSE'),
    SPEND_BY_ACCOUNT: (context) =>
      this.spend(context, { accountId: context.plan.slots.accountId }, 'EXPENSE'),
    SPEND_BY_TAG: (context) => this.spend(context, { tagId: context.plan.slots.tagId }, 'EXPENSE'),
    TOP_CATEGORIES: (context) => this.topCategories(context, 'EXPENSE'),
    TOP_MERCHANTS: (context) => this.topMerchants(context, 'EXPENSE'),
    LARGEST_TRANSACTIONS: (context) => this.largest(context, 'EXPENSE'),
    AVERAGE_DAILY_SPEND: (context) => this.averageDaily(context),
    TRANSACTION_COUNT: (context) => this.countTransactions(context),
    TRANSACTION_LIST: (context) => this.listTransactions(context),
    UNCATEGORISED_REVIEW: (context) => this.needsReview(context),
    INCOME_TOTAL: (context) => this.spend(context, {}, 'INCOME'),
    NET_CASHFLOW: (context) => this.netCashflow(context),
    ACCOUNT_BALANCE: (context) => this.accountBalances(context, context.plan.slots.accountId),
    ACCOUNT_BALANCE_ALL: (context) => this.accountBalances(context, undefined),
    BUDGET_STATUS: (context) => this.budgetStatus(context),
    BUDGET_LIST: (context) => this.budgetList(context),
    SAFE_TO_SPEND: (context) => this.safeToSpend(context),
    MONTH_PROJECTION: (context) => this.monthProjection(context),
    BUDGET_PACE_VS_PLAN: (context) => this.budgetPace(context),
    TREND_VS_LAST_MONTH: (context) => this.trendVsLastMonth(context),
    COMPARE_PERIODS: (context) => this.unavailableBuilt(context, 'NEEDS_TWO_PERIODS'),
    TREND_VS_AVERAGE: (context) => this.trendVsAverage(context),
    GOAL_PROGRESS: (context) => this.unavailableBuilt(context, 'NOT_BUILT:goals'),
    GOAL_REQUIRED_MONTHLY: (context) => this.unavailableBuilt(context, 'NOT_BUILT:goals'),
    SAVINGS_PROPOSAL: (context) => this.unavailableBuilt(context, 'NOT_BUILT:goals'),
    RECURRING_UPCOMING: (context) => this.unavailableBuilt(context, 'NOT_BUILT:recurring'),
    RECURRING_LIST: (context) => this.unavailableBuilt(context, 'NOT_BUILT:recurring'),
    NO_TEMPLATE_MATCH: (context) => this.unavailableBuilt(context, 'NO_TEMPLATE_MATCH'),
  };

  private async unavailableBuilt(context: Context, reason: string): Promise<Built> {
    return this.unavailable(context, reason);
  }

  // -------------------------------------------------------------------------------------------
  // Spending
  // -------------------------------------------------------------------------------------------

  /**
   * Sum over the scope, **including splits**.
   *
   * Two aggregates rather than one because a split lives in `transaction_splits` and carries its own
   * `category_id`; the count is a **transaction** count (a row with three splits in the same category is
   * one transaction), which is what docs/06 §8.3 requires provenance to report.
   */
  private async spend(context: Context, scope: SpendScope, kind: 'EXPENSE' | 'INCOME'): Promise<Built> {
    const base = {
      household_id: context.householdId,
      deleted_at: null,
      status: 'CONFIRMED' as const, // I-7: PENDING never contributes
      kind,
      occurred_local_date: { gte: this.date(context.period.start), lte: this.date(context.period.end) },
      ...(scope.accountId !== undefined ? { account_id: scope.accountId } : {}),
      ...(scope.merchantId !== undefined ? { merchant_id: scope.merchantId } : {}),
    };
    const categoryIds = scope.categoryIds === undefined ? undefined : [...scope.categoryIds];
    const tagFilter = scope.tagId === undefined ? {} : { transaction_tags: { some: { tag_id: scope.tagId } } };

    const direct = await this.prisma.client.transactions.aggregate({
      where: {
        ...base,
        ...tagFilter,
        ...(categoryIds !== undefined && categoryIds.length > 0 ? { category_id: { in: categoryIds } } : {}),
      },
      _sum: { amount_minor: true },
    });

    const splitSum =
      categoryIds === undefined || categoryIds.length === 0
        ? 0n
        : (
            await this.prisma.client.transaction_splits.aggregate({
              where: {
                household_id: context.householdId,
                category_id: { in: categoryIds },
                transactions: base,
              },
              _sum: { amount_minor: true },
            })
          )._sum.amount_minor ?? 0n;

    const count = await this.prisma.client.transactions.count({
      where: {
        ...base,
        ...tagFilter,
        ...(categoryIds !== undefined && categoryIds.length > 0
          ? {
              OR: [
                { category_id: { in: categoryIds } },
                { transaction_splits: { some: { category_id: { in: categoryIds } } } },
              ],
            }
          : {}),
      },
    });

    const totalMinor = (direct._sum.amount_minor ?? 0n) + splitSum;
    const formatted = this.format(totalMinor, context.currency);
    const label = kind === 'INCOME' ? 'Income' : 'Spending';

    return {
      rows: [],
      totals: [
        {
          label,
          money: { amountMinor: totalMinor.toString(), currency: context.currency },
          formatted,
        },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: formatted,
        currency: context.currency,
      },
      transactionCount: count,
      filters: this.filtersOf(context, scope, kind),
    };
  }

  /** The N categories with the most spend, splits included. */
  private async topCategories(context: Context, kind: 'EXPENSE' | 'INCOME'): Promise<Built> {
    const [direct, split, categories] = await Promise.all([
      this.prisma.client.transactions.groupBy({
        by: ['category_id'],
        where: {
          household_id: context.householdId,
          deleted_at: null,
          status: 'CONFIRMED',
          kind,
          category_id: { not: null },
          occurred_local_date: this.range(context),
        },
        _sum: { amount_minor: true },
        _count: { _all: true },
      }),
      this.prisma.client.transaction_splits.groupBy({
        by: ['category_id'],
        where: {
          household_id: context.householdId,
          transactions: {
            deleted_at: null,
            status: 'CONFIRMED',
            kind,
            occurred_local_date: this.range(context),
          },
        },
        _sum: { amount_minor: true },
      }),
      this.prisma.client.categories.findMany({
        where: { household_id: context.householdId, deleted_at: null },
        select: { id: true, name: true, parent_id: true },
      }),
    ]);

    const byId = new Map(categories.map((row) => [row.id, row]));
    const totals = new Map<string, bigint>();
    let transactionCount = 0;
    for (const row of direct) {
      if (row.category_id === null) continue;
      totals.set(row.category_id, (totals.get(row.category_id) ?? 0n) + (row._sum.amount_minor ?? 0n));
      transactionCount += row._count._all;
    }
    for (const row of split) {
      totals.set(row.category_id, (totals.get(row.category_id) ?? 0n) + (row._sum.amount_minor ?? 0n));
    }

    const limit = Math.min(context.plan.slots.limit ?? 10, MAX_ROWS);
    const rows = [...totals.entries()]
      .sort((left, right) => (right[1] > left[1] ? 1 : right[1] < left[1] ? -1 : left[0] < right[0] ? -1 : 1))
      .slice(0, limit)
      .map(([categoryId, minor]) => ({
        label: this.pathOf(categoryId, byId),
        value: minor.toString(),
        formatted: this.format(minor, context.currency),
        categoryId,
      }));

    return {
      rows,
      totals: [],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: rows[0]?.formatted ?? this.format(0n, context.currency),
        topLabel: rows[0]?.label ?? '',
      },
      transactionCount,
      filters: { kind, limit: String(limit) },
    };
  }

  /** The N merchants with the most spend. Splits carry no Merchant, so this is direct spend only. */
  private async topMerchants(context: Context, kind: 'EXPENSE' | 'INCOME'): Promise<Built> {
    const grouped = await this.prisma.client.transactions.groupBy({
      by: ['merchant_id'],
      where: {
        household_id: context.householdId,
        deleted_at: null,
        status: 'CONFIRMED',
        kind,
        merchant_id: { not: null },
        occurred_local_date: this.range(context),
      },
      _sum: { amount_minor: true },
      _count: { _all: true },
      orderBy: { _sum: { amount_minor: 'desc' } },
      take: Math.min(context.plan.slots.limit ?? 10, MAX_ROWS),
    });

    const retailers = await this.prisma.client.merchants.findMany({
      where: { id: { in: grouped.map((row) => row.merchant_id).filter((id): id is string => id !== null) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(retailers.map((row) => [row.id, row.name]));

    const rows = grouped.map((row) => ({
      label: nameById.get(row.merchant_id ?? '') ?? '—',
      value: (row._sum.amount_minor ?? 0n).toString(),
      formatted: this.format(row._sum.amount_minor ?? 0n, context.currency),
      ...(row.merchant_id === null ? {} : { merchantId: row.merchant_id }),
    }));

    return {
      rows,
      totals: [],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: rows[0]?.formatted ?? this.format(0n, context.currency),
        topLabel: rows[0]?.label ?? '',
      },
      transactionCount: grouped.reduce((sum, row) => sum + row._count._all, 0),
      filters: { kind },
    };
  }

  private async largest(context: Context, kind: 'EXPENSE' | 'INCOME'): Promise<Built> {
    const rows = await this.prisma.client.transactions.findMany({
      where: {
        household_id: context.householdId,
        deleted_at: null,
        status: 'CONFIRMED',
        kind,
        occurred_local_date: this.range(context),
      },
      orderBy: { amount_minor: 'desc' },
      take: Math.min(context.plan.slots.limit ?? 10, MAX_ROWS),
      select: { id: true, description: true, amount_minor: true, occurred_local_date: true, category_id: true },
    });

    return {
      rows: rows.map((row) => ({
        label: row.description,
        value: row.amount_minor.toString(),
        formatted: this.format(row.amount_minor, context.currency),
        ...(row.category_id === null ? {} : { categoryId: row.category_id }),
      })),
      totals: [],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: rows[0] === undefined ? this.format(0n, context.currency) : this.format(rows[0].amount_minor, context.currency),
      },
      transactionCount: rows.length,
      filters: { kind },
    };
  }

  private async averageDaily(context: Context): Promise<Built> {
    const total = await this.spend(context, {}, 'EXPENSE');
    const days = this.daysBetween(context.period.start, context.period.end);
    const totalMinor = BigInt(total.totals[0]?.money.amountMinor ?? '0');
    const perDay = totalMinor / BigInt(days);

    return {
      rows: [],
      totals: [
        {
          label: 'Average per day',
          money: { amountMinor: perDay.toString(), currency: context.currency },
          formatted: this.format(perDay, context.currency),
        },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        days: String(days),
        headline: this.format(perDay, context.currency),
        total: total.formatted['headline'] ?? '',
      },
      transactionCount: total.transactionCount,
      filters: { days: String(days) },
    };
  }

  private async countTransactions(context: Context): Promise<Built> {
    const count = await this.prisma.client.transactions.count({
      where: {
        household_id: context.householdId,
        deleted_at: null,
        status: 'CONFIRMED',
        occurred_local_date: this.range(context),
      },
    });

    return {
      rows: [],
      totals: [],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: String(count),
      },
      transactionCount: count,
      filters: {},
    };
  }

  private async listTransactions(context: Context): Promise<Built> {
    const rows = await this.prisma.client.transactions.findMany({
      where: {
        household_id: context.householdId,
        deleted_at: null,
        status: 'CONFIRMED',
        occurred_local_date: this.range(context),
        ...(context.plan.slots.categoryId === undefined
          ? {}
          // Prisma wants a mutable array; `subtree` returns a readonly one.
          : { category_id: { in: [...(await this.subtree(context.householdId, context.plan.slots.categoryId))] } }),
        ...(context.plan.slots.merchantId === undefined ? {} : { merchant_id: context.plan.slots.merchantId }),
      },
      orderBy: { id: 'desc' },
      take: Math.min(context.plan.slots.limit ?? 10, MAX_ROWS),
      select: { id: true, description: true, amount_minor: true, kind: true, category_id: true },
    });

    return {
      rows: rows.map((row) => ({
        label: row.description,
        value: row.amount_minor.toString(),
        formatted: this.format(row.amount_minor, context.currency),
        ...(row.category_id === null ? {} : { categoryId: row.category_id }),
      })),
      totals: [],
      formatted: { period: `${context.period.start} – ${context.period.end}`, headline: String(rows.length) },
      transactionCount: rows.length,
      filters: {},
    };
  }

  private async needsReview(context: Context): Promise<Built> {
    const rows = await this.prisma.client.transactions.findMany({
      where: { household_id: context.householdId, deleted_at: null, needs_review: true },
      orderBy: { id: 'desc' },
      take: Math.min(context.plan.slots.limit ?? 10, MAX_ROWS),
      select: { id: true, description: true, amount_minor: true, category_id: true },
    });

    return {
      rows: rows.map((row) => ({
        label: row.description,
        value: row.amount_minor.toString(),
        formatted: this.format(row.amount_minor, context.currency),
        ...(row.category_id === null ? {} : { categoryId: row.category_id }),
      })),
      totals: [],
      formatted: { headline: String(rows.length), asOf: context.today },
      transactionCount: rows.length,
      filters: { needsReview: 'true', asOf: 'now' },
      // The queue is a **current state**, not a period report: docs/06 §8.3's range is the household's
      // day, and the `asOf` filter says which of the two readings applies.
      period: this.asOf(context),
    };
  }

  private async netCashflow(context: Context): Promise<Built> {
    const [expense, income] = await Promise.all([
      this.spend(context, {}, 'EXPENSE'),
      this.spend(context, {}, 'INCOME'),
    ]);
    const expenseMinor = BigInt(expense.totals[0]?.money.amountMinor ?? '0');
    const incomeMinor = BigInt(income.totals[0]?.money.amountMinor ?? '0');
    const netMinor = incomeMinor - expenseMinor;

    return {
      rows: [],
      totals: [
        {
          label: 'Income',
          money: { amountMinor: incomeMinor.toString(), currency: context.currency },
          formatted: this.format(incomeMinor, context.currency),
        },
        {
          label: 'Spending',
          money: { amountMinor: expenseMinor.toString(), currency: context.currency },
          formatted: this.format(expenseMinor, context.currency),
        },
        {
          label: 'Net',
          money: { amountMinor: netMinor.toString(), currency: context.currency },
          formatted: this.format(netMinor, context.currency),
        },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: this.format(netMinor, context.currency),
        income: this.format(incomeMinor, context.currency),
        spending: this.format(expenseMinor, context.currency),
      },
      transactionCount: expense.transactionCount + income.transactionCount,
      filters: {},
    };
  }

  // -------------------------------------------------------------------------------------------
  // Accounts, budgets, trends
  // -------------------------------------------------------------------------------------------

  /** Balances come from `AccountsService` (invariant I-4): the assistant never recomputes one. */
  private async accountBalances(context: Context, accountId: string | undefined): Promise<Built> {
    const page = await this.accounts.list({ householdId: context.householdId, first: MAX_ROWS });
    const accounts = accountId === undefined ? page.items : page.items.filter((item) => item.id === accountId);

    return {
      rows: accounts.map((account) => ({
        label: account.name,
        value: String(account.balance.amountMinor),
        formatted: this.format(BigInt(account.balance.amountMinor), account.balance.currency),
      })),
      totals: [],
      formatted: {
        headline: accounts[0] === undefined ? this.format(0n, context.currency) : this.format(BigInt(accounts[0].balance.amountMinor), accounts[0].balance.currency),
        count: String(accounts.length),
        asOf: context.today,
      },
      transactionCount: 0,
      filters: accountId === undefined ? { asOf: 'now' } : { accountId, asOf: 'now' },
      // A balance is the whole ledger up to now — there is no range to report, so the honest statement
      // is the day it is true for (docs/06 §8.3).
      period: this.asOf(context),
    };
  }

  private async budgetStatus(context: Context): Promise<Built> {
    const budgets = await this.budgets.list(context.householdId, context.today);
    const wanted =
      context.plan.slots.categoryId === undefined
        ? budgets
        : budgets.filter((budget) => budget.categoryId === context.plan.slots.categoryId);
    const chosen = wanted.length > 0 ? wanted : budgets;

    return {
      rows: chosen.map((budget) => ({
        label: budget.categoryName ?? 'Household',
        value: String(budget.remaining.amountMinor),
        formatted: this.format(budget.remaining.amountMinor, budget.remaining.currency),
        ...(budget.categoryId === null ? {} : { categoryId: budget.categoryId }),
      })),
      totals: chosen.slice(0, 1).map((budget) => ({
        label: budget.categoryName ?? 'Household',
        money: { amountMinor: budget.remaining.amountMinor.toString(), currency: budget.remaining.currency },
        formatted: this.format(budget.remaining.amountMinor, budget.remaining.currency),
      })),
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: chosen[0] === undefined ? this.format(0n, context.currency) : this.format(chosen[0].remaining.amountMinor, chosen[0].remaining.currency),
        spent: chosen[0] === undefined ? this.format(0n, context.currency) : this.format(chosen[0].spent.amountMinor, chosen[0].spent.currency),
        limit: chosen[0] === undefined || chosen[0].amount === undefined ? '' : this.format(BigInt(chosen[0].amount.amountMinor), chosen[0].amount.currency),
        asOf: context.today,
      },
      transactionCount: 0,
      filters: { asOf: 'now' },
      // The consumption a budget reports is for **its own** period (`period_start`), which need not be
      // the month the question named — provenance follows the budget, not the question.
      ...(chosen[0] === undefined
        ? {}
        : { period: { start: chosen[0].periodStart, end: chosen[0].periodEnd } }),
    };
  }

  private async budgetList(context: Context): Promise<Built> {
    const budgets = await this.budgets.list(context.householdId, context.today);
    const span = this.span(budgets);
    return {
      rows: budgets.map((budget) => ({
        label: budget.categoryName ?? 'Household',
        value: String(budget.remaining.amountMinor),
        formatted: this.format(budget.remaining.amountMinor, budget.remaining.currency),
        ...(budget.categoryId === null ? {} : { categoryId: budget.categoryId }),
      })),
      totals: [],
      formatted: { headline: String(budgets.length), asOf: context.today },
      transactionCount: 0,
      filters: { asOf: 'now' },
      ...(span === undefined ? {} : { period: span }),
    };
  }

  private async safeToSpend(context: Context): Promise<Built> {
    const dashboard = await this.budgets.dashboard(context.householdId);
    const safe = dashboard.safeToSpendToday;
    return {
      rows: [],
      totals: [
        {
          label: 'Safe to spend today',
          money: { amountMinor: safe.amountMinor.toString(), currency: safe.currency },
          formatted: this.format(safe.amountMinor, safe.currency),
        },
      ],
      formatted: {
        headline: this.format(safe.amountMinor, safe.currency),
        spent: this.format(dashboard.spentThisMonth.amountMinor, dashboard.spentThisMonth.currency),
        asOf: dashboard.today,
      },
      transactionCount: 0,
      filters: { asOf: 'now' },
      // `dashboard` has no date parameter: it is the **current** month by construction, so the plan's
      // period is reported as the dashboard's own bounds rather than the one the question named.
      period: { start: dashboard.periodStart, end: dashboard.periodEnd },
    };
  }

  private async monthProjection(context: Context): Promise<Built> {
    const dashboard = await this.budgets.dashboard(context.householdId);
    const projected = dashboard.projectedTotal;
    const overrun = dashboard.projectedOverrun;
    return {
      rows: [],
      totals: [
        {
          label: 'Projected total',
          money: { amountMinor: projected.amountMinor.toString(), currency: projected.currency },
          formatted: this.format(projected.amountMinor, projected.currency),
        },
        ...(overrun === null
          ? []
          : [
              {
                label: 'Projected overrun',
                money: { amountMinor: overrun.amountMinor.toString(), currency: overrun.currency },
                formatted: this.format(overrun.amountMinor, overrun.currency),
              },
            ]),
      ],
      formatted: {
        headline: this.format(projected.amountMinor, projected.currency),
        reliable: String(dashboard.paceIsReliable),
        asOf: dashboard.today,
      },
      transactionCount: 0,
      // docs/04 §4: a projection from three days of data is not a forecast, and the answer must say so.
      filters: { paceIsReliable: String(dashboard.paceIsReliable), asOf: 'now' },
      period: { start: dashboard.periodStart, end: dashboard.periodEnd },
    };
  }

  private async budgetPace(context: Context): Promise<Built> {
    const budgets = await this.budgets.list(context.householdId, context.today);
    const rows = budgets
      .filter((budget) => budget.isAheadOfPace)
      .map((budget) => ({
        label: budget.categoryName ?? 'Household',
        value: String(budget.spent.amountMinor),
        formatted: this.format(budget.spent.amountMinor, budget.spent.currency),
        ...(budget.categoryId === null ? {} : { categoryId: budget.categoryId }),
      }));

    const span = this.span(budgets);
    return {
      rows,
      totals: [],
      formatted: { headline: String(rows.length), asOf: context.today },
      transactionCount: 0,
      filters: { asOf: 'now' },
      ...(span === undefined ? {} : { period: span }),
    };
  }

  /** This period against the one before it — the comparison the user asked for, both figures computed. */
  private async trendVsLastMonth(context: Context): Promise<Built> {
    const previous = monthPeriod(addMonths(context.period.start, -1));
    const scope: SpendScope =
      context.plan.slots.categoryId === undefined
        ? {}
        : { categoryIds: await this.subtree(context.householdId, context.plan.slots.categoryId) };

    const [current, before] = await Promise.all([
      this.spend(context, scope, 'EXPENSE'),
      this.spend({ ...context, period: previous }, scope, 'EXPENSE'),
    ]);
    const currentMinor = BigInt(current.totals[0]?.money.amountMinor ?? '0');
    const beforeMinor = BigInt(before.totals[0]?.money.amountMinor ?? '0');
    const deltaMinor = currentMinor - beforeMinor;

    return {
      rows: [],
      totals: [
        { label: 'This period', money: { amountMinor: currentMinor.toString(), currency: context.currency }, formatted: this.format(currentMinor, context.currency) },
        { label: 'Previous period', money: { amountMinor: beforeMinor.toString(), currency: context.currency }, formatted: this.format(beforeMinor, context.currency) },
        { label: 'Change', money: { amountMinor: deltaMinor.toString(), currency: context.currency }, formatted: this.format(deltaMinor, context.currency) },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        previousPeriod: `${previous.start} – ${previous.end}`,
        headline: this.format(deltaMinor, context.currency),
        current: this.format(currentMinor, context.currency),
        previous: this.format(beforeMinor, context.currency),
      },
      transactionCount: current.transactionCount,
      filters: {},
    };
  }

  /** This period against the household's own average of the three before it. */
  private async trendVsAverage(context: Context): Promise<Built> {
    const scope: SpendScope =
      context.plan.slots.categoryId === undefined
        ? {}
        : { categoryIds: await this.subtree(context.householdId, context.plan.slots.categoryId) };

    const baselines = [3, 2, 1].map((months) => monthPeriod(addMonths(context.period.start, -months)));
    const [current, ...history] = await Promise.all([
      this.spend(context, scope, 'EXPENSE'),
      ...baselines.map((period) => this.spend({ ...context, period }, scope, 'EXPENSE')),
    ]);

    const currentMinor = BigInt(current.totals[0]?.money.amountMinor ?? '0');
    const historyMinor = history.map((built) => BigInt(built.totals[0]?.money.amountMinor ?? '0'));
    const mean = historyMinor.length === 0 ? 0n : historyMinor.reduce((sum, value) => sum + value, 0n) / BigInt(historyMinor.length);
    const deltaMinor = currentMinor - mean;

    return {
      rows: [],
      totals: [
        { label: 'This period', money: { amountMinor: currentMinor.toString(), currency: context.currency }, formatted: this.format(currentMinor, context.currency) },
        { label: 'Usual', money: { amountMinor: mean.toString(), currency: context.currency }, formatted: this.format(mean, context.currency) },
        { label: 'Difference', money: { amountMinor: deltaMinor.toString(), currency: context.currency }, formatted: this.format(deltaMinor, context.currency) },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        periodsCompared: String(baselines.length),
        headline: this.format(deltaMinor, context.currency),
        current: this.format(currentMinor, context.currency),
        average: this.format(mean, context.currency),
      },
      transactionCount: current.transactionCount,
      filters: { baselinePeriods: String(baselines.length) },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  /**
   * A Category and every Category beneath it (docs/03's tree, invariant I-11).
   *
   * Asking about `Hrana` must include `Hrana / Supermarket`: anything else answers a narrower question
   * than the one that was asked, and the budget tile the user can compare against expands the same way.
   */
  private async subtree(householdId: string, categoryId: string | undefined): Promise<readonly string[]> {
    if (categoryId === undefined) return [];
    const rows = await this.prisma.client.categories.findMany({
      where: { household_id: householdId, deleted_at: null },
      select: { id: true, parent_id: true },
    });
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parent_id === null) continue;
      children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row.id]);
    }
    const collected: string[] = [];
    const visit = (id: string): void => {
      collected.push(id);
      for (const child of children.get(id) ?? []) visit(child);
    };
    visit(categoryId);
    return collected;
  }

  private pathOf(categoryId: string, byId: ReadonlyMap<string, { name: string; parent_id: string | null }>): string {
    const parts: string[] = [];
    let current: string | null = categoryId;
    while (current !== null) {
      const row = byId.get(current);
      if (row === undefined) break;
      parts.unshift(row.name);
      current = row.parent_id;
    }
    return parts.join(' / ');
  }

  private async ledgerCurrency(householdId: string): Promise<CurrencyCode> {
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { ledger_currency: true },
    });
    return (household?.ledger_currency ?? 'RSD') as CurrencyCode;
  }

  private format(minor: bigint, currency: string): string {
    return formatMoney(money(minor, currency as CurrencyCode), this.locale);
  }

  private filtersOf(context: Context, scope: SpendScope, kind: string): Readonly<Record<string, string>> {
    return {
      kind,
      ...(scope.categoryIds === undefined ? {} : { categoryIds: scope.categoryIds.join(',') }),
      ...(scope.merchantId === undefined ? {} : { merchantId: scope.merchantId }),
      ...(scope.accountId === undefined ? {} : { accountId: scope.accountId }),
      ...(scope.tagId === undefined ? {} : { tagId: scope.tagId }),
      period: `${context.period.start}..${context.period.end}`,
    };
  }

  private range(context: Context): { gte: Date; lte: Date } {
    return { gte: this.date(context.period.start), lte: this.date(context.period.end) };
  }

  /** The provenance range for a **state** figure (a balance, the review queue): true as of today. */
  private asOf(context: Context): { start: LocalDate; end: LocalDate } {
    return { start: context.today, end: context.today };
  }

  /** The widest range a set of same-shaped budget rows spans, for a list whose members differ. */
  private span(
    budgets: readonly { readonly periodStart: LocalDate; readonly periodEnd: LocalDate }[],
  ): { start: LocalDate; end: LocalDate } | undefined {
    if (budgets.length === 0) return undefined;
    const starts = budgets.map((budget) => budget.periodStart).sort();
    const ends = budgets.map((budget) => budget.periodEnd).sort();
    return { start: starts[0] as LocalDate, end: ends[ends.length - 1] as LocalDate };
  }

  private date(day: LocalDate): Date {
    return new Date(`${day}T00:00:00.000Z`);
  }

  private daysBetween(start: LocalDate, end: LocalDate): number {
    const from = this.date(start).getTime();
    const to = this.date(end).getTime();
    return Math.max(1, Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1);
  }
}

interface Context {
  readonly householdId: string;
  readonly currency: CurrencyCode;
  readonly today: LocalDate;
  readonly period: { readonly start: LocalDate; readonly end: LocalDate };
  readonly plan: Plan;
}
