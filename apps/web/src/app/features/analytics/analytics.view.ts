import { monthPeriod } from '@finmate/domain';

import type { TranslationKey } from '../../core/i18n/translations';
import type { MoneyWire } from '../../shared/ui/money/money.component';

/**
 * The analytics screen's decisions, as pure functions — F-20, docs/02 §4.15, docs/06 §4.3.
 *
 * What lives here is the part that is **wrong silently**:
 *
 *  - the **month key arithmetic**. A period is `YYYY-MM` and navigation must not go through a `Date`:
 *    a local `Date` in a Household that is not in the browser's timezone moves a boundary by a day, and
 *    a month that starts on the 31st of the previous month is a real bug that only shows up in
 *    February. `monthPeriod` (already tested in `@finmate/domain`) supplies the days.
 *  - **which rows a flat chart may draw.** The API returns every Category with spend *plus every
 *    ancestor that aggregates it*, so drawing all of them double-counts a parent's whole subtree.
 *    {@link rootRows} is the display set — the roots plus the uncategorised bucket — and the roots
 *    partition the categorised spend.
 *  - **"nothing to compare with"**. `changeRatio` is `null` when the baseline is zero, and rendering
 *    that as `0 %` or `+∞` is exactly the misleading number docs/02 §4.15 forbids. It is a distinct
 *    state, not a missing one.
 *  - the **drill-through**, which must carry the range the figure was computed over. A link that
 *    opens an unfiltered list shows rows the chart did not come from.
 *
 * Money is never computed here. `shareOfTotal` and `changeRatio` arrive as ratios from the server and
 * are only *rounded for display*; the one place a raw amount becomes a number is
 * {@link sparklinePoints}, which turns amounts into **pixel coordinates** and renders none of them.
 *
 * @module apps/web/src/app/features/analytics
 */

/** docs/06 §4.3's `CategorySpend`. */
export interface CategorySpendRow {
  readonly categoryId: string | null;
  readonly category: { readonly id: string; readonly name: string; readonly path: readonly string[]; readonly parentId: string | null } | null;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly total: MoneyWire;
  readonly transactionCount: number;
  readonly shareOfTotal: number;
  readonly priorPeriodTotal: MoneyWire | null;
  readonly changeRatio: number | null;
  readonly isSubtreeAggregate: boolean;
}

export interface SpendBucketRow {
  readonly bucketStart: string;
  readonly bucketEnd: string;
  readonly expenseTotal: MoneyWire;
  readonly incomeTotal: MoneyWire;
  readonly transactionCount: number;
}

export interface MerchantSpendRow {
  readonly merchantId: string | null;
  readonly displayName: string;
  readonly total: MoneyWire;
  readonly transactionCount: number;
}

export interface MonthComparisonView {
  readonly period: string;
  readonly compareTo: string;
  readonly total: MoneyWire;
  readonly compareTotal: MoneyWire;
  readonly delta: MoneyWire;
  readonly deltaRatio: number | null;
  readonly categories: readonly CategorySpendRow[];
}

export interface AnalyticsData {
  readonly spendByCategory: readonly CategorySpendRow[];
  readonly spendOverTime: readonly SpendBucketRow[];
  readonly topMerchants: readonly MerchantSpendRow[];
  readonly monthComparison: MonthComparisonView;
}

export interface DateRangeArg {
  readonly start: string;
  readonly end: string;
}

/** `UP` and `DOWN` are about spending; `NO_BASIS` is the third state, never a zero. */
export type ChangeKind = 'UP' | 'DOWN' | 'FLAT' | 'NO_BASIS';

export type TrendDirection = 'UP' | 'DOWN' | 'FLAT';

const MONTH_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** How many months back the period picker and the trend reach. */
export const MONTHS_BACK = 12;
export const TREND_MONTHS = 6;

/** The `YYYY-MM` a local day belongs to. */
export function monthKeyOf(day: string): string {
  return day.slice(0, 7);
}

export function isMonthKey(value: string): boolean {
  return MONTH_KEY_PATTERN.test(value);
}

/**
 * Move a month key by whole months, on the key itself.
 *
 * Deliberately arithmetic on `year * 12 + month` rather than `Date`: a `Date` would apply the
 * browser's timezone and its day-of-month rules to a value that is a label, not an instant.
 * `shiftMonthKey('2026-01', -1)` is `'2025-12'`, and `'2026-03', -1` is `'2026-02'` — no 31st.
 */
export function shiftMonthKey(key: string, delta: number): string {
  const [year, month] = key.split('-').map(Number) as [number, number];
  const index = year * 12 + (month - 1) + delta;
  const shiftedYear = Math.floor(index / 12);
  const shiftedMonth = ((index % 12) + 12) % 12;
  return `${String(shiftedYear).padStart(4, '0')}-${String(shiftedMonth + 1).padStart(2, '0')}`;
}

/** The inclusive first and last days of a month, from `@finmate/domain` (never re-derived here). */
export function monthRange(key: string): DateRangeArg {
  const period = monthPeriod(`${key}-01`);
  return { start: period.start, end: period.end };
}

/** The months the pickers offer, newest first, ending at `anchor`. */
export function monthOptions(anchor: string, back = MONTHS_BACK): readonly string[] {
  return Array.from({ length: back + 1 }, (_unused, offset) => shiftMonthKey(anchor, -offset));
}

/**
 * A month's name in the reader's language, e.g. *oktobar 2026.*
 *
 * `Intl` in `UTC` on the first of the month: the label is a calendar month, and letting the browser
 * shift it by a timezone could print the previous month's name at a boundary.
 */
export function periodLabel(key: string, tag: string): string {
  const [year, month] = key.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat(tag, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(year, month - 1, 1)),
  );
}

/**
 * The rows a **flat** chart may draw: the roots, plus the uncategorised bucket.
 *
 * The API's row set is a tree (docs/06 §4.3) — a parent carries its children's money — so drawing all
 * of it would count a subtree twice and make the shares sum to more than the whole. The roots
 * partition the categorised spend, which is exactly what a bar chart needs; the table below shows the
 * full tree.
 */
export function rootRows(rows: readonly CategorySpendRow[]): readonly CategorySpendRow[] {
  return rows.filter((row) => row.categoryId === null || row.category?.parentId === null);
}

/** Every Category that carries spend of its own — the rows `includeSubcategories: false` returns. */
export function leafRows(rows: readonly CategorySpendRow[]): readonly CategorySpendRow[] {
  return rows.filter((row) => !row.isSubtreeAggregate);
}

/** A share as a whole percent, clamped so a bar can never overflow its track. */
export function sharePercent(share: number): number {
  if (!Number.isFinite(share)) return 0;
  return Math.max(0, Math.min(100, Math.round(share * 100)));
}

export function changeKind(ratio: number | null): ChangeKind {
  if (ratio === null || !Number.isFinite(ratio)) return 'NO_BASIS';
  if (ratio === 0) return 'FLAT';
  return ratio > 0 ? 'UP' : 'DOWN';
}

/** The glyph for a change. `NO_BASIS` has none: the row says so in words instead. */
export function changeGlyph(kind: ChangeKind): string {
  switch (kind) {
    case 'UP':
      return '↑';
    case 'DOWN':
      return '↓';
    case 'FLAT':
      return '→';
    case 'NO_BASIS':
      return '';
  }
}

export function changeLabelKey(kind: ChangeKind): TranslationKey {
  switch (kind) {
    case 'UP':
      return 'analytics.changeUp';
    case 'DOWN':
      return 'analytics.changeDown';
    case 'FLAT':
      return 'analytics.changeFlat';
    case 'NO_BASIS':
      return 'analytics.noBasis';
  }
}

/** A Category's label: the breadcrumb the server built, or the uncategorised bucket's own name. */
export function categoryLabel(row: CategorySpendRow, uncategorised: string): string {
  if (row.category === null) return uncategorised;
  return row.category.path.length > 0 ? row.category.path.join(' › ') : row.category.name;
}

/**
 * The drill-through for a row, or `null` when there is none to make.
 *
 * The uncategorised bucket gets **no link**: `transactions(...)` has no "category is null" filter, and
 * a link that opened the whole month under the heading "uncategorised" would show rows the figure did
 * not come from. The assistant's drill-through refuses a merchant- or tag-scoped answer for the same
 * reason (docs/06 §4.4).
 */
export function drillThroughQuery(
  range: DateRangeArg,
  row: { readonly categoryId: string | null },
): Record<string, string> | null {
  if (row.categoryId === null) return null;
  return { from: range.start, to: range.end, categoryId: row.categoryId };
}

/** The transactions CSV for the selected month, filtered exactly as the chart was. */
export function csvHref(range: DateRangeArg): string {
  const search = new URLSearchParams({ from: range.start, to: range.end });
  return `/api/export/transactions.csv?${search.toString()}`;
}

/**
 * The trend's direction, from the first to the last bucket. A **comparison of two amounts**, not
 * arithmetic on money: nothing is computed, and the values themselves are rendered by the table.
 */
export function trendDirection(buckets: readonly SpendBucketRow[]): TrendDirection {
  if (buckets.length < 2) return 'FLAT';
  const first = BigInt(buckets[0]?.expenseTotal.amountMinor ?? '0');
  const last = BigInt(buckets.at(-1)?.expenseTotal.amountMinor ?? '0');
  if (last > first) return 'UP';
  if (last < first) return 'DOWN';
  return 'FLAT';
}

export function trendLabelKey(direction: TrendDirection): TranslationKey {
  switch (direction) {
    case 'UP':
      return 'analytics.trendUp';
    case 'DOWN':
      return 'analytics.trendDown';
    case 'FLAT':
      return 'analytics.trendFlat';
  }
}

/**
 * The sparkline as SVG coordinates, in a `0 0 100 height` viewBox.
 *
 * **This is the one place an amount becomes a `number`, and it is never shown.** A chart needs
 * geometry; the arithmetic is `(value × height) ÷ max` in `BigInt` first, so the division that could
 * lose precision happens on a pixel coordinate rather than on money, and no coordinate is ever
 * rendered as an amount (ADR-003). A series whose maximum is zero draws a flat line along the bottom
 * rather than dividing by zero.
 */
export function sparklinePoints(
  buckets: readonly SpendBucketRow[],
  height = 32,
  width = 100,
): string {
  if (buckets.length === 0) return '';

  const values = buckets.map((bucket) => BigInt(bucket.expenseTotal.amountMinor));
  const max = values.reduce((largest, value) => (value > largest ? value : largest), 0n);
  const step = buckets.length === 1 ? 0 : width / (buckets.length - 1);

  return values
    .map((value, index) => {
      const x = Math.round(index * step);
      const scaled = max === 0n ? 0 : Number((BigInt(height) * value) / max);
      return `${x},${height - scaled}`;
    })
    .join(' ');
}

/** The months the trend covers, oldest first — what the sparkline's x-axis means. */
export function trendRange(period: string, months = TREND_MONTHS): DateRangeArg {
  const oldest = shiftMonthKey(period, -(months - 1));
  return { start: monthRange(oldest).start, end: monthRange(period).end };
}
