import { describe, expect, it } from 'vitest';

import {
  conditionsMatchWitness,
  distinctiveToken,
  LEARNED_RULE_PRIORITY,
  MIN_DISTINCTIVE_TOKEN_LENGTH,
  REPEATED_MERCHANT_CORRECTION_THRESHOLD,
  synthesiseRule,
  TRIGGER_CONFIDENCE,
  type CorrectionSubject,
} from './rule-synthesis';

/**
 * Rule synthesis, docs/04 §8.1.
 *
 * Pure, so each trigger and each rejection is asserted directly. The three things that matter:
 *
 * 1. **The narrowest rule wins.** A correction on a Transaction that resolved a Counterparty must
 *    produce the Counterparty rule, not a text rule — a text rule would also catch every other entry
 *    that happens to contain the word.
 * 2. **Nothing is auto-created and nothing is proposed on a guess that cannot work.** `null` is a
 *    real answer.
 * 3. **The witness matches the rule.** The caller runs the conflict check against the witness, so a
 *    witness the rule does not match would make that check vacuous.
 */

function subject(overrides: Partial<CorrectionSubject> = {}): CorrectionSubject {
  return {
    categoryId: 'cat-house',
    categoryName: 'Kuća / Septička jama',
    description: 'septička jama',
    merchantId: null,
    merchantName: null,
    counterpartyId: null,
    counterpartyName: null,
    priorSameMerchantCorrections: 0,
    ...overrides,
  };
}

describe('synthesiseRule — the narrowest trigger wins', () => {
  it('prefers the resolved Counterparty over the Merchant and over the text', () => {
    const result = synthesiseRule(
      subject({
        description: 'Dejan rođa septička',
        counterpartyId: 'cp-dejan',
        counterpartyName: 'Dejan rođa',
        merchantId: 'merchant-lidl',
        merchantName: 'Lidl',
      }),
    );

    expect(result?.proposal.trigger).toBe('COUNTERPARTY_RESOLVED');
    expect(result?.proposal.conditions).toEqual({
      all: [{ field: 'counterparty', op: 'eq', value: 'cp-dejan' }],
    });
    expect(result?.proposal.actions).toEqual({ setCategoryId: 'cat-house' });
    expect(result?.proposal.origin).toBe('LEARNED');
    expect(result?.proposal.priority).toBe(LEARNED_RULE_PRIORITY);
    expect(result?.keyword).toBeNull();
  });

  it('falls back to the Merchant when no Counterparty resolved', () => {
    const result = synthesiseRule(
      subject({ merchantId: 'merchant-lidl', merchantName: 'Lidl', description: 'Lidl 2000' }),
    );

    expect(result?.proposal.trigger).toBe('MERCHANT_RESOLVED');
    expect(result?.proposal.conditions).toEqual({
      all: [{ field: 'merchant', op: 'eq', value: 'merchant-lidl' }],
    });
  });

  it('falls back to a distinctive token when nothing resolved, and suggests the keyword too', () => {
    const result = synthesiseRule(subject({ description: 'septička jama 3600' }));

    expect(result?.proposal.trigger).toBe('DISTINCTIVE_TOKEN');
    // The folded form, because that is what `contains` compares against.
    expect(result?.proposal.conditions).toEqual({
      all: [{ field: 'text', op: 'contains', value: 'septicka' }],
    });
    // docs/04 §8.1's token row wants the keyword added alongside the rule: the rule catches the
    // phrase, the keyword strengthens the category for everything else.
    expect(result?.keyword).toEqual({ keyword: 'septicka', categoryId: 'cat-house' });
  });

  it('returns null rather than proposing a rule it cannot justify', () => {
    // A bare amount with no entity and no distinctive word: there is nothing to key a rule on, and
    // docs/04 §8.2 would rather propose nothing than propose permanent policy from a typo.
    expect(synthesiseRule(subject({ description: '2000' }))).toBeNull();
    expect(synthesiseRule(subject({ description: '' }))).toBeNull();
    // `kafa` is four letters and IS distinctive — a rule keyed on it is exactly what someone
    // logging coffee every morning wants. The short/generic rejections are asserted separately.
    expect(synthesiseRule(subject({ description: 'kafa' }))?.proposal.trigger).toBe('DISTINCTIVE_TOKEN');
    expect(synthesiseRule(subject({ description: 'i 2000' }))).toBeNull();
    expect(synthesiseRule(subject({ description: 'racun 2000' }))).toBeNull();
  });

  it('proposes fixing the Merchant default on the THIRD correction, not a fourth rule', () => {
    // docs/04 §8.2: "same merchant corrected 3× to the same category → suggest changing the
    // merchant's default category instead of adding a 4th rule".
    const third = synthesiseRule(
      subject({
        merchantId: 'merchant-lidl',
        merchantName: 'Lidl',
        priorSameMerchantCorrections: REPEATED_MERCHANT_CORRECTION_THRESHOLD - 1,
      }),
    );
    expect(third?.proposal.trigger).toBe('REPEATED_MERCHANT_CORRECTION');
    expect(third?.proposal.explanation).toContain("merchant's default category");
    expect(third?.proposal.explanation).toContain('3 times');

    // ...and the second correction is still an ordinary Merchant rule.
    const second = synthesiseRule(
      subject({
        merchantId: 'merchant-lidl',
        merchantName: 'Lidl',
        priorSameMerchantCorrections: REPEATED_MERCHANT_CORRECTION_THRESHOLD - 2,
      }),
    );
    expect(second?.proposal.trigger).toBe('MERCHANT_RESOLVED');
  });

  it('keeps the repeat trigger below the entity triggers in confidence but above a token', () => {
    expect(TRIGGER_CONFIDENCE.COUNTERPARTY_RESOLVED).toBeGreaterThan(
      TRIGGER_CONFIDENCE.MERCHANT_RESOLVED,
    );
    expect(TRIGGER_CONFIDENCE.MERCHANT_RESOLVED).toBeGreaterThan(
      TRIGGER_CONFIDENCE.DISTINCTIVE_TOKEN,
    );
    // A token from one entry is the weakest proposal there is; the explanation says so.
    const token = synthesiseRule(subject({ description: 'septička jama 3600' }));
    expect(token?.proposal.explanation).toMatch(/one entry/i);
  });

  it('writes a proposal the engine can validate: a well-formed leaf inside `all`', () => {
    for (const input of [
      subject({ counterpartyId: 'cp-1', counterpartyName: 'Dejan' }),
      subject({ merchantId: 'm-1', merchantName: 'Lidl' }),
      subject({ description: 'septička jama 3600' }),
    ]) {
      const result = synthesiseRule(input);
      const conditions = result!.proposal.conditions;
      expect(conditions).toHaveProperty('all');
      // Depth 1: `all` of leaves, which is the shallowest form docs/04 §5.2 allows and the one the
      // engine's specificity scorer counts as most specific.
      expect(Array.isArray((conditions as { all: unknown[] }).all)).toBe(true);
      expect((conditions as { all: unknown[] }).all).toHaveLength(1);
    }
  });
});

describe('distinctiveToken', () => {
  it('picks the longest eligible token, so the specific word wins', () => {
    expect(distinctiveToken('septička jama')).toBe('septicka');
    // Folded, so a Cyrillic description produces the same rule as its Latin spelling.
    expect(distinctiveToken('септичка јама')).toBe('septicka');
  });

  it('rejects numbers and words shorter than the threshold', () => {
    expect(distinctiveToken('2000')).toBeNull();
    // Three letters is below the threshold: `sok` (juice) is a good word but too short to key a
    // permanent rule on, because it is a substring of far too much else.
    expect(distinctiveToken('sok 200')).toBeNull();
    expect(distinctiveToken('bar 2000')).toBeNull();
    // Four letters is enough: a merchant name at the minimum length is still a merchant name.
    expect(distinctiveToken('lidl 2000')).toBe('lidl');
  });

  it('accepts a four-letter good — `ulje` is docs/04 §5.4’s own example', () => {
    expect(MIN_DISTINCTIVE_TOKEN_LENGTH).toBe(4);
    expect(distinctiveToken('ulje 1200')).toBe('ulje');
  });

  it('never proposes a rule keyed on a direction marker', () => {
    // A rule on `plata` would fight the parser, which already reads it as INCOME (docs/04 §3.1).
    expect(distinctiveToken('plata')).toBeNull();
    expect(distinctiveToken('povracaj')).toBeNull();
    expect(distinctiveToken('vraceno')).toBeNull();
    expect(distinctiveToken('storno')).toBeNull();
  });

  it('never proposes a rule keyed on a generic ledger word', () => {
    for (const word of ['kartica', 'gotovina', 'kupovina', 'mesecno', 'danas']) {
      expect(distinctiveToken(word), word).toBeNull();
    }
  });

  it('breaks a length tie by first appearance', () => {
    // Both are six letters; the one the user typed first is the one they think of first.
    expect(distinctiveToken('parking racun')).toBe('parking');
  });
});

describe('conditionsMatchWitness', () => {
  it('confirms the witness each trigger produces actually matches its own rule', () => {
    const cases = [
      subject({ counterpartyId: 'cp-1', counterpartyName: 'Dejan', description: 'Dejan 2000' }),
      subject({ merchantId: 'm-1', merchantName: 'Lidl', description: 'Lidl 2000' }),
      subject({ description: 'septička jama 3600' }),
    ];

    for (const input of cases) {
      const result = synthesiseRule(input)!;
      // If this were false the caller's conflict check would run the engine on an input the proposed
      // rule never matches, and report "no conflict" for a rule that would never fire either.
      expect(conditionsMatchWitness(result.proposal.conditions, result.witness)).toBe(true);
    }
  });

  it('is folded on both sides, so a Cyrillic witness matches a Latin condition', () => {
    const result = synthesiseRule(subject({ description: 'септичка јама 3600' }))!;
    expect(conditionsMatchWitness(result.proposal.conditions, { text: 'Septička', description: '' })).toBe(
      true,
    );
  });

  it('says no when the witness is a different entity', () => {
    const result = synthesiseRule(subject({ merchantId: 'm-1', merchantName: 'Lidl', description: 'Lidl' }))!;
    expect(conditionsMatchWitness(result.proposal.conditions, { merchantId: 'm-2' })).toBe(false);
  });
});
