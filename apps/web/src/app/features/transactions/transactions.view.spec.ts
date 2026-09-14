import { describe, expect, it } from 'vitest';

import type { MoneyWire } from '../../shared/ui/money/money.component';
import {
  emptyFilters,
  groupByDay,
  hasActiveFilters,
  localNoonInstant,
  toQueryVariables,
  totalOf,
  type TransactionRow,
} from './transactions.view';

const rsd = (amountMinor: string): MoneyWire => ({ amountMinor, currency: 'RSD' });

let sequence = 0;
function row(overrides: Partial<TransactionRow> = {}): TransactionRow {
  sequence += 1;
  return {
    id: `00000000-0000-7000-8000-${String(sequence).padStart(12, '0')}`,
    kind: 'EXPENSE',
    status: 'CONFIRMED',
    amount: rsd('100000'),
    description: 'Lidl',
    note: null,
    occurredAt: '2026-09-14T12:00:00.000Z',
    occurredLocalDate: '2026-09-14',
    categoryId: null,
    accountId: 'acc',
    needsReview: false,
    version: 1,
    splits: [],
    ...overrides,
  };
}

describe('groupByDay', () => {
  it('groups rows by their local calendar day, preserving server order', () => {
    const groups = groupByDay(
      [
        row({ occurredLocalDate: '2026-09-14' }),
        row({ occurredLocalDate: '2026-09-13' }),
        row({ occurredLocalDate: '2026-09-13' }),
      ],
      false,
    );

    expect(groups.map((group) => group.date)).toEqual(['2026-09-14', '2026-09-13']);
    expect(groups[1]?.rows).toHaveLength(2);
  });

  it('sums expenses and income separately, never netting them', () => {
    const groups = groupByDay(
      [
        row({ kind: 'EXPENSE', amount: rsd('200000') }),
        row({ kind: 'EXPENSE', amount: rsd('5000') }),
        row({ kind: 'INCOME', amount: rsd('14500000') }),
      ],
      false,
    );

    expect(groups[0]?.expenseTotal).toEqual({ amountMinor: 205000n, currency: 'RSD' });
    expect(groups[0]?.incomeTotal).toEqual({ amountMinor: 14500000n, currency: 'RSD' });
  });

  it('reports null rather than a zero total for a day with no expenses', () => {
    const groups = groupByDay([row({ kind: 'INCOME' })], false);
    expect(groups[0]?.expenseTotal).toBeNull();
    expect(groups[0]?.incomeTotal).not.toBeNull();
  });

  it('withholds the total for the truncated oldest day while another page exists', () => {
    // The regression this pins: summing only the loaded rows and printing "total" shows a number
    // that grows as the user scrolls. The newest day is complete and must still be totalled.
    const groups = groupByDay(
      [
        row({ occurredLocalDate: '2026-09-14', amount: rsd('200000') }),
        row({ occurredLocalDate: '2026-09-13', amount: rsd('200000') }),
      ],
      true,
    );

    expect(groups[0]?.expenseTotal).toEqual({ amountMinor: 200000n, currency: 'RSD' });
    expect(groups[1]?.expenseTotal).toBeNull();
  });

  it('totals every day once the last page has been loaded', () => {
    const groups = groupByDay(
      [
        row({ occurredLocalDate: '2026-09-14', amount: rsd('200000') }),
        row({ occurredLocalDate: '2026-09-13', amount: rsd('300000') }),
      ],
      false,
    );

    expect(groups[0]?.expenseTotal).toEqual({ amountMinor: 200000n, currency: 'RSD' });
    expect(groups[1]?.expenseTotal).toEqual({ amountMinor: 300000n, currency: 'RSD' });
  });

  it('sums exactly, with no floating-point drift', () => {
    // 0.1 + 0.2 in minor units is still 30 para — the property that makes BIGINT the right choice.
    const groups = groupByDay([row({ amount: rsd('10') }), row({ amount: rsd('20') })], false);
    expect(groups[0]?.expenseTotal?.amountMinor).toBe(30n);
  });

  it('handles an empty page', () => {
    expect(groupByDay([], true)).toEqual([]);
  });
});

describe('hasActiveFilters', () => {
  it('is false for the empty filter set and for whitespace-only search', () => {
    expect(hasActiveFilters(emptyFilters())).toBe(false);
    expect(hasActiveFilters({ ...emptyFilters(), search: '   ' })).toBe(false);
  });

  it('is true when any single filter is set', () => {
    expect(hasActiveFilters({ ...emptyFilters(), kind: 'EXPENSE' })).toBe(true);
    expect(hasActiveFilters({ ...emptyFilters(), needsReviewOnly: true })).toBe(true);
    expect(hasActiveFilters({ ...emptyFilters(), from: '2026-09-01' })).toBe(true);
  });
});

describe('toQueryVariables', () => {
  it('omits blank filters entirely rather than sending empty strings', () => {
    // An empty `search` would be a substring match against '' and a null `kind` an enum error.
    const variables = toQueryVariables(emptyFilters());
    expect(variables).toEqual({ first: 25 });
  });

  it('trims search and passes the rest through', () => {
    const variables = toQueryVariables({
      ...emptyFilters(),
      search: '  lidl ',
      kind: 'EXPENSE',
      needsReviewOnly: true,
      from: '2026-09-01',
      to: '2026-09-30',
    });

    expect(variables).toEqual({
      first: 25,
      search: 'lidl',
      kind: 'EXPENSE',
      from: '2026-09-01',
      to: '2026-09-30',
      needsReview: true,
    });
  });

  it('only sends the cursor when there is one, so the first page has no `after`', () => {
    expect(toQueryVariables(emptyFilters(), { after: null })).not.toHaveProperty('after');
    expect(toQueryVariables(emptyFilters(), { after: 'cursor-1' })).toHaveProperty(
      'after',
      'cursor-1',
    );
  });

  it('honours an explicit page size', () => {
    expect(toQueryVariables(emptyFilters(), { first: 5 })).toEqual({ first: 5 });
  });
});

describe('totalOf', () => {
  it('sums exactly and returns null for an empty list', () => {
    expect(totalOf([])).toBeNull();
    expect(totalOf([{ amountMinor: 10n, currency: 'RSD' }])).toEqual({
      amountMinor: 10n,
      currency: 'RSD',
    });
    expect(
      totalOf([
        { amountMinor: 10n, currency: 'RSD' },
        { amountMinor: 20n, currency: 'RSD' },
      ])?.amountMinor,
    ).toBe(30n);
  });

  it('refuses to add two currencies together', () => {
    // Silently summing RSD and EUR would produce a number that is not money in any currency.
    expect(() =>
      totalOf([
        { amountMinor: 10n, currency: 'RSD' },
        { amountMinor: 20n, currency: 'EUR' },
      ]),
    ).toThrow();
  });
});

describe('localNoonInstant', () => {
  it('is local noon, so the calendar day survives the round trip in the device timezone', () => {
    const iso = localNoonInstant('2026-09-14');
    const back = new Date(iso);
    expect(back.getFullYear()).toBe(2026);
    expect(back.getMonth()).toBe(8);
    expect(back.getDate()).toBe(14);
    expect(back.getHours()).toBe(12);
  });

  it('is NOT noon UTC, which is the value that shifted the day for eastern timezones', () => {
    // The regression: `2026-09-14T12:00:00.000Z` is the 15th in Pacific/Auckland.
    const iso = localNoonInstant('2026-09-14');
    const offsetMinutes = new Date(iso).getTimezoneOffset();
    if (offsetMinutes !== 0) expect(iso).not.toBe('2026-09-14T12:00:00.000Z');
  });

  it('rejects a non-date', () => {
    expect(() => localNoonInstant('not-a-date')).toThrow();
  });
});
