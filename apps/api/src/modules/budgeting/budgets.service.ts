import { Injectable } from '@nestjs/common';

import {
  balance,
  budgetConsumption,
  elapsedDays,
  monthPeriod,
  money,
  periodBounds,
  projectMonthEnd,
  safeToSpend,
  todayIn,
  totalDays,
  uuidv7,
  zeroBalance,
  DEFAULT_TIME_ZONE,
  type Balance,
  type BudgetPeriod,
} from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { PrismaService } from '../../prisma/prisma.service';
import { BudgetPeriodEnum, type BudgetModel, type DashboardModel } from './budget.model';

export interface UpsertBudgetInput {
  readonly categoryId?: string | null;
  readonly period: BudgetPeriodEnum;
  readonly amountMinor: bigint;
  readonly periodStart?: string;
  readonly includeSubcategories?: boolean;
  readonly rollover?: boolean;
}

/**
 * Budgets and the dashboard.
 *
 * This is where the deterministic calculators meet real data, and the only rule that matters is that
 * **the numbers come from the ledger, in the backend** — never from a model (ADR-001). Every figure
 * is derived here and every input is returned alongside it, so the UI can show its working.
 *
 * The subtle parts are the two aggregation rules:
 *  - **I-5** consumption counts a Category's whole subtree when `includeSubcategories`, and only
 *    `CONFIRMED` rows (I-7).
 *  - **ADR-015** consumption must count BOTH a Transaction's own category and its splits. A split
 *    transaction carries no category of its own, so counting only `transactions.category_id` would
 *    silently ignore every split — understating spend on exactly the receipts that matter most.
 */
@Injectable()
export class BudgetsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(householdId: string, today?: string): Promise<BudgetModel[]> {
    const zone = await this.timeZoneFor(householdId);
    const date = today ?? todayIn(zone);

    const rows = await this.prisma.client.budgets.findMany({
      where: { household_id: householdId, deleted_at: null },
      orderBy: [{ category_id: 'asc' }],
    });
    if (rows.length === 0) return [];

    const categories = await this.prisma.client.categories.findMany({
      where: { household_id: householdId, deleted_at: null },
      select: { id: true, parent_id: true, name: true },
    });

    return Promise.all(
      rows.map(async (row) => {
        const period = row.period as BudgetPeriod;
        const bounds = this.boundsFor(period, this.isoDate(row.period_start));
        const subtree = this.subtreeIds(categories, row.category_id);

        const spent = await this.spendIn(householdId, subtree, bounds, row.currency);
        const elapsed = Math.max(1, elapsedDays(bounds, date));
        const total = totalDays(bounds);
        const budgetBalance = balance(row.amount_minor, row.currency);
        const consumption = budgetConsumption({
          budget: budgetBalance,
          spent,
          daysElapsed: Math.min(elapsed, total),
          daysInMonth: total,
        });

        return {
          id: row.id,
          categoryId: row.category_id,
          categoryName: categories.find((c) => c.id === row.category_id)?.name ?? null,
          period: period as BudgetPeriodEnum,
          periodStart: bounds.start,
          periodEnd: bounds.end,
          amount: money(row.amount_minor, row.currency),
          includeSubcategories: row.include_subcategories,
          rollover: row.rollover,
          spent: consumption.spent,
          remaining: consumption.remaining,
          usedRatio: consumption.usedRatio,
          elapsedRatio: consumption.elapsedRatio,
          isOverspent: consumption.isOverspent,
          isAheadOfPace: consumption.isAheadOfPace,
        };
      }),
    );
  }

  async upsert(householdId: string, input: UpsertBudgetInput): Promise<BudgetModel> {
    if (input.amountMinor <= 0n) {
      throw new ApiError('VALIDATION_FAILED', 'A budget must be greater than zero.');
    }

    const household = await this.prisma.client.households.findFirst({ where: { id: householdId } });
    if (!household) throw new ApiError('NOT_FOUND', 'Household not found.');

    if (input.categoryId) {
      const category = await this.prisma.client.categories.findFirst({
        where: { id: input.categoryId, household_id: householdId, deleted_at: null },
      });
      if (!category) throw new ApiError('NOT_FOUND', 'Category not found.');
    }

    const periodStart =
      input.periodStart ??
      monthPeriod(todayIn(household.iana_timezone || DEFAULT_TIME_ZONE)).start;

    const existing = await this.prisma.client.budgets.findFirst({
      where: {
        household_id: householdId,
        category_id: input.categoryId ?? null,
        period: input.period,
        deleted_at: null,
      },
    });

    if (existing) {
      await this.prisma.client.budgets.update({
        where: { id: existing.id },
        data: {
          amount_minor: input.amountMinor,
          period_start: new Date(`${periodStart}T00:00:00.000Z`),
          include_subcategories: input.includeSubcategories ?? existing.include_subcategories,
          rollover: input.rollover ?? existing.rollover,
          updated_at: new Date(),
        },
      });
      return (await this.list(householdId)).find((budget) => budget.id === existing.id)!;
    }

    const created = await this.prisma.client.budgets.create({
      data: {
        id: uuidv7(),
        household_id: householdId,
        category_id: input.categoryId ?? null,
        period: input.period,
        period_start: new Date(`${periodStart}T00:00:00.000Z`),
        amount_minor: input.amountMinor,
        currency: household.ledger_currency,
        include_subcategories: input.includeSubcategories ?? true,
        rollover: input.rollover ?? false,
      },
    });

    return (await this.list(householdId)).find((budget) => budget.id === created.id)!;
  }

  async remove(householdId: string, id: string): Promise<void> {
    const result = await this.prisma.client.budgets.updateMany({
      where: { id, household_id: householdId, deleted_at: null },
      data: { deleted_at: new Date(), updated_at: new Date() },
    });
    if (result.count === 0) throw new ApiError('NOT_FOUND', 'Budget not found.');
  }

  /**
   * The dashboard: one round trip, every number derived from the ledger.
   *
   * `reserved` is the recurring charges still due this period. Recurring rules are not implemented
   * until Phase 3, so it is currently zero — reported as a real zero rather than hidden, so the
   * arithmetic in the UI stays honest and the field starts working the day the rules land.
   */
  async dashboard(householdId: string): Promise<DashboardModel> {
    const household = await this.prisma.client.households.findFirst({ where: { id: householdId } });
    if (!household) throw new ApiError('NOT_FOUND', 'Household not found.');

    const zone = household.iana_timezone || DEFAULT_TIME_ZONE;
    const currency = household.ledger_currency;
    const today = todayIn(zone);
    const bounds = monthPeriod(today);
    const elapsed = Math.max(1, Math.min(elapsedDays(bounds, today), totalDays(bounds)));

    const [spent, income, householdBudget, reserved, savingsTarget, needsReviewCount] =
      await Promise.all([
        this.sumByKind(householdId, bounds, 'EXPENSE', currency),
        this.sumByKind(householdId, bounds, 'INCOME', currency),
        this.prisma.client.budgets.findFirst({
          where: { household_id: householdId, category_id: null, deleted_at: null },
        }),
        this.reservedThisPeriod(householdId, bounds, currency),
        this.savingsTargetThisPeriod(householdId, currency),
        this.prisma.client.transactions.count({
          where: { household_id: householdId, deleted_at: null, needs_review: true },
        }),
      ]);

    const budgetBalance: Balance | null = householdBudget
      ? balance(householdBudget.amount_minor, currency)
      : null;

    // Without a Household budget there is nothing to spend "safely" against, so the figure is zero
    // and `monthlyBudget` is null — the UI says "set a budget" rather than showing a made-up number.
    const safe = safeToSpend({
      budget: budgetBalance ?? zeroBalance(currency),
      spent,
      reserved,
      savingsTarget,
      daysElapsed: elapsed,
      daysInMonth: totalDays(bounds),
    });

    const projection = projectMonthEnd(
      {
        spent,
        committed: reserved,
        daysElapsed: elapsed,
        daysInMonth: totalDays(bounds),
      },
      budgetBalance ?? undefined,
    );

    return {
      today,
      periodStart: bounds.start,
      periodEnd: bounds.end,
      daysElapsed: elapsed,
      daysInMonth: totalDays(bounds),
      safeToSpendToday: budgetBalance ? safe.safeToSpendToday : zeroBalance(currency),
      available: safe.available,
      isOverspent: budgetBalance ? safe.isOverspent : false,
      spentThisMonth: spent,
      incomeThisMonth: income,
      monthlyBudget: budgetBalance ? money(budgetBalance.amountMinor, currency) : null,
      reserved,
      savingsTarget,
      projectedTotal: projection.projectedTotal,
      projectedOverrun: projection.projectedOverrun,
      dailyPace: projection.dailyPace,
      paceIsReliable: projection.paceIsReliable,
      needsReviewCount,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Aggregation
  // -------------------------------------------------------------------------------------------

  /**
   * Confirmed spend for a set of categories in a period.
   *
   * Counts a Transaction's own category **and** its splits. A split Transaction deliberately carries
   * no `category_id` (invariant I-1), so counting only the parent column would drop every split —
   * understating exactly the mixed-basket receipts the product exists to handle (ADR-015).
   */
  private async spendIn(
    householdId: string,
    categoryIds: readonly string[],
    bounds: { start: string; end: string },
    currency: string,
  ): Promise<Balance> {
    if (categoryIds.length === 0) return zeroBalance(currency);

    const period = { gte: this.date(bounds.start), lte: this.date(bounds.end) };
    const ids = [...categoryIds];

    const [direct, split] = await Promise.all([
      this.prisma.client.transactions.aggregate({
        where: {
          household_id: householdId,
          deleted_at: null,
          status: 'CONFIRMED', // I-7: PENDING never contributes
          kind: 'EXPENSE',
          category_id: { in: ids },
          occurred_local_date: period,
        },
        _sum: { amount_minor: true },
      }),
      this.prisma.client.transaction_splits.aggregate({
        where: {
          household_id: householdId,
          category_id: { in: ids },
          transactions: {
            deleted_at: null,
            status: 'CONFIRMED',
            kind: 'EXPENSE',
            occurred_local_date: period,
          },
        },
        _sum: { amount_minor: true },
      }),
    ]);

    return balance((direct._sum.amount_minor ?? 0n) + (split._sum.amount_minor ?? 0n), currency);
  }

  private async sumByKind(
    householdId: string,
    bounds: { start: string; end: string },
    kind: 'EXPENSE' | 'INCOME',
    currency: string,
  ): Promise<Balance> {
    const result = await this.prisma.client.transactions.aggregate({
      where: {
        household_id: householdId,
        deleted_at: null,
        status: 'CONFIRMED',
        kind,
        occurred_local_date: { gte: this.date(bounds.start), lte: this.date(bounds.end) },
      },
      _sum: { amount_minor: true },
    });
    return balance(result._sum.amount_minor ?? 0n, currency);
  }

  /** Recurring rules arrive in Phase 3; until then the honest answer is zero. */
  private async reservedThisPeriod(
    householdId: string,
    bounds: { start: string; end: string },
    currency: string,
  ): Promise<Balance> {
    const result = await this.prisma.client.recurring_rules.aggregate({
      where: {
        household_id: householdId,
        deleted_at: null,
        is_active: true,
        kind: 'EXPENSE',
        next_occurrence_on: { gte: this.date(bounds.start), lte: this.date(bounds.end) },
      },
      _sum: { amount_minor: true },
    });
    return balance(result._sum.amount_minor ?? 0n, currency);
  }

  /** The remaining monthly amount across active goals. */
  private async savingsTargetThisPeriod(
    householdId: string,
    currency: string,
  ): Promise<Balance> {
    const goals = await this.prisma.client.saving_goals.findMany({
      where: { household_id: householdId, deleted_at: null, status: 'ACTIVE' },
      include: { goal_contributions: { select: { amount_minor: true } } },
    });

    let total = 0n;
    for (const goal of goals) {
      const contributed = goal.goal_contributions.reduce((sum, c) => sum + c.amount_minor, 0n);
      const outstanding = goal.target_minor - contributed;
      if (outstanding <= 0n) continue;

      if (!goal.target_date) {
        total += outstanding;
        continue;
      }
      const months = Math.max(1, this.monthsUntil(goal.target_date));
      total += outstanding / BigInt(months);
    }

    return balance(total, currency);
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  /** The budget's own category plus every descendant (invariant I-5). */
  private subtreeIds(
    categories: readonly { id: string; parent_id: string | null }[],
    rootId: string | null,
  ): string[] {
    if (!rootId) return categories.map((category) => category.id);

    const childrenOf = new Map<string | null, string[]>();
    for (const category of categories) {
      const bucket = childrenOf.get(category.parent_id);
      if (bucket) bucket.push(category.id);
      else childrenOf.set(category.parent_id, [category.id]);
    }

    const ids: string[] = [];
    const queue = [rootId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (seen.has(id)) continue; // cycle guard
      seen.add(id);
      ids.push(id);
      queue.push(...(childrenOf.get(id) ?? []));
    }
    return ids;
  }

  /** Delegated to the domain so the arithmetic is unit-tested without a database. */
  private boundsFor(period: BudgetPeriod, start: string): { start: string; end: string } {
    return periodBounds(period, start);
  }

  private monthsUntil(target: Date): number {
    const now = new Date();
    return (
      (target.getUTCFullYear() - now.getUTCFullYear()) * 12 +
      (target.getUTCMonth() - now.getUTCMonth()) +
      1
    );
  }

  private async timeZoneFor(householdId: string): Promise<string> {
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { iana_timezone: true },
    });
    return household?.iana_timezone || DEFAULT_TIME_ZONE;
  }

  private date(localDate: string): Date {
    return new Date(`${localDate}T00:00:00.000Z`);
  }

  private isoDate(value: Date): string {
    return value.toISOString().slice(0, 10);
  }
}
