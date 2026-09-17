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

  it('does not guess an action from a bare noun phrase', () => {
    // "nova kategorija" *is* a request shape — Serbian drops the verb — so it plans and then refuses
    // for want of a name, which asks the user rather than writing something nobody specified.
    const plan = planAction('nova kategorija');
    expect(plan?.action).toBe('ADD_CATEGORY');
    expect(missingActionSlots(plan!.action, plan!.slots)).toEqual(['name']);
  });
});
