import { describe, expect, it } from 'vitest';

import {
  DUPLICATE_DATE_TOLERANCE_DAYS,
  DUPLICATE_DESCRIPTION_SIMILARITY,
  DUPLICATE_SUBMISSION_WINDOW_MS,
  findDuplicateSubject,
  type DuplicateCandidate,
  type DuplicateSubject,
} from './duplicate-detection';

/**
 * Duplicate-suspect matching, docs/06 §5.2.2.
 *
 * Pure, so every rule and every boundary is asserted directly. The two boundaries that matter are the
 * ones a rounding error would move: the ±2-day date tolerance and the ±5-minute submission window.
 * Both are inclusive, and a test on each side of each is the only thing that keeps that true.
 */

const NOW = new Date('2026-09-14T10:00:00.000Z');

function subject(overrides: Partial<DuplicateSubject> = {}): DuplicateSubject {
  return {
    transactionId: 'new-1',
    accountId: 'acct-1',
    kind: 'EXPENSE',
    amountMinor: 200000n,
    occurredLocalDate: '2026-09-14',
    description: 'Lidl',
    merchantId: null,
    createdAt: NOW,
    ...overrides,
  };
}

function candidate(overrides: Partial<DuplicateCandidate> = {}): DuplicateCandidate {
  return {
    id: 'old-1',
    accountId: 'acct-1',
    kind: 'EXPENSE',
    amountMinor: 200000n,
    occurredLocalDate: '2026-09-14',
    description: 'Lidl',
    merchantId: null,
    createdAt: NOW,
    ...overrides,
  };
}

function match(subjectOverrides: Partial<DuplicateSubject>, ...candidates: DuplicateCandidate[]) {
  return findDuplicateSubject({ subject: subject(subjectOverrides), candidates });
}

describe('findDuplicateSubject', () => {
  it('flags an identical row submitted moments ago, and says what it matched on', () => {
    const result = match({}, candidate());

    expect(result).not.toBeNull();
    expect(result!.existingTransactionId).toBe('old-1');
    expect(result!.similarity).toBe(1);
    expect(result!.matchedOn).toEqual(['amount', 'description', 'date']);
  });

  it('ignores a different account, kind or amount (rules 1–2)', () => {
    expect(match({}, candidate({ accountId: 'acct-2' }))).toBeNull();
    expect(match({}, candidate({ kind: 'INCOME' }))).toBeNull();
    // 200000n vs 200001n: one para is a different payment, not a duplicate.
    expect(match({}, candidate({ amountMinor: 200001n }))).toBeNull();
  });

  it('ignores a description that is not alike when no merchant matches (rule 4)', () => {
    expect(match({}, candidate({ description: 'Gorivo' }))).toBeNull();
  });

  it('flags an identical merchant even when the descriptions differ (rule 4, second arm)', () => {
    const result = match(
      { merchantId: 'merchant-1', description: 'Lidl u Zemunu' },
      candidate({ merchantId: 'merchant-1', description: 'Maxi' }),
    );

    expect(result).not.toBeNull();
    expect(result!.matchedOn).toEqual(['amount', 'merchant', 'date']);
    // The similarity is reported honestly rather than faked to 1 — a merchant match with unlike
    // baskets is the weak case the user should be able to see.
    expect(result!.similarity).toBeLessThan(DUPLICATE_DESCRIPTION_SIMILARITY);
  });

  it('does not treat two null merchants as a merchant match', () => {
    // `null === null` would otherwise make every untagged row a merchant match for every other.
    expect(match({ description: 'Lidl' }, candidate({ description: 'Gorivo' }))).toBeNull();
  });

  it('is inclusive at the ±2-day date tolerance and exclusive beyond it (rule 3)', () => {
    const inside = (day: string) =>
      match({ occurredLocalDate: '2026-09-14' }, candidate({ occurredLocalDate: day }));

    expect(inside('2026-09-12')).not.toBeNull();
    expect(inside('2026-09-16')).not.toBeNull();
    expect(inside('2026-09-11')).toBeNull();
    expect(inside('2026-09-17')).toBeNull();
    expect(DUPLICATE_DATE_TOLERANCE_DAYS).toBe(2);
  });

  it('is inclusive at the submission window and exclusive beyond it', () => {
    const at = (offsetMs: number) =>
      match({}, candidate({ createdAt: new Date(NOW.getTime() + offsetMs) }));

    expect(at(DUPLICATE_SUBMISSION_WINDOW_MS)).not.toBeNull();
    expect(at(-DUPLICATE_SUBMISSION_WINDOW_MS)).not.toBeNull();
    expect(at(DUPLICATE_SUBMISSION_WINDOW_MS + 1)).toBeNull();
  });

  it('flags a repeated row inside one batch, where the candidate is the EARLIER write', () => {
    // The second of two identical rows in one commit has a later `createdAt` than the first, so the
    // candidate's timestamp is in the past — the window must accept a negative delta or the clearest
    // duplicate of all would be missed.
    const result = match(
      { transactionId: 'second', createdAt: new Date(NOW.getTime() + 5) },
      candidate({ id: 'first', createdAt: NOW }),
    );
    expect(result?.existingTransactionId).toBe('first');
  });

  it('never matches a row against itself', () => {
    expect(match({ transactionId: 'old-1' }, candidate({ id: 'old-1' }))).toBeNull();
  });

  it('folds accents and script before comparing, so `septička` matches `septicka`', () => {
    // The same fold the classifier uses, so a description that matches a keyword also matches itself
    // across diacritics (docs/04 §3.1).
    expect(match({ description: 'septička jama' }, candidate({ description: 'septicka jama' }))).not.toBeNull();
  });

  it('picks the most similar candidate, and the newest when two are equally similar', () => {
    const best = match(
      { description: 'Lidl 2000' },
      candidate({ id: 'far', description: 'Lidl', createdAt: NOW }),
      candidate({ id: 'close', description: 'Lidl 2000', createdAt: NOW }),
    );
    expect(best!.existingTransactionId).toBe('close');

    const newest = match(
      { description: 'Lidl' },
      candidate({ id: 'older', createdAt: new Date(NOW.getTime() - 1000) }),
      candidate({ id: 'newer', createdAt: NOW }),
    );
    expect(newest!.existingTransactionId).toBe('newer');
  });

  it('returns null rather than throwing on an unparseable date', () => {
    // Both sides come from a `date` column, so this cannot happen in practice — but a comparison that
    // silently treated `NaN` as "within tolerance" would flag every row as a duplicate.
    expect(match({}, candidate({ occurredLocalDate: 'not-a-date' }))).toBeNull();
  });

  it('is not fooled by a shared prefix alone', () => {
    // `Lidl` vs `Lidl i Maxi` is the SAME shop, and similarity is just under the threshold — which is
    // the trade-off working as designed: a slightly different basket at the same merchant is a
    // merchant match (when one is resolved) or nothing, never a false "you typed this twice".
    const similarity = findDuplicateSubject({
      subject: subject({ description: 'Lidl u Zemunu' }),
      candidates: [candidate({ description: 'Maxi u Zemunu' })],
    });
    expect(similarity).toBeNull();
  });
});
