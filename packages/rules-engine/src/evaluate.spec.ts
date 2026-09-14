/**
 * Conflict resolution — docs/04 §5.3, in its stated order.
 *
 * @module @finmate/rules-engine
 */

import { describe, expect, it } from 'vitest';

import {
  KEYWORD_TIER_PRIORITY,
  RuleDocumentError,
  evaluateRules,
  validateRule,
} from './index';
import type {
  CategoryKeyword,
  ConditionNode,
  EvaluationContext,
  KeywordCandidateRef,
  Rule,
  RuleActions,
  RuleCandidate,
  RuleDecision,
} from './index';
import { createTextFolder } from './testing/text-folder';

const folder = createTextFolder();

/** The losing candidates of kind RULE, in order. */
function losingRuleIds(decision: RuleDecision): readonly string[] {
  return decision.candidates
    .filter((candidate): candidate is RuleCandidate => candidate.kind === 'RULE')
    .map((candidate) => candidate.ruleId);
}

function firstLosingRule(decision: RuleDecision): RuleCandidate | undefined {
  return decision.candidates.find(
    (candidate): candidate is RuleCandidate => candidate.kind === 'RULE',
  );
}

/** The losing candidates of kind KEYWORD, in score order. */
function losingKeywordIds(decision: RuleDecision): readonly string[] {
  return decision.candidates
    .filter((candidate): candidate is KeywordCandidateRef => candidate.kind === 'KEYWORD')
    .map((candidate) => candidate.categoryId);
}

const textContains = (value: string): ConditionNode => ({ field: 'text', op: 'contains', value });
const textEquals = (value: string): ConditionNode => ({ field: 'text', op: 'equals', value });
const amountGte = (value: bigint): ConditionNode => ({ field: 'amount', op: 'gte', value });

interface RuleOverrides {
  readonly name?: string;
  readonly priority?: number;
  readonly isActive?: boolean;
  readonly stopOnMatch?: boolean;
  readonly conditions?: ConditionNode;
  readonly actions?: RuleActions;
  readonly createdAt?: string;
}

function rule(id: string, overrides: RuleOverrides = {}): Rule {
  return {
    id,
    name: overrides.name ?? id,
    priority: overrides.priority ?? 100,
    isActive: overrides.isActive ?? true,
    stopOnMatch: overrides.stopOnMatch ?? false,
    conditions: overrides.conditions ?? { all: [textContains('lidl')] },
    actions: overrides.actions ?? {},
    origin: 'USER',
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function keyword(categoryId: string, value: string, weight = 1): CategoryKeyword {
  return {
    id: `${categoryId}:${value}`,
    categoryId,
    keyword: value,
    polarity: 'INCLUDE',
    matchMode: 'WORD',
    weight,
  };
}

const context: EvaluationContext = { text: 'lidl', amountMinor: 2000n };
const options = { folder };

describe('priority ordering (§5.3.1)', () => {
  it('lower priority wins, and only one category is set', () => {
    const decision = evaluateRules(
      [
        rule('low', { priority: 10, actions: { setCategoryId: 'cat-low' } }),
        rule('high', { priority: 20, actions: { setCategoryId: 'cat-high' } }),
      ],
      context,
      options,
    );
    expect(decision.decidedBy).toBe('RULE');
    expect(decision.ruleId).toBe('low');
    expect(decision.actions.setCategoryId).toBe('cat-low');
    expect(decision.contributingRuleIds).toEqual(['low']);
    expect(decision.matchedRuleIds).toEqual(['low', 'high']);
    expect(losingRuleIds(decision)).toEqual(['high']);
    expect(decision.confidence).toBe(1);
  });

  it('never lets specificity override priority', () => {
    const decision = evaluateRules(
      [
        rule('general', { priority: 10, stopOnMatch: true, actions: { setCategoryId: 'general' } }),
        rule('specific', {
          priority: 20,
          stopOnMatch: true,
          conditions: { all: [textEquals('lidl'), amountGte(1000n)] },
          actions: { setCategoryId: 'specific' },
        }),
      ],
      context,
      options,
    );
    expect(decision.ruleId).toBe('general');
    expect(decision.decidingRule?.specificity).toBeLessThan(
      firstLosingRule(decision)?.specificity ?? 0,
    );
  });
});

describe('created_at DESC tie-break (§5.3.1)', () => {
  it('lets the newest intent win an equal-priority, equal-specificity tie', () => {
    const decision = evaluateRules(
      [
        rule('old', { stopOnMatch: true, createdAt: '2026-01-01T00:00:00.000Z', actions: { setCategoryId: 'old' } }),
        rule('new', { stopOnMatch: true, createdAt: '2026-02-01T00:00:00.000Z', actions: { setCategoryId: 'new' } }),
      ],
      context,
      options,
    );
    expect(decision.ruleId).toBe('new');
  });

  it('does not depend on the order the rules arrive in', () => {
    const forwards = evaluateRules(
      [
        rule('old', { stopOnMatch: true, createdAt: '2026-01-01T00:00:00.000Z', actions: { setCategoryId: 'old' } }),
        rule('new', { stopOnMatch: true, createdAt: '2026-02-01T00:00:00.000Z', actions: { setCategoryId: 'new' } }),
      ],
      context,
      options,
    );
    const backwards = evaluateRules(
      [
        rule('new', { stopOnMatch: true, createdAt: '2026-02-01T00:00:00.000Z', actions: { setCategoryId: 'new' } }),
        rule('old', { stopOnMatch: true, createdAt: '2026-01-01T00:00:00.000Z', actions: { setCategoryId: 'old' } }),
      ],
      context,
      options,
    );
    expect(forwards.ruleId).toBe('new');
    expect(backwards.ruleId).toBe('new');
  });

  it('falls back to id ASC when priority, specificity and created_at all tie', () => {
    const decision = evaluateRules(
      [
        rule('b', { stopOnMatch: true, actions: { setCategoryId: 'b' } }),
        rule('a', { stopOnMatch: true, actions: { setCategoryId: 'a' } }),
      ],
      context,
      options,
    );
    expect(decision.ruleId).toBe('a');
  });
});

describe('specificity tie-break (§5.3.5)', () => {
  it('prefers the more specific rule at equal priority and created_at', () => {
    const decision = evaluateRules(
      [
        rule('general', { stopOnMatch: true, actions: { setCategoryId: 'general' } }),
        rule('specific', {
          stopOnMatch: true,
          conditions: { all: [textEquals('lidl'), amountGte(1000n)] },
          actions: { setCategoryId: 'specific' },
        }),
      ],
      context,
      options,
    );
    expect(decision.ruleId).toBe('specific');
    expect(decision.decidingRule?.specificity).toBeGreaterThan(
      firstLosingRule(decision)?.specificity ?? 0,
    );
  });
});

describe('stop_on_match (§5.3.2)', () => {
  it('takes the first matching stop rule and merges nothing else', () => {
    const decision = evaluateRules(
      [
        rule('stop', { priority: 10, stopOnMatch: true, actions: { setCategoryId: 'stop' } }),
        rule('other', { priority: 20, stopOnMatch: true, actions: { setCategoryId: 'other', setMerchantId: 'm' } }),
      ],
      context,
      options,
    );
    expect(decision.decidedBy).toBe('RULE');
    expect(decision.ruleId).toBe('stop');
    expect(decision.actions).toEqual({ setCategoryId: 'stop' });
    expect(decision.contributingRuleIds).toEqual(['stop']);
    expect(decision.matchedRuleIds).toEqual(['stop', 'other']);
    expect(losingRuleIds(decision)).toEqual(['other']);
  });

  it('reports a stop rule that sets no category as NONE while still applying its actions', () => {
    const decision = evaluateRules(
      [rule('tags-only', { stopOnMatch: true, actions: { addTagIds: ['t1'] } })],
      context,
      options,
    );
    expect(decision.decidedBy).toBe('NONE');
    expect(decision.ruleId).toBeNull();
    expect(decision.actions.addTagIds).toEqual(['t1']);
    expect(decision.contributingRuleIds).toEqual(['tags-only']);
    expect(decision.confidence).toBeNull();
  });
});

describe('non-stopping merge (§5.3.3)', () => {
  it('fills gaps in priority order and never overwrites an explicitly set field', () => {
    const decision = evaluateRules(
      [
        rule('a', { priority: 10, actions: { setCategoryId: 'cat-a', addTagIds: ['t1'] } }),
        rule('b', { priority: 20, actions: { setCategoryId: 'cat-b', setMerchantId: 'm-a', addTagIds: ['t1', 't2'] } }),
        rule('c', { priority: 30, actions: { setDescription: 'desc' } }),
      ],
      context,
      options,
    );
    expect(decision.decidedBy).toBe('RULE');
    expect(decision.ruleId).toBe('a');
    expect(decision.actions).toEqual({
      setCategoryId: 'cat-a',
      setMerchantId: 'm-a',
      setDescription: 'desc',
      addTagIds: ['t1', 't2'],
    });
    expect(decision.contributingRuleIds).toEqual(['a', 'b', 'c']);
    expect(decision.candidates).toEqual([]);
  });

  it('treats an explicit null as set, so a later rule cannot fill the gap', () => {
    const decision = evaluateRules(
      [
        rule('clear', { priority: 10, actions: { setMerchantId: null } }),
        rule('fill', { priority: 20, actions: { setMerchantId: 'm-b' } }),
      ],
      context,
      options,
    );
    expect(decision.actions.setMerchantId).toBeNull();
    expect(decision.contributingRuleIds).toEqual(['clear']);
    expect(losingRuleIds(decision)).toEqual(['fill']);
  });

  it('unions tags without disturbing the order they were first seen', () => {
    const decision = evaluateRules(
      [
        rule('a', { priority: 10, actions: { addTagIds: ['t2'] } }),
        rule('b', { priority: 20, actions: { addTagIds: ['t1', 't2', 't3'] } }),
      ],
      context,
      options,
    );
    expect(decision.actions.addTagIds).toEqual(['t2', 't1', 't3']);
  });

  it('reports a matched rule whose every field was already set as a losing candidate', () => {
    const decision = evaluateRules(
      [
        rule('winner', { priority: 10, actions: { setCategoryId: 'cat' } }),
        rule('shadowed', { priority: 20, actions: { setCategoryId: 'other' } }),
      ],
      context,
      options,
    );
    expect(decision.matchedRuleIds).toEqual(['winner', 'shadowed']);
    expect(firstLosingRule(decision)?.ruleId).toBe('shadowed');
    expect(firstLosingRule(decision)?.stopOnMatch).toBe(false);
  });
});

describe('the keyword tier (§5.3.4)', () => {
  it('is at priority 1000', () => {
    expect(KEYWORD_TIER_PRIORITY).toBe(1000);
  });

  it('is outranked by an explicit rule at the same priority 1000', () => {
    // The explicit rule has specificity 5 and the implicit tier has 0, which is how an explicit
    // rule beats a keyword at the tier's own priority.
    const decision = evaluateRules([rule('explicit', { priority: KEYWORD_TIER_PRIORITY, actions: { setCategoryId: 'explicit-cat' } })], context, {
      folder,
      keywords: [keyword('keyword-cat', 'lidl', 5)],
    });
    expect(decision.decidedBy).toBe('RULE');
    expect(decision.ruleId).toBe('explicit');
    expect(decision.actions.setCategoryId).toBe('explicit-cat');
    expect(decision.keyword?.decision?.categoryId).toBe('keyword-cat');
    expect(decision.keyword?.decision?.score).toBeCloseTo(5, 12);
    expect(decision.keywordShadowed).toBe(true);
  });

  it('decides the category when no explicit rule sets one, and fills only that gap', () => {
    const decision = evaluateRules([rule('merchant-only', { priority: 100, actions: { setMerchantId: 'm-1' } })], context, {
      folder,
      keywords: [keyword('keyword-cat', 'lidl', 2)],
    });
    expect(decision.decidedBy).toBe('KEYWORD');
    expect(decision.ruleId).toBeNull();
    expect(decision.decidingRule).toBeNull();
    expect(decision.actions).toEqual({ setCategoryId: 'keyword-cat', setMerchantId: 'm-1' });
    expect(decision.contributingRuleIds).toEqual(['merchant-only']);
    expect(decision.keywordShadowed).toBe(false);
    expect(decision.confidence).toBe(decision.keyword?.decision?.confidence);
  });

  it('is outranked by every explicit rule below 1000', () => {
    const decision = evaluateRules([rule('user-rule', { priority: 999, actions: { setCategoryId: 'rule-cat' } })], context, {
      folder,
      keywords: [keyword('keyword-cat', 'lidl', 9)],
    });
    expect(decision.decidedBy).toBe('RULE');
    expect(decision.actions.setCategoryId).toBe('rule-cat');
  });

  it('lets a rule above 1000 fill gaps around a keyword decision, not overwrite it', () => {
    // Documented consequence of §5.3.4's numeric tier: the tier is ordered at 1000, so a rule put
    // above it runs later and can only fill gaps.
    const decision = evaluateRules(
      [rule('late', { priority: 2000, actions: { setCategoryId: 'late-cat', setDescription: 'd' } })],
      context,
      { folder, keywords: [keyword('keyword-cat', 'lidl', 2)] },
    );
    expect(decision.decidedBy).toBe('KEYWORD');
    expect(decision.actions.setCategoryId).toBe('keyword-cat');
    expect(decision.actions.setDescription).toBe('d');
    expect(decision.keywordShadowed).toBe(false);
  });

  it('does not shadow when the keyword gate fails', () => {
    const decision = evaluateRules([rule('r', { actions: { setCategoryId: 'rule-cat' } })], context, {
      folder,
      keywords: [keyword('weak', 'lidl', 1)],
    });
    expect(decision.keyword?.decision).toBeNull();
    expect(decision.keywordShadowed).toBe(false);
  });

  it('records the keyword tier in the losing candidates when a rule decides', () => {
    const decision = evaluateRules(
      [rule('user-rule', { priority: 999, actions: { setCategoryId: 'rule-cat' } })],
      context,
      { folder, keywords: [keyword('keyword-cat', 'lidl', 5), keyword('runner-up', 'lidl', 1)] },
    );
    expect(decision.decidedBy).toBe('RULE');
    expect(losingRuleIds(decision)).toEqual([]);
    expect(losingKeywordIds(decision)).toEqual(['keyword-cat', 'runner-up']);
  });

  it('leaves the deciding keyword out of its own losing candidates', () => {
    const decision = evaluateRules([], context, {
      folder,
      keywords: [keyword('winner', 'lidl', 3), keyword('runner', 'lidl', 1)],
    });
    expect(decision.decidedBy).toBe('KEYWORD');
    expect(decision.actions.setCategoryId).toBe('winner');
    expect(losingKeywordIds(decision)).toEqual(['runner']);
  });
});

describe('NONE — fall through to AI rather than guess', () => {
  it('decides nothing when nothing matches', () => {
    const decision = evaluateRules([], context, options);
    expect(decision.decidedBy).toBe('NONE');
    expect(decision.ruleId).toBeNull();
    expect(decision.decidingRule).toBeNull();
    expect(decision.actions).toEqual({});
    expect(decision.contributingRuleIds).toEqual([]);
    expect(decision.matchedRuleIds).toEqual([]);
    expect(decision.candidates).toEqual([]);
    expect(decision.confidence).toBeNull();
    expect(decision.flags).toEqual([]);
  });

  it('decides nothing when a rule matches but sets no category and no keyword clears the gate', () => {
    const decision = evaluateRules([rule('merchant-only', { actions: { setMerchantId: 'm' } })], context, options);
    expect(decision.decidedBy).toBe('NONE');
    expect(decision.actions.setMerchantId).toBe('m');
    expect(decision.contributingRuleIds).toEqual(['merchant-only']);
  });

  it('skips an inactive rule but still counts its match nowhere', () => {
    const decision = evaluateRules([rule('off', { isActive: false, actions: { setCategoryId: 'x' } })], context, options);
    expect(decision.decidedBy).toBe('NONE');
    expect(decision.matchedRuleIds).toEqual([]);
  });
});

describe('regex refusal is visible and cannot break the evaluation (§5.2)', () => {
  const regexRule = rule('regex', {
    conditions: { all: [{ field: 'text', op: 'regex', value: '^lidl' }] },
    actions: { setCategoryId: 'regex-cat' },
  });

  it('reports the rule as non-matching and flags it, and still applies the other rules', () => {
    const decision = evaluateRules(
      [regexRule, rule('plain', { priority: 200, actions: { setCategoryId: 'plain-cat' } })],
      context,
      options,
    );
    expect(decision.matchedRuleIds).toEqual(['plain']);
    expect(decision.actions.setCategoryId).toBe('plain-cat');
    expect(decision.flags).toHaveLength(1);
    expect(decision.flags[0]?.code).toBe('REGEX_DISABLED');
    expect(decision.flags[0]?.ruleId).toBe('regex');
  });

  it('evaluates the pattern when allowRegex is true', () => {
    const decision = evaluateRules([regexRule], context, { folder, allowRegex: true });
    expect(decision.actions.setCategoryId).toBe('regex-cat');
    expect(decision.flags).toEqual([]);
  });
});

describe('document refusal', () => {
  const deep = rule('deep', {
    conditions: { all: [{ any: [{ none: [{ all: [textContains('lidl')] }] }] }] },
  });

  it('refuses a depth-4 tree with a typed error rather than evaluating it', () => {
    expect(() => evaluateRules([deep], context, options)).toThrowError(RuleDocumentError);
    try {
      evaluateRules([deep], context, options);
    } catch (error) {
      expect((error as RuleDocumentError).code).toBe('DEPTH_EXCEEDED');
      expect((error as RuleDocumentError).ruleId).toBe('deep');
    }
  });

  it('validates inactive rules too, so deactivating a bad rule is not a quarantine', () => {
    expect(() => evaluateRules([{ ...deep, isActive: false }], context, options)).toThrowError(
      RuleDocumentError,
    );
  });

  it('refuses an unparseable createdAt', () => {
    expect(() => validateRule(rule('bad-date', { createdAt: 'yesterday' }))).toThrowError(
      RuleDocumentError,
    );
  });

  it('refuses a non-string action value', () => {
    expect(() =>
      validateRule(rule('bad-action', { actions: { setCategoryId: 42 as unknown as string } })),
    ).toThrowError(RuleDocumentError);
  });

  it('refuses malformed addTagIds, an empty id and a non-finite priority', () => {
    expect(() =>
      validateRule(rule('bad-tags', { actions: { addTagIds: [1 as unknown as string] } })),
    ).toThrowError(RuleDocumentError);
    expect(() =>
      validateRule(rule('bad-tags', { actions: { addTagIds: 't1' as unknown as readonly string[] } })),
    ).toThrowError(RuleDocumentError);
    expect(() => validateRule(rule('', {}))).toThrowError(RuleDocumentError);
    expect(() => validateRule(rule('bad-priority', { priority: Number.POSITIVE_INFINITY }))).toThrowError(
      RuleDocumentError,
    );
  });
});

describe('purity and determinism', () => {
  it('gives a deep-equal result twice and mutates neither the rules nor the context', () => {
    const rules = Object.freeze([
      Object.freeze(rule('a', { priority: 10, actions: Object.freeze({ setCategoryId: 'cat-a', addTagIds: Object.freeze(['t1']) }) })),
      Object.freeze(rule('b', { priority: 20, actions: Object.freeze({ addTagIds: Object.freeze(['t2']) }) })),
    ]);
    const frozenContext = Object.freeze({ text: 'lidl', amountMinor: 2000n });
    const order = rules.map((entry) => entry.id);

    const first = evaluateRules(rules, frozenContext, options);
    const second = evaluateRules(rules, frozenContext, options);

    expect(second).toEqual(first);
    expect(rules.map((entry) => entry.id)).toEqual(order);
    expect(frozenContext.text).toBe('lidl');
  });

  it('does not mutate the keywords it was given', () => {
    const keywords = Object.freeze([Object.freeze(keyword('cat', 'lidl', 2))]);
    const first = evaluateRules([], context, { folder, keywords });
    const second = evaluateRules([], context, { folder, keywords });
    expect(second).toEqual(first);
    expect(keywords).toHaveLength(1);
  });
});
