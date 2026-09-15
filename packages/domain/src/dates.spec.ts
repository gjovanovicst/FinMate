import { describe, expect, it } from 'vitest';

import {
  addDays,
  addMonths,
  DateError,
  instantForLocalNoon,
  localDate,
  toLocalDate,
  type LocalDate,
} from './dates';

/**
 * `instantForLocalNoon` is the inverse of `toLocalDate`, so the property that matters is the
 * round-trip: whatever instant the helper picks, the zone must read it back as the same calendar
 * day. A test that only checked the returned `Date` against a formula would re-state the
 * implementation rather than prove the contract.
 *
 * The zones below are chosen for the offsets that break naive arithmetic: a half-hour offset
 * (Asia/Kolkata) and zones with DST on both sides of the world (Europe/Belgrade, America/New_York,
 * Pacific/Auckland).
 */
const ZONES = [
  'UTC',
  'Europe/Belgrade',
  'Pacific/Auckland',
  'America/New_York',
  'Asia/Kolkata',
] as const;

function* calendarDays(year: number): Generator<LocalDate> {
  for (let month = 1; month <= 12; month++) {
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    for (let day = 1; day <= days; day++) {
      yield localDate(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    }
  }
}

/** The zone's local wall-clock hour at an instant, 0–23. */
function localHour(instant: Date, timeZone: string): number {
  const formatted = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(instant);
  return Number(formatted) % 24;
}

describe('instantForLocalNoon — round-trip', () => {
  /** Exhaustive over a year × five zones, so it is multi-second; the package timeout covers it. */
  it('reads back as the same calendar day in every zone, for every day of 2026', () => {
    for (const timeZone of ZONES) {
      for (const date of calendarDays(2026)) {
        const instant = instantForLocalNoon(date, timeZone);
        expect(toLocalDate(instant, timeZone), `${date} in ${timeZone}`).toBe(date);
      }
    }
  });

  it('round-trips across both 2026 DST transitions in Europe/Belgrade', () => {
    // Belgrade springs forward on the last Sunday of March (the 29th) and falls back on the last
    // Sunday of October (the 25th) — the two days a fixed +02:00 assumption gets wrong.
    const aroundSpring = ['2026-03-28', '2026-03-29', '2026-03-30'];
    const aroundAutumn = ['2026-10-24', '2026-10-25', '2026-10-26'];
    for (const date of [...aroundSpring, ...aroundAutumn]) {
      const instant = instantForLocalNoon(date, 'Europe/Belgrade');
      expect(toLocalDate(instant, 'Europe/Belgrade')).toBe(date);
    }
  });

  it('round-trips across both 2026 DST transitions in America/New_York', () => {
    // The US transitions are the second Sunday of March (the 8th) and the first Sunday of November
    // (the 1st).
    const dates = [
      '2026-03-07',
      '2026-03-08',
      '2026-03-09',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ];
    for (const date of dates) {
      const instant = instantForLocalNoon(date, 'America/New_York');
      expect(toLocalDate(instant, 'America/New_York')).toBe(date);
    }
  });

  it('round-trips on the day Pacific/Auckland enters NZDT', () => {
    // NZDT (UTC+13) begins on the last Sunday of September 2026, the 27th.
    for (const date of ['2026-09-26', '2026-09-27', '2026-09-28']) {
      const instant = instantForLocalNoon(date, 'Pacific/Auckland');
      expect(toLocalDate(instant, 'Pacific/Auckland')).toBe(date);
    }
  });
});

describe('instantForLocalNoon — local wall clock and day boundaries', () => {
  it('lands at local midday wherever midday genuinely exists', () => {
    for (const timeZone of ZONES) {
      for (const date of ['2026-01-15', '2026-06-15', '2026-09-14', '2026-12-15']) {
        const instant = instantForLocalNoon(date, timeZone);
        // 10:00–14:00 rather than exactly 12:00: a zone whose offset changes in the middle of the
        // day cannot have a noon, and the contract is only "as close as the zone allows". Every
        // zone here has a real noon, so the bound is tight in practice.
        expect(localHour(instant, timeZone), `${date} in ${timeZone}`).toBeGreaterThanOrEqual(10);
        expect(localHour(instant, timeZone), `${date} in ${timeZone}`).toBeLessThanOrEqual(14);
      }
    }
  });

  it('picks an instant strictly inside the local day where noon is the local midday', () => {
    for (const timeZone of ['UTC', 'Europe/Belgrade', 'America/New_York', 'Asia/Kolkata']) {
      const date = '2026-09-14';
      const instant = instantForLocalNoon(date, timeZone);
      // A millisecond either side stays on the same day, so the instant is neither local midnight
      // nor the final millisecond of the day. (A fixed "− 12 h is yesterday" assertion would be
      // false for a positive offset: 12 h before local noon is local midnight, the same day.)
      expect(toLocalDate(new Date(instant.getTime() - 1), timeZone)).toBe(date);
      expect(toLocalDate(new Date(instant.getTime() + 1), timeZone)).toBe(date);
    }
  });

  it('is exactly 12:00Z for UTC', () => {
    expect(instantForLocalNoon('2026-09-14', 'UTC').toISOString()).toBe('2026-09-14T12:00:00.000Z');
  });

  it('handles the half-hour offset of Asia/Kolkata without truncating it', () => {
    // 12:00 local at UTC+05:30 is 12:00 − 5:30 = 06:30 UTC on the same day.
    expect(instantForLocalNoon('2026-09-14', 'Asia/Kolkata').toISOString()).toBe(
      '2026-09-14T06:30:00.000Z',
    );
  });
});

describe('instantForLocalNoon — Pacific/Auckland regression (hand-computed)', () => {
  it('places local noon on 2026-09-14 at 2026-09-14T00:00:00Z, not noon UTC', () => {
    // Arithmetic, worked by hand:
    //   2026-09-01 is a Tuesday, so that month's Sundays are the 6th, 13th, 20th and 27th. NZDT
    //   (UTC+13) begins on the last of those — the 27th — so the 14th is still NZST, UTC+12.
    //   Local noon on the 14th = 12:00 − 12:00 = 00:00 UTC on the same day.
    const instant = instantForLocalNoon('2026-09-14', 'Pacific/Auckland');

    expect(instant.toISOString().startsWith('2026-09-14')).toBe(true);
    expect(instant.toISOString()).toBe('2026-09-14T00:00:00.000Z');

    // Why the old client behaviour was wrong: 2026-09-14T12:00:00Z is midnight on the 15th in
    // Auckland, so a client that invents noon UTC files the transaction a day late — and at a
    // month boundary, in the wrong month.
    expect(instant.toISOString()).not.toBe('2026-09-14T12:00:00.000Z');
    expect(toLocalDate(new Date('2026-09-14T12:00:00.000Z'), 'Pacific/Auckland')).toBe('2026-09-15');

    // Once NZDT starts a fortnight later, local noon moves to 23:00 UTC on the previous day.
    expect(instantForLocalNoon('2026-10-14', 'Pacific/Auckland').toISOString()).toBe(
      '2026-10-13T23:00:00.000Z',
    );
  });
});

describe('instantForLocalNoon — invalid input', () => {
  it('throws DateError for a malformed date', () => {
    expect(() => instantForLocalNoon('14/09/2026', 'UTC')).toThrow(DateError);
  });

  it('throws DateError for an impossible calendar day', () => {
    expect(() => instantForLocalNoon('2026-02-31', 'UTC')).toThrow(DateError);
  });

  it('throws a clear DateError for an unknown time zone', () => {
    expect(() => instantForLocalNoon('2026-09-14', 'Mars/Olympus')).toThrow(DateError);
    expect(() => instantForLocalNoon('2026-09-14', 'Mars/Olympus')).toThrow(
      /not a valid IANA time zone/,
    );
  });
});

describe('addDays', () => {
  it('shifts across month and year boundaries', () => {
    expect(addDays('2026-09-14', 1)).toBe('2026-09-15');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-09-14', -90)).toBe('2026-06-16');
  });

  it('is not affected by the process timezone, because it works in UTC', () => {
    // A DST-shifting day in Europe/Belgrade: local-time arithmetic would land on the 30th.
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
  });

  it('refuses a malformed date rather than returning NaN', () => {
    expect(() => addDays('14/09/2026', 1)).toThrow(DateError);
  });
});

describe('addMonths', () => {
  it('lands on the same day of the target month', () => {
    expect(addMonths('2026-09-14', -1)).toBe('2026-08-14');
    expect(addMonths('2026-09-14', -3)).toBe('2026-06-14');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
  });

  it('clamps to the target month length instead of sliding into the next month', () => {
    // `Date.UTC` would make this 2026-03-03; a period comparison means "the same month last month".
    expect(addMonths('2026-03-31', -1)).toBe('2026-02-28');
    expect(addMonths('2024-03-31', -1)).toBe('2024-02-29');
  });
});
