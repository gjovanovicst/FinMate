import { describe, expect, it } from 'vitest';

import {
  deleteRefusal,
  matchesTypeFilter,
  mergeRefusal,
  sameCounterpartyName,
  TYPE_FILTERS,
  type CounterpartyNode,
} from './counterparties.view';

function person(overrides: Partial<CounterpartyNode> & { id: string }): CounterpartyNode {
  return {
    name: 'Dejan',
    type: 'PERSON',
    defaultCategoryId: null,
    defaultCategoryPath: null,
    note: null,
    aliases: [],
    transactionCount: 0,
    ...overrides,
  };
}

describe('matchesTypeFilter', () => {
  const dejan = person({ id: 'a', type: 'PERSON' });
  const eps = person({ id: 'b', type: 'COMPANY' });

  it('lets everything through on ALL', () => {
    expect(matchesTypeFilter(dejan, 'ALL')).toBe(true);
    expect(matchesTypeFilter(eps, 'ALL')).toBe(true);
  });

  it('keeps people and companies apart, which is what the tabs are for', () => {
    expect(matchesTypeFilter(dejan, 'PERSON')).toBe(true);
    expect(matchesTypeFilter(eps, 'PERSON')).toBe(false);
    expect(matchesTypeFilter(eps, 'COMPANY')).toBe(true);
  });

  it('does not treat OTHER as a catch-all', () => {
    // A tab that silently absorbed unrelated rows would make the counts above it wrong.
    expect(matchesTypeFilter(person({ id: 'c', type: 'GOVERNMENT' }), 'OTHER')).toBe(false);
  });

  it('offers ALL first so the default selection is the whole list', () => {
    expect(TYPE_FILTERS[0]).toBe('ALL');
    expect(TYPE_FILTERS).toHaveLength(5);
  });
});

describe('sameCounterpartyName', () => {
  it('treats the F-11 spelling variants as one person', () => {
    expect(sameCounterpartyName('Dejan rođa', 'dejan roda')).toBe(true);
    expect(sameCounterpartyName('  DEJAN   ROĐA ', 'Dejan rođa')).toBe(true);
  });

  it('keeps genuinely different people apart', () => {
    expect(sameCounterpartyName('Dejan', 'Dragan')).toBe(false);
  });
});

describe('mergeRefusal', () => {
  it('refuses merging into itself', () => {
    expect(mergeRefusal(person({ id: 'a' }), person({ id: 'a' }))).toBe('SAME');
  });

  it('allows any two distinct counterparties, including a company into a person', () => {
    // Nothing is "shipped" here, so the only rule is that a merge needs two rows.
    expect(mergeRefusal(person({ id: 'a' }), person({ id: 'b', type: 'COMPANY' }))).toBeNull();
  });

  it('says nothing before a target is chosen', () => {
    expect(mergeRefusal(person({ id: 'a' }), null)).toBeNull();
  });
});

describe('deleteRefusal', () => {
  it('refuses one that Transactions still point at, pointing at merge', () => {
    expect(deleteRefusal(person({ id: 'a', transactionCount: 14 }))).toBe('IN_USE');
  });

  it('allows an unreferenced one', () => {
    expect(deleteRefusal(person({ id: 'a' }))).toBeNull();
  });
});
