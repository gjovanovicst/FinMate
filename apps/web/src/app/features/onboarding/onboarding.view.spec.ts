import { describe, expect, it } from 'vitest';

import {
  COMPLETE_STEP,
  FIRST_STEP,
  LAST_STEP,
  ONBOARDING_STEPS,
  RELATION_WORDS,
  canContinue,
  clampStep,
  filterMerchants,
  merchantGroups,
  move,
  needsOnboarding,
  personNameFrom,
  personProposals,
  previewRows,
  stepAt,
  toggleSelection,
  treeSummary,
  writesOnContinue,
} from './onboarding.view';

/**
 * The onboarding wizard's decisions.
 *
 * Two of these are the difference between a wizard that helps and one that traps:
 *
 *  - **`needsOnboarding` keys on `completedAt`, not on whether the tree is empty.** A user who finished
 *    onboarding and then deleted their categories must not be sent back into it; that is why the server
 *    stores a timestamp instead of inferring completion from row counts.
 *  - **`personNameFrom` strips relationship words.** `Dejan rođa` is "Dejan my cousin", and a
 *    Counterparty named `Dejan rođa` would never match a later `Dejan 2000` — the opposite of what F-13
 *    step 3 exists for.
 */

describe('step arithmetic', () => {
  it('lists the six steps of docs/02 §4.1 in order', () => {
    expect(ONBOARDING_STEPS.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ONBOARDING_STEPS.map((step) => step.key)).toEqual([
      'categories',
      'accounts',
      'people',
      'merchants',
      'plan',
      'firstEntry',
    ]);
  });

  it('clamps nonsense into the legal range instead of rendering nothing', () => {
    // A hand-edited settings row must not produce an empty screen.
    expect(clampStep(0)).toBe(FIRST_STEP);
    expect(clampStep(-4)).toBe(FIRST_STEP);
    expect(clampStep(99)).toBe(COMPLETE_STEP);
    expect(clampStep(Number.NaN)).toBe(FIRST_STEP);
    expect(clampStep(3.7)).toBe(3);
  });

  it('never wraps when moving', () => {
    // Back at step 1 does nothing; Continue past the last step finishes rather than looping.
    expect(move(1, -1)).toBe(1);
    expect(move(3, 1)).toBe(4);
    expect(move(LAST_STEP, 1)).toBe(COMPLETE_STEP);
    expect(move(COMPLETE_STEP, 1)).toBe(COMPLETE_STEP);
  });

  it('has no step definition past the end', () => {
    expect(stepAt(1)?.key).toBe('categories');
    expect(stepAt(LAST_STEP)?.key).toBe('firstEntry');
    expect(stepAt(COMPLETE_STEP)).toBeNull();
  });
});

describe('needsOnboarding', () => {
  it('sends a Household that has never onboarded into the wizard', () => {
    expect(needsOnboarding({ step: 1, completedAt: null })).toBe(true);
    expect(needsOnboarding({ step: 4, completedAt: null })).toBe(true);
  });

  it('does NOT send a finished Household back, even with nothing to show', () => {
    // The whole reason completion is a timestamp: a household that deleted its tree is still done.
    expect(needsOnboarding({ step: COMPLETE_STEP, completedAt: '2026-09-15T10:00:00.000Z' })).toBe(false);
    expect(needsOnboarding({ step: 2, completedAt: '2026-09-15T10:00:00.000Z' })).toBe(false);
  });

  it('treats step 7 without a timestamp as done', () => {
    // The server writes both together, but a partially-written row should not re-open the wizard.
    expect(needsOnboarding({ step: COMPLETE_STEP, completedAt: null })).toBe(false);
  });

  it('tolerates a Date as well as an ISO string', () => {
    expect(needsOnboarding({ step: 3, completedAt: new Date() })).toBe(false);
  });
});

describe('the starter tree preview', () => {
  it('renders every node the server would create, parents before children', () => {
    const rows = previewRows();
    const summary = treeSummary();
    expect(rows).toHaveLength(summary.categories);

    const seen = new Set<string>();
    for (const row of rows) {
      if (row.parentKey !== null) {
        expect(seen.has(row.parentKey), `${row.key} precedes ${row.parentKey}`).toBe(true);
      }
      seen.add(row.key);
    }
  });

  it('nests to one level for the categories that have a parent', () => {
    const rows = previewRows();
    const supermarket = rows.find((row) => row.key === 'hrana-supermarket')!;
    expect(supermarket.depth).toBe(2);
    expect(supermarket.parentKey).toBe('hrana');

    const food = rows.find((row) => row.key === 'hrana')!;
    expect(food.depth).toBe(1);
    expect(food.parentKey).toBeNull();
  });

  it('reports both directions, so the wizard can show the two tabs', () => {
    const summary = treeSummary();
    expect(summary.expense).toBeGreaterThan(30);
    expect(summary.income).toBeGreaterThanOrEqual(4);
    expect(summary.expense + summary.income).toBe(summary.categories);
  });

  it('counts decisive and corroborating keywords separately', () => {
    // The distinction is load-bearing (docs/04 §8.1.3), so the preview must not flatten it: a tree of
    // only corroborating keywords categorises nothing, and the count is what makes that visible.
    const summary = treeSummary();
    expect(summary.decisive).toBeGreaterThan(50);
    expect(summary.corroborating).toBeGreaterThan(10);
    expect(summary.blocked).toBeGreaterThan(0);
  });

  it('carries each node\u2019s own keyword counts', () => {
    const supermarket = previewRows().find((row) => row.key === 'hrana-supermarket')!;
    expect(supermarket.decisive).toBeGreaterThanOrEqual(6);
    expect(supermarket.corroborating).toBe(0);

    const fuel = previewRows().find((row) => row.key === 'auto-gorivo')!;
    // `ulje` must appear as a blocker here, not as a keyword that attracts.
    expect(fuel.blocked).toBeGreaterThan(0);
  });
});

describe('personNameFrom', () => {
  it("strips the relationship word from docs/01 F-13's own example", () => {
    expect(personNameFrom('Dejan rođa')).toBe('Dejan');
  });

  it('strips Cyrillic and diacritic spellings through the same fold', () => {
    expect(personNameFrom('Дејан рођак'.replace('рођак', 'рођа'))).toBe('Дејан');
    expect(personNameFrom('Marko brat')).toBe('Marko');
    expect(personNameFrom('Jelena sestra')).toBe('Jelena');
  });

  it('keeps a phrase that is not a person at all', () => {
    // `septička jama` is *who you pay* for the septic tank — a bill, not a person, and there is no
    // relationship word to strip.
    expect(personNameFrom('septička jama')).toBe('septička jama');
  });

  it('never returns an empty name', () => {
    // A phrase made only of relationship words keeps its original form rather than becoming nameless.
    expect(personNameFrom('rođa')).toBe('rođa');
    expect(personNameFrom('  ')).toBe('');
  });

  it('keeps a middle name and only removes the relation', () => {
    expect(personNameFrom('Dejan Petrović rođa')).toBe('Dejan Petrović');
  });

  it('lists relationship words folded, so both scripts match', () => {
    // Guards the list itself: an unfolded entry would be dead weight and silently stop matching.
    for (const word of RELATION_WORDS) {
      expect(word, `${word} is not folded`).toBe(word.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
    }
  });
});

describe('personProposals', () => {
  it('pairs each server fragment with the Counterparty to create', () => {
    const proposals = personProposals([
      { description: 'Dejan rođa', categoryId: 'cat-house', needsReview: false },
      { description: 'septička jama', categoryId: 'cat-septic', needsReview: false },
    ]);

    expect(proposals.map((proposal) => proposal.personName)).toEqual(['Dejan', 'septička jama']);
    expect(proposals.map((proposal) => proposal.categoryId)).toEqual(['cat-house', 'cat-septic']);
  });

  it('stores the WHOLE phrase as the alias, not the trimmed name', () => {
    // Rung 3 requires every folded token of the name to occur in the input, so `Dejan` alone would not
    // match a later `Dejan rođa 3600`. The alias is what makes step 3 pay off on the next capture.
    const [proposal] = personProposals([
      { description: 'Dejan rođa', categoryId: null, needsReview: true },
    ]);
    expect(proposal?.alias).toBe('dejan roda');
    expect(proposal?.personName).toBe('Dejan');
  });

  it('keeps the position so removing a card does not renumber the rest', () => {
    const proposals = personProposals([
      { description: 'A', categoryId: null, needsReview: false },
      { description: 'B', categoryId: null, needsReview: false },
      { description: 'C', categoryId: null, needsReview: false },
    ]);
    expect(proposals.map((proposal) => proposal.index)).toEqual([0, 1, 2]);
  });

  it('carries the pipeline\u2019s uncertainty rather than asserting a category', () => {
    const [proposal] = personProposals([
      { description: 'Nepoznato', categoryId: null, needsReview: true },
    ]);
    expect(proposal?.needsReview).toBe(true);
    expect(proposal?.categoryId).toBeNull();
  });

  it('has nothing to propose for empty input', () => {
    expect(personProposals([])).toEqual([]);
  });
});

describe('merchantGroups', () => {
  it('groups the shipped catalogue by the category path each merchant suggests', () => {
    const groups = merchantGroups();
    const supermarket = groups.find((group) => group.categoryPath === 'Hrana \u203a Supermarket');
    expect(supermarket?.merchants).toContain('Lidl');
    expect(supermarket?.merchants).toContain('Maxi');
  });

  it('covers every shipped merchant exactly once', () => {
    // A merchant the tree cannot place would be invisible in the step-4 picker.
    const grouped = merchantGroups().flatMap((group) => group.merchants);
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(grouped.length).toBeGreaterThanOrEqual(60);
  });

  it('orders groups the way the tree reads, so it matches step 1', () => {
    const groups = merchantGroups();
    expect(groups[0]?.categoryPath).toBe('Hrana \u203a Supermarket');
    const paths = groups.map((group) => group.categoryPath);
    expect(paths.indexOf('Hrana \u203a Supermarket')).toBeLessThan(paths.indexOf('Zabava \u203a Pretplate'));
  });

  it('surfaces a merchant whose suggestion the tree cannot resolve instead of hiding it', () => {
    const groups = merchantGroups([{ name: 'Orphan', categoryKey: 'does-not-exist' }]);
    expect(groups).toEqual([{ categoryPath: '?', merchants: ['Orphan'] }]);
  });
});

describe('filterMerchants', () => {
  it('matches on the name and on the aliases', () => {
    expect(filterMerchants('lidl')).toContain('Lidl');
    // `лидл` is a shipped alias, so a Cyrillic search finds the same merchant.
    expect(filterMerchants('лидл')).toContain('Lidl');
  });

  it('ignores case and diacritics', () => {
    expect(filterMerchants('DJAK')).toContain('Đak Sport');
  });

  it('returns everything for a blank query', () => {
    expect(filterMerchants('   ').length).toBeGreaterThanOrEqual(60);
  });

  it('returns nothing for a miss, rather than everything', () => {
    expect(filterMerchants('nepostojeci-market')).toEqual([]);
  });
});

describe('toggleSelection', () => {
  it('adds at the end and removes in place', () => {
    expect(toggleSelection([], 'Lidl')).toEqual(['Lidl']);
    expect(toggleSelection(['Lidl'], 'Maxi')).toEqual(['Lidl', 'Maxi']);
    expect(toggleSelection(['Lidl', 'Maxi'], 'Lidl')).toEqual(['Maxi']);
  });
});

describe('canContinue', () => {
  const draft = (over: Partial<Parameters<typeof canContinue>[1]> = {}) => ({
    categoryCount: 0,
    accountCount: 0,
    acceptedPeople: 0,
    selectedMerchants: 0,
    ...over,
  });

  it('will not press Continue on step 1 with no tree, because that writes nothing', () => {
    // Continue calls `seedStarterCategories`; Skip is the control for "I want an empty tree".
    expect(canContinue(1, draft({ categoryCount: 0 }))).toBe(false);
    expect(canContinue(1, draft({ categoryCount: 39 }))).toBe(true);
  });

  it('requires an account before step 2 and step 6 can proceed', () => {
    // A Transaction needs an Account (I-4), and step 6 commits one.
    expect(canContinue(2, draft({ accountCount: 0 }))).toBe(false);
    expect(canContinue(2, draft({ accountCount: 1 }))).toBe(true);
    expect(canContinue(6, draft({ accountCount: 0 }))).toBe(false);
    expect(canContinue(6, draft({ accountCount: 1 }))).toBe(true);
  });

  it('lets steps 3, 4 and 5 proceed with nothing chosen', () => {
    // docs/01 F-13: skippable at every step. Only an invalid WRITE is blocked.
    expect(canContinue(3, draft())).toBe(true);
    expect(canContinue(4, draft())).toBe(true);
    expect(canContinue(5, draft())).toBe(true);
  });

  it('is false past the end, where no step definition exists', () => {
    expect(canContinue(COMPLETE_STEP, draft({ categoryCount: 1, accountCount: 1 }))).toBe(false);
  });

  it('names the steps whose Continue actually writes', () => {
    // Step 3 writes Counterparties through its own cards, and step 6 through the capture pipeline, so
    // neither is in this set: their work is not done by the Continue button.
    expect([1, 2, 4, 5].map(writesOnContinue)).toEqual([true, true, true, true]);
    expect(writesOnContinue(3)).toBe(false);
    expect(writesOnContinue(6)).toBe(false);
  });
});
