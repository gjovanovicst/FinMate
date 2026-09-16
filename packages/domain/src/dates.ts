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

/**
 * The UTC instant of local noon on `date` in `timeZone`.
 *
 * This is the inverse of {@link toLocalDate}, and it is what lets a client record a day it picked
 * without knowing the Household timezone: the client asserts the calendar day and the server picks
 * the instant. Deriving the day *from* a client-chosen instant is the wrong direction — an instant
 * only names a day relative to a zone the client does not have.
 *
 * The offset is resolved at the candidate instant rather than assumed. A fixed offset is off by an
 * hour across a DST transition, which at a month boundary files the transaction in the wrong month.
 * Two passes converge because an offset only changes at a transition, and the corrected instant
 * lands on the correct side of it.
 */
export function instantForLocalNoon(date: LocalDate, timeZone: string): Date {
  const day = localDate(date);
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  // Fails fast with a clear DateError rather than a RangeError from deep inside the conversion.
  const formatter = zoneFormatter(timeZone);

  // The wall clock we want, read as if it were UTC. Subtracting the zone offset then gives the
  // instant at which those same fields are the local time.
  const wallClockAsUtc = Date.UTC(year, month - 1, dayOfMonth, 12, 0, 0, 0);

  let candidate = new Date(wallClockAsUtc - offsetAt(formatter, new Date(wallClockAsUtc)));
  // The first guess used the offset that applies at the wrong instant whenever a transition sits
  // between the two, so correct once more with the offset that applies at the candidate.
  candidate = new Date(wallClockAsUtc - offsetAt(formatter, candidate));

  // The safety net that makes this honest rather than approximately right: no arithmetic above is
  // trusted until it reproduces the day it was asked for.
  const resolved = toLocalDate(candidate, timeZone);
  if (resolved !== day) {
    throw new DateError(
      `Could not resolve a local noon on ${day} in ${timeZone}: the nearest instant falls on ` +
        `${resolved}.`,
    );
  }
  return candidate;
}

/** An `Intl` formatter for a zone, or a `DateError` naming the bad zone. */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (error) {
    // `Intl` signals an unknown zone with a RangeError; the caller gets the domain error instead so
    // an API layer can map one error type, not two.
    if (error instanceof RangeError) {
      throw new DateError(`"${timeZone}" is not a valid IANA time zone.`);
    }
    throw error;
  }
}

/** The zone's UTC offset in milliseconds at `instant`. */
function offsetAt(formatter: Intl.DateTimeFormat, instant: Date): number {
  const parts = formatter.formatToParts(instant);
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  // Some ICU versions render midnight as 24 with `hour12: false`; without this the offset gains a
  // whole day and the result lands on the wrong date.
  const hour = field('hour') % 24;
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    hour,
    field('minute'),
    field('second'),
  );
  // Offsets are whole seconds in practice; rounding drops a sub-second remainder introduced by the
  // instant's milliseconds rather than mistaking it for part of the offset.
  return Math.round((asUtc - instant.getTime()) / 1000) * 1000;
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

/**
 * The ISO week (Monday–Sunday) containing `date`, inclusive.
 *
 * Monday-based because that is the Serbian convention and the ISO one; a Sunday-based week would move
 * every "this week" figure by a day and nobody would notice until a Sunday.
 */
export function weekPeriod(date: LocalDate): { start: LocalDate; end: LocalDate } {
  const [year, month, day] = localDate(date).split('-').map(Number) as [number, number, number];
  // `getUTCDay()` is 0 for Sunday, so Sunday belongs to the week that started six days earlier.
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  const start = addDays(date, offset);
  return { start, end: addDays(start, 6) };
}

/**
 * Shift a calendar day by `days` (negative goes back).
 *
 * Built on `Date.UTC`, not local time: `new Date(y, m, d)` would shift by the process timezone, which
 * is how a monthly window silently becomes 30 or 32 days on a machine in another zone.
 */
export function addDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = localDate(date).split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return localDate(
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
  );
}

/**
 * How many whole days lie between two calendar days, signed (`to - from`).
 *
 * `Date.UTC` on both ends, for the same reason {@link addDays} uses it: the process timezone must not
 * decide how long a billing window is. The division is exact because both ends are UTC midnights and a
 * UTC day has no DST hour to lose.
 */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  const start = Date.parse(`${localDate(from)}T00:00:00.000Z`);
  const end = Date.parse(`${localDate(to)}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}

/**
 * Shift a calendar day by `months`, clamping the day to the target month's length.
 *
 * `2026-03-31` minus one month is `2026-02-28`, not `2026-03-03`: the sliding that `Date.UTC` does when
 * a day does not exist is right for "one month later in elapsed time" and wrong for "the same month
 * last month", which is what a period comparison means.
 */
export function addMonths(date: LocalDate, months: number): LocalDate {
  const [year, month, day] = localDate(date).split('-').map(Number) as [number, number, number];
  const firstOfTarget = new Date(Date.UTC(year, month - 1 + months, 1));
  const targetYear = firstOfTarget.getUTCFullYear();
  const targetMonth = firstOfTarget.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate();
  return localDate(`${targetYear}-${pad(targetMonth)}-${pad(Math.min(day, lastDay))}`);
}

/** The Household timezone used when none is configured. */
export const DEFAULT_TIME_ZONE = 'Europe/Belgrade';

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
