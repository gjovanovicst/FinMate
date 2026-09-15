import { monthPeriod, type LocalDate } from './dates';

/**
 * Saving-goal calculators — docs/01 F-18, docs/03 §6, docs/02 §4.13.
 *
 * Pure and deterministic, like every other calculator here (ADR-001). Three things live in this file
 * because each is **silent when wrong**:
 *
 * 1. **The required monthly amount.** `(target − contributed) / months remaining`, computed in
 *    `bigint` minor units with a **ceiling**, never a float and never a truncating division: a plan
 *    that rounds down leaves the goal a few hundred dinars short at the deadline, which the user only
 *    discovers on the day it matters.
 * 2. **"Months remaining" is a calendar question, not a duration.** It is the number of month
 *    boundaries between the current month and the target month, so a goal due on the 1st of next
 *    month has **one** month to save, not 0.9 — and it does not move with the day of the month the
 *    user happens to open the screen on.
 * 3. **An overdue goal is not an empty one.** A target date in the past with money still missing
 *    yields `monthsRemaining: 0` and a required amount equal to the whole remainder, rather than
 *    `null` (which would hide the problem) or a division by zero.
 *
 * **A contribution is not a Transaction.** Goal progress is the sum of `goal_contributions`
 * (docs/02 §4.13 states it once inline to prevent double-counting confusion); nothing here reads the
 * ledger, and nothing here writes to it.
 *
 * @module @finmate/domain
 */

/** docs/06 §4.3's `GoalStatus`. */
export type GoalStatus = 'ACTIVE' | 'ACHIEVED' | 'ARCHIVED';

export const GOAL_STATUSES: readonly GoalStatus[] = ['ACTIVE', 'ACHIEVED', 'ARCHIVED'];

export interface GoalProgressInput {
  readonly targetMinor: bigint;
  /** Σ `goal_contributions.amount_minor`. Never negative — the column has a CHECK. */
  readonly contributedMinor: bigint;
  /** The day the money is wanted by, or `null` for a goal with no deadline. */
  readonly targetDate: LocalDate | null;
  /** Today in the Household's own timezone (I-2), never the server's UTC day. */
  readonly today: LocalDate;
}

export interface GoalProgress {
  readonly targetMinor: bigint;
  readonly contributedMinor: bigint;
  /** `max(0, target − contributed)`: an over-funded goal is not in debt. */
  readonly remainingMinor: bigint;
  /** 0…1, **capped**: progress is a display ratio and a bar cannot be 140 % full. */
  readonly progress: number;
  readonly isAchieved: boolean;
  /** Whole months to the target month; `0` means "by the end of this month, or already past". */
  readonly monthsRemaining: number | null;
  /**
   * What has to be put aside each month from now on. `null` only when there is no target date; when
   * the date has passed it is the whole remainder, because that is what is actually needed.
   */
  readonly requiredPerMonthMinor: bigint | null;
}

/** Whole calendar months from `today`'s month to `targetDate`'s month; `0` when that is not later. */
export function monthsUntil(today: LocalDate, targetDate: LocalDate): number {
  const from = monthPeriod(today).start;
  const to = monthPeriod(targetDate).start;
  const months =
    (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
    (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
  return months > 0 ? months : 0;
}

/**
 * `ceil(numerator / denominator)` in `bigint`.
 *
 * The ceiling is the point (see the module note). `denominator: 0` returns the numerator: with no
 * months left, everything that is still missing is due now.
 */
export function ceilDiv(numerator: bigint, denominator: number): bigint {
  if (denominator <= 0) return numerator;
  const divisor = BigInt(denominator);
  return (numerator + divisor - 1n) / divisor;
}

export function goalProgress(input: GoalProgressInput): GoalProgress {
  const remainingMinor =
    input.targetMinor > input.contributedMinor ? input.targetMinor - input.contributedMinor : 0n;
  const isAchieved = input.contributedMinor >= input.targetMinor;

  const monthsRemaining =
    input.targetDate === null ? null : monthsUntil(input.today, input.targetDate);

  return {
    targetMinor: input.targetMinor,
    contributedMinor: input.contributedMinor,
    remainingMinor,
    progress:
      input.targetMinor > 0n
        ? Math.min(1, Number(input.contributedMinor) / Number(input.targetMinor))
        : 0,
    isAchieved,
    monthsRemaining,
    requiredPerMonthMinor:
      monthsRemaining === null ? null : ceilDiv(remainingMinor, monthsRemaining),
  };
}

/**
 * The stored status a goal should have, given its contributions.
 *
 * `ACHIEVED` is **derived**, so it is recomputed on every write that can change it (a contribution,
 * a deleted contribution, a changed target) rather than being a flag somebody sets once — that is why
 * deleting the contribution that crossed the target puts a goal back to `ACTIVE` instead of leaving
 * it "achieved" with 0 % progress on screen.
 *
 * `ARCHIVED` is the one status a **person** chooses, and this function never overrides it: an
 * archived goal stays archived even when more money goes in (which is also why archiving is the way to
 * stop tracking a goal without losing its history).
 */
export function reconcileGoalStatus(
  current: GoalStatus,
  contributedMinor: bigint,
  targetMinor: bigint,
): GoalStatus {
  if (current === 'ARCHIVED') return 'ARCHIVED';
  return contributedMinor >= targetMinor ? 'ACHIEVED' : 'ACTIVE';
}
