import { describe, expect, it } from 'vitest';

import { bucketKey, bucketRanges, changeRatio, previousMonthRange, shareOfTotal } from './analytics';
import { localDate } from './dates';

/**
 * Bucket boundaries and ratios. Both are silent when wrong — a chart that lies by a day looks exactly
 * like a chart that does not — so every boundary is asserted rather than the happy path.
 */
describe('bucketRanges', () => {
  it('tiles an inclusive range exactly, with no gap and no overlap', () => {
    const buckets = bucketRanges({ start: localDate('2026-09-01'), end: localDate('2026-09-30') }, 'WEEK');

    // 2026-09-01 is a Tuesday, so the first bucket is clipped to the 1st and the last to the 30th.
    expect(buckets[0]).toEqual({ start: '2026-09-01', end: '2026-09-06', key: '2026-08-31' });
    expect(buckets.at(-1)?.end).toBe('2026-09-30');
    expect(buckets[0]?.start).toBe('2026-09-01');
    // Contiguous: each bucket starts the day after the previous one ends.
    for (let index = 1; index < buckets.length; index += 1) {
      const previous = buckets[index - 1]!;
      const current = buckets[index]!;
      expect(current.start > previous.end, `${previous.end} → ${current.start}`).toBe(true);
      expect(new Date(`${current.start}T00:00:00Z`).getTime() - new Date(`${previous.end}T00:00:00Z`).getTime()).toBe(
        86_400_000,
      );
    }
    // The whole range is covered by the sum of the bucket lengths.
    const days = buckets.reduce(
      (total, bucket) =>
        total +
        (new Date(`${bucket.end}T00:00:00Z`).getTime() - new Date(`${bucket.start}T00:00:00Z`).getTime()) /
          86_400_000 +
        1,
      0,
    );
    expect(days).toBe(30);
  });

  it('uses calendar months and calendar quarters', () => {
    const months = bucketRanges({ start: localDate('2026-01-15'), end: localDate('2026-03-10') }, 'MONTH');
    expect(months.map((bucket) => [bucket.start, bucket.end, bucket.key])).toEqual([
      ['2026-01-15', '2026-01-31', '2026-01'],
      ['2026-02-01', '2026-02-28', '2026-02'],
      ['2026-03-01', '2026-03-10', '2026-03'],
    ]);

    const quarters = bucketRanges({ start: localDate('2026-02-10'), end: localDate('2026-08-05') }, 'QUARTER');
    expect(quarters.map((bucket) => [bucket.start, bucket.end, bucket.key])).toEqual([
      ['2026-02-10', '2026-03-31', '2026-Q1'],
      ['2026-04-01', '2026-06-30', '2026-Q2'],
      ['2026-07-01', '2026-08-05', '2026-Q3'],
    ]);
  });

  it('gives one bucket for a single day, whichever bucket size is asked for', () => {
    for (const bucket of ['DAY', 'WEEK', 'MONTH', 'QUARTER'] as const) {
      const ranges = bucketRanges({ start: localDate('2026-09-17'), end: localDate('2026-09-17') }, bucket);
      expect(ranges, bucket).toEqual([{ start: '2026-09-17', end: '2026-09-17', key: bucketKey('2026-09-17', bucket) }]);
    }
  });

  it('returns nothing for a range that ends before it starts, rather than looping', () => {
    expect(bucketRanges({ start: localDate('2026-09-20'), end: localDate('2026-09-01') }, 'DAY')).toEqual([]);
  });

  it('handles a year boundary without losing or repeating a day', () => {
    const buckets = bucketRanges({ start: localDate('2026-12-28'), end: localDate('2027-01-04') }, 'WEEK');
    expect(buckets.map((bucket) => [bucket.start, bucket.end])).toEqual([
      ['2026-12-28', '2027-01-03'],
      ['2027-01-04', '2027-01-04'],
    ]);
  });

  it('names a week by its Monday, even when the range starts mid-week', () => {
    expect(bucketKey(localDate('2026-09-02'), 'WEEK')).toBe('2026-08-31');
  });
});

describe('previousMonthRange', () => {
  it('is the calendar month before the range starts in', () => {
    expect(previousMonthRange({ start: localDate('2026-03-10'), end: localDate('2026-03-31') })).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
  });

  it('crosses a year boundary', () => {
    expect(previousMonthRange({ start: localDate('2027-01-01'), end: localDate('2027-01-31') })).toEqual({
      start: '2026-12-01',
      end: '2026-12-31',
    });
  });
});

describe('changeRatio', () => {
  it('is the signed change against the prior period', () => {
    expect(changeRatio(120n, 100n)).toBeCloseTo(0.2);
    expect(changeRatio(80n, 100n)).toBeCloseTo(-0.2);
    expect(changeRatio(100n, 100n)).toBe(0);
  });

  it('is null when there is nothing to compare against, never Infinity or NaN', () => {
    // docs/02 §4.15: the screen says "nema osnova za poređenje"; an infinite increase is not a number
    // a person can read, and `NaN` from 0/0 would render as "NaN %" on the chart.
    expect(changeRatio(100n, 0n)).toBeNull();
    expect(changeRatio(0n, 0n)).toBeNull();
  });

  it('is -1 when a Category disappeared, which is a readable figure', () => {
    expect(changeRatio(0n, 100n)).toBe(-1);
  });
});

describe('shareOfTotal', () => {
  it('is the fraction of the period total', () => {
    expect(shareOfTotal(25n, 100n)).toBeCloseTo(0.25);
  });

  it('is 0 for an empty period rather than NaN', () => {
    expect(shareOfTotal(0n, 0n)).toBe(0);
  });
});
