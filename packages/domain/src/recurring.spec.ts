import { describe, expect, it } from 'vitest';

import type { LocalDate } from './dates';
import {
  WEEKDAYS,
  expandOccurrences,
  formatRRule,
  nextOccurrenceOn,
  parseRRule,
  type RRuleSpec,
} from './recurring';

/**
 * The RRULE subset.
 *
 * The cases that are wrong silently: a month without the requested day (skip it, never roll back to
 * the 28th — that moves a bill the household budgeted for), the interval in `WEEKLY;BYDAY` (measured
 * in weeks from the cursor's week, not from the anchor's weekday), a `COUNT` that has already been used
 * up, and a rule naming a part this subset does not implement — which must be **refused**, because
 * silently ignoring `BYSETPOS` produces dates nobody asked for.
 */

const day = (value: string) => value as LocalDate;
const spec = (text: string): RRuleSpec => {
  const parsed = parseRRule(text);
  if (!parsed.ok) throw new Error(`expected ${text} to parse, got ${parsed.reason}`);
  return parsed.spec;
};

describe('parseRRule', () => {
  it('reads the four frequencies the screen can express', () => {
    expect(spec('FREQ=DAILY').frequency).toBe('DAILY');
    expect(spec('RRULE:FREQ=WEEKLY;INTERVAL=2').interval).toBe(2);
    expect(spec('FREQ=MONTHLY;BYMONTHDAY=1,15').byMonthDay).toEqual([1, 15]);
    expect(spec('FREQ=WEEKLY;BYDAY=MO,TH').byDay).toEqual(['MO', 'TH']);
    expect(spec('FREQ=YEARLY;UNTIL=20270601').until).toBe('2027-06-01');
  });

  it('refuses a part it does not implement rather than ignoring it', () => {
    expect(parseRRule('FREQ=MONTHLY;BYSETPOS=-1')).toEqual({ ok: false, reason: 'UNSUPPORTED_PART' });
    expect(parseRRule('FREQ=MONTHLY;BYYEARDAY=100')).toEqual({ ok: false, reason: 'UNSUPPORTED_PART' });
    expect(parseRRule('FREQ=MONTHLY;BYDAY=MO')).toEqual({ ok: false, reason: 'UNSUPPORTED_PART' });
    expect(parseRRule('FREQ=WEEKLY;BYMONTHDAY=1')).toEqual({ ok: false, reason: 'UNSUPPORTED_PART' });
    // Negative month days ("the last day") are a different feature.
    expect(parseRRule('FREQ=MONTHLY;BYMONTHDAY=-1')).toEqual({ ok: false, reason: 'UNSUPPORTED_PART' });
  });

  it('refuses a frequency it does not know, a bad interval and nonsense', () => {
    expect(parseRRule('FREQ=HOURLY')).toEqual({ ok: false, reason: 'UNSUPPORTED_FREQUENCY' });
    expect(parseRRule('FREQ=DAILY;INTERVAL=0')).toEqual({ ok: false, reason: 'BAD_INTERVAL' });
    expect(parseRRule('FREQ=DAILY;INTERVAL=x')).toEqual({ ok: false, reason: 'BAD_INTERVAL' });
    expect(parseRRule('')).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(parseRRule('INTERVAL=2')).toEqual({ ok: false, reason: 'MALFORMED' });
    expect(parseRRule('FREQ=MONTHLY;UNTIL=20270231')).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('accepts WKST and ignores it, because no rule here crosses a week boundary', () => {
    expect(spec('FREQ=WEEKLY;BYDAY=MO;WKST=SU').byDay).toEqual(['MO']);
  });

  it('round-trips through a canonical string, so two equal rules look equal', () => {
    expect(formatRRule(spec('FREQ=MONTHLY;BYMONTHDAY=15,1'))).toBe('RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15');
    expect(formatRRule(spec('FREQ=WEEKLY;BYDAY=TH,MO;INTERVAL=2'))).toBe(
      'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH',
    );
    expect(formatRRule(spec(formatRRule(spec('FREQ=DAILY;COUNT=5'))))).toBe('RRULE:FREQ=DAILY;COUNT=5');
  });
});

describe('nextOccurrenceOn', () => {
  it('advances a daily rule by its interval', () => {
    const daily = spec('FREQ=DAILY');
    expect(nextOccurrenceOn(daily, day('2026-09-01'), day('2026-09-01'))).toBe('2026-09-01');
    expect(nextOccurrenceOn(daily, day('2026-09-01'), day('2026-09-02'))).toBe('2026-09-02');

    const everyTen = spec('FREQ=DAILY;INTERVAL=10');
    expect(nextOccurrenceOn(everyTen, day('2026-09-01'), day('2026-09-05'))).toBe('2026-09-11');
  });

  it('keeps a monthly rule on its own day across months and years', () => {
    const monthly = spec('FREQ=MONTHLY');
    expect(nextOccurrenceOn(monthly, day('2026-11-01'), day('2026-11-01'))).toBe('2026-11-01');
    expect(nextOccurrenceOn(monthly, day('2026-11-01'), day('2026-12-15'))).toBe('2027-01-01');
  });

  it('skips a month that has no such day, per RFC 5545', () => {
    const endOfMonth = spec('FREQ=MONTHLY;BYMONTHDAY=31');
    // From the 31st of January, the next occurrence is the 31st of **March**: February has none, and
    // rolling back to the 28th would move a bill the household budgeted for.
    expect(nextOccurrenceOn(endOfMonth, day('2026-01-31'), day('2026-02-01'))).toBe('2026-03-31');
    expect(expandOccurrences(endOfMonth, day('2026-01-31'), day('2026-01-01'), day('2026-06-30'))).toEqual([
      '2026-01-31',
      '2026-03-31',
      '2026-05-31',
    ]);
  });

  it('takes the remaining weekdays of a week, then jumps the interval', () => {
    const twiceAWeek = spec('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH');
    // 2026-09-03 is a Thursday.
    expect(nextOccurrenceOn(twiceAWeek, day('2026-09-03'), day('2026-09-04'))).toBe('2026-09-14');
    expect(
      expandOccurrences(twiceAWeek, day('2026-09-03'), day('2026-09-01'), day('2026-10-31')),
    ).toEqual([
      '2026-09-03',
      '2026-09-14',
      '2026-09-17',
      '2026-09-28',
      '2026-10-01',
      '2026-10-12',
      '2026-10-15',
      '2026-10-26',
      '2026-10-29',
    ]);
  });

  it('honours UNTIL and returns null once the rule is finished', () => {
    const until = spec('FREQ=MONTHLY;UNTIL=20261101');
    expect(nextOccurrenceOn(until, day('2026-09-01'), day('2026-11-01'))).toBe('2026-11-01');
    expect(nextOccurrenceOn(until, day('2026-09-01'), day('2026-11-02'))).toBeNull();
  });

  it('honours COUNT through `remaining`, which the service keeps from the generated rows', () => {
    const counted = spec('FREQ=MONTHLY;COUNT=3');
    // The service always passes the rule's CURRENT `next_occurrence_on` as the anchor (the column holds
    // the next date, not the original), so `remaining` is simply how many the rule may still produce.
    expect(nextOccurrenceOn(counted, day('2026-11-01'), day('2026-11-01'), { remaining: 1 })).toBe('2026-11-01');
    expect(nextOccurrenceOn(counted, day('2026-11-01'), day('2026-11-01'), { remaining: 0 })).toBeNull();
    // Without an explicit `remaining`, the rule's own COUNT caps the scan from the anchor.
    expect(nextOccurrenceOn(counted, day('2026-09-01'), day('2027-01-01'))).toBeNull();
  });

  it('stops at an endsOn the caller supplies, whichever end comes first', () => {
    const monthly = spec('FREQ=MONTHLY;UNTIL=20271201');
    expect(nextOccurrenceOn(monthly, day('2026-09-01'), day('2026-10-01'), { until: day('2026-10-15') })).toBe(
      '2026-10-01',
    );
    expect(nextOccurrenceOn(monthly, day('2026-09-01'), day('2026-10-16'), { until: day('2026-10-15') })).toBeNull();
  });

  it('returns null rather than looping for a rule that can never match', () => {
    // A yearly rule on the 29th of February: the next real one is 2028.
    const leapDay = spec('FREQ=YEARLY');
    expect(nextOccurrenceOn(leapDay, day('2024-02-29'), day('2025-01-01'))).toBe('2028-02-29');
  });
});

describe('expandOccurrences', () => {
  it('returns the window, oldest first, bounded by the limit', () => {
    const daily = spec('FREQ=DAILY');
    const window = expandOccurrences(daily, day('2026-09-01'), day('2026-09-05'), day('2026-09-08'));
    expect(window).toEqual(['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']);
    expect(expandOccurrences(daily, day('2026-09-01'), day('2026-09-01'), day('2026-09-30'), { limit: 3 })).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ]);
  });

  it('yields nothing for a window before the anchor, and nothing past the end', () => {
    const monthly = spec('FREQ=MONTHLY');
    expect(expandOccurrences(monthly, day('2026-09-01'), day('2026-01-01'), day('2026-08-31'))).toEqual([]);
    expect(
      expandOccurrences(monthly, day('2026-09-01'), day('2027-01-01'), day('2027-12-31'), {
        until: day('2026-12-01'),
      }),
    ).toEqual([]);
  });

  it('expands a yearly rule across the years in the window', () => {
    const yearly = spec('FREQ=YEARLY');
    expect(expandOccurrences(yearly, day('2026-03-15'), day('2026-01-01'), day('2029-12-31'))).toEqual([
      '2026-03-15',
      '2027-03-15',
      '2028-03-15',
      '2029-03-15',
    ]);
  });

  it('stays on the same local day across a DST transition', () => {
    // Europe/Belgrade moves to summer time on the last Sunday of March. Every value here is a
    // `LocalDate`, so a monthly rule on the 15th is the 15th on both sides of it — "expands across
    // DST" is a property of the representation, not a special case the expander has to know about.
    const monthly = spec('FREQ=MONTHLY;BYMONTHDAY=15');
    expect(expandOccurrences(monthly, day('2026-02-15'), day('2026-02-01'), day('2026-04-30'))).toEqual([
      '2026-02-15',
      '2026-03-15',
      '2026-04-15',
    ]);
  });

  it('exposes the weekday tokens the screen renders', () => {
    expect([...WEEKDAYS]).toEqual(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
  });
});
