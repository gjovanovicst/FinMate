/**
 * Specificity scoring — the derived half of docs/04 §5.3.5.
 *
 * > "A **specificity score** breaks remaining ties: more conditions and `eq` over `contains` wins."
 *
 * docs/04 gives no formula, so this module defines one and states its properties. It is used only as
 * a tie-break **inside a priority band** (`evaluateRules` compares `priority` first), which is what
 * makes "the score never overrides `priority`" structural rather than a convention.
 *
 * ## The formula
 *
 * Each leaf contributes its operator's strength; a composite contributes the sum of its children,
 * scaled by whether the shape is strong or weak evidence:
 *
 * ```text
 * all(children)  = Σ score(child)              // a conjunction: every condition must hold
 * any(children)  = 0.5 × Σ score(child)        // a disjunction: one branch suffices, so it is weaker
 * none(children) = 0.5 × Σ score(child)        // a negation: also weaker than an assertion
 * ```
 *
 * ## Why these numbers
 *
 * The scale is tenths, so the ordering is exact integer arithmetic and needs no epsilon:
 *
 * | Operator | Score | Why |
 * |---|---|---|
 * | `eq`, `equals`, `is_null`, `between` | 10 | exact (interval) identity — the stated "`eq` over `contains`" |
 * | `in`, `starts_with` | 8 | bounded sets / anchored prefixes |
 * | `regex` | 7 | arbitrary author-supplied matching, deliberately below an explicit `eq` |
 * | `contains`, `not_contains` | 5 | the weakest: a needle anywhere in the text |
 *
 * Properties this buys, each asserted in `specificity.spec.ts`:
 * 1. **Monotone in conditions** — adding a leaf never lowers the score, and under `all` it strictly
 *    raises it, so a strictly more specific rule wins (docs/04 §5.3.5).
 * 2. **`eq` > `contains`** — 10 > 5 (docs/04 §5.3.5).
 * 3. **`all` > `any`** for the same leaves — 1.0 vs 0.5 factor.
 * 4. **Priority always dominates** — the comparator never looks at specificity across bands.
 *
 * @module @finmate/rules-engine
 */

import type { ConditionNode } from './types';

const SCORE = {
  exact: 10,
  bounded: 8,
  regex: 7,
  containment: 5,
} as const;

const OPERATOR_SPECIFICITY: Readonly<Record<string, number>> = Object.freeze({
  eq: SCORE.exact,
  equals: SCORE.exact,
  is_null: SCORE.exact,
  between: SCORE.exact,
  in: SCORE.bounded,
  starts_with: SCORE.bounded,
  regex: SCORE.regex,
  contains: SCORE.containment,
  not_contains: SCORE.containment,
});

/** A disjunction and a negation are half as specific as the conjunction of the same leaves. */
const WEAK_SHAPE_FACTOR = 0.5;

type UnknownRecord = Record<string, unknown>;

/**
 * The specificity of a condition tree. Higher wins a tie.
 *
 * Never throws: it only reads shape, so it can run on a tree a caller has not validated (the
 * operator/field checks are {@link validateConditionTree}'s job).
 */
export function specificityOf(node: ConditionNode): number {
  if (node === null || typeof node !== 'object') return 0;
  const record = node as unknown as UnknownRecord;

  if (Array.isArray(record['all'])) {
    return sumChildren(record['all'] as readonly ConditionNode[], 1);
  }
  if (Array.isArray(record['any'])) {
    return sumChildren(record['any'] as readonly ConditionNode[], WEAK_SHAPE_FACTOR);
  }
  if (Array.isArray(record['none'])) {
    return sumChildren(record['none'] as readonly ConditionNode[], WEAK_SHAPE_FACTOR);
  }

  const op = record['op'];
  if (typeof op !== 'string') return 0;
  return OPERATOR_SPECIFICITY[op] ?? SCORE.containment;
}

function sumChildren(children: readonly ConditionNode[], factor: number): number {
  let total = 0;
  for (const child of children) total += specificityOf(child);
  return total * factor;
}
