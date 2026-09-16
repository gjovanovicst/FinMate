import { describe, expect, it } from 'vitest';

import {
  baselineMean,
  budgetPaceInsights,
  categorySpikeInsights,
  generateInsights,
  medianMinor,
  periodsWithSpend,
  positiveTrendInsights,
  recurringDueInsights,
  unusualSpendInsights,
  INSIGHT_THRESHOLDS,
  type BudgetPaceFact,
  type CategoryTrendFact,
  type RecurringDueFact,
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
    periodComplete: true,
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

function dueFact(overrides: Partial<RecurringDueFact> = {}): RecurringDueFact {
  return {
    ruleId: 'rule-netflix',
    description: 'Netflix',
    categoryId: null,
    categoryPath: null,
    currency: 'RSD',
    amountMinor: 1_299_00n,
    occurredOn: '2026-09-21' as LocalDate,
    daysUntil: 1,
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

  it('does not call a month a saving before the month is over', () => {
    // Mid-period every category looks "down", because the spend has not happened yet. A spike is
    // worth saying now; a saving is not.
    const midPeriod = trendFact({ currentMinor: 0n, periodComplete: false });
    expect(positiveTrendInsights([midPeriod])).toEqual([]);
    // The spike generator still speaks mid-period: that asymmetry is the point.
    expect(categorySpikeInsights([trendFact({ currentMinor: 30_000n })])).toHaveLength(1);
  });
});

describe('recurringDueInsights', () => {
  it('announces a charge due today or tomorrow, and stays silent past the horizon', () => {
    // Both sides of the boundary: today (0) and tomorrow (1) speak; the day after (2) and an overdue
    // fact (-1) do not. The horizon is a named threshold, so this test is the only place it is pinned.
    expect(recurringDueInsights([dueFact({ daysUntil: 0 })])).toHaveLength(1);
    expect(recurringDueInsights([dueFact({ daysUntil: 1 })])).toHaveLength(1);
    expect(recurringDueInsights([dueFact({ daysUntil: 2 })])).toEqual([]);
    expect(recurringDueInsights([dueFact({ daysUntil: -1 })])).toEqual([]);
    expect(INSIGHT_THRESHOLDS.recurringDueHorizonDays).toBe(1);
  });

  it('is informational, because an expected charge is not a warning', () => {
    const [draft] = recurringDueInsights([dueFact()]);
    expect(draft?.kind).toBe('RECURRING_DUE');
    expect(draft?.severity).toBe('INFO');
  });

  it('carries the amount as a minor-unit string and never as a JSON number (ADR-003)', () => {
    const [draft] = recurringDueInsights([dueFact()]);
    expect(draft?.payload['amountMinor']).toBe('129900');
    expect(typeof draft?.payload['amountMinor']).toBe('string');
    // The rule's own words are carried for the in-app copy; the lock-screen rule is the copy module's.
    expect(draft?.payload['description']).toBe('Netflix');
    expect(draft?.payload['daysUntil']).toBe(1);
    expect(draft?.payload['occurredOn']).toBe('2026-09-21');
  });

  it('keys on the occurrence, so two dates of one rule are two conditions', () => {
    const first = recurringDueInsights([dueFact({ occurredOn: '2026-09-21' as LocalDate })])[0];
    const second = recurringDueInsights([dueFact({ occurredOn: '2026-09-28' as LocalDate })])[0];
    expect(first?.dedupeKey).toBe('RECURRING_DUE:2026-09-21:rule-netflix');
    expect(second?.dedupeKey).toBe('RECURRING_DUE:2026-09-28:rule-netflix');
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey);
  });

  it('refuses a non-positive amount rather than announcing a zero charge', () => {
    expect(recurringDueInsights([dueFact({ amountMinor: 0n })])).toEqual([]);
  });

  it('keeps the Category breadcrumb for the copy, and null when the rule has no Category', () => {
    const withCategory = recurringDueInsights([
      dueFact({ categoryId: 'cat-fun', categoryPath: ['Zabava', 'Pretplate'] }),
    ])[0];
    expect(withCategory?.payload['categoryPath']).toBe('Zabava / Pretplate');
    expect(withCategory?.payload['categoryId']).toBe('cat-fun');

    const without = recurringDueInsights([dueFact()])[0];
    expect(without?.payload['categoryPath']).toBeNull();
  });
});

describe('generateInsights', () => {
  it('runs every generator and returns a deterministic order', () => {
    const facts = {
      budgets: [budgetFact({ limitMinor: 10_000n, spentMinor: 6_000n, daysElapsed: 15 })],
      categories: [
        trendFact({ currentMinor: 30_000n }),
        // A second category that came *down*, so all four month-scoped generators are exercised.
        trendFact({ categoryId: 'cat-fuel', categoryPath: ['Automobil', 'Gorivo'], currentMinor: 5_000n }),
      ],
      unusual: [unusualFact({ amountMinor: 100_000n })],
      recurring: [dueFact()],
    };
    const first = generateInsights(facts);
    const second = generateInsights(facts);

    expect(first.map((draft) => draft.kind)).toEqual([
      'BUDGET_PACE',
      'CATEGORY_SPIKE',
      'POSITIVE_TREND',
      'RECURRING_DUE',
      'UNUSUAL_SPEND',
    ]);
    expect(first.map((draft) => draft.dedupeKey)).toEqual(second.map((draft) => draft.dedupeKey));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('is silent on empty facts rather than throwing', () => {
    expect(generateInsights({ budgets: [], categories: [], unusual: [], recurring: [] })).toEqual([]);
  });

  it('gives every month-scoped draft a dedupe key namespaced by kind and period', () => {
    const drafts = generateInsights({
      budgets: [budgetFact({ limitMinor: 10_000n, spentMinor: 6_000n, daysElapsed: 15 })],
      categories: [trendFact({ currentMinor: 30_000n })],
      unusual: [],
      recurring: [],
    });
    for (const draft of drafts) {
      expect(draft.dedupeKey.startsWith(`${draft.kind}:2026-09-01:`)).toBe(true);
    }
  });

  it('names the occurrence, not the period, in a recurring due key', () => {
    // The one generator whose condition is a single day rather than a month: two occurrences of one
    // rule inside one period must produce two keys, which a period-scoped key could not express.
    const drafts = generateInsights({
      budgets: [],
      categories: [],
      unusual: [],
      recurring: [dueFact({ occurredOn: '2026-09-21' as LocalDate }), dueFact({ occurredOn: '2026-09-28' as LocalDate })],
    });
    expect(drafts.map((draft) => draft.dedupeKey)).toEqual([
      'RECURRING_DUE:2026-09-21:rule-netflix',
      'RECURRING_DUE:2026-09-28:rule-netflix',
    ]);
  });
});
