import { describe, expect, it } from 'vitest';

import {
  actionsOf,
  bucketRules,
  clausesOf,
  readabilityOf,
  type ResolveValue,
} from './rules.view';

/**
 * Rule rendering.
 *
 * The property that matters is **fidelity**: what the screen says a rule does must be what the rule
 * does. Every test below is about that rather than about formatting — an unresolved id, a `null`
 * action and a nested tree all have to survive the trip, because each one is a case where a renderer
 * can quietly say something false.
 */

const NAMES: Record<string, string> = {
  'merchant:merchant-lidl': 'Lidl',
  'counterparty:cp-dejan': 'Dejan rođa',
  'categoryId:cat-food': 'Hrana › Supermarket',
};

const resolve: ResolveValue = (field, value) => {
  const label = NAMES[`${field}:${value}`];
  return label === undefined ? { label: value, known: false } : { label, known: true };
};

describe('clausesOf', () => {
  it('renders a single-level tree and resolves the entity names', () => {
    const group = clausesOf(
      { all: [{ field: 'merchant', op: 'eq', value: 'merchant-lidl' }] },
      resolve,
    );

    expect(group).toEqual({
      quantifier: 'all',
      clauses: [{ field: 'merchant', op: 'eq', value: 'Lidl', unresolved: false }],
    });
  });

  it('keeps the quantifier, so AND is never drawn as OR', () => {
    expect(clausesOf({ any: [{ field: 'text', op: 'contains', value: 'a' }] }, resolve)?.quantifier).toBe(
      'any',
    );
    expect(clausesOf({ none: [{ field: 'text', op: 'contains', value: 'a' }] }, resolve)?.quantifier).toBe(
      'none',
    );
  });

  it('treats a bare leaf as `all` of one, which is how the engine reads it', () => {
    const group = clausesOf({ field: 'kind', op: 'eq', value: 'EXPENSE' }, resolve);
    expect(group).toEqual({
      quantifier: 'all',
      clauses: [{ field: 'kind', op: 'eq', value: 'EXPENSE', unresolved: false }],
    });
  });

  it('does not ask the resolver about a literal, so enum and text values are never "unresolved"', () => {
    // Only `merchant`, `counterparty` and `account` hold ids. Marking `EXPENSE` or `septička` as
    // unresolved would be noise, and noise on a warning marker is how the marker stops meaning
    // anything.
    for (const [field, value] of [
      ['kind', 'EXPENSE'],
      ['text', 'septička'],
      ['source', 'NATURAL_LANGUAGE'],
    ] as const) {
      const group = clausesOf({ all: [{ field, op: 'eq', value }] }, resolve);
      expect(group?.clauses[0]?.unresolved, field).toBe(false);
      expect(group?.clauses[0]?.value, field).toBe(value);
    }
  });

  it('expands an `in` list into one clause per member, resolving each', () => {
    const group = clausesOf(
      { all: [{ field: 'merchant', op: 'in', value: ['merchant-lidl', 'unknown-id'] }] },
      resolve,
    );

    expect(group?.clauses).toEqual([
      { field: 'merchant', op: 'in', value: 'Lidl', unresolved: false },
      // Unknown ids are shown raw and marked, never dropped: a rule listing three shops that renders
      // two is a rule the user cannot audit.
      { field: 'merchant', op: 'in', value: 'unknown-id', unresolved: true },
    ]);
  });

  it('marks an unresolved id rather than hiding it', () => {
    const group = clausesOf({ all: [{ field: 'merchant', op: 'eq', value: 'gone' }] }, resolve);
    expect(group?.clauses[0]).toEqual({
      field: 'merchant',
      op: 'eq',
      value: 'gone',
      unresolved: true,
    });
  });

  it('renders a value-less `is_null` clause', () => {
    const group = clausesOf({ all: [{ field: 'counterparty', op: 'is_null' }] }, resolve);
    expect(group?.clauses).toEqual([
      { field: 'counterparty', op: 'is_null', value: '', unresolved: false },
    ]);
  });

  it('refuses a nested tree instead of flattening it', () => {
    // "all of: A, any of: B" is not "A and B". Flattening would misstate the rule, and a screen that
    // misstates a rule is worse than one that shows the raw document.
    const nested = {
      all: [{ field: 'kind', op: 'eq', value: 'EXPENSE' }, { any: [{ field: 'text', op: 'contains', value: 'x' }] }],
    };
    expect(clausesOf(nested, resolve)).toBeNull();
    expect(readabilityOf(nested, resolve)).toBe('RAW');
  });

  it('refuses a document mixing `all` and `any` at one level', () => {
    const mixed = { all: [], any: [{ field: 'text', op: 'contains', value: 'x' }] };
    expect(clausesOf(mixed, resolve)).toBeNull();
  });

  it('refuses empty, malformed and non-object documents', () => {
    for (const value of [null, undefined, [], 'nonsense', {}, { all: [] }, { all: ['nope'] }]) {
      expect(clausesOf(value, resolve), JSON.stringify(value)).toBeNull();
    }
  });

  it('refuses a value-less clause that is not `is_null`', () => {
    expect(clausesOf({ all: [{ field: 'merchant', op: 'eq' }] }, resolve)).toBeNull();
  });
});

describe('readabilityOf', () => {
  it('agrees with the renderer about what it can draw', () => {
    expect(readabilityOf({ all: [{ field: 'text', op: 'contains', value: 'x' }] }, resolve)).toBe(
      'READABLE',
    );
    // Same function, so the template's fallback cannot drift from what the renderer handles.
    expect(readabilityOf(null, resolve)).toBe('RAW');
  });
});

describe('actionsOf', () => {
  it('resolves the category a rule sets', () => {
    const actions = actionsOf({ setCategoryId: 'cat-food' }, resolve);
    expect(actions.setCategory).toEqual({ label: 'Hrana › Supermarket', known: true });
    expect(actions.clearsCategory).toBe(false);
  });

  it('keeps "clear it" and "leave it alone" apart', () => {
    // docs/04 §5.1: an absent field is untouched; an explicit `null` is cleared. Collapsing them
    // would describe a rule that erases a category as one that does nothing to it.
    expect(actionsOf({}, resolve).clearsCategory).toBe(false);
    expect(actionsOf({ setCategoryId: null }, resolve).clearsCategory).toBe(true);
    expect(actionsOf({ setCategoryId: null }, resolve).setCategory).toBeNull();
  });

  it('collects tags as ids, because the screen does not load the Tag list', () => {
    expect(actionsOf({ addTagIds: ['t1', 't2', 7] }, resolve).addTags).toEqual(['t1', 't2']);
  });

  it('survives a malformed action document', () => {
    const empty = actionsOf(null, resolve);
    expect(empty.setCategory).toBeNull();
    expect(empty.addTags).toEqual([]);
  });
});

describe('bucketRules', () => {
  const rule = (name: string, over: Partial<{ isActive: boolean; isStale: boolean; conflictsWith: unknown[] }> = {}) => ({
    name,
    isActive: over.isActive ?? true,
    isStale: over.isStale ?? false,
    conflictsWith: over.conflictsWith ?? [],
  });

  it('puts shadowed and stale rules first, because those are the ones that rot a rule set', () => {
    const buckets = bucketRules([
      rule('healthy'),
      rule('shadowed', { conflictsWith: [{ ruleId: 'x' }] }),
      rule('stale', { isStale: true }),
      rule('off', { isActive: false }),
    ]);

    expect(buckets.needsAttention.map((r) => r.name)).toEqual(['shadowed', 'stale']);
    expect(buckets.active.map((r) => r.name)).toEqual(['healthy']);
    expect(buckets.inactive.map((r) => r.name)).toEqual(['off']);
  });

  it('does not nag about a rule the user switched off', () => {
    // An inactive rule that never fired is not stale; it is deliberately off.
    const buckets = bucketRules([rule('off', { isActive: false, isStale: true })]);
    expect(buckets.needsAttention).toHaveLength(0);
    expect(buckets.inactive.map((r) => r.name)).toEqual(['off']);
  });
});
