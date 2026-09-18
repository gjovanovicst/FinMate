import { describe, expect, it } from 'vitest';

import {
  ASSISTANT_ACTION_ENUM_MIRROR,
  ASSISTANT_ACTION_SLOT_ENUM_MIRROR,
  AssistantActionEnum,
  AssistantActionSlotEnum,
} from './assistant.model';
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
    // dispatches and `captureCommit` is the one `/capture`'s Confirm dispatches; an action naming
    // anything else would be the assistant reaching somewhere a screen cannot, which is exactly what
    // ADR-035 decision 3 forbids.
    expect(registeredMutations()).toEqual(['createCategory', 'captureCommit']);
  });

  it('requires a name and fills only what it says it fills', () => {
    expect(ACTION_TEMPLATES.ADD_CATEGORY.requiredSlots).toEqual(['name']);
    expect(ACTION_TEMPLATES.ADD_CATEGORY.defaultedSlots).toEqual(['kind']);
    // `MEMBER`, because that is what the UI allows: `createCategory` carries no role guard, so the
    // assistant must not invent a stricter one. `VIEWER` is refused by the resolver's rank check.
    expect(ACTION_TEMPLATES.ADD_CATEGORY.role).toBe('MEMBER');
  });

  it('declares the capture path for ADD_TRANSACTION, with the slot it actually needs', () => {
    const template = ACTION_TEMPLATES.ADD_TRANSACTION;
    expect(template.mutation).toBe('captureCommit');
    // The **text**, not a name: what to record is the whole fragment, and the amount, the category and
    // the date all come out of the pipeline rather than out of the question.
    expect(template.requiredSlots).toEqual(['text']);
    // The account is filled and shown; the kind is filled only when the text stated no direction,
    // which is why the flag is per-proposal and this list is only the permission.
    expect(template.defaultedSlots).toEqual(['accountId', 'kind']);
    // `undoCapture` — docs/02 §3's undo toast, which is the only undo the capture path has, and it
    // exists, which is the precondition for offering the action at all.
    expect(template.undo).toBe('UNDO_CAPTURE');
    expect(template.role).toBe('MEMBER');
  });

  it('mirrors the registry in the GraphQL enums, member for member', () => {
    // ⚠️ This is the assertion whose absence was a **500**, found only by a live call: the model's
    // `action` field is typed with the registry's union, so nothing else connects the two, and a member
    // the SDL enum lacks fails at serialisation with `Enum "AssistantAction" cannot represent value`.
    // The `Record`s make a *missing* member a compile error; this catches a *mis-mapped* one.
    expect(Object.values(AssistantActionEnum).sort()).toEqual([...ASSISTANT_ACTIONS].sort());
    expect(Object.values(ASSISTANT_ACTION_ENUM_MIRROR).sort()).toEqual([...ASSISTANT_ACTIONS].sort());

    // Same rule for the slots: `accountId` was added to the union in B-3a and not to the enum, and the
    // diff row serialised as `Enum "AssistantActionSlot" cannot represent value: "accountId"`.
    const declared = [...new Set(ASSISTANT_ACTIONS.flatMap((action) => [
      ...ACTION_TEMPLATES[action].requiredSlots,
      ...ACTION_TEMPLATES[action].defaultedSlots,
    ]))].sort();
    // `parentId` is the one slot no template declares: `ADD_CATEGORY` always creates at the top level
    // and nothing can change that, so the diff row documents a **fixed** value rather than a filled
    // default — which is exactly why it is neither required nor defaulted, and why adding a parent
    // picker would start by declaring it.
    const slots = [...declared, 'parentId'].sort();
    expect(Object.keys(AssistantActionSlotEnum).sort()).toEqual(slots);
    expect(Object.values(ASSISTANT_ACTION_SLOT_ENUM_MIRROR).sort()).toEqual(slots);
  });

  it('keeps every action\'s declared slots to the union the planner may fill', () => {
    // The registry is closed, and so is the vocabulary: a slot nobody can resolve or default is a card
    // row that can never be filled. `text` and `accountId` are the two `ADD_TRANSACTION` added.
    for (const action of ASSISTANT_ACTIONS) {
      const template = ACTION_TEMPLATES[action];
      for (const slot of [...template.requiredSlots, ...template.defaultedSlots]) {
        expect(['name', 'text', 'kind', 'parentId', 'accountId']).toContain(slot);
      }
      // A required slot is never also a defaulted one: "the question must say it" and "the proposal
      // fills it" are different claims about the same field.
      for (const slot of template.requiredSlots) {
        expect(template.defaultedSlots).not.toContain(slot);
      }
    }
  });
});
