/**
 * Calendar-day helpers.
 *
 * docs/03 §3.2 requires **both** `occurred_at` (an instant) and `occurred_local_date` (the calendar
 * day the user means). That is not redundancy: "which day was this?" is a local-calendar question,
 * and deriving it from an instant requires knowing the Household's timezone. Conflating the two is
 * what makes a transaction land in the wrong month — the bug that silently breaks every report.
 *
 * Everything here works on `YYYY-MM-DD` strings rather than `Date`, because a `Date` is an instant
 * and invites exactly the confusion this module exists to prevent.
 *
 * @module @finmate/domain
 */

/** A calendar day, `YYYY-MM-DD`. */
export type LocalDate = string;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class DateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateError';
  }
}

/** Assert and narrow a string to {@link LocalDate}. */
export function localDate(value: string): LocalDate {
  if (!LOCAL_DATE_PATTERN.test(value)) {
    throw new DateError(`Expected a calendar day formatted YYYY-MM-DD, received "${value}".`);
  }
  // Reject impossible dates that still match the pattern, e.g. 2026-02-31.
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new DateError(`"${value}" is not a real calendar day.`);
  }
  return value;
}

/**
 * The calendar day an instant falls on **in a given timezone**.
 *
 * This is the only correct way to derive `occurred_local_date` from `occurred_at`. Using the
 * server's own timezone would be wrong for any Household that is not in it, and using UTC would be
 * wrong for every Household that is not in UTC — a 23:30 purchase in Belgrade is the *next* day in
 * UTC during summer time.
 */
export function toLocalDate(instant: Date, timeZone: string): LocalDate {
  // `en-CA` formats as YYYY-MM-DD, which avoids assembling parts by hand and getting month/day
  // order wrong.
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return localDate(formatter.format(instant));
}

/** Today's calendar day in a timezone. */
export function todayIn(timeZone: string, now: Date = new Date()): LocalDate {
  return toLocalDate(now, timeZone);
}

/** First and last day of the month containing `date`, inclusive. */
export function monthPeriod(date: LocalDate): { start: LocalDate; end: LocalDate } {
  const [year, month] = date.split('-').map(Number) as [number, number, number];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: localDate(`${pad(year)}-${pad(month)}-01`),
    end: localDate(`${pad(year)}-${pad(month)}-${pad(last)}`),
  };
}

/** Number of days in the month containing `date`. */
export function daysInMonth(date: LocalDate): number {
  const [year, month] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * How many days of the month have elapsed, counting `date` itself.
 *
 * Used by the projection calculator, where an off-by-one changes the predicted spend by ~3 %, so the
 * convention is stated rather than implied: on the 1st this returns 1, not 0. Dividing by zero on the
 * first of the month is a real crash the naive version has.
 */
export function dayOfMonth(date: LocalDate): number {
  return Number(date.slice(8, 10));
}

/** Days remaining in the month **including** `date`. Never below 1. */
export function daysRemainingInMonth(date: LocalDate): number {
  return Math.max(1, daysInMonth(date) - dayOfMonth(date) + 1);
}

/** Compare two calendar days. Lexicographic order is chronological for `YYYY-MM-DD`. */
export function compareLocalDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when `date` falls within `[start, end]`, inclusive at both ends. */
export function isWithin(date: LocalDate, start: LocalDate, end: LocalDate): boolean {
  return date >= start && date <= end;
}

/** The Household timezone used when none is configured. */
export const DEFAULT_TIME_ZONE = 'Europe/Belgrade';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
