/**
 * Condition evaluation — docs/04 §5.2, operator by operator.
 *
 * @module @finmate/rules-engine
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_CONDITION_DEPTH,
  REGEX_MAX_INPUT_LENGTH,
  REGEX_MAX_PATTERN_LENGTH,
  RuleDocumentError,
  RuleEvaluationError,
  conditionDepth,
  evaluateConditionTree,
  hasNestedQuantifier,
  toBigIntStrict,
  validateConditionTree,
} from './index';
import type {
  ConditionNode,
  ConditionOutcome,
  EvaluationContext,
  RuleEngineOptions,
} from './index';
import { createNaiveFolder, createRecordingFolder, createTextFolder } from './testing/text-folder';

const folder = createTextFolder();
const withRegex: RuleEngineOptions = { folder, allowRegex: true };
const withoutRegex: RuleEngineOptions = { folder };

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return { text: 'Lidl 2000', ...overrides };
}

function evaluate(
  node: ConditionNode,
  ctx: EvaluationContext = context(),
  options: RuleEngineOptions = withoutRegex,
): ConditionOutcome {
  return evaluateConditionTree(node, ctx, options);
}

function expectError(fn: () => unknown, code: string): RuleDocumentError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(RuleDocumentError);
    const documentError = error as RuleDocumentError;
    expect(documentError.code).toBe(code);
    return documentError;
  }
  throw new Error(`expected a RuleDocumentError with code ${code}`);
}

describe('text operators (§5.2)', () => {
  it('contains / not_contains / equals / starts_with fold both sides', () => {
    expect(evaluate({ field: 'text', op: 'contains', value: 'lidl' }).matched).toBe(true);
    expect(evaluate({ field: 'text', op: 'contains', value: 'maxi' }).matched).toBe(false);
    expect(evaluate({ field: 'text', op: 'not_contains', value: 'poklon' }).matched).toBe(true);
    expect(
      evaluate({ field: 'text', op: 'not_contains', value: 'lidl' }, context({ text: 'poklon lidl' }))
        .matched,
    ).toBe(false);
    expect(evaluate({ field: 'text', op: 'equals', value: 'LIDL 2000' }).matched).toBe(true);
    expect(evaluate({ field: 'text', op: 'equals', value: 'lidl' }).matched).toBe(false);
    expect(
      evaluate({ field: 'text', op: 'starts_with', value: 'LIDL' }, context({ text: 'lidl 2000' }))
        .matched,
    ).toBe(true);
  });

  it('in is whole-value membership, not token membership', () => {
    expect(
      evaluate({ field: 'text', op: 'in', value: ['maxi', 'SEPTICKA'] }, context({ text: 'Septička' }))
        .matched,
    ).toBe(true);
    // `contains` is the token-ish operator; `in` deliberately is not.
    expect(
      evaluate(
        { field: 'text', op: 'in', value: ['septicka'] },
        context({ text: 'septicka jama' }),
      ).matched,
    ).toBe(false);
  });

  it('description falls back to text and text falls back to description', () => {
    expect(evaluate({ field: 'description', op: 'contains', value: 'lidl' }).matched).toBe(true);
    expect(
      evaluate(
        { field: 'text', op: 'contains', value: 'racun' },
        context({ text: undefined, description: 'račun za struju' }),
      ).matched,
    ).toBe(true);
  });

  it('folds the rule value too: Septička matches text septicka', () => {
    expect(
      evaluate(
        { field: 'text', op: 'contains', value: 'Septička' },
        context({ text: 'praznjenje septicka jama' }),
      ).matched,
    ).toBe(true);
    expect(
      evaluate(
        { field: 'text', op: 'equals', value: 'Septička jama' },
        context({ text: 'septicka jama' }),
      ).matched,
    ).toBe(true);
  });

  it('transliterates a Cyrillic rule value through the injected folder', () => {
    expect(
      evaluate(
        { field: 'text', op: 'contains', value: 'Септичка' },
        context({ text: 'septicka' }),
      ).matched,
    ).toBe(true);
  });

  it('has no fold of its own: a non-transliterating folder leaves Cyrillic unmatched', () => {
    // If the engine contained a hidden fold, this would match. It must not.
    const outcome = evaluateConditionTree(
      { field: 'text', op: 'contains', value: 'Септичка' },
      context({ text: 'septicka' }),
      { folder: createNaiveFolder() },
    );
    expect(outcome.matched).toBe(false);
  });

  it('calls the injected folder for both the value and the text', () => {
    const recording = createRecordingFolder();
    evaluateConditionTree(
      { field: 'text', op: 'contains', value: 'Septička' },
      context({ text: 'septicka jama' }),
      { folder: recording },
    );
    expect(recording.foldCalls).toContain('Septička');
    expect(recording.foldCalls).toContain('septicka jama');
  });
});

describe('regex is enterprise-only and never throws (§5.2)', () => {
  const regexRule: ConditionNode = { field: 'text', op: 'regex', value: '^lidl' };

  it('reports a non-match and a visible flag when allowRegex is off (the default)', () => {
    const outcome = evaluate(regexRule);
    expect(outcome.matched).toBe(false);
    expect(outcome.flags).toHaveLength(1);
    expect(outcome.flags[0]?.code).toBe('REGEX_DISABLED');
    expect(outcome.flags[0]?.field).toBe('text');
  });

  it('evaluates the pattern only when allowRegex is explicitly true', () => {
    expect(evaluate(regexRule, context(), withRegex).matched).toBe(true);
    expect(evaluate(regexRule, context({ text: 'maxi' }), withRegex).matched).toBe(false);
  });

  it('flags an invalid pattern instead of throwing', () => {
    const outcome = evaluate({ field: 'text', op: 'regex', value: '(' }, context(), withRegex);
    expect(outcome.matched).toBe(false);
    expect(outcome.flags[0]?.code).toBe('REGEX_INVALID');
  });

  it('flags a catastrophic nested-quantifier pattern', () => {
    const outcome = evaluate({ field: 'text', op: 'regex', value: '(a+)+' }, context(), withRegex);
    expect(outcome.matched).toBe(false);
    expect(outcome.flags[0]?.code).toBe('REGEX_UNSAFE');
  });

  it('caps the pattern and the input', () => {
    expect(
      evaluate(
        { field: 'text', op: 'regex', value: 'a'.repeat(REGEX_MAX_PATTERN_LENGTH + 1) },
        context(),
        withRegex,
      ).flags[0]?.code,
    ).toBe('REGEX_TOO_LONG');
    expect(
      evaluate(regexRule, context({ text: 'l'.repeat(REGEX_MAX_INPUT_LENGTH + 1) }), withRegex).flags[0]
        ?.code,
    ).toBe('REGEX_INPUT_TOO_LONG');
  });

  it('is three-valued: a refused regex can never satisfy `none`', () => {
    // `none` of a condition that was never evaluated must not be treated as "the condition was false".
    const outcome = evaluate({ none: [regexRule] });
    expect(outcome.matched).toBe(false);
    expect(outcome.flags[0]?.code).toBe('REGEX_DISABLED');
  });

  it('hasNestedQuantifier recognises the classic shapes', () => {
    expect(hasNestedQuantifier('(a+)+')).toBe(true);
    expect(hasNestedQuantifier('(.*)*')).toBe(true);
    expect(hasNestedQuantifier('(\\d+){2,}')).toBe(true);
    expect(hasNestedQuantifier('((\\d+))+')).toBe(true);
    expect(hasNestedQuantifier('^lidl.*$')).toBe(false);
    expect(hasNestedQuantifier('^\\d{4}-\\d{2}$')).toBe(false);
    expect(hasNestedQuantifier('[a+]+')).toBe(false);
  });
});

describe('entity operators (§5.2)', () => {
  it('eq / in compare ids through the fold', () => {
    expect(
      evaluate(
        { field: 'merchant', op: 'eq', value: 'M1' },
        context({ merchantId: 'm1' }),
      ).matched,
    ).toBe(true);
    expect(
      evaluate(
        { field: 'counterparty', op: 'in', value: ['c-1', 'c-2'] },
        context({ counterpartyId: 'c-2' }),
      ).matched,
    ).toBe(true);
    expect(
      evaluate(
        { field: 'account', op: 'eq', value: 'a-1' },
        context({ accountId: 'a-9' }),
      ).matched,
    ).toBe(false);
  });

  it('is_null is true for an omitted or null field, false otherwise', () => {
    expect(evaluate({ field: 'merchant', op: 'is_null' }, context()).matched).toBe(true);
    expect(
      evaluate({ field: 'merchant', op: 'is_null' }, context({ merchantId: null })).matched,
    ).toBe(true);
    expect(
      evaluate({ field: 'merchant', op: 'is_null' }, context({ merchantId: 'm1' })).matched,
    ).toBe(false);
  });

  it('never matches an id predicate against a missing field', () => {
    expect(evaluate({ field: 'merchant', op: 'eq', value: 'm1' }, context()).matched).toBe(false);
    expect(
      evaluate({ field: 'counterparty', op: 'in', value: ['c-1'] }, context()).matched,
    ).toBe(false);
  });
});

describe('amount operators are bigint minor units, never floats (ADR-003)', () => {
  it('eq / gt / gte / lt / lte', () => {
    const ctx = context({ amountMinor: 200000n });
    expect(evaluate({ field: 'amount', op: 'eq', value: 200000n }, ctx).matched).toBe(true);
    expect(evaluate({ field: 'amount', op: 'eq', value: 200001n }, ctx).matched).toBe(false);
    expect(evaluate({ field: 'amount', op: 'gt', value: 199999n }, ctx).matched).toBe(true);
    expect(evaluate({ field: 'amount', op: 'gt', value: 200000n }, ctx).matched).toBe(false);
    expect(evaluate({ field: 'amount', op: 'gte', value: 200000n }, ctx).matched).toBe(true);
    expect(evaluate({ field: 'amount', op: 'lt', value: 200001n }, ctx).matched).toBe(true);
    expect(evaluate({ field: 'amount', op: 'lte', value: 200000n }, ctx).matched).toBe(true);
  });

  it('between is inclusive', () => {
    const ctx = context({ amountMinor: 200000n });
    expect(evaluate({ field: 'amount', op: 'between', value: [100000n, 200000n] }, ctx).matched).toBe(
      true,
    );
    expect(evaluate({ field: 'amount', op: 'between', value: [200000n, 300000n] }, ctx).matched).toBe(
      true,
    );
    expect(
      evaluate({ field: 'amount', op: 'between', value: [200001n, 300000n] }, ctx).matched,
    ).toBe(false);
  });

  it('accepts a decimal string, because JSONB cannot carry a bigint', () => {
    expect(
      evaluate({ field: 'amount', op: 'eq', value: '200000' }, context({ amountMinor: 200000n }))
        .matched,
    ).toBe(true);
    expect(toBigIntStrict('9007199254740993')).toBe(9007199254740993n);
  });

  it('does no arithmetic through Number past MAX_SAFE_INTEGER', () => {
    // 9007199254740993n is MAX_SAFE_INTEGER + 2. `Number(...)` would round it to ...992, so a float
    // comparison would make `eq` true for the wrong value and `between` include the wrong rows.
    const pastSafe = 9007199254740993n;
    const asFloatWouldBe = Number(pastSafe);
    expect(BigInt(asFloatWouldBe)).not.toBe(pastSafe);

    expect(
      evaluate({ field: 'amount', op: 'eq', value: pastSafe }, context({ amountMinor: pastSafe }))
        .matched,
    ).toBe(true);
    expect(
      evaluate(
        { field: 'amount', op: 'eq', value: pastSafe + 1n },
        context({ amountMinor: pastSafe }),
      ).matched,
    ).toBe(false);
    expect(
      evaluate(
        { field: 'amount', op: 'gte', value: pastSafe },
        context({ amountMinor: pastSafe }),
      ).matched,
    ).toBe(true);
    expect(
      evaluate(
        { field: 'amount', op: 'lte', value: pastSafe },
        context({ amountMinor: pastSafe }),
      ).matched,
    ).toBe(true);
    expect(
      evaluate(
        { field: 'amount', op: 'between', value: [pastSafe - 1n, pastSafe + 1n] },
        context({ amountMinor: pastSafe }),
      ).matched,
    ).toBe(true);
    // The string form survives JSONB and stays exact too.
    expect(
      evaluate(
        { field: 'amount', op: 'eq', value: '9007199254740993' },
        context({ amountMinor: pastSafe }),
      ).matched,
    ).toBe(true);
  });

  it('refuses a JS number amount value rather than coercing it', () => {
    // Refused by validation...
    expectError(
      () => validateConditionTree({ field: 'amount', op: 'eq', value: 2000 as unknown as bigint }),
      'AMOUNT_IS_FLOAT',
    );
    expectError(
      () =>
        validateConditionTree({
          field: 'amount',
          op: 'between',
          value: [1000 as unknown as bigint, 2000n],
        }),
      'AMOUNT_IS_FLOAT',
    );
    // ...and by evaluation, so a missing amount in the context cannot hide a float in the rule.
    expectError(
      () =>
        evaluate(
          { field: 'amount', op: 'eq', value: 2000 as unknown as bigint },
          context({ amountMinor: 2000n }),
        ),
      'AMOUNT_IS_FLOAT',
    );
  });

  it('refuses a malformed or negative amount string', () => {
    expectError(() => toBigIntStrict('1.5'), 'INVALID_AMOUNT');
    expectError(() => toBigIntStrict('-5'), 'INVALID_AMOUNT');
    expectError(() => toBigIntStrict('2 000'), 'INVALID_AMOUNT');
    expectError(() => toBigIntStrict(undefined as unknown as string), 'INVALID_AMOUNT');
  });

  it('refuses a float amount in the context', () => {
    try {
      evaluate(
        { field: 'amount', op: 'eq', value: 200000n },
        context({ amountMinor: 200000 as unknown as bigint }),
      );
      throw new Error('expected a RuleEvaluationError');
    } catch (error) {
      expect(error).toBeInstanceOf(RuleEvaluationError);
      expect((error as RuleEvaluationError).code).toBe('AMOUNT_NOT_BIGINT');
    }
  });

  it('never matches an amount predicate against a missing amount', () => {
    expect(evaluate({ field: 'amount', op: 'lte', value: 10n ** 30n }, context()).matched).toBe(false);
  });
});

describe('ordinal, kind and source operators (§5.2)', () => {
  it('dayOfWeek / dayOfMonth support in and between', () => {
    expect(
      evaluate({ field: 'dayOfWeek', op: 'in', value: [6, 7] }, context({ dayOfWeek: 7 })).matched,
    ).toBe(true);
    expect(
      evaluate({ field: 'dayOfWeek', op: 'between', value: [1, 5] }, context({ dayOfWeek: 7 }))
        .matched,
    ).toBe(false);
    expect(
      evaluate({ field: 'dayOfMonth', op: 'between', value: [1, 15] }, context({ dayOfMonth: 15 }))
        .matched,
    ).toBe(true);
    expect(evaluate({ field: 'dayOfMonth', op: 'in', value: [1, 2] }, context()).matched).toBe(false);
  });

  it('refuses a non-integer ordinal context', () => {
    expect(() =>
      evaluate({ field: 'dayOfWeek', op: 'in', value: [1] }, context({ dayOfWeek: 1.5 })),
    ).toThrowError(RuleEvaluationError);
  });

  it('kind and source are exact', () => {
    expect(
      evaluate({ field: 'kind', op: 'eq', value: 'INCOME' }, context({ kind: 'INCOME' })).matched,
    ).toBe(true);
    expect(
      evaluate({ field: 'kind', op: 'eq', value: 'INCOME' }, context({ kind: 'EXPENSE' })).matched,
    ).toBe(false);
    expect(
      evaluate({ field: 'source', op: 'eq', value: 'MANUAL' }, context({ source: 'MANUAL' })).matched,
    ).toBe(true);
    expect(evaluate({ field: 'source', op: 'eq', value: 'MANUAL' }, context()).matched).toBe(false);
  });
});

describe('composites and the depth cap (§5.2)', () => {
  const a: ConditionNode = { field: 'text', op: 'contains', value: 'lidl' };
  const b: ConditionNode = { field: 'amount', op: 'gt', value: 1000n };
  const c: ConditionNode = { field: 'kind', op: 'eq', value: 'EXPENSE' };

  it('all / any / none', () => {
    expect(evaluate({ all: [a, b] }, context({ amountMinor: 2000n })).matched).toBe(true);
    expect(evaluate({ all: [a, b] }, context({ amountMinor: 500n })).matched).toBe(false);
    expect(evaluate({ any: [a, { field: 'text', op: 'contains', value: 'maxi' }] }).matched).toBe(
      true,
    );
    expect(evaluate({ none: [a] }).matched).toBe(false);
    expect(
      evaluate({ none: [{ field: 'text', op: 'contains', value: 'maxi' }] }).matched,
    ).toBe(true);
  });

  it('nests to depth 3', () => {
    // all( any( none(leaf) ) ) — three composite levels.
    const depth3: ConditionNode = { all: [{ any: [{ none: [b] }, a] }, c] };
    expect(conditionDepth(depth3)).toBe(3);
    expect(evaluate(depth3, context({ amountMinor: 2000n, kind: 'EXPENSE' })).matched).toBe(true);
  });

  it('refuses depth 4 with a typed error', () => {
    const depth4: ConditionNode = { all: [{ any: [{ none: [{ all: [a] }] }] }] };
    expect(conditionDepth(depth4)).toBe(4);
    expect(conditionDepth(depth4)).toBeGreaterThan(MAX_CONDITION_DEPTH);
    expectError(() => validateConditionTree(depth4, 'rule-1'), 'DEPTH_EXCEEDED');
  });

  it('counts composite levels: a bare leaf is 0', () => {
    expect(conditionDepth(a)).toBe(0);
    expect(conditionDepth({ all: [a] })).toBe(1);
    expect(conditionDepth({ all: [{ any: [a] }] })).toBe(2);
  });
});

describe('document validation', () => {
  it('rejects an unknown field', () => {
    expectError(
      () => validateConditionTree({ field: 'merchantName', op: 'eq', value: 'x' } as unknown as ConditionNode),
      'UNKNOWN_FIELD',
    );
  });

  it('rejects an operator the field does not support', () => {
    expectError(
      () => validateConditionTree({ field: 'amount', op: 'contains', value: '1' } as unknown as ConditionNode),
      'UNSUPPORTED_OPERATOR',
    );
    expectError(
      () => validateConditionTree({ field: 'merchant', op: 'contains', value: 'lidl' } as unknown as ConditionNode),
      'UNSUPPORTED_OPERATOR',
    );
  });

  it('rejects malformed composites', () => {
    expectError(() => validateConditionTree({ all: [] }), 'MALFORMED_COMPOSITE');
    expectError(() => validateConditionTree({ all: [], any: [] }), 'MALFORMED_COMPOSITE');
    expectError(
      () => validateConditionTree({ all: 'nope' } as unknown as ConditionNode),
      'MALFORMED_COMPOSITE',
    );
  });

  it('rejects an empty or wrong-typed needle', () => {
    expectError(() => validateConditionTree({ field: 'text', op: 'contains', value: '' }), 'INVALID_VALUE');
    expectError(
      () => validateConditionTree({ field: 'text', op: 'in', value: [] }),
      'INVALID_VALUE',
    );
    expectError(
      () => validateConditionTree({ field: 'text', op: 'regex', value: ['a'] as unknown as string }),
      'INVALID_VALUE',
    );
  });

  it('rejects a value on is_null and a bad ordinal', () => {
    expectError(
      () => validateConditionTree({ field: 'merchant', op: 'is_null', value: 'm1' }),
      'INVALID_VALUE',
    );
    expectError(
      () => validateConditionTree({ field: 'dayOfWeek', op: 'in', value: [8] }),
      'INVALID_VALUE',
    );
    expectError(
      () => validateConditionTree({ field: 'dayOfMonth', op: 'between', value: [1] }),
      'INVALID_VALUE',
    );
  });

  it('rejects a kind that is not an enum member', () => {
    expectError(
      () => validateConditionTree({ field: 'kind', op: 'eq', value: 'TRANSFER' as unknown as 'INCOME' }),
      'INVALID_VALUE',
    );
  });

  it('validates every rule, and stamps the rule id on the error', () => {
    const leaf: ConditionNode = { field: 'text', op: 'contains', value: 'lidl' };
    const error = expectError(
      () => validateConditionTree({ all: [{ all: [{ any: [{ none: [leaf] }] }] }] }, 'rule-7'),
      'DEPTH_EXCEEDED',
    );
    expect(error.ruleId).toBe('rule-7');
    expect(error.path).toBe('conditions');
  });

  it('falls back to non-matching on an operator or field it does not know', () => {
    // Unvalidated input only; `evaluateRules` never reaches these arms.
    expect(evaluate({ field: 'text', op: 'made_up', value: 'x' } as unknown as ConditionNode).matched).toBe(
      false,
    );
    expect(
      evaluate({ field: 'amount', op: 'made_up', value: 1n } as unknown as ConditionNode, context({ amountMinor: 1n }))
        .matched,
    ).toBe(false);
    expect(evaluate({ field: 'made_up', op: 'eq', value: 'x' } as unknown as ConditionNode).matched).toBe(
      false,
    );
  });

  it('rejects a non-object node, in validation and in depth measurement', () => {
    expect(conditionDepth(null as unknown as ConditionNode)).toBe(0);
    expectError(() => validateConditionTree(null as unknown as ConditionNode), 'MALFORMED_CONDITION');
    expectError(
      () => validateConditionTree('nope' as unknown as ConditionNode),
      'MALFORMED_CONDITION',
    );
  });

  it('accepts a valid document without throwing', () => {
    expect(() =>
      validateConditionTree({
        all: [
          { field: 'text', op: 'contains', value: 'septička' },
          { field: 'amount', op: 'between', value: ['1000', '500000'] },
          { field: 'dayOfWeek', op: 'in', value: [1, 2, 3, 4, 5] },
          { none: [{ field: 'text', op: 'contains', value: 'poklon' }] },
        ],
      }),
    ).not.toThrow();
  });
});
