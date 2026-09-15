import { addDays, addMonths, compareLocalDates, monthPeriod, weekPeriod, type LocalDate } from './dates';

/**
 * Recurring rules — F-16, docs/03 §4 (`recurring_rules`), docs/06 §4/§5.8.
 *
 * ## Why this is a hand-written RRULE subset and not a library
 *
 * A dependency needs an ADR (ADR-004). The product's recurrence needs are the four cases a household
 * actually has — every N days, every N weeks, monthly on a day, yearly on a date — plus an end. A full
 * RFC 5545 implementation is thousands of lines for `BYSETPOS`, `BYYEARDAY` and timezone rules this
 * model deliberately does not have; what ships here is the subset the screen can express, and anything
 * else is **refused with a reason** rather than silently mis-expanded. When a real need appears, the
 * ADR is cheap to write; a wrong date on somebody's rent is not.
 *
 * ## Dates, never instants
 *
 * Everything here is a `LocalDate` (I-2). A monthly rule on the 1st is the 1st in the Household's own
 * calendar whatever a DST transition did to the UTC offset, and the instant is derived once, on the
 * write path, from `occurred_local_date` — so "expands across DST" is a property of the design rather
 * than a test that has to keep passing.
 *
 * ## Two rules worth knowing
 *
 * 1. **A month without the day is skipped**, per RFC 5545: `FREQ=MONTHLY;BYMONTHDAY=31` produces
 *    nothing in February. Rolling back to the 28th would quietly move a bill a household budgets for.
 * 2. **`COUNT` counts occurrences, not materialised rows.** The service compares it against how many
 *    Transactions the rule has generated, so a paused or retried run does not lose an occurrence.
 *
 * @module @finmate/domain
 */

export type RecurrenceFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export const RECURRENCE_FREQUENCIES: readonly RecurrenceFrequency[] = [
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'YEARLY',
];

/** RFC 5545's weekday tokens, Monday first — the order a European screen reads them in. */
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export interface RRuleSpec {
  readonly frequency: RecurrenceFrequency;
  /** `INTERVAL`, 1 when absent. */
  readonly interval: number;
  /** `BYMONTHDAY`, for MONTHLY (and YEARLY); empty means "the anchor's own day". */
  readonly byMonthDay: readonly number[];
  /** `BYDAY`, for WEEKLY; empty means "the anchor's own weekday". */
  readonly byDay: readonly Weekday[];
  /** `COUNT`, or `null`. */
  readonly count: number | null;
  /** `UNTIL`, or `null`. The service folds this into `ends_on`. */
  readonly until: LocalDate | null;
}

/** Why a rule string was refused. The API maps these onto one `VALIDATION_FAILED` message each. */
export type RRuleError = 'MALFORMED' | 'UNSUPPORTED_FREQUENCY' | 'UNSUPPORTED_PART' | 'BAD_INTERVAL';

export type RRuleParse = { readonly ok: true; readonly spec: RRuleSpec } | { readonly ok: false; readonly reason: RRuleError };

/** The parts this subset understands. A rule naming anything else is refused, never ignored. */
const KNOWN_PARTS = new Set(['FREQ', 'INTERVAL', 'BYMONTHDAY', 'BYDAY', 'COUNT', 'UNTIL', 'WKST']);

/**
 * Parse an RRULE. The leading `RRULE:` is optional, because half the world stores it and half does not.
 *
 * `WKST` is accepted and ignored: this subset never produces a week-crossing rule where it matters
 * (`BYDAY` inside a `WEEKLY` rule is measured in weeks from the anchor, not from a week start).
 */
export function parseRRule(text: string): RRuleParse {
  const body = text.trim().replace(/^RRULE:/i, '');
  if (body.length === 0) return { ok: false, reason: 'MALFORMED' };

  let frequency: RecurrenceFrequency | null = null;
  let interval = 1;
  const byMonthDay: number[] = [];
  const byDay: Weekday[] = [];
  let count: number | null = null;
  let until: LocalDate | null = null;

  for (const part of body.split(';')) {
    const [rawKey, rawValue] = part.split('=');
    const key = (rawKey ?? '').trim().toUpperCase();
    const value = (rawValue ?? '').trim().toUpperCase();
    if (key.length === 0 || value.length === 0) return { ok: false, reason: 'MALFORMED' };
    if (!KNOWN_PARTS.has(key)) return { ok: false, reason: 'UNSUPPORTED_PART' };

    switch (key) {
      case 'FREQ': {
        if (!RECURRENCE_FREQUENCIES.includes(value as RecurrenceFrequency)) {
          return { ok: false, reason: 'UNSUPPORTED_FREQUENCY' };
        }
        frequency = value as RecurrenceFrequency;
        break;
      }
      case 'INTERVAL': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
          return { ok: false, reason: 'BAD_INTERVAL' };
        }
        interval = parsed;
        break;
      }
      case 'BYMONTHDAY': {
        for (const entry of value.split(',')) {
          const day = Number(entry);
          // Negative ordinals ("the last day") are a different feature; refuse rather than guess.
          if (!Number.isInteger(day) || day < 1 || day > 31) return { ok: false, reason: 'UNSUPPORTED_PART' };
          byMonthDay.push(day);
        }
        break;
      }
      case 'BYDAY': {
        for (const entry of value.split(',')) {
          if (!WEEKDAYS.includes(entry as Weekday)) return { ok: false, reason: 'UNSUPPORTED_PART' };
          byDay.push(entry as Weekday);
        }
        break;
      }
      case 'COUNT': {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) return { ok: false, reason: 'MALFORMED' };
        count = parsed;
        break;
      }
      case 'UNTIL': {
        const day = untilFrom(value);
        if (day === null) return { ok: false, reason: 'MALFORMED' };
        until = day;
        break;
      }
      default:
        // `WKST`, accepted and deliberately ignored.
        break;
    }
  }

  if (frequency === null) return { ok: false, reason: 'MALFORMED' };
  if (byMonthDay.length > 0 && frequency !== 'MONTHLY' && frequency !== 'YEARLY') {
    return { ok: false, reason: 'UNSUPPORTED_PART' };
  }
  if (byDay.length > 0 && frequency !== 'WEEKLY') return { ok: false, reason: 'UNSUPPORTED_PART' };

  return { ok: true, spec: { frequency, interval, byMonthDay, byDay, count, until } };
}

/** `UNTIL=20270601` or the full `20270601T000000Z` form, as a Household day. */
function untilFrom(value: string): LocalDate | null {
  const match = /^(\d{4})(\d{2})(\d{2})(T\d{6}Z?)?$/.exec(value);
  if (match === null) return null;
  const [, year, month, day] = match;
  const candidate = `${year}-${month}-${day}`;
  // A date that does not exist (`20270231`) is malformed, not the 3rd of March.
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) return null;
  return candidate as LocalDate;
}

/** The rule as a string, canonical order — what the API stores, so two equal rules look equal. */
export function formatRRule(spec: RRuleSpec): string {
  const parts = [`FREQ=${spec.frequency}`];
  if (spec.interval !== 1) parts.push(`INTERVAL=${spec.interval}`);
  if (spec.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${[...spec.byMonthDay].sort((a, b) => a - b).join(',')}`);
  if (spec.byDay.length > 0) {
    parts.push(`BYDAY=${WEEKDAYS.filter((day) => spec.byDay.includes(day)).join(',')}`);
  }
  if (spec.count !== null) parts.push(`COUNT=${spec.count}`);
  if (spec.until !== null) parts.push(`UNTIL=${spec.until.replace(/-/g, '')}`);
  return `RRULE:${parts.join(';')}`;
}

/**
 * The first occurrence **on or after** `from`, given the rule and the `anchor` it started at.
 *
 * Returns `null` when the rule has already finished — past `UNTIL`, or `from` beyond a `COUNT` the
 * caller has already used up (`remaining: 0`). The step is bounded: a rule that can never produce a
 * date (a monthly rule on the 31st, asked about February) advances rather than looping forever, and the
 * guard turns "no occurrence in the next decade" into `null` instead of a hung request.
 */
export function nextOccurrenceOn(
  spec: RRuleSpec,
  anchor: LocalDate,
  from: LocalDate,
  options: { readonly until?: LocalDate | null; readonly remaining?: number | null } = {},
): LocalDate | null {
  const end = earlier(spec.until, options.until ?? null);
  const remaining = spec.count === null ? (options.remaining ?? null) : (options.remaining ?? spec.count);
  if (remaining !== null && remaining <= 0) return null;

  let cursor = anchor;
  let produced = 0;
  for (let guard = 0; guard < 2_000; guard += 1) {
    if (cmp(cursor, from) >= 0) {
      if (end !== null && cmp(cursor, end) > 0) return null;
      return cursor;
    }
    produced += 1;
    if (remaining !== null && produced >= remaining) return null;

    const next = step(spec, cursor);
    if (next === null) return null;
    cursor = next;
  }
  return null;
}

/**
 * Occurrences in the inclusive window `[from, to]`, oldest first, at most `limit`.
 *
 * This is what `upcomingRecurring` renders and what materialisation walks. `remaining` is how many
 * occurrences the rule may still produce (`COUNT` minus what it has already generated), so a rule that
 * has been running for a year does not report a horizon the user already paid.
 */
export function expandOccurrences(
  spec: RRuleSpec,
  anchor: LocalDate,
  from: LocalDate,
  to: LocalDate,
  options: { readonly until?: LocalDate | null; readonly remaining?: number | null; readonly limit?: number } = {},
): readonly LocalDate[] {
  const end = earlier(spec.until, options.until ?? null);
  const limit = options.limit ?? 100;
  const dates: LocalDate[] = [];

  let cursor: LocalDate | null = anchor;
  let produced = 0;
  const remaining = spec.count === null ? (options.remaining ?? null) : (options.remaining ?? spec.count);

  for (let guard = 0; cursor !== null && guard < 2_000 && dates.length < limit; guard += 1) {
    if (remaining !== null && produced >= remaining) break;
    if (end !== null && cmp(cursor, end) > 0) break;

    if (cmp(cursor, from) >= 0 && cmp(cursor, to) <= 0) dates.push(cursor);
    produced += 1;
    cursor = step(spec, cursor);
  }

  return dates;
}

/** The occurrence after `cursor`, or `null` when the rule's own shape cannot produce one. */
function step(spec: RRuleSpec, cursor: LocalDate): LocalDate | null {
  switch (spec.frequency) {
    case 'DAILY':
      return addDays(cursor, spec.interval);
    case 'WEEKLY': {
      if (spec.byDay.length === 0) return addDays(cursor, 7 * spec.interval);

      // The remaining matching weekdays of the cursor's own week, then a jump of `interval` weeks from
      // that week's start — which is RFC 5545's reading of WEEKLY + INTERVAL + BYDAY (the interval is
      // measured in weeks from the week the cursor is in, not from the anchor date's weekday).
      const weekStart = weekPeriod(cursor).start;
      const offsets = spec.byDay.map((day) => WEEKDAYS.indexOf(day)).sort((left, right) => left - right);
      for (const offset of offsets) {
        const candidate = addDays(weekStart, offset);
        if (cmp(candidate, cursor) > 0) return candidate;
      }
      return addDays(weekStart, 7 * spec.interval + offsets[0]!);
    }
    case 'MONTHLY': {
      const days = spec.byMonthDay.length > 0 ? [...spec.byMonthDay].sort((a, b) => a - b) : [Number(cursor.slice(8, 10))];
      // The next candidate day in the same month, then the following intervals.
      for (const day of days) {
        const sameMonth = withDay(cursor, day);
        if (sameMonth !== null && cmp(sameMonth, cursor) > 0) return sameMonth;
      }
      let month = addMonths(monthPeriod(cursor).start, spec.interval);
      for (let guard = 0; guard < 60; guard += 1) {
        for (const day of days) {
          const candidate = withDay(month, day);
          if (candidate !== null) return candidate;
        }
        month = addMonths(month, spec.interval);
      }
      return null;
    }
    case 'YEARLY': {
      const day = Number(cursor.slice(8, 10));
      const month = cursor.slice(5, 7);
      let year = Number(cursor.slice(0, 4)) + spec.interval;
      for (let guard = 0; guard < 20; guard += 1) {
        const candidate = withDay(`${year}-${month}-01` as LocalDate, day);
        if (candidate !== null && cmp(candidate, cursor) > 0) return candidate;
        year += spec.interval;
      }
      return null;
    }
  }
}

/** A date in the same month as `reference` on `day`, or `null` when that month has no such day. */
function withDay(reference: LocalDate, day: number): LocalDate | null {
  const period = monthPeriod(reference);
  const lastDay = Number(period.end.slice(8, 10));
  if (day > lastDay) return null;
  return `${period.start.slice(0, 8)}${String(day).padStart(2, '0')}` as LocalDate;
}



function cmp(left: LocalDate, right: LocalDate): number {
  return compareLocalDates(left, right);
}

function earlier(left: LocalDate | null, right: LocalDate | null): LocalDate | null {
  if (left === null) return right;
  if (right === null) return left;
  return cmp(left, right) <= 0 ? left : right;
}
