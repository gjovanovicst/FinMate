import { describe, expect, it } from 'vitest';

import {
  EMPTY_DRAFT,
  activeGoals,
  canContribute,
  contributionProblem,
  dateLabel,
  draftProblem,
  goalWriteInput,
  orderedGoals,
  percent,
  rateLabelKey,
  statusLabelKey,
  type Goal,
} from './goals.view';

/**
 * The goals screen's decisions.
 *
 * These are the ones that are wrong silently: a typed target read a second, different way; a list that
 * reshuffles; a goal with no deadline rendered as *0 per month* instead of a nudge; and a submission
 * that could be saved twice because the key was regenerated.
 */

const money = (minor: string) => ({ amountMinor: minor, currency: 'RSD' });

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    name: 'Letovanje',
    target: money('12000000'),
    targetDate: '2027-06-01',
    accountId: null,
    account: null,
    status: 'ACTIVE',
    contributed: money('2100000'),
    remaining: money('9900000'),
    progress: 0.175,
    requiredPerMonth: money('1100000'),
    monthsRemaining: 9,
    contributions: [],
    ...overrides,
  };
}

describe('the create form', () => {
  it('reads a typed target once, through the domain parser', () => {
    const input = goalWriteInput({ ...EMPTY_DRAFT, name: '  Auto  ', target: '400.000' }, 'RSD');

    expect(input).toEqual({
      name: 'Auto',
      targetMinor: 40_000_000n,
      targetDate: null,
      accountId: null,
    });
  });

  it('says which field is wrong rather than letting the API find out', () => {
    expect(draftProblem({ ...EMPTY_DRAFT, target: '1000' }, 'RSD')).toBe('NAME');
    expect(draftProblem({ ...EMPTY_DRAFT, name: 'Auto', target: '' }, 'RSD')).toBe('TARGET');
    expect(draftProblem({ ...EMPTY_DRAFT, name: 'Auto', target: 'nema' }, 'RSD')).toBe('TARGET');
    // Zero is refused here too: the column is CHECK (target_minor > 0).
    expect(draftProblem({ ...EMPTY_DRAFT, name: 'Auto', target: '0' }, 'RSD')).toBe('TARGET');
    expect(
      draftProblem({ ...EMPTY_DRAFT, name: 'Auto', target: '1000', targetDate: '01.06.2027' }, 'RSD'),
    ).toBe('TARGET_DATE');
    expect(
      draftProblem({ ...EMPTY_DRAFT, name: 'Auto', target: '1000', targetDate: '2027-06-01' }, 'RSD'),
    ).toBeNull();
  });

  it('refuses to build an input from an invalid draft', () => {
    expect(goalWriteInput(EMPTY_DRAFT, 'RSD')).toBeNull();
  });

  it('accepts a deadline and an account when they are given', () => {
    const input = goalWriteInput(
      { name: 'Auto', target: '400000', targetDate: '2028-03-01', accountId: 'a1' },
      'RSD',
    );
    expect(input?.targetDate).toBe('2028-03-01');
    expect(input?.accountId).toBe('a1');
  });
});

describe('the contribution form', () => {
  it('refuses an unreadable or zero amount, so a double-tap cannot save nothing', () => {
    expect(contributionProblem('', 'RSD')).toBe('AMOUNT');
    expect(contributionProblem('0', 'RSD')).toBe('AMOUNT');
    expect(contributionProblem('nema', 'RSD')).toBe('AMOUNT');
    expect(contributionProblem('1.050', 'RSD')).toBeNull();
  });
});

describe('the list order', () => {
  it('puts active goals first, soonest deadline first, and archived last', () => {
    const soonest = goal({ id: 'a', name: 'A', targetDate: '2027-01-01' });
    const later = goal({ id: 'b', name: 'B', targetDate: '2027-09-01' });
    const noDate = goal({ id: 'c', name: 'C', targetDate: null });
    const achieved = goal({ id: 'd', name: 'D', status: 'ACHIEVED', targetDate: '2026-01-01' });
    const archived = goal({ id: 'e', name: 'E', status: 'ARCHIVED', targetDate: '2026-01-01' });

    expect(orderedGoals([archived, later, achieved, noDate, soonest]).map((row) => row.name)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
    ]);
  });

  it('breaks a tie on the name, so two goals never swap places', () => {
    const first = goal({ id: 'x', name: 'Auto', targetDate: null });
    const second = goal({ id: 'y', name: 'Bicikl', targetDate: null });
    expect(orderedGoals([second, first]).map((row) => row.name)).toEqual(['Auto', 'Bicikl']);
  });

  it('hides the archived ones from the main list', () => {
    expect(activeGoals([goal(), goal({ id: 'z', status: 'ARCHIVED' })])).toHaveLength(1);
  });
});

describe('what a card says', () => {
  it('rounds progress to a whole percent and clamps it', () => {
    expect(percent(0.175)).toBe(18);
    expect(percent(1.4)).toBe(100);
    expect(percent(Number.NaN)).toBe(0);
  });

  it('nudges for a date instead of printing a rate when there is none', () => {
    expect(rateLabelKey(goal())).toBe('goals.rate');
    expect(rateLabelKey(goal({ targetDate: null, requiredPerMonth: null }))).toBe('goals.noDate');
  });

  it('labels the three statuses', () => {
    expect(statusLabelKey('ACTIVE')).toBe('goals.statusActive');
    expect(statusLabelKey('ACHIEVED')).toBe('goals.statusAchieved');
    expect(statusLabelKey('ARCHIVED')).toBe('goals.statusArchived');
  });

  it('refuses to contribute to an archived goal, which the API refuses too', () => {
    expect(canContribute(goal())).toBe(true);
    expect(canContribute(goal({ status: 'ARCHIVED' }))).toBe(false);
  });

  it('formats a goal day without touching the money formatter', () => {
    expect(dateLabel('2027-06-01', 'en-GB')).toContain('2027');
    // UTC: a date-only value must not shift a day for a reader west of Greenwich.
    expect(dateLabel('2027-01-01', 'en-GB')).toContain('Jan');
  });
});
