import { daysBetween, type LocalDate } from './dates';

/**
 * Subscription detection — F-16, docs/02 §4.14, docs/09 task 3.3.4.
 *
 * "Propose, never auto-create" is the whole point: this file finds candidates and reports the
 * **evidence** for each, and nothing here writes a rule. The screen shows the evidence (*4×, the same
 * amount*) and the user accepts or dismisses; docs/04 §8.2's guardrail is why.
 *
 * ## What counts as a subscription
 *
 * A run of charges that look like one bill:
 *
 * 1. **Same identity** — the same Merchant when the ledger resolved one, otherwise the same
 *    description, folded by the caller. The identity is the caller's; this file groups by a key it is
 *    given, so the API can use the fold the rest of the product uses.
 * 2. **At least `minOccurrences` charges** (three by default). Two is a coincidence: a person buys
 *    groceries twice.
 * 3. **A steady amount** — every charge within `toleranceRatio` of the median (2 % by default, which
 *    absorbs a price rise but not a different purchase).
 * 4. **A steady interval** — the gaps are close to a calendar period (weekly, monthly, quarterly,
 *    yearly) within `maxDriftDays` (4 by default). The period is **chosen from the gaps**, not assumed,
 *    because assuming monthly is how a weekly delivery becomes a monthly bill.
 * 5. **Still alive** — the last charge is within `recencyDays` (45 by default) of today. A cancelled
 *    subscription stops being a subscription.
 *
 * Everything is minor units and `LocalDate`; the only non-integer is the tolerance ratio, which is a
 * comparison, not money.
 *
 * @module @finmate/domain
 */

export interface SubscriptionCharge {
  /** The grouping key the caller computed: a Merchant id, or a folded description. */
  readonly key: string;
  /** What to show the user — a Merchant name or the raw description. */
  readonly label: string;
  readonly merchantId: string | null;
  readonly description: string;
  readonly amountMinor: bigint;
  readonly occurredOn: LocalDate;
}

export interface DetectOptions {
  readonly today: LocalDate;
  readonly minOccurrences?: number;
  readonly toleranceRatio?: number;
  readonly maxDriftDays?: number;
  readonly recencyDays?: number;
}

/** The periods a household actually pays on, with the tolerance window in days. */
export interface DetectedPeriod {
  readonly kind: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY';
  /** A canonical RRULE for the period, ready to store once the user accepts. */
  readonly rrule: string;
  readonly days: number;
}

export interface SubscriptionProposal {
  readonly key: string;
  readonly label: string;
  readonly merchantId: string | null;
  readonly description: string;
  /** The median charge: what the next one will most likely cost. */
  readonly typicalAmountMinor: bigint;
  readonly occurrences: number;
  readonly period: DetectedPeriod;
  readonly firstOccurredOn: LocalDate;
  readonly lastOccurredOn: LocalDate;
  /** How many days the observed gaps differ from the period, at most. The smaller, the stronger. */
  readonly driftDays: number;
  /** True when every charge was the same amount to the cent. */
  readonly sameAmount: boolean;
}

const PERIODS: readonly DetectedPeriod[] = [
  { kind: 'WEEKLY', rrule: 'RRULE:FREQ=WEEKLY', days: 7 },
  { kind: 'MONTHLY', rrule: 'RRULE:FREQ=MONTHLY', days: 30 },
  { kind: 'QUARTERLY', rrule: 'RRULE:FREQ=MONTHLY;INTERVAL=3', days: 91 },
  { kind: 'YEARLY', rrule: 'RRULE:FREQ=YEARLY', days: 365 },
];

const DEFAULT_MIN_OCCURRENCES = 3;
const DEFAULT_TOLERANCE_RATIO = 0.02;
const DEFAULT_MAX_DRIFT_DAYS = 4;
const DEFAULT_RECENCY_DAYS = 45;

/**
 * Propose the subscriptions hiding in a list of charges, strongest first.
 *
 * Deterministic: the same charges produce the same proposals in the same order (the caller's key
 * breaks ties), so a screen that re-renders does not reshuffle, and a test can assert an order.
 */
export function detectSubscriptions(
  charges: readonly SubscriptionCharge[],
  options: DetectOptions,
): readonly SubscriptionProposal[] {
  const minOccurrences = options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const tolerance = options.toleranceRatio ?? DEFAULT_TOLERANCE_RATIO;
  const maxDrift = options.maxDriftDays ?? DEFAULT_MAX_DRIFT_DAYS;
  const recency = options.recencyDays ?? DEFAULT_RECENCY_DAYS;

  const byKey = new Map<string, SubscriptionCharge[]>();
  for (const charge of charges) {
    const bucket = byKey.get(charge.key);
    if (bucket === undefined) byKey.set(charge.key, [charge]);
    else bucket.push(charge);
  }

  const proposals: SubscriptionProposal[] = [];
  for (const [key, bucket] of byKey) {
    if (bucket.length < minOccurrences) continue;

    const ordered = [...bucket].sort((left, right) =>
      left.occurredOn === right.occurredOn
        ? left.amountMinor < right.amountMinor
          ? -1
          : 1
        : left.occurredOn < right.occurredOn
          ? -1
          : 1,
    );
    const last = ordered.at(-1) as SubscriptionCharge;
    if (daysBetween(last.occurredOn, options.today) > recency) continue;

    const median = medianOf(ordered.map((charge) => charge.amountMinor));
    const sameAmount = ordered.every((charge) => charge.amountMinor === median);
    if (!ordered.every((charge) => withinTolerance(charge.amountMinor, median, tolerance))) continue;

    const gaps = ordered.slice(1).map((charge, index) =>
      daysBetween((ordered[index] as SubscriptionCharge).occurredOn, charge.occurredOn),
    );
    const period = pickPeriod(gaps, maxDrift);
    if (period === null) continue;

    const driftDays = gaps.reduce(
      (worst, gap) => Math.max(worst, Math.abs(gap - period.period.days)),
      0,
    );

    proposals.push({
      key,
      label: last.label,
      merchantId: last.merchantId,
      description: last.description,
      typicalAmountMinor: median,
      occurrences: ordered.length,
      period: period.period,
      firstOccurredOn: (ordered[0] as SubscriptionCharge).occurredOn,
      lastOccurredOn: last.occurredOn,
      driftDays,
      sameAmount,
    });
  }

  // Strongest evidence first: more occurrences, then a steadier interval, then the bigger bill. The key
  // breaks the remaining ties so the order never depends on Map iteration.
  return proposals.sort((left, right) => {
    if (left.occurrences !== right.occurrences) return right.occurrences - left.occurrences;
    if (left.driftDays !== right.driftDays) return left.driftDays - right.driftDays;
    if (left.typicalAmountMinor !== right.typicalAmountMinor) {
      return right.typicalAmountMinor > left.typicalAmountMinor ? 1 : -1;
    }
    return left.key.localeCompare(right.key);
  });
}

/** The period the gaps look most like, or `null` when they look like nothing regular. */
function pickPeriod(
  gaps: readonly number[],
  maxDrift: number,
): { readonly period: DetectedPeriod; readonly drift: number } | null {
  if (gaps.length === 0) return null;

  let best: { period: DetectedPeriod; drift: number } | null = null;
  for (const period of PERIODS) {
    const worst = gaps.reduce((value, gap) => Math.max(value, Math.abs(gap - period.days)), 0);
    // A monthly rule's real gap moves between 28 and 31 days, so the window is the period's own
    // tolerance (maxDrift) plus the calendar's slack for the longer periods.
    const slack = period.kind === 'MONTHLY' || period.kind === 'QUARTERLY' ? 3 : 0;
    if (worst > maxDrift + slack) continue;
    if (best === null || worst < best.drift) best = { period, drift: worst };
  }

  return best;
}

function withinTolerance(amount: bigint, median: bigint, tolerance: number): boolean {
  if (median === 0n) return amount === 0n;
  const difference = amount > median ? amount - median : median - amount;
  // Compare in basis points so no money value ever becomes a float (ADR-003).
  const allowed = (median * BigInt(Math.round(tolerance * 10_000))) / 10_000n;
  return difference <= allowed;
}

/** The middle value; for an even count, the lower of the two middles — never an average of money. */
function medianOf(values: readonly bigint[]): bigint {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const index = Math.floor((sorted.length - 1) / 2);
  return sorted[index] as bigint;
}
