import { describe, expect, it } from 'vitest';

import {
  baselineMean,
  budgetPaceInsights,
  categorySpikeInsights,
  generateInsights,
  medianMinor,
  periodsWithSpend,
  positiveTrendInsights,
  unusualSpendInsights,
  INSIGHT_THRESHOLDS,
  type BudgetPaceFact,
  type CategoryTrendFact,
  type UnusualSpendFact,
} from './insights';
import type { LocalDate } from './dates';

/**
 * The generators decide what the product tells a user about their own money, so every threshold is
 * asserted **on both sides** of the boundary. A test that only checks the firing case cannot tell a
 * threshold from a typo, and both failures are silent in production: one spams the feed, the other
 * never speaks.
 */

const period = (start: string): { periodStart: LocalDate; periodEnd: LocalDate } => ({
  periodStart: start as LocalDate,
  periodEnd: '2026-09-30' as LocalDate,
});

function budgetFact(overrides: Partial<BudgetPaceFact> = {}): BudgetPaceFact {
  return {
    budgetId: 'budget-1',
    categoryId: null,
    categoryPath: null,
    currency: 'RSD',
    limitMinor: 100_000n,
    spentMinor: 0n,
    committedMinor: 0n,
    daysElapsed: 15,
    daysInMonth: 30,
    ...period('2026-09-01'),
    ...overrides,
  };
}

function trendFact(overrides: Partial<CategoryTrendFact> = {}): CategoryTrendFact {
  return {
    categoryId: 'cat-food',
    categoryPath: ['Hrana', 'Supermarket'],
    currency: 'RSD',
    currentMinor: 0n,
    baseline: [
      { periodStart: '2026-06-01' as LocalDate, spentMinor: 10_000n },
      { periodStart: '2026-07-01' as LocalDate, spentMinor: 10_000n },
      { periodStart: '2026-08-01' as LocalDate, spentMinor: 10_000n },
    ],
    ...period('2026-09-01'),
    ...overrides,
  };
}

function unusualFact(overrides: Partial<UnusualSpendFact> = {}): UnusualSpendFact {
  return {
    transactionId: 'tx-1',
    categoryId: 'cat-food',
    categoryPath: ['Hrana', 'Supermarket'],
    currency: 'RSD',
    amountMinor: 100_000n,
    occurredOn: '2026-09-14' as LocalDate,
    historyMinor: [10_000n, 10_000n, 10_000n, 10_000n, 10_000n],
    ...period('2026-09-01'),
    ...overrides,
  };
}

describe('medianMinor', () => {
  it('takes the lower middle value for an even list, because the mean can be fractional', () => {
    expect(medianMinor([])).toBe(0n);
    expect(medianMinor([7n])).toBe(7n);
    expect(medianMinor([1n, 3n, 2n])).toBe(2n);
    // The two middles are 2 and 3: the lower one, never 2.5 rounded in the money path (ADR-003).
    expect(medianMinor([4n, 2n, 1n, 3n])).toBe(2n);
  });
});

describe('baselineMean and periodsWithSpend', () => {
  it('counts an empty period as a zero month, so the baseline is not inflated', () => {
    expect(baselineMean([])).toBe(0n);
    expect(
      baselineMean([
        { periodStart: '2026-07-01' as LocalDate, spentMinor: 30_000n },
        { periodStart: '2026-08-01' as LocalDate, spentMinor: 0n },
      ]),
    ).toBe(15_000n);
    expect(
      periodsWithSpend([
        { periodStart: '2026-07-01' as LocalDate, spentMinor: 30_000n },
        { periodStart: '2026-08-01' as LocalDate, spentMinor: 0n },
      ]),
    ).toBe(1);
  });
});

describe('budgetPaceInsights', () => {
  it('stays silent while the pace is unreliable, however dramatic the projection', () => {
    // 4 days elapsed is under MIN_PACE_DAYS: two shopping trips extrapolate to a catastrophe.
    expect(budgetPaceInsights([budgetFact({ daysElapsed: 4, spentMinor: 90_000n })])).toEqual([]);
  });

  it('stays silent when the projection stays inside the limit', () => {
    // 300 per day over 30 days = 9 000 < 100 000.
    expect(budgetPaceInsights([budgetFact({ spentMinor: 4_500n, daysElapsed: 15 })])).toEqual([]);
  });

  it('warns on a small projected overrun and turns CRITICAL at 20 % of the limit', () => {
    // Pace 400/day -> 12 000 projected on a 10 000 limit: overrun 2 000 = 20 % exactly.
    const at = budgetPaceInsights([
      budgetFact({ limitMinor: 10_000n, spentMinor: 6_000n, daysElapsed: 15, daysInMonth: 30 }),
    ]);
    expect(at).toHaveLength(1);
    expect(at[0]?.severity).toBe('CRITICAL');
    expect(at[0]?.payload['projectedOverrunMinor']).toBe('2000');
    expect(at[0]?.dedupeKey).toBe('BUDGET_PACE:2026-09-01:budget-1');

    // One unit below the boundary is a warning, not a critical.
    const below = budgetPaceInsights([
      budgetFact({ limitMinor: 100_000n, spentMinor: 59_000n, daysElapsed: 15, daysInMonth: 30 }),
    ]);
    expect(below[0]?.severity).toBe('WARNING');
  });

  it('counts committed charges, which is what makes the projection honest', () => {
    const without = budgetPaceInsights([
      budgetFact({ limitMinor: 100_000n, spentMinor: 30_000n, daysElapsed: 15, daysInMonth: 30 }),
    ]);
    expect(without).toEqual([]);
    const withCommitment = budgetPaceInsights([
      budgetFact({
        limitMinor: 100_000n,
        spentMinor: 30_000n,
        committedMinor: 50_000n,
        daysElapsed: 15,
        daysInMonth: 30,
      }),
    ]);
    expect(withCommitment).toHaveLength(1);
    expect(withCommitment[0]?.payload['projectedTotalMinor']).toBe('110000');
  });

  it('keeps money as strings in the payload and never as a JSON number', () => {
    const [draft] = budgetPaceInsights([
      budgetFact({ limitMinor: 10_000n, spentMinor: 6_000n, daysElapsed: 15 }),
    ]);
    expect(typeof draft?.payload['limitMinor']).toBe('string');
    expect(typeof draft?.payload['projectedOverrunMinor']).toBe('string');
    // Ratios are comparisons, not money, so they stay numbers.
    expect(typeof draft?.payload['overrunRatio']).toBe('number');
  });
});

describe('categorySpikeInsights', () => {
  it('fires at 1.5× the baseline and not below it', () => {
    const at = categorySpikeInsights([trendFact({ currentMinor: 15_000n })]);
    expect(at).toHaveLength(1);
    expect(at[0]?.severity).toBe('WARNING');
    expect(at[0]?.payload['multiple']).toBe(1.5);

    expect(categorySpikeInsights([trendFact({ currentMinor: 14_999n })])).toEqual([]);
  });

  it('turns CRITICAL at 3× the baseline', () => {
    expect(categorySpikeInsights([trendFact({ currentMinor: 30_000n })])[0]?.severity).toBe('CRITICAL');
    expect(categorySpikeInsights([trendFact({ currentMinor: 29_000n })])[0]?.severity).toBe('WARNING');
  });

  it('ignores a spike that is real but tiny in absolute terms', () => {
    // 3× a 2.00 baseline is 6.00 — under the 10.00 floor, and not worth a user's attention.
    const tiny = trendFact({
      currentMinor: 600n,
      baseline: [
        { periodStart: '2026-07-01' as LocalDate, spentMinor: 200n },
        { periodStart: '2026-08-01' as LocalDate, spentMinor: 200n },
      ],
    });
    expect(categorySpikeInsights([tiny])).toEqual([]);
  });

  it('refuses to judge a category it has seen in fewer than two periods', () => {
    const once = trendFact({
      currentMinor: 500_000n,
      baseline: [
        { periodStart: '2026-07-01' as LocalDate, spentMinor: 10_000n },
        { periodStart: '2026-08-01' as LocalDate, spentMinor: 0n },
      ],
    });
    expect(periodsWithSpend(once.baseline)).toBe(1);
    expect(categorySpikeInsights([once])).toEqual([]);
  });

  it('stays silent when the baseline is zero', () => {
    expect(
      categorySpikeInsights([
        trendFact({
          currentMinor: 999_999n,
          baseline: [
            { periodStart: '2026-07-01' as LocalDate, spentMinor: 0n },
            { periodStart: '2026-08-01' as LocalDate, spentMinor: 0n },
          ],
        }),
      ]),
    ).toEqual([]);
  });
});

describe('unusualSpendInsights', () => {
  it('fires at 3× the median and not below it', () => {
    expect(unusualSpendInsights([unusualFact({ amountMinor: 30_000n })])).toHaveLength(1);
    expect(unusualSpendInsights([unusualFact({ amountMinor: 29_999n })])).toEqual([]);
  });

  it('uses the median rather than the mean, so one past outlier cannot hide the next one', () => {
    const history = [10_000n, 10_000n, 10_000n, 10_000n, 200_000n];
    expect(medianMinor(history)).toBe(10_000n);
    expect(unusualSpendInsights([unusualFact({ historyMinor: history, amountMinor: 40_000n })])).toHaveLength(1);
  });

  it('needs enough history for a median to mean anything', () => {
    expect(unusualSpendInsights([unusualFact({ historyMinor: [10_000n, 10_000n, 10_000n, 10_000n] })])).toEqual(
      [],
    );
    expect(INSIGHT_THRESHOLDS.unusualMinHistory).toBe(5);
  });

  it('respects the absolute floor', () => {
    expect(
      unusualSpendInsights([
        unusualFact({ amountMinor: 4_000n, historyMinor: [100n, 100n, 100n, 100n, 100n] }),
      ]),
    ).toEqual([]);
  });
});

describe('positiveTrendInsights', () => {
  it('fires at a 20 % reduction and carries what was saved', () => {
    const [draft] = positiveTrendInsights([trendFact({ currentMinor: 8_000n })]);
    expect(draft?.severity).toBe('POSITIVE');
    expect(draft?.payload['savedMinor']).toBe('2000');
    expect(draft?.payload['reductionRatio']).toBe(0.2);

    expect(positiveTrendInsights([trendFact({ currentMinor: 8_001n })])).toEqual([]);
  });

  it('is not fooled by a baseline that is too small to matter', () => {
    const small = trendFact({
      currentMinor: 0n,
      baseline: [
        { periodStart: '2026-07-01' as LocalDate, spentMinor: 900n },
        { periodStart: '2026-08-01' as LocalDate, spentMinor: 900n },
      ],
    });
    expect(positiveTrendInsights([small])).toEqual([]);
  });

  it('never reports a category that went up', () => {
    expect(positiveTrendInsights([trendFact({ currentMinor: 20_000n })])).toEqual([]);
  });
});

describe('generateInsights', () => {
  it('runs every generator and returns a deterministic order', () => {
    const facts = {
      budgets: [budgetFact({ limitMinor: 10_000n, spentMinor: 6_000n, daysElapsed: 15 })],
      categories: [
        trendFact({ currentMinor: 30_000n }),
        // A second category that came *down*, so all four generators are exercised in one run.
        trendFact({ categoryId: 'cat-fuel', categoryPath: ['Automobil', 'Gorivo'], currentMinor: 5_000n }),
      ],
      unusual: [unusualFact({ amountMinor: 100_000n })],
    };
    const first = generateInsights(facts);
    const second = generateInsights(facts);

    expect(first.map((draft) => draft.kind)).toEqual([
      'BUDGET_PACE',
      'CATEGORY_SPIKE',
      'POSITIVE_TREND',
      'UNUSUAL_SPEND',
    ]);
    expect(first.map((draft) => draft.dedupeKey)).toEqual(second.map((draft) => draft.dedupeKey));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('is silent on empty facts rather than throwing', () => {
    expect(generateInsights({ budgets: [], categories: [], unusual: [] })).toEqual([]);
  });

  it('gives every draft a dedupe key namespaced by kind and period', () => {
    const drafts = generateInsights({
      budgets: [budgetFact({ limitMinor: 10_000n, spentMinor: 6_000n, daysElapsed: 15 })],
      categories: [trendFact({ currentMinor: 30_000n })],
      unusual: [],
    });
    for (const draft of drafts) {
      expect(draft.dedupeKey.startsWith(`${draft.kind}:2026-09-01:`)).toBe(true);
    }
  });
});
