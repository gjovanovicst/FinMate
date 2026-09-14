import { describe, expect, it } from 'vitest';

import { budgetConsumption, projectMonthEnd, safeToSpend, sumBalances } from './budget';
import { balance } from './money';

/**
 * Hand-computed fixtures.
 *
 * This is a Phase 1 exit criterion, so the numbers below are worked out **by hand in the comments**
 * and asserted exactly. A calculator test that recomputes the formula it is testing proves nothing;
 * these state the expected figure independently.
 */
const rsd = (major: number): bigint => BigInt(Math.round(major * 100));

describe('safeToSpend — hand-computed', () => {
  it('matches the worked example from docs/01 F-19', () => {
    // Documented case: budget 120.000, spent 68.450, reserved 12.000, savings 25.000, 10 of 30 days.
    //   available     = 120.000 − 68.450 − 12.000 − 25.000 = 14.550
    //   daysRemaining = 30 − 10 + 1                         = 21
    //   per day       = floor(14.550 / 21)                  = 692,85…  → 692  (floor: never round up)
    const result = safeToSpend({
      budget: balance(rsd(120_000), 'RSD'),
      spent: balance(rsd(68_450), 'RSD'),
      reserved: balance(rsd(12_000), 'RSD'),
      savingsTarget: balance(rsd(25_000), 'RSD'),
      daysElapsed: 10,
      daysInMonth: 30,
    });

    expect(result.available.amountMinor).toBe(rsd(14_550));
    expect(result.safeToSpendToday.amountMinor).toBe(69_285n);
    expect(result.isOverspent).toBe(false);
  });

  it('divides by the whole month on day one, not by the days remaining after today', () => {
    //   available = 30.000, daysRemaining = 30 − 1 + 1 = 30, per day = 1.000
    // Dividing by 29 instead would give 1.034 and overspend the month by ~3 %.
    const result = safeToSpend({
      budget: balance(rsd(30_000), 'RSD'),
      spent: balance(0n, 'RSD'),
      reserved: balance(0n, 'RSD'),
      savingsTarget: balance(0n, 'RSD'),
      daysElapsed: 1,
      daysInMonth: 30,
    });

    expect(result.safeToSpendToday.amountMinor).toBe(rsd(1_000));
  });

  it('floors rather than rounds, so the advice never breaches the budget', () => {
    //   available = 100 (1,00 RSD), daysRemaining = 3 → 33,33 → 33
    const result = safeToSpend({
      budget: balance(100n, 'RSD'),
      spent: balance(0n, 'RSD'),
      reserved: balance(0n, 'RSD'),
      savingsTarget: balance(0n, 'RSD'),
      daysElapsed: 28,
      daysInMonth: 30,
    });

    expect(result.safeToSpendToday.amountMinor).toBe(33n);
  });

  it('returns zero — never a negative number — when the budget is already blown', () => {
    //   available = 100.000 − 130.000 = −30.000
    const result = safeToSpend({
      budget: balance(rsd(100_000), 'RSD'),
      spent: balance(rsd(130_000), 'RSD'),
      reserved: balance(0n, 'RSD'),
      savingsTarget: balance(0n, 'RSD'),
      daysElapsed: 15,
      daysInMonth: 30,
    });

    expect(result.safeToSpendToday.amountMinor).toBe(0n);
    expect(result.available.amountMinor).toBe(-rsd(30_000));
    expect(result.isOverspent).toBe(true);
  });

  it('subtracts reserved and savings BEFORE dividing', () => {
    // Committed money is not spendable. Dividing first would imply it is.
    //   available = 10.000 − 0 − 5.000 − 0 = 5.000; daysRemaining = 10 → 500/day
    // (dividing 10.000 first would give 1.000/day and consume the reserved 5.000)
    const withReserved = safeToSpend({
      budget: balance(rsd(10_000), 'RSD'),
      spent: balance(0n, 'RSD'),
      reserved: balance(rsd(5_000), 'RSD'),
      savingsTarget: balance(0n, 'RSD'),
      daysElapsed: 21,
      daysInMonth: 30,
    });

    expect(withReserved.safeToSpendToday.amountMinor).toBe(rsd(500));
  });

  it('echoes every input back, so the figure is auditable', () => {
    const input = {
      budget: balance(rsd(1_000), 'RSD'),
      spent: balance(rsd(100), 'RSD'),
      reserved: balance(rsd(50), 'RSD'),
      savingsTarget: balance(rsd(25), 'RSD'),
      daysElapsed: 5,
      daysInMonth: 30,
    };
    expect(safeToSpend(input).inputs).toEqual(input);
  });

  it('never divides by zero, even with nonsensical day counts', () => {
    expect(() =>
      safeToSpend({
        budget: balance(rsd(1_000), 'RSD'),
        spent: balance(0n, 'RSD'),
        reserved: balance(0n, 'RSD'),
        savingsTarget: balance(0n, 'RSD'),
        daysElapsed: 0,
        daysInMonth: 30,
      }),
    ).not.toThrow();

    expect(() =>
      safeToSpend({
        budget: balance(rsd(1_000), 'RSD'),
        spent: balance(0n, 'RSD'),
        reserved: balance(0n, 'RSD'),
        savingsTarget: balance(0n, 'RSD'),
        daysElapsed: 31,
        daysInMonth: 30,
      }),
    ).not.toThrow();
  });
});

describe('projectMonthEnd — hand-computed', () => {
  it('flags a projection from too few days as unreliable', () => {
    const early = projectMonthEnd({
      spent: balance(rsd(3_000), 'RSD'),
      committed: balance(0n, 'RSD'),
      daysElapsed: 1,
      daysInMonth: 30,
    });
    expect(early.paceIsReliable).toBe(false);

    const later = projectMonthEnd({
      spent: balance(rsd(48_000), 'RSD'),
      committed: balance(0n, 'RSD'),
      daysElapsed: 10,
      daysInMonth: 30,
    });
    expect(later.paceIsReliable).toBe(true);
  });

  it('matches the worked example from docs/04 §4', () => {
    // Documented case: spent 48.000 by day 10 of 30.
    //   pace           = floor(48.000 / 10) = 4.800/day
    //   daysRemaining  = 30 − 10 = 20
    //   projected      = 48.000 + 4.800 × 20 = 144.000
    const result = projectMonthEnd({
      spent: balance(rsd(48_000), 'RSD'),
      committed: balance(0n, 'RSD'),
      daysElapsed: 10,
      daysInMonth: 30,
    });

    expect(result.dailyPace.amountMinor).toBe(rsd(4_800));
    expect(result.projectedTotal.amountMinor).toBe(rsd(144_000));
  });

  it('reports the overrun against a budget', () => {
    //   budget 120.000, projected 144.000 → overrun 24.000 (docs/04 §4's warning)
    const result = projectMonthEnd(
      {
        spent: balance(rsd(48_000), 'RSD'),
        committed: balance(0n, 'RSD'),
        daysElapsed: 10,
        daysInMonth: 30,
      },
      balance(rsd(120_000), 'RSD'),
    );

    expect(result.projectedOverrun?.amountMinor).toBe(rsd(24_000));
  });

  it('adds known committed charges on top of the observed pace', () => {
    // A subscription still due this month is a KNOWN future event; the pace is observed behaviour.
    //   pace = 4.800; projected = 48.000 + 4.800×20 + 1.299 = 145.299
    const result = projectMonthEnd({
      spent: balance(rsd(48_000), 'RSD'),
      committed: balance(rsd(1_299), 'RSD'),
      daysElapsed: 10,
      daysInMonth: 30,
    });

    expect(result.projectedTotal.amountMinor).toBe(rsd(145_299));
  });

  it('projects the spend itself when the month is already over', () => {
    const result = projectMonthEnd({
      spent: balance(rsd(50_000), 'RSD'),
      committed: balance(0n, 'RSD'),
      daysElapsed: 31,
      daysInMonth: 31,
    });

    expect(result.projectedTotal.amountMinor).toBe(rsd(50_000));
  });

  it('refuses a zero day count instead of dividing by zero', () => {
    expect(() =>
      projectMonthEnd({
        spent: balance(0n, 'RSD'),
        committed: balance(0n, 'RSD'),
        daysElapsed: 0,
        daysInMonth: 30,
      }),
    ).toThrow(/at least 1/);
  });

  it('returns no overrun when no budget is supplied', () => {
    const result = projectMonthEnd({
      spent: balance(rsd(1_000), 'RSD'),
      committed: balance(0n, 'RSD'),
      daysElapsed: 1,
      daysInMonth: 30,
    });
    expect(result.projectedOverrun).toBeNull();
  });
});

describe('budgetConsumption — hand-computed', () => {
  it('computes remaining and both ratios', () => {
    //   spent 24.000 of 30.000 → remaining 6.000; used 0.80; elapsed 20/30 = 0.667
    //   ahead of pace because 0.80 > 0.667 + 0.05
    const result = budgetConsumption({
      budget: balance(rsd(30_000), 'RSD'),
      spent: balance(rsd(24_000), 'RSD'),
      daysElapsed: 20,
      daysInMonth: 30,
    });

    expect(result.remaining.amountMinor).toBe(rsd(6_000));
    expect(result.usedRatio).toBeCloseTo(0.8, 10);
    expect(result.elapsedRatio).toBeCloseTo(2 / 3, 10);
    expect(result.isAheadOfPace).toBe(true);
    expect(result.isOverspent).toBe(false);
  });

  it('reports an overspend as a negative remainder', () => {
    const result = budgetConsumption({
      budget: balance(rsd(30_000), 'RSD'),
      spent: balance(rsd(31_500), 'RSD'),
      daysElapsed: 30,
      daysInMonth: 30,
    });

    expect(result.remaining.amountMinor).toBe(-rsd(1_500));
    expect(result.isOverspent).toBe(true);
  });

  it('does not cry "ahead of pace" from a single early purchase', () => {
    // Spending 10 % of the budget on day 1 is one grocery run. Mathematically it is 3x the daily
    // pace; practically it is noise, and a warning here teaches the user to ignore warnings.
    const result = budgetConsumption({
      budget: balance(rsd(30_000), 'RSD'),
      spent: balance(rsd(3_000), 'RSD'),
      daysElapsed: 1,
      daysInMonth: 30,
    });

    expect(result.isAheadOfPace).toBe(false);
    expect(result.paceIsReliable).toBe(false);
  });

  it('starts judging pace once there is enough signal', () => {
    // Same spend, but five days in: 10 % used with 17 % elapsed is behind, not ahead.
    const result = budgetConsumption({
      budget: balance(rsd(30_000), 'RSD'),
      spent: balance(rsd(3_000), 'RSD'),
      daysElapsed: 5,
      daysInMonth: 30,
    });

    expect(result.paceIsReliable).toBe(true);
    expect(result.isAheadOfPace).toBe(false);
  });

  it('refuses a zero budget rather than producing Infinity', () => {
    expect(() =>
      budgetConsumption({
        budget: balance(0n, 'RSD'),
        spent: balance(0n, 'RSD'),
        daysElapsed: 1,
        daysInMonth: 30,
      }),
    ).toThrow(/greater than zero/);
  });
});

describe('sumBalances', () => {
  it('adds signed balances', () => {
    expect(
      sumBalances([balance(100n, 'RSD'), balance(-30n, 'RSD'), balance(5n, 'RSD')], 'RSD').amountMinor,
    ).toBe(75n);
  });

  it('returns zero for an empty list', () => {
    expect(sumBalances([], 'RSD').amountMinor).toBe(0n);
  });
});
