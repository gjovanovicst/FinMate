import { describe, expect, it } from 'vitest';

import type { LocalDate } from '@finmate/domain';

import {
  EMPTY_DRAFT,
  buildRRule,
  describeSchedule,
  draftFromRule,
  draftProblem,
  intervalOf,
  orderedRules,
  problemKey,
  ruleWriteInput,
  upcomingWithin,
  weekdayLabelKey,
  type RecurringRule,
} from './recurring.view';

/**
 * The recurring screen's decisions.
 *
 * The one that matters most is the **pair** of `buildRRule` and `describeSchedule`: the first is what
 * the API stores and expands, the second is what the user is told it does. If they disagree, the screen
 * lies about when money moves — so the tests below assert the sentence each builder output produces,
 * including the inverse round trip through `draftFromRule`.
 */

const money = (minor: string) => ({ amountMinor: minor, currency: 'RSD' });

function rule(overrides: Partial<RecurringRule> = {}): RecurringRule {
  return {
    id: 'r1',
    accountId: 'a1',
    accountName: 'Tekući',
    kind: 'EXPENSE',
    amount: money('129900'),
    categoryId: null,
    description: 'Netflix',
    rrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15',
    nextOccurrenceOn: '2026-09-15',
    endsOn: null,
    autoConfirm: true,
    isDetected: false,
    isActive: true,
    generatedCount: 0,
    upcomingOccurrences: ['2026-09-15', '2026-10-15'],
    ...overrides,
  };
}

describe('building a schedule from the form', () => {
  it('writes the frequency, the interval and the day the user picked', () => {
    expect(buildRRule({ ...EMPTY_DRAFT, frequency: 'DAILY' })).toBe('RRULE:FREQ=DAILY');
    expect(buildRRule({ ...EMPTY_DRAFT, frequency: 'DAILY', interval: '10' })).toBe(
      'RRULE:FREQ=DAILY;INTERVAL=10',
    );
    expect(buildRRule({ ...EMPTY_DRAFT, frequency: 'MONTHLY', startsOn: '2026-11-05' })).toBe(
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=5',
    );
    expect(buildRRule({ ...EMPTY_DRAFT, frequency: 'MONTHLY', interval: '3', startsOn: '2026-11-05' })).toBe(
      'RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=5',
    );
    expect(
      buildRRule({ ...EMPTY_DRAFT, frequency: 'WEEKLY', interval: '2', byDay: ['MO', 'TH'] }),
    ).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH');
    expect(buildRRule({ ...EMPTY_DRAFT, frequency: 'YEARLY', startsOn: '2027-03-01' })).toBe(
      'RRULE:FREQ=YEARLY',
    );
  });

  it('carries an end date as UNTIL', () => {
    expect(buildRRule({ ...EMPTY_DRAFT, frequency: 'MONTHLY', startsOn: '2026-11-05', endsOn: '2027-06-05' })).toBe(
      'RRULE:FREQ=MONTHLY;BYMONTHDAY=5;UNTIL=20270605',
    );
  });

  it('treats a blank or unreadable interval as 1 rather than as a broken schedule', () => {
    expect(intervalOf({ ...EMPTY_DRAFT, interval: '' })).toBe(1);
    expect(intervalOf({ ...EMPTY_DRAFT, interval: 'x' })).toBe(1);
    expect(intervalOf({ ...EMPTY_DRAFT, interval: '0' })).toBe(1);
    expect(intervalOf({ ...EMPTY_DRAFT, interval: '7' })).toBe(7);
  });
});

describe('the sentence the user reads', () => {
  it('describes every schedule the builder can produce', () => {
    expect(describeSchedule('RRULE:FREQ=DAILY')).toEqual({ key: 'recurring.everyDay', params: {} });
    expect(describeSchedule('RRULE:FREQ=DAILY;INTERVAL=10')).toEqual({
      key: 'recurring.everyNDays',
      params: { count: 10 },
    });
    expect(describeSchedule('RRULE:FREQ=WEEKLY;BYDAY=MO,TH')).toEqual({
      key: 'recurring.everyWeekOn',
      params: { days: 'MO,TH' },
    });
    expect(describeSchedule('RRULE:FREQ=MONTHLY;BYMONTHDAY=5')).toEqual({
      key: 'recurring.everyMonthOn',
      params: { day: 5 },
    });
    expect(describeSchedule('RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=5')).toEqual({
      key: 'recurring.everyNMonthsOn',
      params: { count: 3, day: 5 },
    });
    expect(describeSchedule('RRULE:FREQ=YEARLY')).toEqual({ key: 'recurring.everyYear', params: {} });
  });

  it('says nothing rather than something wrong for a rule it cannot read', () => {
    expect(describeSchedule('nonsense')).toBeNull();
  });

  it('labels the weekdays the picker offers', () => {
    expect(weekdayLabelKey('MO')).toBe('recurring.day.MO');
    expect(weekdayLabelKey('SU')).toBe('recurring.day.SU');
  });
});

describe('editing an existing rule', () => {
  it('round-trips the form through the schedule and back', () => {
    const draft = { ...EMPTY_DRAFT, frequency: 'WEEKLY' as const, interval: '2', byDay: ['MO', 'TH'] as const };
    const stored = buildRRule(draft);
    const reloaded = draftFromRule(rule({ rrule: stored, byDay: undefined } as Partial<RecurringRule>));

    expect(reloaded.frequency).toBe('WEEKLY');
    expect(reloaded.interval).toBe('2');
    expect(reloaded.byDay).toEqual(['MO', 'TH']);
  });

  it('prefills the form from the rule it is editing', () => {
    const draft = draftFromRule(rule({ rrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1', endsOn: '2026-12-01' }));

    expect(draft.description).toBe('Netflix');
    expect(draft.amount).toBe('129900');
    expect(draft.accountId).toBe('a1');
    expect(draft.frequency).toBe('MONTHLY');
    expect(draft.startsOn).toBe('2026-09-15');
    expect(draft.endsOn).toBe('2026-12-01');
    expect(draft.autoConfirm).toBe(true);
  });
});

describe('the form’s write plan', () => {
  const valid = {
    ...EMPTY_DRAFT,
    description: '  EPS  ',
    amount: '4.200',
    accountId: 'a1',
    startsOn: '2026-11-01',
  };

  it('names the field that is wrong', () => {
    expect(draftProblem({ ...valid, description: ' ' }, 'RSD')).toBe('DESCRIPTION');
    expect(draftProblem({ ...valid, amount: 'nema' }, 'RSD')).toBe('AMOUNT');
    expect(draftProblem({ ...valid, amount: '0' }, 'RSD')).toBe('AMOUNT');
    expect(draftProblem({ ...valid, accountId: '' }, 'RSD')).toBe('ACCOUNT');
    expect(draftProblem({ ...valid, interval: '0' }, 'RSD')).toBe('INTERVAL');
    expect(draftProblem({ ...valid, startsOn: '01.11.2026' }, 'RSD')).toBe('START_DATE');
    expect(draftProblem({ ...valid, endsOn: '01.11.2026' }, 'RSD')).toBe('END_DATE');
    expect(draftProblem(valid, 'RSD')).toBeNull();
  });

  it('maps a problem onto a sentence', () => {
    expect(problemKey('DESCRIPTION')).toBe('recurring.problem.DESCRIPTION');
    expect(problemKey('END_DATE')).toBe('recurring.problem.DATE');
  });

  it('builds the mutation input, reading the amount once', () => {
    const input = ruleWriteInput(valid, 'RSD');

    expect(input).toEqual({
      accountId: 'a1',
      kind: 'EXPENSE',
      amountMinor: 420_000n,
      description: 'EPS',
      rrule: 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1',
      startsOn: '2026-11-01',
      endsOn: null,
      autoConfirm: false,
    });
    expect(ruleWriteInput({ ...valid, description: '' }, 'RSD')).toBeNull();
  });
});

describe('the list and the next 30 days', () => {
  const today = '2026-09-20' as LocalDate;

  it('orders active rules first, soonest first', () => {
    const later = rule({ id: 'b', description: 'B', nextOccurrenceOn: '2026-11-01' });
    const sooner = rule({ id: 'a', description: 'A', nextOccurrenceOn: '2026-10-01' });
    const off = rule({ id: 'c', description: 'C', isActive: false, nextOccurrenceOn: '2026-09-21' });

    expect(orderedRules([off, later, sooner]).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('flattens the server-expanded dates inside the window, and nothing else', () => {
    const soon = rule({ id: 'a', description: 'Netflix', upcomingOccurrences: ['2026-09-25', '2026-10-25', '2026-11-25'] });
    const later = rule({ id: 'b', description: 'EPS', upcomingOccurrences: ['2026-11-01'] });
    const off = rule({ id: 'c', description: 'Off', isActive: false, upcomingOccurrences: ['2026-09-22'] });

    const entries = upcomingWithin([soon, later, off], today, 30);
    // The window is `today … today+30` (2026-09-20 … 2026-10-20), so the September date is in and the
    // October 25th and November dates are not; the deactivated rule contributes nothing at all.
    expect(entries.map((entry) => [entry.date, entry.description])).toEqual([['2026-09-25', 'Netflix']]);
  });

  it('never shows a date the API did not produce, and breaks a tie by description', () => {
    const one = rule({ id: 'a', description: 'Zeta', upcomingOccurrences: ['2026-10-01'] });
    const two = rule({ id: 'b', description: 'Alfa', upcomingOccurrences: ['2026-10-01'] });

    expect(upcomingWithin([one, two], today).map((entry) => entry.description)).toEqual(['Alfa', 'Zeta']);
    expect(upcomingWithin([rule({ upcomingOccurrences: [] })], today)).toEqual([]);
  });
});
