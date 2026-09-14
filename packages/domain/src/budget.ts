import { balance, zeroBalance, type Balance } from './money';

/**
 * Deterministic budget calculators.
 *
 * Every figure here is computed in the backend, in integer minor units, and **never by a language
 * model** (ADR-001). These are the numbers a user makes decisions with, so they are pure functions
 * with no I/O: the same inputs always produce the same output, and every input is returned alongside
 * the result so the figure is auditable rather than magic.
 *
 * Division is the only place money can leak precision, so all of it floors and the remainder is
 * reported rather than hidden.
 *
 * @module @finmate/domain
 */

export interface SafeToSpendInput {
  /** The monthly budget for the scope in question (whole Household, or one category subtree). */
  readonly budget: Balance;
  /** Confirmed spend so far in the period. PENDING rows must already be excluded (invariant I-7). */
  readonly spent: Balance;
  /** Recurring obligations still expected before the period ends. */
  readonly reserved: Balance;
  /** What the Household still wants to put aside this period. */
  readonly savingsTarget: Balance;
  readonly daysElapsed: number;
  readonly daysInMonth: number;
}

export interface SafeToSpendResult {
  /** What can be spent today without breaching the budget. Never negative — zero means "nothing". */
  readonly safeToSpendToday: Balance;
  /** budget − spent − reserved − savingsTarget. **May be negative**, which is the overspend. */
  readonly available: Balance;
  readonly isOverspent: boolean;
  /** Every input, echoed back so the UI can show its working (docs/01 F-19 acceptance criteria). */
  readonly inputs: SafeToSpendInput;
}

/**
 * How much can be spent today without breaching the budget.
 *
 * The arithmetic, stated so it can be checked by hand:
 *
 * ```
 * available      = budget − spent − reserved − savingsTarget
 * daysRemaining  = daysInMonth − daysElapsed + 1
 * safeToSpend    = max(0, floor(available / daysRemaining))
 * ```
 *
 * `daysElapsed` counts **today** as elapsed, so on the 1st of a 30-day month `daysRemaining` is 30,
 * not 29. That off-by-one changes the daily figure by ~3 %, which is the difference between advice
 * that works and advice that quietly overspends.
 *
 * Reserved and savingsTarget are subtracted before dividing, not after: money already promised to a
 * subscription or a savings goal is not available to spend, and dividing first would imply it is.
 */
export function safeToSpend(input: SafeToSpendInput): SafeToSpendResult {
  const { budget, spent, reserved, savingsTarget } = input;

  if (input.daysInMonth < 1) throw new Error('daysInMonth must be at least 1.');
  if (input.daysElapsed < 0) throw new Error('daysElapsed cannot be negative.');

  const availableMinor =
    budget.amountMinor - spent.amountMinor - reserved.amountMinor - savingsTarget.amountMinor;

  const daysRemaining = Math.max(1, input.daysInMonth - input.daysElapsed + 1);

  // Floor, never round: telling someone they can spend 501 RSD when the true figure is 500.90 is
  // advice that breaches the budget.
  const perDay = availableMinor > 0n ? availableMinor / BigInt(daysRemaining) : 0n;

  return {
    safeToSpendToday: balance(perDay, budget.currency),
    available: balance(availableMinor, budget.currency),
    isOverspent: availableMinor < 0n,
    inputs: input,
  };
}

export interface MonthProjectionInput {
  readonly spent: Balance;
  /** Recurring charges still due before the month ends, if known. */
  readonly committed: Balance;
  readonly daysElapsed: number;
  readonly daysInMonth: number;
}

export interface MonthProjectionResult {
  /** spent + pace over the remaining days + known committed charges. */
  readonly projectedTotal: Balance;
  /** The projection minus the budget, when a budget is supplied. Null without one. */
  readonly projectedOverrun: Balance | null;
  /** Average confirmed spend per elapsed day, floored. */
  readonly dailyPace: Balance;
  /**
   * False before {@link MIN_PACE_DAYS} have elapsed. The projection is still computed — the caller
   * may show it — but the UI must label it as low confidence rather than presenting a straight line
   * extrapolated from one shopping trip as a forecast.
   */
  readonly paceIsReliable: boolean;
  readonly inputs: MonthProjectionInput;
}

/**
 * Project the month-end total and, when a budget is given, the overrun.
 *
 * ```
 * dailyPace      = floor(spent / daysElapsed)
 * projectedTotal = spent + dailyPace × daysRemaining + committed
 * ```
 *
 * `committed` is added on top of the pace rather than instead of it, because the pace is observed
 * behaviour and the committed charges are *known future* events. Subtracting one from the other
 * would double-count a subscription that has already been paid — which is why the caller passes only
 * what is genuinely still due.
 *
 * Deliberately linear. A seasonal curve would be more accurate with months of history and less
 * honest with two weeks of it, and a projection the user cannot reproduce by hand is one they will
 * not trust.
 */
export function projectMonthEnd(
  input: MonthProjectionInput,
  budget?: Balance,
): MonthProjectionResult {
  if (input.daysInMonth < 1) throw new Error('daysInMonth must be at least 1.');
  if (input.daysElapsed < 1) throw new Error('daysElapsed must be at least 1.');

  const daysRemaining = Math.max(0, input.daysInMonth - input.daysElapsed);

  // daysElapsed is guaranteed ≥ 1 above, so this cannot divide by zero — the reason for that guard.
  const dailyPaceMinor = input.spent.amountMinor / BigInt(input.daysElapsed);
  const projectedMinor =
    input.spent.amountMinor +
    dailyPaceMinor * BigInt(daysRemaining) +
    input.committed.amountMinor;

  return {
    projectedTotal: balance(projectedMinor, input.spent.currency),
    projectedOverrun: budget ? balance(projectedMinor - budget.amountMinor, input.spent.currency) : null,
    dailyPace: balance(dailyPaceMinor, input.spent.currency),
    paceIsReliable: input.daysElapsed >= MIN_PACE_DAYS,
    inputs: input,
  };
}

/**
 * Days that must have elapsed before a pace judgement means anything.
 *
 * Without this, a single grocery run on the 1st reads as "3× your usual pace" — technically true and
 * completely useless. Worse, it teaches the user to ignore the warning, and an ignored warning is a
 * warning that will not be read on the day it matters (docs/14 risk R-02).
 */
export const MIN_PACE_DAYS = 5;

export interface BudgetConsumptionInput {
  readonly budget: Balance;
  readonly spent: Balance;
  readonly daysElapsed: number;
  readonly daysInMonth: number;
}

export interface BudgetConsumptionResult {
  readonly spent: Balance;
  readonly remaining: Balance;
  /** 0–1, clamped. Above 1 only when overspent, and then `isOverspent` is true. */
  readonly usedRatio: number;
  /**
   * The share of the period that has elapsed. Comparing it with `usedRatio` is what turns "82 % of
   * budget used" into the more useful "82 % used with 60 % of the month gone".
   */
  readonly elapsedRatio: number;
  readonly isOverspent: boolean;
  /**
   * True when spend is meaningfully ahead of the elapsed fraction. **Always false before
   * {@link MIN_PACE_DAYS} have elapsed**, because there is not yet enough signal.
   */
  readonly isAheadOfPace: boolean;
  /** False early in the period: the UI should say "not enough data yet" rather than warn. */
  readonly paceIsReliable: boolean;
}

/** Consumption of a Budget: how much is used, how much remains, and whether that is on pace. */
export function budgetConsumption(input: BudgetConsumptionInput): BudgetConsumptionResult {
  if (input.budget.amountMinor <= 0n) {
    throw new Error('A budget must be greater than zero.');
  }
  if (input.daysInMonth < 1) throw new Error('daysInMonth must be at least 1.');

  const remainingMinor = input.budget.amountMinor - input.spent.amountMinor;
  const usedRatio = Number(input.spent.amountMinor) / Number(input.budget.amountMinor);
  const elapsedRatio = input.daysElapsed / input.daysInMonth;
  const paceIsReliable = input.daysElapsed >= MIN_PACE_DAYS;

  return {
    spent: input.spent,
    remaining: balance(remainingMinor, input.budget.currency),
    usedRatio,
    elapsedRatio,
    isOverspent: remainingMinor < 0n,
    paceIsReliable,
    // A small tolerance absorbs a normal early purchase; the reliability gate absorbs the first
    // few days entirely, where the ratio is mathematically true and practically meaningless.
    isAheadOfPace: paceIsReliable && usedRatio > elapsedRatio + 0.05,
  };
}

/** Sum a list of same-currency balances. The zero case needs the currency supplied. */
export function sumBalances(values: readonly Balance[], currency: string): Balance {
  return values.reduce((total, value) => balance(total.amountMinor + value.amountMinor, currency), zeroBalance(currency));
}
