import { addDays, addMonths, compareLocalDates, monthPeriod, weekPeriod, type LocalDate } from './dates';

/**
 * Analytics calculators — docs/01 F-20, docs/06 §4.3.
 *
 * Pure and deterministic, like every other calculator in this package (ADR-001). Two things live here
 * because they are **silent when wrong**:
 *
 * 1. **Bucket boundaries.** `spendOverTime` returns contiguous buckets covering the requested range
 *    exactly — no gaps, no overlaps, and the first and last clipped to the range. Off-by-one at a
 *    boundary is a chart that lies by a day, and nothing about the shape of the response reveals it.
 * 2. **Ratios with no basis.** A Category's `changeRatio` against a period it did not exist in, or a
 *    share of a total of zero, is **`null`**, not `Infinity` or `NaN` — docs/02 §4.15 requires the
 *    screen to say *nema osnova za poređenje* rather than draw a number nobody can interpret. A ratio
 *    is dimensionless, so a `number` is right here; money never is (ADR-003).
 *
 * @module @finmate/domain
 */

/** docs/06 §4.3's `TimeBucket`. */
export type TimeBucket = 'DAY' | 'WEEK' | 'MONTH' | 'QUARTER';

export const TIME_BUCKETS: readonly TimeBucket[] = ['DAY', 'WEEK', 'MONTH', 'QUARTER'];

/** An inclusive calendar range, in the Household's own days. */
export interface DateRange {
  readonly start: LocalDate;
  readonly end: LocalDate;
}

export interface BucketRange extends DateRange {
  /** The bucket's own label, e.g. `2026-09` for a month — stable and sortable. */
  readonly key: string;
}

/**
 * Split an inclusive range into contiguous buckets.
 *
 * The **last** bucket is clipped to `end`, and the first to `start`, so the buckets tile the range
 * exactly: `buckets[0].start === start`, `buckets.at(-1)!.end === end`, and every bucket starts the day
 * after the previous one ends. Weeks are ISO weeks (Monday–Sunday, from {@link weekPeriod}) and
 * quarters are calendar quarters, so the boundaries match what a person would circle on a calendar.
 *
 * Returns `[]` for a range whose end precedes its start rather than throwing: an empty series is a
 * legitimate answer to a badly formed request, and the caller's validation owns the refusal.
 */
export function bucketRanges(range: DateRange, bucket: TimeBucket): readonly BucketRange[] {
  if (compareLocalDates(range.start, range.end) > 0) return [];

  const buckets: BucketRange[] = [];
  let cursor = range.start;

  // Bounded by construction: every step advances at least one day, and the loop stops at `end`. The
  // guard is a backstop against a future bucket type that does not advance (an infinite loop in a
  // request handler is an outage, not a bug report).
  let guard = 0;
  while (compareLocalDates(cursor, range.end) <= 0 && guard < 10_000) {
    guard += 1;
    const natural = naturalEnd(cursor, bucket);
    const end = compareLocalDates(natural, range.end) > 0 ? range.end : natural;
    buckets.push({ start: cursor, end, key: bucketKey(cursor, bucket) });
    cursor = addDays(end, 1);
  }

  return buckets;
}

/** The bucket's label. Sortable as a string, which is what a chart's x-axis needs. */
export function bucketKey(start: LocalDate, bucket: TimeBucket): string {
  switch (bucket) {
    case 'DAY':
      return start;
    case 'WEEK': {
      // The week's Monday, not its end: a week bucket is named by when it starts.
      return weekPeriod(start).start;
    }
    case 'MONTH':
      return start.slice(0, 7);
    case 'QUARTER': {
      const month = Number(start.slice(5, 7));
      const quarter = Math.floor((month - 1) / 3) + 1;
      return `${start.slice(0, 4)}-Q${quarter}`;
    }
  }
}

function naturalEnd(start: LocalDate, bucket: TimeBucket): LocalDate {
  switch (bucket) {
    case 'DAY':
      return start;
    case 'WEEK':
      return weekPeriod(start).end;
    case 'MONTH':
      return monthPeriod(start).end;
    case 'QUARTER': {
      // The quarter's last month, then that month's last day.
      const month = Number(start.slice(5, 7));
      const firstMonthOfQuarter = Math.floor((month - 1) / 3) * 3 + 1;
      const lastMonthOfQuarter = firstMonthOfQuarter + 2;
      const lastMonth = monthPeriod(`${start.slice(0, 4)}-${String(lastMonthOfQuarter).padStart(2, '0')}-01` as LocalDate);
      return lastMonth.end;
    }
  }
}

/** The range one month earlier than `range`, for the `monthComparison` default. */
export function previousMonthRange(range: DateRange): DateRange {
  const previous = monthPeriod(addMonths(range.start, -1));
  return { start: previous.start, end: previous.end };
}

/**
 * `(current − prior) / prior`, or **`null` when there is nothing to compare against**.
 *
 * `null` covers both halves of docs/02 §4.15's rule: no prior-period spend at all, *and* a prior of
 * zero with current spend (which would otherwise be an infinite increase). `-1` is the floor when a
 * Category disappeared entirely — a real, readable number: it fell by 100 %.
 */
export function changeRatio(currentMinor: bigint, priorMinor: bigint): number | null {
  if (priorMinor === 0n) return null;
  return Number(currentMinor - priorMinor) / Number(priorMinor);
}

/**
 * A Category's share of the period's spend, or `0` when the period has no spend at all.
 *
 * `0` rather than `null` here, deliberately: a share of nothing is not "unknown", it is nothing, and a
 * chart drawing zero-width bars for an empty month is correct. (Contrast {@link changeRatio}, where
 * `null` is the only honest answer.)
 */
export function shareOfTotal(partMinor: bigint, totalMinor: bigint): number {
  if (totalMinor === 0n) return 0;
  return Number(partMinor) / Number(totalMinor);
}
