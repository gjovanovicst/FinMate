import { describe, expect, it } from 'vitest';

import { missingActionSlots, planAction } from './action-planner';

/**
 * The action planner is pure, so this is the cheap half of B-2a's coverage: what a question means,
 * and — more importantly — what it does **not** mean. Every "not an action" case here is a question the
 * read planner must still get.
 */
describe('planAction (docs/06 §8.16)', () => {
  it('plans ADD_CATEGORY from the Serbian imperative', () => {
    const plan = planAction('dodaj kategoriju Putovanja');

    expect(plan?.action).toBe('ADD_CATEGORY');
    expect(plan?.slots['name']).toBe('Putovanja');
    expect(plan?.matchedOn).toContain('action:ADD_CATEGORY');
  });

  it('plans it from English too, with a word inserted between verb and object', () => {
    expect(planAction('add a new category Pet care')?.slots['name']).toBe('Pet care');
    expect(planAction('create category Gym')?.slots['name']).toBe('Gym');
  });

  it('keeps the name exactly as typed — script, case and diacritics are the user\'s', () => {
    // The fold is for comparing; storing `rodendan` because somebody typed `Rođendan` would be a bug
    // in the user's data, not a normalisation.
    expect(planAction('додај категорију Путовања')?.slots['name']).toBe('Путовања');
    expect(planAction('dodaj kategoriju Rođendan')?.slots['name']).toBe('Rođendan');
    expect(planAction('napravi novu kategoriju "Hrana za pse"')?.slots['name']).toBe('Hrana za pse');
  });

  it('keeps a name that is the word itself', () => {
    // The reason the *first* object token is the anchor rather than the last.
    expect(planAction('dodaj kategoriju Kategorija')?.slots['name']).toBe('Kategorija');
  });

  it('marks the request unbuildable when it does not say what to create', () => {
    const plan = planAction('dodaj kategoriju');

    expect(plan?.action).toBe('ADD_CATEGORY');
    expect(plan?.slots['name']).toBeUndefined();
    expect(missingActionSlots(plan!.action, plan!.slots)).toEqual(['name']);
  });

  it('is null when a question merely mentions the word', () => {
    // These must still reach the read planner — a verb *before* the object is what makes an
    // imperative, and none of these has one.
    expect(planAction('koliko sam potrošio na kategoriju hrana')).toBeNull();
    expect(planAction('na kategoriju hrana')).toBeNull();
    expect(planAction('kolika mi je penzija')).toBeNull();
    expect(planAction('')).toBeNull();
  });

  it('does not read an attributive adjective inside a question as an imperative', () => {
    // Found while preparing B-2b, by planning every action-shaped question against the read planner:
    // `nova`/`novu`/`novi`/`novo`/`new` are ordinary adjectives, and counting them anywhere before the
    // object made all three of these propose a write. The first two are questions about a category; the
    // third is a report. None may offer to create anything.
    expect(planAction('koja je nova kategorija najveća')).toBeNull();
    expect(planAction('koliko sam potrošio na novu kategoriju hrana')).toBeNull();
    expect(planAction('make a report of spending by category')).toBeNull();
  });

  it('still reads the adjective-only request shape when it leads', () => {
    // Serbian and English both drop the verb, so the leading adjective *is* the request — which is the
    // distinction the rule draws, and not a ban on the word.
    expect(planAction('nova kategorija Hrana')?.slots['name']).toBe('Hrana');
    expect(planAction('new category Travel')?.slots['name']).toBe('Travel');
    expect(planAction('napravi novu kategoriju Hrana')?.slots['name']).toBe('Hrana');
  });

  it('takes an imperative that a polite lead-in precedes', () => {
    // Why the imperative rung is not "first token only": a request is still a request when it is asked
    // rather than ordered.
    expect(planAction('molim te dodaj kategoriju Putovanja')?.slots['name']).toBe('Putovanja');
    expect(planAction('can you create a category Travel')?.slots['name']).toBe('Travel');
  });

  it('plans ADD_TRANSACTION from a named object, taking the whole fragment as its text', () => {
    // The text is what follows the object word, unedited — the pipeline reads it, not this planner.
    expect(planAction('dodaj trošak kafa 180')?.action).toBe('ADD_TRANSACTION');
    expect(planAction('dodaj trošak kafa 180')?.slots['text']).toBe('kafa 180');
    expect(planAction('unesi transakciju Lidl 2000')?.slots['text']).toBe('Lidl 2000');
    expect(planAction('zabeleži prihod plata 85000')?.slots['text']).toBe('plata 85000');
    expect(planAction('add expense coffee 180')?.slots['text']).toBe('coffee 180');
    expect(planAction('dodaj trošak kafa 180')?.matchedOn).toContain('anchor:object');
  });

  it('accepts an imperative plus a number, because that is how it is actually asked', () => {
    // *"dodaj kafu 180"* names no object the list could hold — the words between the verb and the
    // amount are the content. The rung is safe only because the action cannot be built without an
    // amount: a text that yields none is refused one layer down.
    expect(planAction('dodaj kafu 180')?.action).toBe('ADD_TRANSACTION');
    expect(planAction('dodaj kafu 180')?.slots['text']).toBe('kafu 180');
    expect(planAction('dodaj kafu 180')?.matchedOn).toContain('anchor:amount');
  });

  it('still lets the category action win its own question', () => {
    // The registry is checked in declaration order and `ADD_CATEGORY` matches on its own object, so a
    // number in the name cannot turn a category request into a transaction.
    expect(planAction('dodaj kategoriju Putovanja')?.action).toBe('ADD_CATEGORY');
    expect(planAction('dodaj kategoriju 500')?.action).toBe('ADD_CATEGORY');
    expect(planAction('dodaj kategoriju 500')?.slots['name']).toBe('500');
    // …and a bare number with the category word is still a *name* problem, not a transaction: the name
    // is missing, which the caller refuses with `UNRUNNABLE:name`.
    expect(planAction('dodaj 2 kategorije')?.action).toBe('ADD_CATEGORY');
    expect(planAction('dodaj 2 kategorije')?.slots['name']).toBeUndefined();
  });

  it('does not offer a transaction for a bare fragment, or for a question with no amount', () => {
    // `Lidl 2000` on its own is the **capture screen's** signature interaction, and the assistant is
    // not a second one: without an imperative there is no request here, and an unanswerable question
    // containing a number must not become an offer to write (the ordering docs/06 §8.16 records).
    expect(planAction('Lidl 2000')).toBeNull();
    expect(planAction('kafa 180')).toBeNull();
    // …but a named object with no number *is* the action's shape, and the refusal belongs to the layer
    // that can see it: the planner cannot know whether `kafu` carries an amount, and the pipeline
    // answers `NO_AMOUNT` (asserted in `assistant-transaction.integration.spec.ts`).
    expect(planAction('dodaj trošak kafu')?.action).toBe('ADD_TRANSACTION');
    expect(planAction('dodaj trošak kafu')?.slots['text']).toBe('kafu');
    expect(planAction('napravi mi pregled potrošnje po kategorijama')).toBeNull();
  });

  it('does not guess an action from a bare noun phrase', () => {
    // "nova kategorija" *is* a request shape — Serbian drops the verb — so it plans and then refuses
    // for want of a name, which asks the user rather than writing something nobody specified.
    const plan = planAction('nova kategorija');
    expect(plan?.action).toBe('ADD_CATEGORY');
    expect(missingActionSlots(plan!.action, plan!.slots)).toEqual(['name']);
  });
});
