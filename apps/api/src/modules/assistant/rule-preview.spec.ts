import { describe, expect, it } from 'vitest';

import { rulePreviewRows, type RulePreviewCopy, type RulePreviewNames } from './rule-preview';

/**
 * `rulePreviewRows` — the card's rendering of a Rule document (B-5).
 *
 * The shapes asserted here are the ones `synthesiseRule` actually produces, plus the documents it
 * cannot: a composite that is not a flat `all`, an amount predicate, an action whose ids have no names.
 * The last group is the point of the suite — every one of them must render **as stored** rather than as
 * a guess, because the reader is confirming a rule about their own money.
 */
const NAMES: RulePreviewNames = {
  category: { 'cat-food': 'Hrana' },
  merchant: { 'mer-lidl': 'Lidl' },
  counterparty: { 'cp-dejan': 'Dejan' },
};

const COPY: RulePreviewCopy = {
  field: {
    text: 'entry text',
    description: 'description',
    merchant: 'merchant',
    counterparty: 'person',
    category: 'category',
  },
  op: { contains: 'contains', notContains: 'does not contain', equals: 'is', startsWith: 'starts with' },
  asStored: 'shown as stored',
  cleared: 'cleared',
};

const rows = (conditions: unknown, actions: unknown) =>
  rulePreviewRows({ conditions, actions }, NAMES, COPY);

describe('rulePreviewRows (B-5)', () => {
  it('renders the merchant rule synthesis actually produces', () => {
    // `MERCHANT_RESOLVED`: one condition on the Merchant, one action setting the Category.
    expect(
      rows(
        { all: [{ field: 'merchant', op: 'eq', value: 'mer-lidl' }] },
        { setCategoryId: 'cat-food' },
      ),
    ).toEqual([
      { slot: 'conditions', field: 'merchant', after: 'is Lidl', afterValue: 'mer-lidl' },
      { slot: 'actions', field: 'category', after: 'Hrana', afterValue: 'cat-food' },
    ]);
  });

  it('renders the counterparty and distinctive-token rules too', () => {
    expect(
      rows(
        { all: [{ field: 'counterparty', op: 'eq', value: 'cp-dejan' }] },
        { setCategoryId: 'cat-food' },
      )[0],
    ).toEqual({ slot: 'conditions', field: 'person', after: 'is Dejan', afterValue: 'cp-dejan' });

    // The token is quoted, because it is a word to look **for** — unquoted, `description contains lidl`
    // reads like a description of the entry rather than a predicate about it.
    expect(
      rows({ all: [{ field: 'text', op: 'contains', value: 'lidl' }] }, { setCategoryId: 'cat-food' })[0],
    ).toEqual({ slot: 'conditions', field: 'entry text', after: 'contains „lidl”', afterValue: 'lidl' });
  });

  it('puts the conditions before the actions, because that is how a rule is read', () => {
    const order = rows(
      { all: [{ field: 'merchant', op: 'eq', value: 'mer-lidl' }] },
      { setCategoryId: 'cat-food' },
    ).map((row) => row.slot);
    expect(order).toEqual(['conditions', 'actions']);
  });

  it('renders free text an action writes, and an explicit null as a cleared field', () => {
    expect(rows({ all: [{ field: 'text', op: 'contains', value: 'kafa' }] }, { setDescription: 'Kafa' })[1])
      .toEqual({ slot: 'actions', field: 'description', after: '„Kafa”', afterValue: null });
    // `null` is a **value** in `RuleActions` — "clear it" (docs/04 §5.3.3) — not an absent key.
    expect(rows({ all: [{ field: 'text', op: 'contains', value: 'kafa' }] }, { setCategoryId: null })[1])
      .toEqual({ slot: 'actions', field: 'category', after: 'cleared', afterValue: null });
  });

  it('shows a clause as stored rather than printing an id it cannot resolve', () => {
    const stored = rows(
      { all: [{ field: 'merchant', op: 'eq', value: 'mer-unknown' }] },
      { setCategoryId: 'cat-food' },
    );
    expect(stored).toEqual([
      {
        slot: 'conditions',
        field: 'shown as stored',
        after: JSON.stringify({ all: [{ field: 'merchant', op: 'eq', value: 'mer-unknown' }] }),
        afterValue: null,
      },
      { slot: 'actions', field: 'category', after: 'Hrana', afterValue: 'cat-food' },
    ]);
  });

  it('shows a whole half as stored when one clause of it is unreadable', () => {
    // Three clauses rendered and a fourth hidden would describe a **narrower** rule than the one about
    // to be written, which is the one failure mode a confirmation cannot have.
    const both = rows(
      {
        all: [
          { field: 'merchant', op: 'eq', value: 'mer-lidl' },
          { field: 'amount', op: 'gt', value: '200000' },
        ],
      },
      { setCategoryId: 'cat-food' },
    );
    expect(both[0]?.field).toBe('shown as stored');
    expect(both[0]?.after).toContain('amount');
    // …and the readable half is still readable: the halves are independent.
    expect(both[1]).toEqual({ slot: 'actions', field: 'category', after: 'Hrana', afterValue: 'cat-food' });
  });

  it('refuses to paraphrase a composite it cannot flatten', () => {
    // `any` / `none` / nesting each need a grouping syntax this renderer does not have, and inventing
    // one is how a card starts paraphrasing a rule instead of stating it.
    for (const conditions of [
      { any: [{ field: 'merchant', op: 'eq', value: 'mer-lidl' }] },
      { none: [{ field: 'merchant', op: 'eq', value: 'mer-lidl' }] },
      { all: [{ all: [{ field: 'merchant', op: 'eq', value: 'mer-lidl' }] }] },
      { all: [] },
      {},
      null,
    ]) {
      const rendered = rows(conditions, { setCategoryId: 'cat-food' });
      expect(rendered[0]?.field, JSON.stringify(conditions)).toBe('shown as stored');
    }
  });

  it('shows the actions as stored when it has no names for what they set', () => {
    // `addTagIds` would need a fourth name map for a key synthesis never sets.
    const rendered = rows({ all: [{ field: 'text', op: 'contains', value: 'kafa' }] }, {
      setCategoryId: 'cat-food',
      addTagIds: ['tag-1'],
    });
    expect(rendered[1]?.field).toBe('shown as stored');
    // Nothing is emitted for an action object that is empty: a rule with no actions is not a rule the
    // card should invent a row for.
    expect(rows({ all: [{ field: 'text', op: 'contains', value: 'kafa' }] }, {})).toHaveLength(1);
  });

  it('renders an unreadable document as stored, without throwing', () => {
    // Not a document this build can produce, but a renderer on the path to a confirmation must not
    // throw: an unreadable proposal is a refusal, not a 500.
    expect(rows(undefined, undefined)).toHaveLength(2);
    expect(rows(undefined, {})[0]?.field).toBe('shown as stored');
  });
});
