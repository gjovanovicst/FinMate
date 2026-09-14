/**
 * The derived specificity formula — docs/04 §5.3.5 ("more conditions and `eq` over `contains` wins").
 *
 * @module @finmate/rules-engine
 */

import { describe, expect, it } from 'vitest';

import { specificityOf } from './index';
import type { ConditionNode } from './index';

const eq = (): ConditionNode => ({ field: 'text', op: 'equals', value: 'lidl' });
const contains = (): ConditionNode => ({ field: 'text', op: 'contains', value: 'lidl' });
const notContains = (): ConditionNode => ({ field: 'text', op: 'not_contains', value: 'poklon' });
const merchantEq = (): ConditionNode => ({ field: 'merchant', op: 'eq', value: 'm1' });

describe('specificityOf', () => {
  it('scores eq above contains, as §5.3.5 requires', () => {
    expect(specificityOf(eq())).toBeGreaterThan(specificityOf(contains()));
    expect(specificityOf(eq())).toBeGreaterThan(specificityOf(notContains()));
  });

  it('scores exact > bounded > regex > containment', () => {
    const bounded = specificityOf({ field: 'text', op: 'starts_with', value: 'li' });
    const regex = specificityOf({ field: 'text', op: 'regex', value: '^li' });
    const containment = specificityOf(contains());
    expect(specificityOf(eq())).toBeGreaterThan(bounded);
    expect(bounded).toBeGreaterThan(regex);
    expect(regex).toBeGreaterThan(containment);
  });

  it('is strictly increasing in the number of conditions under all', () => {
    const one = specificityOf({ all: [contains()] });
    const two = specificityOf({ all: [contains(), merchantEq()] });
    const three = specificityOf({ all: [contains(), merchantEq(), eq()] });
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
  });

  it('treats a disjunction as weaker than the conjunction of the same leaves', () => {
    expect(specificityOf({ all: [eq(), merchantEq()] })).toBeGreaterThan(
      specificityOf({ any: [eq(), merchantEq()] }),
    );
    // `none` is a negation: also weaker than an assertion over the same leaves.
    expect(specificityOf({ all: [eq(), merchantEq()] })).toBeGreaterThan(
      specificityOf({ none: [eq(), merchantEq()] }),
    );
  });

  it('adds across nesting, but discounts the weak branches', () => {
    const nested = specificityOf({ all: [{ any: [eq(), merchantEq()] }] });
    expect(nested).toBe(0.5 * (specificityOf(eq()) + specificityOf(merchantEq())));
  });

  it('never throws on a tree that was not validated', () => {
    expect(specificityOf({} as unknown as ConditionNode)).toBe(0);
    expect(specificityOf(null as unknown as ConditionNode)).toBe(0);
    expect(specificityOf({ field: 'text', op: 'made_up', value: 'x' } as unknown as ConditionNode)).toBe(
      specificityOf(contains()),
    );
  });

  it('is monotone: a strictly more specific rule never scores lower', () => {
    const base: ConditionNode = { all: [contains(), merchantEq()] };
    const moreSpecific: ConditionNode = { all: [contains(), merchantEq(), eq()] };
    expect(specificityOf(moreSpecific)).toBeGreaterThan(specificityOf(base));
  });
});
