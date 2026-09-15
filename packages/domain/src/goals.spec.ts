import { describe, expect, it } from 'vitest';

import type { LocalDate } from './dates';
import {
  GOAL_STATUSES,
  ceilDiv,
  goalProgress,
  monthsUntil,
  reconcileGoalStatus,
} from './goals';

/**
 * The saving-goal calculators.
 *
 * The three that are wrong silently: a division that truncates (the goal lands short on the day it
 * matters), a "months remaining" that moves with the day of the month, and an overdue goal that
 * reports *no basis* instead of the money it still needs.
 */

const day = (value: string) => value as LocalDate;

const progress = (input: Partial<Parameters<typeof goalProgress>[0]> = {}) =>
  goalProgress({
    targetMinor: 12_000_000n,
    contributedMinor: 2_100_000n,
    targetDate: day('2027-06-01'),
    today: day('2026-09-15'),
    ...input,
  });

describe('monthsUntil', () => {
  it('counts calendar months, not weeks or days', () => {
    // September → June is nine month boundaries: October..June.
    expect(monthsUntil(day('2026-09-15'), day('2027-06-01'))).toBe(9);
    expect(monthsUntil(day('2026-09-01'), day('2027-06-30'))).toBe(9);
    // The day of the month is deliberately irrelevant: a deadline on the 30th is not one month
    // further away than a deadline on the 1st.
    expect(monthsUntil(day('2026-09-30'), day('2026-10-01'))).toBe(1);
    expect(monthsUntil(day('2026-09-01'), day('2026-09-30'))).toBe(0);
  });

  it('is zero for a target in the past or in this month', () => {
    expect(monthsUntil(day('2026-09-15'), day('2026-09-20'))).toBe(0);
    expect(monthsUntil(day('2026-09-15'), day('2026-01-01'))).toBe(0);
  });

  it('crosses a year boundary', () => {
    expect(monthsUntil(day('2026-12-31'), day('2027-01-01'))).toBe(1);
    expect(monthsUntil(day('2026-01-31'), day('2027-01-01'))).toBe(12);
  });
});

describe('ceilDiv', () => {
  it('rounds up, so a plan always reaches the target', () => {
    expect(ceilDiv(9_900_000n, 9)).toBe(1_100_000n);
    expect(ceilDiv(100n, 3)).toBe(34n);
    expect(ceilDiv(99n, 3)).toBe(33n);
    expect(ceilDiv(0n, 5)).toBe(0n);
  });

  it('returns the whole amount when there are no months left', () => {
    expect(ceilDiv(500n, 0)).toBe(500n);
  });
});

describe('goalProgress', () => {
  it('reports the remainder, the capped ratio and the monthly amount', () => {
    const result = progress();

    expect(result.remainingMinor).toBe(9_900_000n);
    expect(result.progress).toBeCloseTo(0.175, 10);
    expect(result.isAchieved).toBe(false);
    expect(result.monthsRemaining).toBe(9);
    // 99.000 / 9 = 11.000 exactly; the ceiling makes it 11.000 rather than 10.999,99.
    expect(result.requiredPerMonthMinor).toBe(1_100_000n);
  });

  it('has no rate at all without a target date, and says so rather than inventing one', () => {
    const result = progress({ targetDate: null });

    expect(result.monthsRemaining).toBeNull();
    expect(result.requiredPerMonthMinor).toBeNull();
    // Progress itself still works: a goal without a deadline still has a distance travelled.
    expect(result.progress).toBeCloseTo(0.175, 10);
  });

  it('asks for the whole remainder once the date has passed', () => {
    const result = progress({ targetDate: day('2026-08-01') });

    expect(result.monthsRemaining).toBe(0);
    expect(result.requiredPerMonthMinor).toBe(9_900_000n);
  });

  it('caps the ratio and never reports a negative remainder when over-funded', () => {
    const result = progress({ contributedMinor: 15_000_000n });

    expect(result.remainingMinor).toBe(0n);
    expect(result.progress).toBe(1);
    expect(result.isAchieved).toBe(true);
    expect(result.requiredPerMonthMinor).toBe(0n);
  });

  it('treats exactly-on-target as achieved', () => {
    const result = progress({ contributedMinor: 12_000_000n });

    expect(result.isAchieved).toBe(true);
    expect(result.remainingMinor).toBe(0n);
    expect(result.progress).toBe(1);
  });

  it('handles a goal with no contributions yet', () => {
    const result = progress({ contributedMinor: 0n, targetDate: day('2027-03-01') });

    expect(result.monthsRemaining).toBe(6);
    expect(result.requiredPerMonthMinor).toBe(2_000_000n);
    expect(result.progress).toBe(0);
  });
});

describe('reconcileGoalStatus', () => {
  it('marks a goal achieved when the contributions reach the target', () => {
    expect(reconcileGoalStatus('ACTIVE', 12_000_000n, 12_000_000n)).toBe('ACHIEVED');
    expect(reconcileGoalStatus('ACTIVE', 11_999_999n, 12_000_000n)).toBe('ACTIVE');
  });

  it('puts it back when the crossing contribution is deleted', () => {
    expect(reconcileGoalStatus('ACHIEVED', 2_000_000n, 12_000_000n)).toBe('ACTIVE');
  });

  it('never overrides the status a person chose', () => {
    expect(reconcileGoalStatus('ARCHIVED', 99_000_000n, 12_000_000n)).toBe('ARCHIVED');
    expect(reconcileGoalStatus('ARCHIVED', 0n, 12_000_000n)).toBe('ARCHIVED');
  });

  it('exposes exactly the three statuses docs/06 declares', () => {
    expect([...GOAL_STATUSES]).toEqual(['ACTIVE', 'ACHIEVED', 'ARCHIVED']);
  });
});
