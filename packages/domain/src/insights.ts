import { projectMonthEnd } from './budget';
import type { LocalDate } from './dates';
import { balance, type CurrencyCode } from './money';

/**
 * Deterministic insight generators (docs/01 F-20, F-22; docs/09 task 3.1.1).
 *
 * ## What this module is
 *
 * Four pure functions that turn **facts the caller already loaded** into `InsightDraft`s: a budget
 * that is projected to overrun, a category whose spend jumped, a single transaction far outside its
 * category's usual amount, and a category that came *down*.
 *
 * ## Why it is pure, and why the thresholds live here
 *
 * The numbers a user reads in the insight feed are the same class of number as a balance or a budget
 * remainder: computed, auditable, and never produced by a model (ADR-001). So the arithmetic is here,
 * in the package whose whole job is arithmetic with tests, and the caller does only I/O.
 *
 * The thresholds are **content**, like the seed keyword weights (docs/04 §8.1.3): they are what makes
 * an insight useful instead of noise, so they are named constants with the reasoning attached rather
 * than literals inside a comparison. Their canonical statement is the acceptance criteria on F-20 and
 * F-22 in docs/01; this file implements them and a test asserts each boundary.
 *
 * ## Positive feedback is not decoration
 *
 * F-22 lists **positive feedback** as in-scope explicitly, and the retention argument is the reason: an
 * insight feed that only ever warns is a feed users learn to avoid (docs/14 risk R-08). `POSITIVE_TREND`
 * is therefore a first-class generator, not a footnote on the spike generator, and it carries
 * `severity: 'POSITIVE'` so the UI can render it differently (docs/02 §7.1).
 *
 * ## Money
 *
 * Every amount is `bigint` minor units (ADR-003) and every payload stringifies them, because a JSON
 * *number* in the money path is a float. Ratios are plain `number`: they are comparisons, not money.
 *
 * @module @finmate/domain
 */

/** The four generators task 3.1.1 ships. `insights.kind` is an open `TEXT` column (docs/03 §4). */
export type InsightKind = 'BUDGET_PACE' | 'CATEGORY_SPIKE' | 'UNUSUAL_SPEND' | 'POSITIVE_TREND';

/** Mirrors the `insights.severity` CHECK constraint (docs/03 §4). */
export type InsightSeverity = 'INFO' | 'POSITIVE' | 'WARNING' | 'CRITICAL';

/**
 * The thresholds, in one place.
 *
 * Every one of them is a **noise filter as much as a trigger**: a feed that fires on a 12 % wobble
 * teaches the user that the feed is not worth reading, and the warning that mattered is then the one
 * they scroll past.
 */
export const INSIGHT_THRESHOLDS = {
  /**
   * A projected overrun at or above this share of the limit is `CRITICAL`; any smaller overrun is
   * `WARNING`. 20 % is roughly "one more week of the month at this pace".
   */
  paceCriticalOverrunRatio: 0.2,
  /** Current-period spend at or above this multiple of the baseline is a spike. */
  spikeRatio: 1.5,
  /** …and at or above this multiple it is `CRITICAL`. */
  spikeCriticalRatio: 3,
  /** Ignore a spike worth less than this in absolute terms (10.00 in a 2-decimal currency). */
  spikeMinDeltaMinor: 1000n,
  /** Complete periods of history the baseline averages over. */
  baselinePeriods: 3,
  /**
   * How many of those periods must contain spend for the category before any trend judgement is made.
   * Two, so a category seen once is not "trending" in either direction.
   */
  minBaselinePeriods: 2,
  /** A transaction at or above this multiple of its category's median is unusual. */
  unusualRatio: 3,
  /** …with an absolute floor, so a 3× jump on a 3.00 purchase is not news. */
  unusualMinMinor: 5000n,
  /** Median is noise below this many prior transactions in the category. */
  unusualMinHistory: 5,
  /** A reduction of at least this share counts as a positive trend. */
  positiveReductionRatio: 0.2,
  /** …and the baseline must be worth reacting to at all. */
  positiveMinBaselineMinor: 1000n,
} as const;

/** A payload value: JSON-safe, with money as a string (ADR-003). */
export type InsightPayloadValue = string | number | boolean | null;
export type InsightPayload = Readonly<Record<string, InsightPayloadValue>>;

export interface InsightDraft {
  readonly kind: InsightKind;
  readonly severity: InsightSeverity;
  readonly periodStart: LocalDate;
  readonly periodEnd: LocalDate;
  /** The computed facts. Contains **only** numbers this module calculated. */
  readonly payload: InsightPayload;
  /**
   * The stable identity of the **condition**, not of the row: `kind:periodStart:subject`.
   *
   * A re-run of the generator for the same period must recognise what it already said, so the writer
   * looks this up before inserting. It is stored inside `payload` because `insights` has no column for
   * it and adding one is a migration this task does not need (docs/06 §5.13).
   */
  readonly dedupeKey: string;
}

/** One period's spend for one category, already summed by the caller. */
export interface PeriodSpend {
  readonly periodStart: LocalDate;
  readonly spentMinor: bigint;
}

/** Everything the budget-pace generator needs. Assembled by the caller from `budgets` + the ledger. */
export interface BudgetPaceFact {
  readonly budgetId: string;
  /** `null` for the whole-Household budget. */
  readonly categoryId: string | null;
  /** Breadcrumb for the message, e.g. `['Hrana', 'Supermarket']`. */
  readonly categoryPath: readonly string[] | null;
  readonly currency: string;
  readonly limitMinor: bigint;
  readonly spentMinor: bigint;
  /** What is still expected to be charged before the period ends (docs/03 `committed`). */
  readonly committedMinor: bigint;
  readonly periodStart: LocalDate;
  readonly periodEnd: LocalDate;
  readonly daysElapsed: number;
  readonly daysInMonth: number;
}

/** One category's current-period spend against its complete baseline periods. */
export interface CategoryTrendFact {
  readonly categoryId: string;
  readonly categoryPath: readonly string[];
  readonly currency: string;
  readonly periodStart: LocalDate;
  readonly periodEnd: LocalDate;
  readonly currentMinor: bigint;
  /** Complete periods only — the current, partial one is never part of its own baseline. */
  readonly baseline: readonly PeriodSpend[];
  /**
   * Whether the current period has actually ended.
   *
   * The asymmetry is deliberate and is the one place these two generators disagree: a **spike** is
   * worth saying mid-period, because there is still time to act on it, while a **reduction** is not a
   * saving until the period is over — on the 3rd of the month every category is "down 90 %".
   */
  readonly periodComplete: boolean;
}

/** One transaction that might be unusual for its category. */
export interface UnusualSpendFact {
  readonly transactionId: string;
  readonly categoryId: string;
  readonly categoryPath: readonly string[];
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly occurredOn: LocalDate;
  readonly periodStart: LocalDate;
  readonly periodEnd: LocalDate;
  /** Amounts of the category's transactions in the trailing window, excluding this one. */
  readonly historyMinor: readonly bigint[];
}

/**
 * Mean of the baseline periods, counting a period with no spend as zero.
 *
 * Averaging only the months the user *did* buy would inflate the baseline and hide exactly the
 * increase worth reporting; averaging every period in the window is the honest denominator for "your
 * spending here went up".
 */
export function baselineMean(baseline: readonly PeriodSpend[]): bigint {
  if (baseline.length === 0) return 0n;
  const total = baseline.reduce((sum, period) => sum + period.spentMinor, 0n);
  return total / BigInt(baseline.length);
}

/** How many baseline periods actually carry spend. */
export function periodsWithSpend(baseline: readonly PeriodSpend[]): number {
  return baseline.filter((period) => period.spentMinor > 0n).length;
}

/**
 * The median of a list of amounts.
 *
 * An even-length list returns the **lower** of the two middle values rather than their mean: the mean
 * of two `bigint`s can be fractional, and rounding it in the money path is how a "typical amount"
 * stops being a figure the user can point at. Lower is also the conservative side for an unusual-spend
 * test, which is the side that produces fewer false alarms.
 */
export function medianMinor(values: readonly bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const middle = Math.floor((sorted.length - 1) / 2);
  return sorted[middle] ?? 0n;
}

/**
 * A budget whose **projection** breaches its limit.
 *
 * Uses the same linear pace as F-21's projection (docs/03 `projectMonthEnd`), and refuses to speak
 * before `MIN_PACE_DAYS`: on the 2nd of the month a single grocery run projects a catastrophe, and an
 * insight that cries wolf in week one is one nobody reads in week three.
 */
export function budgetPaceInsights(facts: readonly BudgetPaceFact[]): readonly InsightDraft[] {
  return facts.flatMap((fact) => {
    if (fact.daysElapsed < 1 || fact.daysInMonth < 1) return [];
    if (fact.limitMinor <= 0n) return [];

    // The **existing** F-21 calculator, not a second copy of its arithmetic: a projection that
    // disagreed with the dashboard's would be two numbers for one question (ADR-001).
    const currency = fact.currency as CurrencyCode;
    const projection = projectMonthEnd(
      {
        spent: balance(fact.spentMinor, currency),
        committed: balance(fact.committedMinor, currency),
        daysElapsed: fact.daysElapsed,
        daysInMonth: fact.daysInMonth,
      },
      balance(fact.limitMinor, currency),
    );
    // Before MIN_PACE_DAYS a single shopping trip projects a catastrophe; the generator is silent
    // rather than clever. (The projection is still returned to other callers — docs/01 F-21 labels it
    // low-confidence instead of hiding it.)
    if (!projection.paceIsReliable) return [];

    const overrunMinor = projection.projectedOverrun?.amountMinor ?? 0n;
    if (overrunMinor <= 0n) return [];
    const projectedTotalMinor = projection.projectedTotal.amountMinor;

    const overrunRatio = Number(overrunMinor) / Number(fact.limitMinor);
    const severity: InsightSeverity =
      overrunRatio >= INSIGHT_THRESHOLDS.paceCriticalOverrunRatio ? 'CRITICAL' : 'WARNING';

    return [
      {
        kind: 'BUDGET_PACE' as const,
        severity,
        periodStart: fact.periodStart,
        periodEnd: fact.periodEnd,
        payload: {
          budgetId: fact.budgetId,
          categoryId: fact.categoryId,
          categoryPath: fact.categoryPath === null ? null : fact.categoryPath.join(' / '),
          currency: fact.currency,
          limitMinor: fact.limitMinor.toString(),
          spentMinor: fact.spentMinor.toString(),
          committedMinor: fact.committedMinor.toString(),
          projectedTotalMinor: projectedTotalMinor.toString(),
          projectedOverrunMinor: overrunMinor.toString(),
          overrunRatio: Number(overrunRatio.toFixed(4)),
          daysElapsed: fact.daysElapsed,
          daysInMonth: fact.daysInMonth,
        },
        dedupeKey: `BUDGET_PACE:${fact.periodStart}:${fact.budgetId}`,
      },
    ];
  });
}

/**
 * A category whose current-period spend is well above its own recent baseline.
 *
 * The baseline is a mean over **complete** periods, and the current period is never part of it. Two of
 * the window's periods must carry spend, so a category bought once is not reported as "up 400 %".
 */
export function categorySpikeInsights(facts: readonly CategoryTrendFact[]): readonly InsightDraft[] {
  return facts.flatMap((fact) => {
    const mean = baselineMean(fact.baseline);
    if (mean <= 0n) return [];
    if (periodsWithSpend(fact.baseline) < INSIGHT_THRESHOLDS.minBaselinePeriods) return [];
    if (fact.currentMinor - mean < INSIGHT_THRESHOLDS.spikeMinDeltaMinor) return [];

    const multiple = Number(fact.currentMinor) / Number(mean);
    if (multiple < INSIGHT_THRESHOLDS.spikeRatio) return [];

    const severity: InsightSeverity =
      multiple >= INSIGHT_THRESHOLDS.spikeCriticalRatio ? 'CRITICAL' : 'WARNING';

    return [
      {
        kind: 'CATEGORY_SPIKE' as const,
        severity,
        periodStart: fact.periodStart,
        periodEnd: fact.periodEnd,
        payload: {
          categoryId: fact.categoryId,
          categoryPath: fact.categoryPath.join(' / '),
          currency: fact.currency,
          currentMinor: fact.currentMinor.toString(),
          baselineMeanMinor: mean.toString(),
          increaseMinor: (fact.currentMinor - mean).toString(),
          multiple: Number(multiple.toFixed(3)),
          baselinePeriods: fact.baseline.length,
          baselinePeriodsWithSpend: periodsWithSpend(fact.baseline),
        },
        dedupeKey: `CATEGORY_SPIKE:${fact.periodStart}:${fact.categoryId}`,
      },
    ];
  });
}

/**
 * A single transaction far outside its category's usual amount.
 *
 * The comparison is against the **median**, not the mean: one previous large purchase would drag a
 * mean up far enough to hide the very transaction this exists to catch.
 */
export function unusualSpendInsights(facts: readonly UnusualSpendFact[]): readonly InsightDraft[] {
  return facts.flatMap((fact) => {
    if (fact.historyMinor.length < INSIGHT_THRESHOLDS.unusualMinHistory) return [];
    const median = medianMinor(fact.historyMinor);
    if (median <= 0n) return [];
    if (fact.amountMinor < INSIGHT_THRESHOLDS.unusualMinMinor) return [];

    const multiple = Number(fact.amountMinor) / Number(median);
    if (multiple < INSIGHT_THRESHOLDS.unusualRatio) return [];

    return [
      {
        kind: 'UNUSUAL_SPEND' as const,
        severity: 'WARNING' as const,
        periodStart: fact.periodStart,
        periodEnd: fact.periodEnd,
        payload: {
          transactionId: fact.transactionId,
          categoryId: fact.categoryId,
          categoryPath: fact.categoryPath.join(' / '),
          currency: fact.currency,
          amountMinor: fact.amountMinor.toString(),
          medianMinor: median.toString(),
          multiple: Number(multiple.toFixed(3)),
          historySize: fact.historyMinor.length,
          occurredOn: fact.occurredOn,
        },
        dedupeKey: `UNUSUAL_SPEND:${fact.periodStart}:${fact.transactionId}`,
      },
    ];
  });
}

/**
 * A category that came **down**, which F-22 requires the product to say out loud.
 *
 * Deliberately the mirror of the spike generator, with the same baseline rules, so the two cannot
 * disagree about what a category's "usual" month is. The payload carries what was saved, because
 * "you spent 4 200 less than usual" is the sentence that motivates; "down 32 %" is not.
 */
export function positiveTrendInsights(facts: readonly CategoryTrendFact[]): readonly InsightDraft[] {
  return facts.flatMap((fact) => {
    // A month is not a saving until it is over (see `CategoryTrendFact.periodComplete`).
    if (!fact.periodComplete) return [];
    const mean = baselineMean(fact.baseline);
    if (mean < INSIGHT_THRESHOLDS.positiveMinBaselineMinor) return [];
    if (periodsWithSpend(fact.baseline) < INSIGHT_THRESHOLDS.minBaselinePeriods) return [];
    if (fact.currentMinor >= mean) return [];

    const reduction = Number(mean - fact.currentMinor) / Number(mean);
    if (reduction < INSIGHT_THRESHOLDS.positiveReductionRatio) return [];

    return [
      {
        kind: 'POSITIVE_TREND' as const,
        severity: 'POSITIVE' as const,
        periodStart: fact.periodStart,
        periodEnd: fact.periodEnd,
        payload: {
          categoryId: fact.categoryId,
          categoryPath: fact.categoryPath.join(' / '),
          currency: fact.currency,
          currentMinor: fact.currentMinor.toString(),
          baselineMeanMinor: mean.toString(),
          savedMinor: (mean - fact.currentMinor).toString(),
          reductionRatio: Number(reduction.toFixed(4)),
          baselinePeriods: fact.baseline.length,
          baselinePeriodsWithSpend: periodsWithSpend(fact.baseline),
        },
        dedupeKey: `POSITIVE_TREND:${fact.periodStart}:${fact.categoryId}`,
      },
    ];
  });
}

/** Facts for one generation run. Every field is already loaded and summed by the caller. */
export interface InsightFacts {
  readonly budgets: readonly BudgetPaceFact[];
  readonly categories: readonly CategoryTrendFact[];
  readonly unusual: readonly UnusualSpendFact[];
}

/**
 * Run every generator, in one deterministic order.
 *
 * The order is fixed (and the output sorted) so two runs over the same facts produce byte-identical
 * payloads — which is what makes "did today's run say anything new?" a comparison instead of a diff.
 */
export function generateInsights(facts: InsightFacts): readonly InsightDraft[] {
  return [
    ...budgetPaceInsights(facts.budgets),
    ...categorySpikeInsights(facts.categories),
    ...unusualSpendInsights(facts.unusual),
    ...positiveTrendInsights(facts.categories),
  ].sort((left, right) => left.dedupeKey.localeCompare(right.dedupeKey));
}
