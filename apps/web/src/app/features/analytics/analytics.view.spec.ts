import { describe, expect, it } from 'vitest';

import {
  categoryLabel,
  changeIcon,
  changeKind,
  changeLabelKey,
  csvHref,
  drillThroughQuery,
  isMonthKey,
  leafRows,
  monthKeyOf,
  monthOptions,
  monthRange,
  periodLabel,
  rootRows,
  sharePercent,
  shiftMonthKey,
  sparklinePoints,
  trendDirection,
  trendRange,
  type CategorySpendRow,
} from './analytics.view';

/**
 * The analytics screen's decisions.
 *
 * These are the ones that are wrong *silently*: a month boundary moved by a day, a chart that draws a
 * parent and its child (so the shares exceed the whole), a `null` ratio rendered as `0 %`, and a
 * drill-through that opens rows the figure did not come from.
 */

function row(overrides: Partial<CategorySpendRow> = {}): CategorySpendRow {
  return {
    categoryId: 'c1',
    category: { id: 'c1', name: 'Hrana', path: ['Hrana'], parentId: null },
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    total: { amountMinor: '100000', currency: 'RSD' },
    transactionCount: 2,
    shareOfTotal: 0.5,
    priorPeriodTotal: { amountMinor: '50000', currency: 'RSD' },
    changeRatio: 1,
    isSubtreeAggregate: true,
    ...overrides,
  };
}

const bucket = (day: string, minor: string) => ({
  bucketStart: day,
  bucketEnd: day,
  expenseTotal: { amountMinor: minor, currency: 'RSD' },
  incomeTotal: { amountMinor: '0', currency: 'RSD' },
  transactionCount: 1,
});

describe('month keys', () => {
  it('recognises a month key and rejects anything else', () => {
    expect(isMonthKey('2026-09')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-9')).toBe(false);
    expect(isMonthKey('September')).toBe(false);
  });

  it('reads the month out of a day', () => {
    expect(monthKeyOf('2026-09-20')).toBe('2026-09');
  });

  it('moves across a year boundary without a Date', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2025-12', 1)).toBe('2026-01');
    // No 31st anywhere: the key is a label, so February cannot be skipped.
    expect(shiftMonthKey('2026-03', -1)).toBe('2026-02');
    expect(shiftMonthKey('2026-03', -13)).toBe('2025-02');
  });

  it('gives the inclusive first and last day of a month', () => {
    expect(monthRange('2026-09')).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(monthRange('2024-02')).toEqual({ start: '2024-02-01', end: '2024-02-29' });
  });

  it('offers the months newest first, ending at the anchor', () => {
    expect(monthOptions('2026-02', 2)).toEqual(['2026-02', '2026-01', '2025-12']);
  });

  it('labels a month in the reader’s language', () => {
    expect(periodLabel('2026-09', 'sr-Latn-RS')).toContain('2026');
    expect(periodLabel('2026-09', 'en-GB')).toContain('September');
    // UTC on the first of the month: a timezone shift could otherwise print August.
    expect(periodLabel('2026-01', 'en-GB')).toContain('January');
  });
});

describe('the rows a flat chart may draw', () => {
  it('keeps the roots and the uncategorised bucket, and drops the children', () => {
    const root = row({ categoryId: 'root' });
    const child = row({
      categoryId: 'child',
      category: { id: 'child', name: 'Supermarket', path: ['Hrana', 'Supermarket'], parentId: 'root' },
      // A leaf: it carries its own spend and no descendant's.
      isSubtreeAggregate: false,
    });
    const uncategorised = row({ categoryId: null, category: null, isSubtreeAggregate: false });

    expect(rootRows([root, child, uncategorised]).map((entry) => entry.categoryId)).toEqual([
      'root',
      null,
    ]);
    // The tree itself is still available: the table renders it.
    expect(leafRows([root, child, uncategorised]).map((entry) => entry.categoryId)).toEqual([
      'child',
      null,
    ]);
  });
});

describe('shares and changes', () => {
  it('rounds a share to a whole percent and clamps it', () => {
    expect(sharePercent(0.3846)).toBe(38);
    expect(sharePercent(1.4)).toBe(100);
    expect(sharePercent(-1)).toBe(0);
    expect(sharePercent(Number.NaN)).toBe(0);
  });

  it('treats a missing basis as its own state, never as zero', () => {
    expect(changeKind(null)).toBe('NO_BASIS');
    expect(changeKind(0)).toBe('FLAT');
    expect(changeKind(0.2)).toBe('UP');
    expect(changeKind(-1)).toBe('DOWN');
    expect(changeIcon('NO_BASIS')).toBe('');
    // A chrome glyph is an <fm-icon> name, never a text arrow (ADR-039).
    expect(changeIcon('UP')).toBe('arrowUp');
    expect(changeIcon('DOWN')).toBe('arrowDown');
    expect(changeIcon('FLAT')).toBe('trending');
    expect(changeLabelKey('NO_BASIS')).toBe('analytics.noBasis');
  });

  it('labels a Category by its breadcrumb, and the null bucket by its own name', () => {
    expect(categoryLabel(row(), 'Neraspoređeno')).toBe('Hrana');
    expect(
      categoryLabel(
        row({
          categoryId: null,
          category: null,
        }),
        'Neraspoređeno',
      ),
    ).toBe('Neraspoređeno');
  });
});

describe('drill-through and export', () => {
  it('carries the range the figure was computed over', () => {
    const range = { start: '2026-09-01', end: '2026-09-30' };
    expect(drillThroughQuery(range, { categoryId: 'c1' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
      categoryId: 'c1',
    });
  });

  it('refuses a link for the uncategorised bucket rather than opening everything', () => {
    expect(
      drillThroughQuery({ start: '2026-09-01', end: '2026-09-30' }, { categoryId: null }),
    ).toBeNull();
  });

  it('builds the month’s CSV URL through the same range', () => {
    expect(csvHref({ start: '2026-09-01', end: '2026-09-30' })).toBe(
      '/api/export/transactions.csv?from=2026-09-01&to=2026-09-30',
    );
  });
});

describe('the trend', () => {
  it('reads direction from the first and last bucket', () => {
    expect(trendDirection([bucket('2026-08-01', '100'), bucket('2026-09-01', '300')])).toBe('UP');
    expect(trendDirection([bucket('2026-08-01', '300'), bucket('2026-09-01', '100')])).toBe('DOWN');
    expect(trendDirection([bucket('2026-08-01', '100'), bucket('2026-09-01', '100')])).toBe('FLAT');
    expect(trendDirection([])).toBe('FLAT');
  });

  it('covers six months ending at the selected one', () => {
    expect(trendRange('2026-09')).toEqual({ start: '2026-04-01', end: '2026-09-30' });
    expect(trendRange('2026-02', 3)).toEqual({ start: '2025-12-01', end: '2026-02-28' });
  });

  it('turns amounts into coordinates in a 0..height box, without rendering a number', () => {
    const points = sparklinePoints(
      [bucket('2026-08-01', '0'), bucket('2026-09-01', '100'), bucket('2026-10-01', '50')],
      32,
      100,
    ).split(' ');

    expect(points).toHaveLength(3);
    expect(points[0]).toBe('0,32');
    // The maximum sits on the top edge, half of it in the middle.
    expect(points[1]).toBe('50,0');
    expect(points[2]).toBe('100,16');
  });

  it('draws a flat line rather than dividing by zero', () => {
    expect(sparklinePoints([bucket('2026-08-01', '0'), bucket('2026-09-01', '0')])).toBe('0,32 100,32');
    expect(sparklinePoints([])).toBe('');
  });
});
