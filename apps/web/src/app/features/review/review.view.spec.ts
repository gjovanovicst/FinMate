import { describe, expect, it } from 'vitest';

import {
  MAX_ALTERNATIVES,
  badgeOf,
  canApplyToSimilar,
  choicesOf,
  commandFor,
  cursorAfterRemoval,
  isEditableTarget,
  nextIndex,
  percentOf,
  rememberAvailable,
  resolvePlan,
  type KeyContext,
  type ReviewItem,
} from './review.view';

/**
 * The review queue's decisions.
 *
 * Two properties carry the weight here and both are silent when they break:
 *
 *  - **the queue never auto-resolves**, which is `resolvePlan` returning `null` for a row with no
 *    choice — the difference between "unanswered" and "answered with nothing";
 *  - **a control the server ignores is never offered**, which is `rememberAvailable` and
 *    `canApplyToSimilar` — a tick that does nothing teaches the user the learning loop is broken.
 *
 * The keyboard is covered here too, including the §8 rule that a shortcut must not fire inside a
 * form control: `commandFor` re-checks it rather than trusting its caller.
 */

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'item-1',
    reason: 'LOW_CONFIDENCE',
    confidence: 0.55,
    suggestedCategoryId: 'cat-food',
    candidates: [],
    ageHours: 3,
    transaction: {
      id: 'tx-1',
      kind: 'EXPENSE',
      status: 'PENDING',
      amount: { amountMinor: '200000', currency: 'RSD' },
      description: 'Lidl',
      occurredLocalDate: '2026-09-14',
      categoryId: 'cat-food',
      merchantId: null,
      counterpartyId: null,
    },
    ...overrides,
  };
}

/** An uncategorised row: `category_id IS NULL`, so I-8 puts it in the blocking lane too. */
function uncategorised(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return item({
    reason: 'UNCATEGORISED',
    confidence: 0,
    suggestedCategoryId: null,
    transaction: { ...item().transaction, categoryId: null },
    ...overrides,
  });
}

function key(partial: Partial<KeyContext> = {}): KeyContext {
  return { key: '', modified: false, targetTag: 'OL', targetEditable: false, ...partial };
}

describe('badgeOf', () => {
  it("uses docs/04 §7's bands", () => {
    expect(badgeOf(item({ confidence: 0.95 }))).toBe('AUTO');
    expect(badgeOf(item({ confidence: 0.9 }))).toBe('AUTO');
    expect(badgeOf(item({ confidence: 0.89 }))).toBe('VERIFY');
    expect(badgeOf(item({ confidence: 0.6 }))).toBe('VERIFY');
    expect(badgeOf(item({ confidence: 0.59 }))).toBe('ASK');
    expect(badgeOf(item({ confidence: 0 }))).toBe('ASK');
  });

  it('separates "no confidence recorded" from zero', () => {
    // The API distinguishes them on purpose; drawing both as 0 % would present a missing fact as a
    // measurement (docs/06 §4.2).
    expect(badgeOf(item({ confidence: null }))).toBe('NONE');
    expect(badgeOf(item({ confidence: 0 }))).not.toBe('NONE');
  });
});

describe('choicesOf', () => {
  it('leads with the suggestion, then the losing candidates by descending confidence', () => {
    const row = item({
      suggestedCategoryId: 'cat-food',
      candidates: [
        { categoryId: 'cat-gift', confidence: 0.4 },
        { categoryId: 'cat-house', confidence: 0.45 },
      ],
    });
    expect(choicesOf(row)).toEqual(['cat-food', 'cat-house', 'cat-gift']);
  });

  it('de-duplicates the suggestion when it is also a candidate', () => {
    // `ReviewService.enrich` sets the suggestion from the stored category, which is usually the top
    // candidate. Without this, `1` and `2` would be the same category and the accelerator would look
    // like it did something while changing nothing.
    const row = item({
      suggestedCategoryId: 'cat-food',
      candidates: [
        { categoryId: 'cat-food', confidence: 0.55 },
        { categoryId: 'cat-house', confidence: 0.2 },
      ],
    });
    expect(choicesOf(row)).toEqual(['cat-food', 'cat-house']);
  });

  it('caps the list at MAX_ALTERNATIVES', () => {
    const row = item({
      suggestedCategoryId: 'c1',
      candidates: [
        { categoryId: 'c2', confidence: 0.5 },
        { categoryId: 'c3', confidence: 0.4 },
        { categoryId: 'c4', confidence: 0.3 },
        { categoryId: 'c5', confidence: 0.2 },
      ],
    });
    expect(MAX_ALTERNATIVES).toBe(3);
    expect(choicesOf(row)).toEqual(['c1', 'c2', 'c3']);
  });

  it('has no alternatives for an uncategorised row with no candidates', () => {
    expect(choicesOf(uncategorised())).toEqual([]);
  });

  it('drops a malformed candidate rather than rendering an empty chip', () => {
    const row = item({
      suggestedCategoryId: null,
      candidates: [
        { categoryId: '', confidence: 0.5 },
        { categoryId: 'cat-house', confidence: 0.4 },
      ],
    });
    expect(choicesOf(row)).toEqual(['cat-house']);
  });
});

describe('resolvePlan', () => {
  it('refuses to resolve a row with nothing chosen', () => {
    // The invariant the whole screen rests on: an uncategorised row has no suggestion to accept, and
    // inventing one would clear the flag while leaving the question unanswered (docs/02 §4.6).
    expect(resolvePlan(uncategorised(), null)).toBeNull();
    expect(resolvePlan(item(), null)).toBeNull();
  });

  it('confirms the stored category without learning anything', () => {
    const plan = resolvePlan(item(), 'cat-food');
    expect(plan).toEqual({ action: 'ACCEPT_SUGGESTION', categoryId: null, learns: false });
  });

  it('routes a changed category through the correction path', () => {
    const plan = resolvePlan(item(), 'cat-house');
    expect(plan).toEqual({ action: 'SET_CATEGORY', categoryId: 'cat-house', learns: true });
  });

  it('categorises an uncategorised row through the correction path', () => {
    const plan = resolvePlan(uncategorised(), 'cat-house');
    expect(plan).toEqual({ action: 'SET_CATEGORY', categoryId: 'cat-house', learns: true });
  });

  it('compares against the STORED category, not the suggestion', () => {
    // The server's `SET_CATEGORY` arm compares with the row's current category. A row whose
    // suggestion drifted from what is stored must send SET_CATEGORY, not ACCEPT_SUGGESTION.
    const row = item({
      suggestedCategoryId: 'cat-house',
      transaction: { ...item().transaction, categoryId: 'cat-food' },
    });
    expect(resolvePlan(row, 'cat-food')?.action).toBe('ACCEPT_SUGGESTION');
    expect(resolvePlan(row, 'cat-house')?.action).toBe('SET_CATEGORY');
  });
});

describe('rememberAvailable', () => {
  it('is offered only where the server honours it', () => {
    // `correctTransaction` is the only path that reads `rememberForFuture` (docs/06 §5.5), so a
    // checkbox on the accept path would be ignored — and a checkbox that does nothing is a lie.
    expect(rememberAvailable(item(), 'cat-house')).toBe(true);
    expect(rememberAvailable(uncategorised(), 'cat-house')).toBe(true);
    expect(rememberAvailable(item(), 'cat-food')).toBe(false);
    expect(rememberAvailable(item(), null)).toBe(false);
  });
});

describe('canApplyToSimilar', () => {
  it('needs a resolved Merchant or Counterparty', () => {
    // `similarQueuedRows` returns nothing without one: "uncategorised rows of the same kind" is not a
    // group a person would recognise.
    expect(canApplyToSimilar(item())).toBe(false);
    expect(canApplyToSimilar(item({ transaction: { ...item().transaction, merchantId: 'm-1' } }))).toBe(true);
    expect(
      canApplyToSimilar(item({ transaction: { ...item().transaction, counterpartyId: 'cp-1' } })),
    ).toBe(true);
  });
});

describe('isEditableTarget', () => {
  it('protects the form controls docs/02 §8 names', () => {
    expect(isEditableTarget('INPUT', false)).toBe(true);
    expect(isEditableTarget('TEXTAREA', false)).toBe(true);
    expect(isEditableTarget('DIV', true)).toBe(true);
  });

  it('also protects SELECT, beyond the letter of §8', () => {
    // A native select consumes 1-3 and the arrow keys, so letting accelerators through would fight
    // the control or silently change the row's category while the user navigated the dropdown.
    expect(isEditableTarget('select', false)).toBe(true);
  });

  it('leaves the list, buttons and links alone', () => {
    expect(isEditableTarget('OL', false)).toBe(false);
    expect(isEditableTarget('BUTTON', false)).toBe(false);
    expect(isEditableTarget('A', false)).toBe(false);
  });
});

describe('commandFor', () => {
  const choices = ['c1', 'c2', 'c3'];

  it('maps j and k to movement', () => {
    expect(commandFor(key({ key: 'j' }), choices)).toEqual({ kind: 'MOVE', delta: 1 });
    expect(commandFor(key({ key: 'k' }), choices)).toEqual({ kind: 'MOVE', delta: -1 });
  });

  it('maps the number keys to the listed alternatives', () => {
    expect(commandFor(key({ key: '1' }), choices)).toEqual({ kind: 'CHOOSE', categoryId: 'c1' });
    expect(commandFor(key({ key: '3' }), choices)).toEqual({ kind: 'CHOOSE', categoryId: 'c3' });
  });

  it('ignores a number past the end of the list', () => {
    expect(commandFor(key({ key: '3' }), ['c1'])).toEqual({ kind: 'NONE' });
    expect(commandFor(key({ key: '4' }), choices)).toEqual({ kind: 'NONE' });
    expect(commandFor(key({ key: '0' }), choices)).toEqual({ kind: 'NONE' });
  });

  it('maps Enter to resolve and c to the category picker', () => {
    expect(commandFor(key({ key: 'Enter' }), choices)).toEqual({ kind: 'RESOLVE' });
    expect(commandFor(key({ key: 'c' }), choices)).toEqual({ kind: 'FOCUS_CATEGORY' });
  });

  it('never fires with a modifier held', () => {
    for (const keyName of ['j', 'k', 'c', 'Enter', '1']) {
      expect(commandFor(key({ key: keyName, modified: true }), choices)).toEqual({ kind: 'NONE' });
    }
  });

  it('never fires inside a form control', () => {
    // Re-checked inside `commandFor`, so a caller that forgets the guard cannot break it.
    for (const targetTag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      for (const keyName of ['j', 'k', 'c', 'Enter', '1']) {
        expect(commandFor(key({ key: keyName, targetTag }), choices)).toEqual({ kind: 'NONE' });
      }
      expect(commandFor(key({ key: 'Enter', targetTag, targetEditable: false }), choices)).toEqual({
        kind: 'NONE',
      });
    }
    expect(commandFor(key({ key: 'j', targetTag: 'DIV', targetEditable: true }), choices)).toEqual({
      kind: 'NONE',
    });
  });

  it('leaves Shift+J and Shift+K alone', () => {
    // docs/02 §8 defines them as "extend selection", and multi-select is not built. A shortcut that
    // half-works is worse than one that does not exist.
    expect(commandFor(key({ key: 'J' }), choices)).toEqual({ kind: 'NONE' });
    expect(commandFor(key({ key: 'K' }), choices)).toEqual({ kind: 'NONE' });
  });

  it('ignores anything else', () => {
    expect(commandFor(key({ key: 'x' }), choices)).toEqual({ kind: 'NONE' });
    expect(commandFor(key({ key: 'Escape' }), choices)).toEqual({ kind: 'NONE' });
  });
});

describe('nextIndex', () => {
  it('moves within the list', () => {
    expect(nextIndex(0, 1, 5)).toBe(1);
    expect(nextIndex(3, -1, 5)).toBe(2);
  });

  it('clamps at both ends rather than wrapping', () => {
    // A `j` at the bottom that jumped to the top would lose the user's place in the queue.
    expect(nextIndex(4, 1, 5)).toBe(4);
    expect(nextIndex(0, -1, 5)).toBe(0);
  });

  it('is 0 for an empty list', () => {
    expect(nextIndex(0, 1, 0)).toBe(0);
    expect(nextIndex(7, -1, 0)).toBe(0);
  });
});

describe('cursorAfterRemoval', () => {
  it('stays put when the row below slides up', () => {
    expect(cursorAfterRemoval(0, 4)).toBe(0);
    expect(cursorAfterRemoval(2, 4)).toBe(2);
  });

  it('moves up when the last row left', () => {
    expect(cursorAfterRemoval(4, 4)).toBe(3);
    expect(cursorAfterRemoval(1, 1)).toBe(0);
  });

  it('is 0 when the queue is empty', () => {
    expect(cursorAfterRemoval(3, 0)).toBe(0);
  });
});

describe('percentOf', () => {
  it('rounds to whole percent, and has nothing to say about null', () => {
    expect(percentOf(0.615)).toBe(62);
    expect(percentOf(1)).toBe(100);
    expect(percentOf(0)).toBe(0);
    expect(percentOf(null)).toBeNull();
  });
});
