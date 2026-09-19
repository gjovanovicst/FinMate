import { Injectable, Logger } from '@nestjs/common';

import {
  balance,
  formatBalance,
  monthPeriod,
  addMonths,
  proposeSavings,
  type CurrencyCode,
  type LocalDate,
} from '@finmate/domain';

import { copyIntlLocale, tr, type CopyLocale } from '../../common/i18n/copy';
import { FACT_LABELS } from '../../common/i18n/fact-labels';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { BudgetsService } from '../budgeting/budgets.service';
import { GoalsService, type GoalView } from '../goals/goals.service';
import { RecurringService } from '../recurring/recurring.service';
import { MerchantsService } from '../taxonomy/merchants.service';
import { SpendReadModel, type SpendScope } from '../ledger/spend-read-model';
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
 * ## Splits are included, and every aggregate comes from one place
 *
 * A Transaction with splits contributes each split's amount to its own Category (invariant I-1), and
 * `BudgetsService.spendIn` is split-aware for exactly that reason. The assistant's category figures
 * therefore match the **budget tile** the user is looking at. As of 3.3.1 the aggregation itself is
 * {@link SpendReadModel}'s, shared with the analytics queries and the insight trends, so the assistant
 * cannot drift from the screen beside it (docs/06 §5.13).
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
  /**
   * The machine value, as strings for the wire.
   *
   * **A derived total is a `Balance`, not a `Money`** — `amountMinor` may be negative (ADR-003's
   * Money/Balance split). The totals here are `Income − spending`, a period-over-period *change*, a
   * budget's `remaining`, an account's `balance` and a projection's overrun: every one of them is a
   * sum of movements, and any of them can legitimately be negative. The GraphQL field is
   * `BalanceScalar` for exactly this reason (see {@link AssistantFactTotalModel} in
   * `assistant.model.ts`), because `Money` refuses a negative amount at serialisation.
   */
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
  /**
   * The Transactions the answer is *made of*, when the template aggregated named rows (docs/06 §4.4's
   * drill-through). Empty for an aggregate: the rows behind a total are the filtered list, which is
   * what `filters` is for — listing thousands of ids would be a payload nobody asked for.
   */
  readonly transactionIds: readonly string[];
}

interface Built {
  readonly rows: readonly FactRowView[];
  readonly totals: readonly FactTotalView[];
  readonly formatted: Readonly<Record<string, string>>;
  readonly transactionCount: number;
  readonly filters: Readonly<Record<string, string>>;
  /** Set by a builder that cannot answer in this build, e.g. `NOT_BUILT:goals`. */
  readonly unavailable?: string;
  /** The rows a `LIST` builder actually returned, for the drill-through; absent for an aggregate. */
  readonly transactionIds?: readonly string[];
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

const MAX_ROWS = 50;

@Injectable()
export class FactAssemblyService {
  private readonly logger = new Logger(FactAssemblyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly budgets: BudgetsService,
    private readonly accounts: AccountsService,
    private readonly spendModel: SpendReadModel,
    private readonly merchants: MerchantsService,
    private readonly goals: GoalsService,
    private readonly recurring: RecurringService,
  ) {}

  /** Assemble the facts for one plan. Never throws for a template that is merely unimplemented. */
  async assemble(
    householdId: string,
    plan: Plan,
    options: { readonly today: LocalDate; readonly locale?: CopyLocale },
  ): Promise<AssemblyResult> {
    const currency = await this.ledgerCurrency(householdId);
    const context: Context = {
      householdId,
      currency,
      today: options.today,
      period: plan.slots.period,
      plan,
      // Defaults to English, the product's primary language, for the callers that do not carry one.
      locale: options.locale ?? 'en',
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
      transactionIds: built.transactionIds ?? [],
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
    INCOME_BY_CATEGORY: async (context) => {
      // The same read model call as `SPEND_BY_CATEGORY`, with `kind: 'INCOME'` — the split-aware
      // aggregate is one implementation, and the direction is an argument to it rather than a second
      // query. `scopePhrase` and the `TOTAL_AMOUNT` frame read `plan.template.kind`, so the labelled
      // sentence ("You received X on Plata") follows from the registry entry rather than from a branch.
      const categoryIds = await this.subtree(context.householdId, context.plan.slots.categoryId);
      return this.spend(context, { categoryIds }, 'INCOME');
    },
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
    GOAL_PROGRESS: (context) => this.goalProgress(context),
    GOAL_REQUIRED_MONTHLY: (context) => this.goalRequiredMonthly(context),
    SAVINGS_PROPOSAL: (context) => this.savingsProposal(context),
    RECURRING_UPCOMING: (context) => this.recurringUpcoming(context),
    RECURRING_LIST: (context) => this.recurringList(context),
    NO_TEMPLATE_MATCH: (context) => this.unavailableBuilt(context, 'NO_TEMPLATE_MATCH'),
  };

  private async unavailableBuilt(context: Context, reason: string): Promise<Built> {
    return this.unavailable(context, reason);
  }

  // -------------------------------------------------------------------------------------------
  // Goals and recurring rules — docs/01 F-18, F-16, docs/06 §5.7/§5.8
  // -------------------------------------------------------------------------------------------

  /**
   * How far the "due soon" window reaches.
   *
   * Thirty days, because that is the window the `/recurring` screen already shows in its own
   * next-30-days line — and the drill-through sends the reader to exactly that screen, so a different
   * window here would make the answer uncheckable against the figure it links to.
   */
  private static readonly RECURRING_WINDOW_DAYS = 30;

  /**
   * One goal, by the id the planner resolved from its **name**.
   *
   * `list` rather than `getById`: a goal deleted between planning and assembly must produce a refusal,
   * and `getById` throws `NOT_FOUND`, which the resolver would surface as an error rather than as "I
   * could not tell which goal you meant". One read either way, and `list` also carries the
   * contributions `GOAL_PROGRESS` reports.
   */
  private async goal(context: Context): Promise<GoalView | null> {
    const goalId = context.plan.slots.goalId;
    if (goalId === undefined) return null;
    const goals = await this.goals.list(context.householdId);
    return goals.find((goal) => goal.id === goalId) ?? null;
  }

  /**
   * Progress toward one goal — docs/02 §4.13.
   *
   * Every figure is `GoalView`'s, i.e. `@finmate/domain`'s `goalProgress`, so the answer, the goal card
   * and the `/goals` screen cannot disagree about how far along a goal is.
   *
   * `transactionCount` is **0 on purpose.** `provenance.transactionCount` means "CONFIRMED, non-deleted
   * Transactions aggregated", and a contribution is *not* a Transaction (docs/03: goal progress is the
   * sum of `goal_contributions`, which is why `contributeToGoal` writes no ledger row). Reporting the
   * contribution count there would put a number in the provenance panel that claims something the
   * figure never touched — the same small lie the `savings.proposal.v1` rename exists to avoid.
   */
  private async goalProgress(context: Context): Promise<Built> {
    const goal = await this.goal(context);
    if (goal === null) return this.unavailable(context, 'UNRUNNABLE:goalId');

    const contributed = this.format(context, goal.contributedMinor, goal.currency);
    const target = this.format(context, goal.targetMinor, goal.currency);
    const remaining = this.format(context, goal.remainingMinor, goal.currency);
    // A **rounded** percentage, and the rounding is the only arithmetic this builder does: it is a
    // display ratio `@finmate/domain` already computed (capped at 1 — a bar cannot be 140 % full).
    const progressPercent = String(Math.round(goal.progress * 100));

    return {
      rows: [{ label: goal.name, value: goal.contributedMinor.toString(), formatted: contributed }],
      totals: [
        {
          label: tr(context.locale, FACT_LABELS.saved),
          money: { amountMinor: goal.contributedMinor.toString(), currency: goal.currency },
          formatted: contributed,
        },
        {
          label: tr(context.locale, FACT_LABELS.target),
          money: { amountMinor: goal.targetMinor.toString(), currency: goal.currency },
          formatted: target,
        },
        {
          label: tr(context.locale, FACT_LABELS.remaining),
          money: { amountMinor: goal.remainingMinor.toString(), currency: goal.currency },
          formatted: remaining,
        },
      ],
      formatted: {
        goal: goal.name,
        headline: contributed,
        contributed,
        target,
        remaining,
        progressPercent,
        ...(goal.targetDate === null ? {} : { targetDate: goal.targetDate }),
        status: goal.status,
        currency: goal.currency,
        asOf: context.today,
      },
      transactionCount: 0,
      filters: { goalId: goal.id, asOf: 'now' },
      // A goal is a **state as of now**, not a report over the question's period (docs/06 §8.3).
      period: this.asOf(context),
    };
  }

  /**
   * What to put aside each month to reach one goal by its date — docs/01 F-18.
   *
   * `requiredPerMonthMinor` is `null` for a goal with **no target date**, and that is not a missing
   * figure: there is no monthly amount that reaches an undated goal, and inventing one from a default
   * horizon would be the answer's most important input made up. The refusal says which state it is
   * (`NO_TARGET_DATE`) rather than reusing the generic "I cannot answer that".
   */
  private async goalRequiredMonthly(context: Context): Promise<Built> {
    const goal = await this.goal(context);
    if (goal === null) return this.unavailable(context, 'UNRUNNABLE:goalId');
    if (goal.requiredPerMonthMinor === null || goal.monthsRemaining === null || goal.targetDate === null) {
      return this.unavailable(context, 'NO_TARGET_DATE');
    }

    const monthly = this.format(context, goal.requiredPerMonthMinor, goal.currency);

    return {
      rows: [],
      totals: [
        {
          label: tr(context.locale, FACT_LABELS.perMonth),
          money: { amountMinor: goal.requiredPerMonthMinor.toString(), currency: goal.currency },
          formatted: monthly,
        },
      ],
      formatted: {
        goal: goal.name,
        headline: monthly,
        monthly,
        remaining: this.format(context, goal.remainingMinor, goal.currency),
        target: this.format(context, goal.targetMinor, goal.currency),
        monthsRemaining: String(goal.monthsRemaining),
        targetDate: goal.targetDate,
        currency: goal.currency,
        asOf: context.today,
      },
      transactionCount: 0,
      filters: { goalId: goal.id, asOf: 'now' },
      period: this.asOf(context),
    };
  }

  /**
   * The recurring rules the Household has — docs/01 F-16.
   *
   * **Paused rules are listed, and labelled as paused.** They are part of what the Household has, and
   * hiding them would make "koje pretplate imam" answer a shorter list than the `/recurring` screen
   * shows — the contradiction a drill-through exists to prevent. `formatted.pausedCount` carries the
   * number so the sentence can say it rather than implying every row is being charged.
   */
  private async recurringList(context: Context): Promise<Built> {
    const rules = await this.recurring.list(context.householdId, false);
    const wanted =
      context.plan.slots.recurringRuleId === undefined
        ? rules
        : rules.filter((rule) => rule.id === context.plan.slots.recurringRuleId);
    const limit = Math.min(context.plan.slots.limit ?? MAX_ROWS, MAX_ROWS);
    const shown = wanted.slice(0, limit);
    const paused = shown.filter((rule) => !rule.isActive).length;

    return {
      rows: shown.map((rule) => ({
        label: rule.isActive
          ? `${rule.description} (next ${rule.nextOccurrenceOn})`
          : `${rule.description} (paused)`,
        value: rule.amountMinor.toString(),
        formatted: this.format(context, rule.amountMinor, rule.currency),
      })),
      totals: [],
      formatted: {
        headline: String(shown.length),
        count: String(shown.length),
        pausedCount: String(paused),
        currency: context.currency,
        asOf: context.today,
      },
      transactionCount: 0,
      filters: {
        asOf: 'now',
        ...(context.plan.slots.recurringRuleId === undefined
          ? {}
          : { recurringRuleId: context.plan.slots.recurringRuleId }),
      },
      period: this.asOf(context),
    };
  }

  /**
   * What is still to be charged inside the next {@link RECURRING_WINDOW_DAYS} days — docs/01 F-16.
   *
   * The occurrences come from `RecurringService.dueSoon`, the same `pendingOccurrences` read that feeds
   * a budget's projection (`committed`) and the `RECURRING_DUE` alert, so the assistant, the dashboard
   * and the notification cannot disagree about what is due. That method is also where the three
   * exclusion rules live — an occurrence already posted as a Transaction is not due again.
   */
  private async recurringUpcoming(context: Context): Promise<Built> {
    const occurrences = await this.recurring.dueSoon(context.householdId, {
      asOf: context.today,
      withinDays: FactAssemblyService.RECURRING_WINDOW_DAYS,
    });
    const wanted =
      context.plan.slots.recurringRuleId === undefined
        ? occurrences
        : occurrences.filter((occurrence) => occurrence.ruleId === context.plan.slots.recurringRuleId);
    const limit = Math.min(context.plan.slots.limit ?? MAX_ROWS, MAX_ROWS);
    const shown = wanted.slice(0, limit);

    return {
      rows: shown.map((occurrence) => ({
        label: `${occurrence.description} (${occurrence.occurredOn})`,
        value: occurrence.amountMinor.toString(),
        formatted: this.format(context, occurrence.amountMinor, context.currency),
        ...(occurrence.categoryId === null ? {} : { categoryId: occurrence.categoryId }),
      })),
      totals: [],
      formatted: {
        headline: String(shown.length),
        count: String(shown.length),
        days: String(FactAssemblyService.RECURRING_WINDOW_DAYS),
        currency: context.currency,
        asOf: context.today,
      },
      transactionCount: 0,
      filters: {
        asOf: 'now',
        withinDays: String(FactAssemblyService.RECURRING_WINDOW_DAYS),
        ...(context.plan.slots.recurringRuleId === undefined
          ? {}
          : { recurringRuleId: context.plan.slots.recurringRuleId }),
      },
      period: this.asOf(context),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Spending
  // -------------------------------------------------------------------------------------------

  /**
   * Sum over the scope, **including splits** — {@link SpendReadModel.total} does the arithmetic.
   *
   * The count is a **transaction** count, not a count of contributions: a receipt split across three
   * Categories is one transaction, which is what docs/06 §8.3 requires provenance to report. The read
   * model returns exactly that, so nothing about I-7 or I-1 is re-decided here.
   */
  /**
   * A scoped total, with its **scope named**.
   *
   * ⚠️ The scope phrase is not decoration: without it the facts carry a figure labelled only
   * "Spending" and the scope as an id inside `filters`, and a narrator told never to guess sees no
   * evidence that the number *is* the merchant's or the category's — so it refuses. Measured before
   * this: `koliko sam potrošio u lidlu` answered *"Ne mogu da odgovorim … podaci ne sadrže iznos
   * potrošnje za Lidl"* while the facts held `4.000,00 RSD` for exactly that. The deterministic
   * fallback was scope-blind in the same way ("You spent 4.000,00 RSD."), so the missing name is a
   * **payload** defect, not a narration one (docs/06 §8.2, docs/15).
   */
  private async spend(context: Context, scope: SpendScope, kind: 'EXPENSE' | 'INCOME'): Promise<Built> {
    const [totals, scopePhrase] = await Promise.all([
      this.spendModel.total(context.householdId, this.window(context), { ...scope, kind }),
      this.scopePhrase(context),
    ]);
    const formatted = this.format(context, totals.minor, context.currency);
    const base = tr(context.locale, kind === 'INCOME' ? FACT_LABELS.income : FACT_LABELS.spending);
    const label = scopePhrase === null ? base : `${base} ${scopePhrase}`;

    return {
      rows: [],
      totals: [
        {
          label,
          money: { amountMinor: totals.minor.toString(), currency: context.currency },
          formatted,
        },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: formatted,
        currency: context.currency,
        // The machine-readable scope, beside the labelled total: the narrator may quote it and the
        // template sentence uses it, and neither has to infer the scope from a UUID.
        ...(scopePhrase === null ? {} : { scope: scopePhrase }),
      },
      transactionCount: totals.transactionCount,
      filters: this.filtersOf(context, scope, kind),
    };
  }

  /**
   * How the scope the question named reads in a sentence — `at Lidl`, `on Hrana / Supermarket`,
   * `from Kartica`, `tagged Dejan` — or `null` for an unscoped total.
   *
   * Built from the **plan's resolved slot** rather than from the widened `SpendScope`: a category
   * question resolves to the named node and its subtree, and naming the subtree's first id would print
   * a child where the person said the parent.
   *
   * A name that cannot be read returns `null` rather than an id: "Spending at <uuid>" is worse than no
   * scope at all, which is also why every lookup is `findFirst` on a live row (a deleted one is not a
   * name to print).
   */
  private async scopePhrase(context: Context): Promise<string | null> {
    const slots = context.plan.slots;
    // ⚠️ The phrase names the scope the **figure was computed from** — the routed template's own
    // required slot — not the first slot that happens to be filled.
    //
    // A question can resolve more than one scope: *"na hranu u Lidlu"* names a Category **and** a
    // Merchant, both resolve, and the router picks one. Preferring the Merchant here printed a
    // category total under a merchant's name — the last way a figure could wear another scope's label
    // (ADR-017). `spend()` reads the same slot the phrase does, so the two cannot disagree.
    const required = context.plan.template.requiredSlots;
    if (required.includes('merchantId') && slots.merchantId !== undefined) {
      const name = await this.merchantName(slots.merchantId);
      return name === null ? null : tr(context.locale, { en: 'at {name}', sr: 'kod prodavca „{name}“' }, { name });
    }
    if (required.includes('accountId') && slots.accountId !== undefined) {
      const name = await this.accountName(context.householdId, slots.accountId);
      return name === null ? null : tr(context.locale, { en: 'from {name}', sr: 'sa računa „{name}“' }, { name });
    }
    if (required.includes('tagId') && slots.tagId !== undefined) {
      const name = await this.tagName(slots.tagId);
      return name === null ? null : tr(context.locale, { en: 'tagged {name}', sr: 'sa oznakom „{name}“' }, { name });
    }
    if (required.includes('categoryId') && slots.categoryId !== undefined) {
      const path = await this.categoryPath(context.householdId, slots.categoryId);
      return path === null ? null : tr(context.locale, { en: 'on {name}', sr: 'na kategoriji „{name}“' }, { name: path });
    }
    return null;
  }

  private async merchantName(id: string): Promise<string | null> {
    // Globally readable with a nullable `household_id`, so a name read is not a tenancy question; the
    // guard still applies its global OR (docs/08's allow-list).
    const row = await this.prisma.client.merchants.findFirst({
      where: { id, deleted_at: null },
      select: { name: true },
    });
    return row?.name ?? null;
  }

  private async accountName(householdId: string, id: string): Promise<string | null> {
    const row = await this.prisma.client.accounts.findFirst({
      where: { id, household_id: householdId, deleted_at: null },
      select: { name: true },
    });
    return row?.name ?? null;
  }

  private async tagName(id: string): Promise<string | null> {
    const row = await this.prisma.client.tags.findFirst({
      where: { id, deleted_at: null },
      select: { name: true },
    });
    return row?.name ?? null;
  }

  /** A category's breadcrumb, or `null` when the row is gone. The full path, unlike a total's label. */
  private async categoryPath(householdId: string, categoryId: string): Promise<string | null> {
    const rows = await this.prisma.client.categories.findMany({
      where: { household_id: householdId, deleted_at: null },
      select: { id: true, name: true, parent_id: true },
    });
    const byId = new Map(rows.map((row) => [row.id, { name: row.name, parent_id: row.parent_id }]));
    if (!byId.has(categoryId)) return null;
    return this.pathOf(categoryId, byId);
  }

  /** The N categories with the most spend, splits included. */
  private async topCategories(context: Context, kind: 'EXPENSE' | 'INCOME'): Promise<Built> {
    const spend = await this.categorySpend(context, kind);

    const limit = Math.min(context.plan.slots.limit ?? 10, MAX_ROWS);
    const rows = [...spend.totals.entries()]
      .sort((left, right) => (right[1] > left[1] ? 1 : right[1] < left[1] ? -1 : left[0] < right[0] ? -1 : 1))
      .slice(0, limit)
      .map(([categoryId, minor]) => ({
        label: this.pathOf(categoryId, spend.byId),
        value: minor.toString(),
        formatted: this.format(context, minor, context.currency),
        categoryId,
      }));

    return {
      rows,
      totals: [],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: rows[0]?.formatted ?? this.format(context, 0n, context.currency),
        topLabel: rows[0]?.label ?? '',
      },
      transactionCount: spend.transactionCount,
      filters: { kind, limit: String(limit) },
    };
  }

  /**
   * The savings proposal — docs/01 F-30, docs/02 §4.16.
   *
   * The arithmetic is {@link proposeSavings} in `@finmate/domain` (pure, integer minor units); what
   * this builder owns is the **facts it is given**: the period's confirmed spend per Category, splits
   * included, exactly as the budget tile counts it (I-1, ADR-015). A proposal computed from a
   * different set of rows than the one the user can look at would be a plan nobody could check.
   *
   * The target comes from the planner as `slots.targetMinor`; without one the assembler has already
   * refused the question, so reaching here means the amount was stated and unambiguous.
   */
  private async savingsProposal(context: Context): Promise<Built> {
    const targetMinor = BigInt(context.plan.slots.targetMinor ?? '0');
    const spend = await this.categorySpend(context, 'EXPENSE');
    const proposal = proposeSavings({
      targetMinor,
      currency: context.currency,
      // `kind: 'EXPENSE'` already excludes every INCOME Category, so there is nothing left to filter.
      candidates: [...spend.totals.entries()].map(([categoryId, spentMinor]) => ({
        categoryId,
        spentMinor,
      })),
    });

    const rows = proposal.lines.map((line) => ({
      label: this.pathOf(line.categoryId, spend.byId),
      value: line.reductionMinor.toString(),
      formatted: this.format(context, line.reductionMinor, context.currency),
      categoryId: line.categoryId,
    }));

    const target = this.format(context, proposal.targetMinor, context.currency);
    const proposed = this.format(context, proposal.proposedMinor, context.currency);
    const shortfall = this.format(context, proposal.shortfallMinor, context.currency);

    return {
      rows,
      totals: [
        {
          label: tr(context.locale, FACT_LABELS.target),
          money: { amountMinor: proposal.targetMinor.toString(), currency: context.currency },
          formatted: target,
        },
        {
          label: tr(context.locale, FACT_LABELS.proposed),
          money: { amountMinor: proposal.proposedMinor.toString(), currency: context.currency },
          formatted: proposed,
        },
        {
          label: tr(context.locale, FACT_LABELS.shortfall),
          money: { amountMinor: proposal.shortfallMinor.toString(), currency: context.currency },
          formatted: shortfall,
        },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: proposed,
        target,
        proposed,
        shortfall,
        meetsTarget: String(proposal.meetsTarget),
        capPercent: String(proposal.capPercent),
        currency: context.currency,
      },
      transactionCount: spend.transactionCount,
      filters: { kind: 'EXPENSE', capPercent: String(proposal.capPercent) },
    };
  }

  /**
   * Confirmed spend per Category in the period, splits included (I-1, ADR-015).
   *
   * Shared by the ranked view and the savings proposal so the two can never disagree about what a
   * Category spent — the failure mode being a plan built on figures the screen contradicts. Only the
   * aggregation moved to {@link SpendReadModel}; the Category tree stays here because a label is a
   * taxonomy concern, and the money is not.
   */
  private async categorySpend(
    context: Context,
    kind: 'EXPENSE' | 'INCOME',
  ): Promise<{
    readonly totals: ReadonlyMap<string, bigint>;
    readonly byId: ReadonlyMap<string, { name: string; parent_id: string | null }>;
    readonly transactionCount: number;
  }> {
    const [rows, categories] = await Promise.all([
      this.spendModel.byCategory(context.householdId, this.window(context), { kind }),
      this.prisma.client.categories.findMany({
        where: { household_id: context.householdId, deleted_at: null },
        select: { id: true, name: true, parent_id: true },
      }),
    ]);

    return {
      totals: new Map(rows.map((row) => [row.categoryId, row.minor])),
      byId: new Map(categories.map((row) => [row.id, row])),
      transactionCount: rows.reduce((sum, row) => sum + row.transactionCount, 0),
    };
  }

  /**
   * The N merchants with the most spend.
   *
   * **The full Transaction amount, not the un-split part**: a split receipt paid to Lidl was paid to
   * Lidl in full, which is docs/06 §4.3's rule and is implemented once in
   * {@link SpendReadModel.byMerchant}. A row whose Merchant was never resolved is listed under its raw
   * description instead of being dropped — hiding it would quietly understate the list the user is
   * looking at (before 3.3.1 this query filtered `merchant_id: { not: null }`).
   */
  private async topMerchants(context: Context, kind: 'EXPENSE' | 'INCOME'): Promise<Built> {
    const grouped = await this.spendModel.byMerchant(context.householdId, this.window(context), {
      kind,
      limit: Math.min(context.plan.slots.limit ?? 10, MAX_ROWS),
    });

    // One implementation of "what is this Merchant called", owned by the module that owns the table
    // (the analytics `displayName` reads the same method), so the two surfaces cannot disagree.
    const names = await this.merchants.displayNames(
      grouped.map((row) => row.merchantId).filter((id): id is string => id !== null),
    );

    const rows = grouped.map((row) => ({
      label: row.merchantId === null ? (row.description ?? '—') : (names.get(row.merchantId) ?? '—'),
      value: row.minor.toString(),
      formatted: this.format(context, row.minor, context.currency),
      ...(row.merchantId === null ? {} : { merchantId: row.merchantId }),
    }));

    return {
      rows,
      totals: [],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: rows[0]?.formatted ?? this.format(context, 0n, context.currency),
        topLabel: rows[0]?.label ?? '',
      },
      transactionCount: grouped.reduce((sum, row) => sum + row.transactionCount, 0),
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
        formatted: this.format(context, row.amount_minor, context.currency),
        ...(row.category_id === null ? {} : { categoryId: row.category_id }),
      })),
      totals: [],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: rows[0] === undefined ? this.format(context, 0n, context.currency) : this.format(context, rows[0].amount_minor, context.currency),
      },
      transactionCount: rows.length,
      filters: { kind },
      transactionIds: rows.map((row) => row.id),
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
          label: tr(context.locale, FACT_LABELS.averagePerDay),
          money: { amountMinor: perDay.toString(), currency: context.currency },
          formatted: this.format(context, perDay, context.currency),
        },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        days: String(days),
        headline: this.format(context, perDay, context.currency),
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
        formatted: this.format(context, row.amount_minor, context.currency),
        ...(row.category_id === null ? {} : { categoryId: row.category_id }),
      })),
      totals: [],
      formatted: { period: `${context.period.start} – ${context.period.end}`, headline: String(rows.length) },
      transactionCount: rows.length,
      filters: {},
      transactionIds: rows.map((row) => row.id),
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
        formatted: this.format(context, row.amount_minor, context.currency),
        ...(row.category_id === null ? {} : { categoryId: row.category_id }),
      })),
      totals: [],
      formatted: { headline: String(rows.length), asOf: context.today },
      transactionCount: rows.length,
      filters: { needsReview: 'true', asOf: 'now' },
      transactionIds: rows.map((row) => row.id),
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
          label: tr(context.locale, FACT_LABELS.income),
          money: { amountMinor: incomeMinor.toString(), currency: context.currency },
          formatted: this.format(context, incomeMinor, context.currency),
        },
        {
          label: tr(context.locale, FACT_LABELS.spending),
          money: { amountMinor: expenseMinor.toString(), currency: context.currency },
          formatted: this.format(context, expenseMinor, context.currency),
        },
        {
          label: tr(context.locale, FACT_LABELS.net),
          money: { amountMinor: netMinor.toString(), currency: context.currency },
          formatted: this.format(context, netMinor, context.currency),
        },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: this.format(context, netMinor, context.currency),
        income: this.format(context, incomeMinor, context.currency),
        spending: this.format(context, expenseMinor, context.currency),
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
        formatted: this.format(context, BigInt(account.balance.amountMinor), account.balance.currency),
      })),
      totals: [],
      formatted: {
        headline: accounts[0] === undefined ? this.format(context, 0n, context.currency) : this.format(context, BigInt(accounts[0].balance.amountMinor), accounts[0].balance.currency),
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
        label: budget.categoryName ?? tr(context.locale, FACT_LABELS.household),
        value: String(budget.remaining.amountMinor),
        formatted: this.format(context, budget.remaining.amountMinor, budget.remaining.currency),
        ...(budget.categoryId === null ? {} : { categoryId: budget.categoryId }),
      })),
      totals: chosen.slice(0, 1).map((budget) => ({
        label: budget.categoryName ?? tr(context.locale, FACT_LABELS.household),
        money: { amountMinor: budget.remaining.amountMinor.toString(), currency: budget.remaining.currency },
        formatted: this.format(context, budget.remaining.amountMinor, budget.remaining.currency),
      })),
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        headline: chosen[0] === undefined ? this.format(context, 0n, context.currency) : this.format(context, chosen[0].remaining.amountMinor, chosen[0].remaining.currency),
        spent: chosen[0] === undefined ? this.format(context, 0n, context.currency) : this.format(context, chosen[0].spent.amountMinor, chosen[0].spent.currency),
        limit: chosen[0] === undefined || chosen[0].amount === undefined ? '' : this.format(context, BigInt(chosen[0].amount.amountMinor), chosen[0].amount.currency),
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
        label: budget.categoryName ?? tr(context.locale, FACT_LABELS.household),
        value: String(budget.remaining.amountMinor),
        formatted: this.format(context, budget.remaining.amountMinor, budget.remaining.currency),
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
          label: tr(context.locale, FACT_LABELS.safeToSpendToday),
          money: { amountMinor: safe.amountMinor.toString(), currency: safe.currency },
          formatted: this.format(context, safe.amountMinor, safe.currency),
        },
      ],
      formatted: {
        headline: this.format(context, safe.amountMinor, safe.currency),
        spent: this.format(context, dashboard.spentThisMonth.amountMinor, dashboard.spentThisMonth.currency),
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
          label: tr(context.locale, FACT_LABELS.projectedTotal),
          money: { amountMinor: projected.amountMinor.toString(), currency: projected.currency },
          formatted: this.format(context, projected.amountMinor, projected.currency),
        },
        // ⚠️ Only when the month is genuinely **over**: `projectedOverrun` is a signed Balance, so a
        // negative one means the projection is *under* budget. Emitting it under the label "Projected
        // overrun" would assert an overspend that is not there — and the template frame reads this
        // total by that label, so a negative would render "over by -5.000,00 RSD". ≤ 0 therefore emits
        // **no** overrun fact at all, which is the same rule the client's `overrunText` applies. The
        // under-budget case is not lost: `headline` is the projected total, and the PROJECTION frame
        // reads "You are on track for X this month."
        ...(overrun === null || overrun.amountMinor <= 0n
          ? []
          : [
              {
                label: tr(context.locale, FACT_LABELS.projectedOverrun),
                money: { amountMinor: overrun.amountMinor.toString(), currency: overrun.currency },
                formatted: this.format(context, overrun.amountMinor, overrun.currency),
              },
            ]),
      ],
      formatted: {
        headline: this.format(context, projected.amountMinor, projected.currency),
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
        label: budget.categoryName ?? tr(context.locale, FACT_LABELS.household),
        value: String(budget.spent.amountMinor),
        formatted: this.format(context, budget.spent.amountMinor, budget.spent.currency),
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
        { label: tr(context.locale, FACT_LABELS.thisPeriod), money: { amountMinor: currentMinor.toString(), currency: context.currency }, formatted: this.format(context, currentMinor, context.currency) },
        { label: tr(context.locale, FACT_LABELS.previousPeriod), money: { amountMinor: beforeMinor.toString(), currency: context.currency }, formatted: this.format(context, beforeMinor, context.currency) },
        { label: tr(context.locale, FACT_LABELS.change), money: { amountMinor: deltaMinor.toString(), currency: context.currency }, formatted: this.format(context, deltaMinor, context.currency) },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        previousPeriod: `${previous.start} – ${previous.end}`,
        headline: this.format(context, deltaMinor, context.currency),
        current: this.format(context, currentMinor, context.currency),
        previous: this.format(context, beforeMinor, context.currency),
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
        { label: tr(context.locale, FACT_LABELS.thisPeriod), money: { amountMinor: currentMinor.toString(), currency: context.currency }, formatted: this.format(context, currentMinor, context.currency) },
        { label: tr(context.locale, FACT_LABELS.usual), money: { amountMinor: mean.toString(), currency: context.currency }, formatted: this.format(context, mean, context.currency) },
        { label: tr(context.locale, FACT_LABELS.difference), money: { amountMinor: deltaMinor.toString(), currency: context.currency }, formatted: this.format(context, deltaMinor, context.currency) },
      ],
      formatted: {
        period: `${context.period.start} – ${context.period.end}`,
        periodsCompared: String(baselines.length),
        headline: this.format(context, deltaMinor, context.currency),
        current: this.format(context, currentMinor, context.currency),
        average: this.format(context, mean, context.currency),
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

  /**
   * Render a derived amount.
   *
   * ⚠️ **`formatBalance`, not `formatMoney`, and the difference is a 500.** Every figure this service
   * renders is derived from movements, so it is a `Balance` and may be negative — a month that spent
   * less than the last one, a budget past its limit, an overdrawn account, a projection *under* budget.
   * `formatMoney` calls `money()`, which **throws** on a negative `amountMinor` (ADR-003 forbids a sign
   * on a Transaction amount, and the constructor enforces it), so every one of those ordinary states
   * took the whole answer down with an INTERNAL error before this was fixed. The reported instance was
   * `MONTH_PROJECTION`; the same call sat in eight places, which is why the helper itself changed rather
   * than the one call site (docs/15).
   *
   * For a non-negative value the output is **byte-identical** — `formatBalance` uses the same
   * `Intl.NumberFormat` call — so this changes nothing except that a negative renders with a leading
   * minus instead of throwing. The client already handles both (`fm-money` formats through
   * `formatBalance`, docs/07 §4.5), and `money-text.overrunText` gates on the sign.
   */
  private format(context: Context, minor: bigint, currency: string): string {
    // The reader's own locale: an amount inside a Serbian sentence must be grouped the Serbian way, and
    // one inside an English sentence the English way (docs/15 — the money and the words around it agree).
    return formatBalance(balance(minor, currency as CurrencyCode), copyIntlLocale(context.locale));
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

  /** The plan's period as the read model's inclusive window. */
  private window(context: Context): { from: LocalDate; to: LocalDate } {
    return { from: context.period.start, to: context.period.end };
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
  /**
   * The reader's language, resolved from the request (ADR-040).
   *
   * It rides on the context rather than on a service field on purpose: `FactAssemblyService` is a
   * Nest singleton and every builder awaits the database, so a field would let two concurrent requests
   * format each other's money.
   */
  readonly locale: CopyLocale;
}
