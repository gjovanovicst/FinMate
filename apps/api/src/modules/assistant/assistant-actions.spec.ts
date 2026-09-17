import { describe, expect, it } from 'vitest';

import { ACTION_TEMPLATES, ASSISTANT_ACTIONS, registeredMutations } from './assistant-actions';

/**
 * The registry's own invariants — the write-side twin of `query-planner.spec.ts`'s "every intent has a
 * template" test.
 *
 * The compile-time half is the `Record<AssistantAction, ActionTemplate>` and the executor map in
 * `assistant-action.service.ts`; what a test can add is the **policy** the types cannot express: that
 * every registered action is undoable, that none destroys, and that each one names a method the UI
 * really calls.
 */
describe('the action registry (ADR-035)', () => {
  it('has a template for every action, and no action without one', () => {
    for (const action of ASSISTANT_ACTIONS) {
      expect(ACTION_TEMPLATES[action], action).toBeDefined();
    }
    expect(Object.keys(ACTION_TEMPLATES)).toHaveLength(ASSISTANT_ACTIONS.length);
  });

  it('offers nothing that destroys what it cannot restore', () => {
    // ADR-035 decision 7: a `destroys: true` action is not offered at all, because a confirmation is
    // consent to *a* change rather than to an irreversible one. This is the assertion that keeps the
    // promise from being a v1-only intention.
    for (const action of ASSISTANT_ACTIONS) {
      expect(ACTION_TEMPLATES[action].destroys, action).toBe(false);
      expect(ACTION_TEMPLATES[action].undo, action).not.toBe('NONE');
    }
  });

  it('names a method the UI already calls, for every action', () => {
    // The provenance strings the module doc promises. `createCategory` is the mutation `/categories`
    // dispatches; an action naming anything else would be the assistant reaching somewhere the screen
    // cannot, which is exactly what ADR-035 decision 3 forbids.
    expect(registeredMutations()).toEqual(['createCategory']);
  });

  it('requires a name and fills only what it says it fills', () => {
    expect(ACTION_TEMPLATES.ADD_CATEGORY.requiredSlots).toEqual(['name']);
    expect(ACTION_TEMPLATES.ADD_CATEGORY.defaultedSlots).toEqual(['kind']);
    // `MEMBER`, because that is what the UI allows: `createCategory` carries no role guard, so the
    // assistant must not invent a stricter one. `VIEWER` is refused by the resolver's rank check.
    expect(ACTION_TEMPLATES.ADD_CATEGORY.role).toBe('MEMBER');
  });
});
