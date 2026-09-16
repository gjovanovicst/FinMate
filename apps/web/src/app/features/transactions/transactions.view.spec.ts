import { describe, expect, it } from 'vitest';

import type { SnapshotRow } from '../../core/offline/offline-store';
import type { MoneyWire } from '../../shared/ui/money/money.component';
import {
  planSaveFailure,
  emptyFilters,
  exportUrl,
  filenameFromContentDisposition,
  filterQueryFromBag,
  filterQueryString,
  filtersFromQuery,
  groupByDay,
  groupCachedByDay,
  hasActiveFilters,
  localNoonInstant,
  planEdit,
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
    attachmentId: null,
    version: 1,
    splits: [],
    ...overrides,
  };
}

describe('planEdit', () => {
  const row = (over: Partial<TransactionRow> = {}): TransactionRow => ({
    id: 'tx-1',
    kind: 'EXPENSE',
    status: 'CONFIRMED',
    amount: { amountMinor: '200000', currency: 'RSD' },
    description: 'Lidl',
    note: null,
    occurredAt: '2026-09-14T10:00:00.000Z',
    occurredLocalDate: '2026-09-14',
    categoryId: 'cat-food',
    accountId: 'acct-1',
    needsReview: false,
    attachmentId: null,
    version: 1,
    splits: [],
    ...over,
  });

  const next = (over: Partial<Parameters<typeof planEdit>[0]> = {}) => ({
    current: row(),
    categoryId: 'cat-food',
    description: 'Lidl',
    occurredOn: '2026-09-14',
    status: 'CONFIRMED' as const,
    note: '',
    amountMinor: 200000n,
    ...over,
  });

  it('reports a category change as a correction and nothing else', () => {
    const plan = planEdit(next({ categoryId: 'cat-house' }));
    expect(plan).toEqual({
      categoryChanged: true,
      otherFieldsChanged: false,
      nextCategoryId: 'cat-house',
    });
  });

  it('clearing the category is a correction too', () => {
    // `null` means "clear it", and a cleared category is exactly the kind of change the review queue
    // and the learning loop care about.
    const plan = planEdit(next({ categoryId: null }));
    expect(plan.categoryChanged).toBe(true);
    expect(plan.nextCategoryId).toBeNull();
  });

  it('reports an unchanged category as no correction, so corrections stay meaningful', () => {
    expect(planEdit(next()).categoryChanged).toBe(false);
    expect(planEdit(next()).otherFieldsChanged).toBe(false);
  });

  it('separates a plain edit from a correction', () => {
    const plan = planEdit(next({ description: 'Lidl Zemun' }));
    expect(plan.categoryChanged).toBe(false);
    expect(plan.otherFieldsChanged).toBe(true);
  });

  it('reports both when both changed, so neither write is skipped', () => {
    const plan = planEdit(next({ categoryId: 'cat-house', description: 'Lidl Zemun' }));
    expect(plan.categoryChanged).toBe(true);
    expect(plan.otherFieldsChanged).toBe(true);
  });

  it('treats a trimmed-empty note as equal to no note', () => {
    expect(planEdit(next({ note: '   ' })).otherFieldsChanged).toBe(false);
    expect(planEdit(next({ note: 'kesa' })).otherFieldsChanged).toBe(true);
  });

  it('does not report a split transaction as edited when the amount is not editable', () => {
    // A split Transaction's total is fixed by its parts (I-1), so the sheet passes `null`. Comparing
    // `null` against the stored figure would mark every split row as edited on every save.
    const plan = planEdit(
      next({ current: row({ splits: [{ id: 's1', amount: { amountMinor: '200000', currency: 'RSD' }, categoryId: 'cat-food' }] }), amountMinor: null }),
    );
    expect(plan.otherFieldsChanged).toBe(false);
  });

  it('detects an amount change in bigint, with no float in between', () => {
    expect(planEdit(next({ amountMinor: 200000n })).otherFieldsChanged).toBe(false);
    expect(planEdit(next({ amountMinor: 200001n })).otherFieldsChanged).toBe(true);
    // Past 2^53, where a `Number` comparison would start reporting "unchanged" for a real edit.
    const huge = row({ amount: { amountMinor: '9007199254740993', currency: 'RSD' } });
    expect(planEdit(next({ current: huge, amountMinor: 9_007_199_254_740_993n })).otherFieldsChanged).toBe(false);
    expect(planEdit(next({ current: huge, amountMinor: 9_007_199_254_740_994n })).otherFieldsChanged).toBe(true);
  });
});

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

describe('exportUrl', () => {
  it('has no query string when nothing is filtered', () => {
    expect(exportUrl(emptyFilters())).toBe('/api/export/transactions.csv');
  });

  it('encodes the same filters the list sends, so the file matches the screen', () => {
    const url = exportUrl({
      ...emptyFilters(),
      search: ' lidl ',
      kind: 'EXPENSE',
      from: '2026-09-01',
      to: '2026-09-30',
      needsReviewOnly: true,
    });
    const query = new URLSearchParams(url.split('?')[1]);
    expect(query.get('search')).toBe('lidl');
    expect(query.get('kind')).toBe('EXPENSE');
    expect(query.get('from')).toBe('2026-09-01');
    expect(query.get('to')).toBe('2026-09-30');
    expect(query.get('needsReview')).toBe('true');
    // Paging must NOT leak into an export: it would cap the file at one page.
    expect(query.has('first')).toBe(false);
    expect(query.has('after')).toBe(false);
  });

  it('agrees with the GraphQL variables for the same filter', () => {
    const filters = { ...emptyFilters(), kind: 'INCOME' as const, search: 'plata' };
    const variables = toQueryVariables(filters);
    const query = new URLSearchParams(exportUrl(filters).split('?')[1]);
    for (const key of ['kind', 'search'] as const) {
      expect(query.get(key)).toBe(String(variables[key]));
    }
  });
});

describe('the drill-through a link carries', () => {
  it('keeps exactly the arguments the transactions query takes', () => {
    // The assistant's `drillThrough.filter` is a bag of these names (docs/06 §4.4). A key the screen
    // cannot apply is dropped rather than forwarded: a URL claiming `merchantId` and showing every
    // Merchant is a link that lies.
    expect(
      filterQueryFromBag({ from: '2026-09-01', to: '2026-09-30', merchantId: 'm1', search: '' }),
    ).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(filterQueryString({ merchantId: 'm1' })).toBe('');
  });

  it('reads a drill-through into the screen’s filter', () => {
    const filters = filtersFromQuery({
      from: '2026-09-01',
      to: '2026-09-30',
      kind: 'EXPENSE',
      categoryId: 'c1',
      needsReview: 'true',
    });

    expect(filters).toEqual({
      ...emptyFilters(),
      from: '2026-09-01',
      to: '2026-09-30',
      kind: 'EXPENSE',
      categoryId: 'c1',
      needsReviewOnly: true,
    });
    expect(hasActiveFilters(filters)).toBe(true);
  });

  it('applies only the keys the link carried, so it does not clear what the user chose', () => {
    const base = { ...emptyFilters(), categoryId: 'mine', search: 'lidl' };
    expect(filtersFromQuery({ from: '2026-09-01' }, base)).toEqual({
      ...base,
      from: '2026-09-01',
    });
  });

  it('drops a kind the API would reject instead of turning a typo into a validation error', () => {
    // The URL is user-editable, and the screen did nothing wrong.
    expect(filtersFromQuery({ kind: 'nonsense' }).kind).toBe('');
    expect(filtersFromQuery({ kind: 'INCOME' }).kind).toBe('INCOME');
  });

  it('treats a needsReview that is not "true" as the blocking lane, not as unset', () => {
    expect(filtersFromQuery({ needsReview: 'true' }).needsReviewOnly).toBe(true);
    expect(filtersFromQuery({ needsReview: 'false' }).needsReviewOnly).toBe(false);
  });

  it('reads nothing out of an empty query, which is how the screen opens normally', () => {
    expect(filtersFromQuery({})).toEqual(emptyFilters());
  });

  it('round-trips the six keys a drill-through can carry', () => {
    const original = {
      from: '2026-09-01',
      to: '2026-09-30',
      kind: 'EXPENSE',
      categoryId: 'c1',
      accountId: 'a1',
      needsReview: 'true',
    };
    const parsed = new URLSearchParams(filterQueryString(original));
    const readBack: Record<string, string | null> = {};
    for (const key of Object.keys(original)) readBack[key] = parsed.get(key);
    expect(filtersFromQuery(readBack)).toEqual(filtersFromQuery(original));
  });
});

describe('filenameFromContentDisposition', () => {
  it('extracts a quoted filename', () => {
    expect(
      filenameFromContentDisposition('attachment; filename="finmate-transactions-2026-09-14.csv"'),
    ).toBe('finmate-transactions-2026-09-14.csv');
  });

  it('extracts an unquoted filename and an RFC 5987 one', () => {
    expect(filenameFromContentDisposition('attachment; filename=x.csv')).toBe('x.csv');
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''a%20b.csv")).toBe('a b.csv');
  });

  it('returns null when there is nothing to read, so the caller picks the fallback', () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition('attachment')).toBeNull();
    expect(filenameFromContentDisposition('attachment; filename=""')).toBeNull();
  });

describe('planSaveFailure (task 4.2.7b, ADR-030)', () => {
  const current = {
    id: 'tx-9',
    version: 6,
    categoryId: 'cat-food',
    amount: { amountMinor: '200000' },
    description: 'Lidl 2000',
    occurredLocalDate: '2026-09-14',
    status: 'CONFIRMED',
  };
  const base = { error: new Error('Failed to fetch'), next: {}, current, retryable: true, isConflict: false };

  it('shows a conflict rather than queueing it', () => {
    // Retrying a stale version produces the same conflict forever, so it needs a person.
    expect(planSaveFailure({ ...base, isConflict: true }).kind).toBe('CONFLICT');
  });

  it('shows anything that is not retryable', () => {
    expect(planSaveFailure({ ...base, retryable: false }).kind).toBe('ERROR');
  });

  it('queues an offline edit with the complete before-snapshot of the fields it carries', () => {
    const plan = planSaveFailure({
      ...base,
      next: { description: 'Lidl 2500', amount: { amountMinor: '250000', currency: 'RSD' } },
    });

    expect(plan.kind).toBe('QUEUE');
    if (plan.kind !== 'QUEUE') return;
    expect(plan.edit).toEqual({
      id: 'tx-9',
      version: 6,
      description: 'Lidl 2500',
      amount: { amountMinor: '250000', currency: 'RSD' },
    });
    // The snapshot covers every field the edit carries, which is what makes the conflict diff honest.
    expect(plan.before).toEqual({
      amount: '200000',
      description: 'Lidl 2000',
      occurredLocalDate: '2026-09-14',
      status: 'CONFIRMED',
    });
  });

  it('refuses a category change rather than queueing half the edit', () => {
    // The correction teaches a rule and its signal is bound to the version the user read (ADR-030).
    expect(planSaveFailure({ ...base, next: { categoryId: 'cat-fuel' } }).kind).toBe('REFUSE_CATEGORY');
  });

  it('does not re-send a category that did not change', () => {
    const plan = planSaveFailure({ ...base, next: { categoryId: 'cat-food', description: 'Lidl 2500' } });

    expect(plan.kind).toBe('QUEUE');
    if (plan.kind !== 'QUEUE') return;
    // A no-op field would still bump the version when the queue drains.
    expect(plan.edit['categoryId']).toBeUndefined();
    expect(plan.edit['description']).toBe('Lidl 2500');
  });
});
});

/**
 * The cached list's grouping (task 4.2.8b).
 *
 * The interesting property is not "it groups by day" — the live path already does that, through the
 * same helper — but that a cached row **cannot claim what the cache does not hold**: no id, no status,
 * no review flag, and a `null` category that means either "uncategorised" or "divided".
 */
function cachedRow(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    amountMinor: '200000',
    kind: 'EXPENSE',
    occurredLocalDate: '2026-09-20',
    description: 'Lidl',
    category: { id: 'c1', name: 'Hrana' },
    ...overrides,
  };
}

describe('groupCachedByDay', () => {
  it('groups by day and totals per direction, with the record’s currency', () => {
    const groups = groupCachedByDay(
      [
        cachedRow({ amountMinor: '200000' }),
        cachedRow({ amountMinor: '350000', category: null }),
        cachedRow({ amountMinor: '150000', kind: 'INCOME', occurredLocalDate: '2026-09-19' }),
      ],
      'RSD',
    );

    expect(groups.map((group) => group.date)).toEqual(['2026-09-20', '2026-09-19']);
    expect(groups[0]?.expenseTotal?.amountMinor).toBe(550000n);
    // A day with no income states no income total, rather than a 0,00 that reads as a fact.
    expect(groups[0]?.incomeTotal).toBeNull();
    expect(groups[1]?.incomeTotal?.amountMinor).toBe(150000n);
    expect(groups[0]?.rows[0]?.amount).toEqual({ amountMinor: '200000', currency: 'RSD' });
  });

  it('keeps a missing category as no claim at all', () => {
    const [group] = groupCachedByDay([cachedRow({ category: null })], 'RSD');

    // `null` is "uncategorised" OR "divided" — the whitelist holds one category per row and a split
    // Transaction has none. The screen must say neither, so the view carries the absence through.
    expect(group?.rows[0]?.categoryName).toBeNull();
  });

  it('treats anything that is not INCOME as an expense, never as a sign', () => {
    const [group] = groupCachedByDay([cachedRow({ kind: 'EXPENSE' })], 'RSD');

    expect(group?.rows[0]?.kind).toBe('EXPENSE');
    // The magnitude is never negative: direction lives in `kind` (ADR-003).
    expect(group?.expenseTotal?.amountMinor).toBe(200000n);
  });

  it('never marks a cached day as truncated', () => {
    // The cache is a closed window selected at write time, so there is no next page to be cut by.
    const groups = groupCachedByDay([cachedRow(), cachedRow()], 'RSD');

    expect(groups[0]?.expenseTotal).not.toBeNull();
  });
});
