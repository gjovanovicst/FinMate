import type { MoneyWire } from '../../shared/ui/money/money.component';
import { moneyText } from '../../shared/money-text';

/**
 * The dashboard's pure half (ADR-039).
 *
 * Everything here is a decision that is wrong in a way nobody notices: which greeting a clock time
 * deserves, how a change ratio becomes a signed label, how a category becomes a chart colour, and which
 * of the two theme inks a delta carries. None of it needs Angular, so all of it is asserted directly.
 */

/** The seven chart tokens an avatar or a donut slice may use, in the order the mockup uses them. */
export const CHART_TOKENS = [
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--chart-6',
  '--chart-7',
] as const;

/** The colour a slice or disc takes at a position. Wraps, so an eighth category is still coloured. */
export function chartToken(index: number): string {
  return CHART_TOKENS[((index % CHART_TOKENS.length) + CHART_TOKENS.length) % CHART_TOKENS.length]!;
}

export type GreetingKey =
  | 'dashboard.greetingMorning'
  | 'dashboard.greetingAfternoon'
  | 'dashboard.greetingEvening';

/**
 * The greeting a **local** hour deserves.
 *
 * Midday is the boundary people expect: "Good afternoon" starts at 12:00, and "Good evening" at 18:00.
 * The hour is the browser's, not the server's, because a greeting is about the person reading it rather
 * than about the Household's accounting day — the opposite of every money figure on this screen, which
 * is why that distinction is worth stating.
 */
export function greetingKey(hour: number): GreetingKey {
  if (hour < 12) return 'dashboard.greetingMorning';
  if (hour < 18) return 'dashboard.greetingAfternoon';
  return 'dashboard.greetingEvening';
}

/**
 * A share as a whole-number percentage, or `null` when there is nothing to state.
 *
 * Used for the donut's legend, where the server already computed the share (`shareOfTotal`). Rounding to
 * whole numbers is deliberate: a legend reading "32.4 %" claims a precision nobody reads, and the exact
 * amount is printed on the same row.
 */
export function percentLabel(ratio: number | null | undefined): string | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return null;
  return `${Math.round(ratio * 100)}%`;
}

/**
 * A month-over-month change as a signed label, or `null` when there is no basis for one.
 *
 * The sign is always drawn, including `+`, because an unsigned "12 %" beside a delta arrow is exactly the
 * case where a reader cannot tell growth from decline. `changeRatio` from `@finmate/domain` returns
 * `null` when the prior month is zero, and that `null` is **kept**: "no basis for comparison" is a
 * different statement from "no change", and the mockup's arrow chip has no honest form for it.
 *
 * The minus sign is U+2212, not a hyphen: beside tabular figures a hyphen reads as a dash in a range.
 */
export function deltaLabel(ratio: number | null | undefined): string | null {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return null;
  const percent = Math.round(ratio * 100);
  if (percent === 0) return '0%';
  return percent > 0 ? `+${percent}%` : `−${Math.abs(percent)}%`;
}

/**
 * Whether a delta is bad news.
 *
 * Only spend has a direction worth colouring: **more income is not "good" and less income is not "bad"**
 * — the product does not know why a month was quiet, and docs/13 §9 is explicit that the UI makes no
 * judgement about a household's money. So income deltas render tone-neutral and spend deltas above zero
 * carry the warning tone.
 */
export function deltaTone(ratio: number | null | undefined, series: 'income' | 'expense'): 'up' | 'down' | 'flat' {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio) || ratio === 0) return 'flat';
  if (series === 'income') return ratio > 0 ? 'up' : 'down';
  return ratio > 0 ? 'down' : 'up';
}

/** One row of the spending-by-category legend, as the panel renders it. */
export interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  /** The row's own colour: the Category's own `color` when it has one, else the chart ramp. */
  readonly tint: string;
  readonly total: MoneyWire;
  readonly share: number | null;
}

/**
 * A Category's own colour, or the chart ramp.
 *
 * Categories carry a `color` from the seed and the tree editor, and honouring it is what makes the donut
 * and the `/analytics` screen agree about what "Hrana" looks like. The seed's colours are hex strings, so
 * they are passed through as CSS; a Category with none takes its position in the ramp. Nothing here
 * interprets the value — a malformed one is the store's problem, and CSS drops an invalid colour to
 * `currentColor` rather than crashing a chart.
 */
export function categoryTint(color: string | null | undefined, index: number): string {
  const trimmed = color?.trim() ?? '';
  return trimmed === '' ? `var(${chartToken(index)})` : trimmed;
}

/** The four KPI sparkline series, as `{value,label}` pairs the chart can draw. */
export function seriesFromBuckets(
  buckets: readonly { expenseTotal: MoneyWire; incomeTotal: MoneyWire; bucketStart: string }[],
  key: 'expenseTotal' | 'incomeTotal',
): readonly { value: number; label: string }[] {
  return buckets.map((bucket) => ({
    // A bar height, so a plain number is right here and the exact money never is (ADR-003): the tile's
    // own figure is the number a reader gets.
    value: Number(bucket[key].amountMinor),
    label: bucket.bucketStart,
  }));
}

/** One commitment on the goals panel. */
export interface GoalRow {
  readonly id: string;
  readonly name: string;
  readonly contributed: MoneyWire;
  readonly target: MoneyWire;
  readonly progress: number;
  readonly requiredPerMonth: MoneyWire | null;
  readonly monthsRemaining: number | null;
}

/** One row of the alerts panel: the notification centre's own copy, not a second wording of it. */
export interface AlertRow {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly severity: 'CRITICAL' | 'WARNING' | 'INFO' | 'POSITIVE';
  readonly createdAt: string;
  readonly read: boolean;
}

/** One row of the recent-transactions panel. */
export interface RecentRow {
  readonly id: string;
  readonly description: string;
  readonly categoryName: string | null;
  readonly amount: MoneyWire;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly occurredLocalDate: string;
}

/** A money amount as in-sentence text, for a chart label or a footnote. Never a raw number. */
export function amountText(value: MoneyWire | null | undefined): string {
  return moneyText(value);
}
