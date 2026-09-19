import { describe, expect, it } from 'vitest';

import {
  ASSISTANT_ACTION_ENUM_MIRROR,
  ASSISTANT_ACTION_SLOT_ENUM_MIRROR,
  AssistantActionEnum,
  AssistantActionSlotEnum,
} from './assistant.model';
import { ACTION_EXAMPLES, ACTION_TEMPLATES, ASSISTANT_ACTIONS, registeredMutations } from './assistant-actions';
import { planAction } from './action-planner';

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
    expect(registeredMutations()).toEqual([
      'createCategory',
      'captureCommit',
      'upsertBudget',
      'createSavingGoal',
      'createTag',
      'createRuleFromCorrection',
    ]);
  });

  it('requires a name and fills only what it says it fills', () => {
    expect(ACTION_TEMPLATES.ADD_CATEGORY.requiredSlots).toEqual(['name']);
    expect(ACTION_TEMPLATES.ADD_CATEGORY.defaultedSlots).toEqual(['kind']);
    // `MEMBER`, because that is what the UI allows: `createCategory` carries no role guard, so the
    // assistant must not invent a stricter one. `VIEWER` is refused by the resolver's rank check.
    expect(ACTION_TEMPLATES.ADD_CATEGORY.role).toBe('MEMBER');
  });

  it('declares the budget action as a creation, with the undo that makes that true', () => {
    const template = ACTION_TEMPLATES.SET_BUDGET;
    expect(template.mutation).toBe('upsertBudget');
    // The **text**, because the Category and the amount both come out of it — and neither is a slot a
    // caller may supply: an id must come from the database (ADR-035 decision 5).
    expect(template.requiredSlots).toEqual(['text']);
    expect(template.defaultedSlots).toEqual([]);
    // `deleteBudget`, and this is the load-bearing pair: the action **refuses to overwrite** an existing
    // budget (asserted against a real database in `assistant-budget.integration.spec.ts`), which is what
    // makes deleting the right undo. If it ever overwrites, this assertion must fail with it — otherwise
    // the undo would destroy a budget the user already had.
    expect(template.undo).toBe('SOFT_DELETE');
    expect(template.destroys).toBe(false);
  });

  it('declares the goal action as a creation, with the name and the amount out of its text', () => {
    const template = ACTION_TEMPLATES.ADD_GOAL;
    expect(template.mutation).toBe('createSavingGoal');
    expect(template.requiredSlots).toEqual(['text']);
    expect(template.defaultedSlots).toEqual([]);
    // `deleteSavingGoal`, and correct for the same reason the budget's is: this action only creates.
    expect(template.undo).toBe('SOFT_DELETE');
    expect(template.destroys).toBe(false);
  });

  it('declares the tag action as a name and nothing else', () => {
    const template = ACTION_TEMPLATES.ADD_TAG;
    expect(template.mutation).toBe('createTag');
    expect(template.requiredSlots).toEqual(['name']);
    // No defaulted slot at all, and that is the decision: the colour `/tags` can set is not filled,
    // because the question never states one and a colour has no consequence to confirm.
    expect(template.defaultedSlots).toEqual([]);
    // `deleteTag` — assignments removed outright, the row soft-deleted (`TagsService.remove`), which is
    // correct as an undo because the row this action creates has none of either yet.
    expect(template.undo).toBe('SOFT_DELETE');
    expect(template.destroys).toBe(false);
  });

  it('declares the rule action as one whose input is already in the database', () => {
    const template = ACTION_TEMPLATES.CREATE_RULE_FROM_CORRECTION;
    expect(template.mutation).toBe('createRuleFromCorrection');
    // ⚠️ **No required slot**, and this is the action's whole difference from the five before it: the
    // correction already exists and the rule is derived from it, so the question only has to say *which
    // kind of thing* it wants. A required slot here would refuse the ordinary request.
    expect(template.requiredSlots).toEqual([]);
    // The one thing the preview fills is **which** correction — the question said "this one" — so the
    // card flags that row `chosen for you` rather than pretending the reader named it.
    expect(template.defaultedSlots).toEqual(['correctionId']);
    // `deleteRule`, a **soft** delete (`RulesService.remove`), and honest as an undo because
    // `createRuleFromCorrection` refuses to run twice for one correction.
    expect(template.undo).toBe('SOFT_DELETE');
    expect(template.destroys).toBe(false);
    // `correctTransaction` carries no role guard, so this mirrors the screen beside it — no stricter.
    expect(template.role).toBe('MEMBER');
  });

  it('offers starter examples that each plan to the action they are filed under', () => {
    // ⚠️ This is the assertion that lets the client render a chip saying *"say this and I will do that"*.
    // A chip is a promise, and the promise is only true while `planAction`'s cue vocabulary still routes
    // the sentence to the same action — so a cue edit that breaks a chip fails here rather than on a
    // screen nobody re-reads. It is also why `ACTION_EXAMPLES` is not a client-side constant.
    //
    // **Both languages** (ADR-040): the chip is printed in the reader's language, so an English chip
    // whose cue list stopped matching is the same broken promise as a Serbian one.
    for (const example of ACTION_EXAMPLES) {
      for (const question of [example.question.en, example.question.sr]) {
        expect(ASSISTANT_ACTIONS, question).toContain(example.action);
        expect(planAction(question)?.action, question).toBe(example.action);
      }
    }
    // The **rule** action is deliberately absent, and the reason is a first click: it derives from a
    // Correction the reader made earlier, so on a Household that has corrected nothing the only honest
    // answer is the `NO_CORRECTION` refusal. It is discovered in the moment it applies, not from a
    // starter list — and it stays reachable by typing, which the cue list is unchanged for.
    expect(ACTION_EXAMPLES.map((example) => example.action)).not.toContain('CREATE_RULE_FROM_CORRECTION');
    // …and the list is not empty: a registry with no discoverable action would make the screen's
    // "or tell me to do something" half vanish silently.
    expect(ACTION_EXAMPLES.length).toBeGreaterThan(0);
  });

  it('declares the correction action **last**, because a plan walks the registry in order', () => {
    // Load-bearing, not cosmetic: `planAction` takes the first action whose object word occurs in the
    // question, so an action declared earlier wins a question that mentions two vocabularies. The rule
    // action's words (`pravilo`, `ispravka`) are the weakest evidence of intent, so every more specific
    // action must get its chance first — *"dodaj pravilo za kategoriju Gorivo"* is a Category request.
    expect(ASSISTANT_ACTIONS[ASSISTANT_ACTIONS.length - 1]).toBe('CREATE_RULE_FROM_CORRECTION');
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
    // …and the three slots no template *declares* but a preview **resolves** or reads: `parentId` is a
    // fixed value on the category card, and `categoryId`/`amountMinor`/`period` are what `SET_BUDGET`
    // derives from its text (B-4a). They are part of the card's vocabulary, which is what the enum is.
    const slots = [
      ...declared,
      'parentId',
      'categoryId',
      'amountMinor',
      'period',
      'targetMinor',
      'targetDate',
      // B-5's two **preview-only** members: a Rule is a document, so its rows name the rule's own halves
      // (`conditions`, `actions`) rather than a slot a question could state. They are part of the card's
      // vocabulary, which is what this enum is.
      'conditions',
      'actions',
    ].sort();
    expect(Object.keys(AssistantActionSlotEnum).sort()).toEqual(slots);
    expect(Object.values(ASSISTANT_ACTION_SLOT_ENUM_MIRROR).sort()).toEqual(slots);
  });

  it('keeps every action\'s declared slots to the union the planner may fill', () => {
    // The registry is closed, and so is the vocabulary: a slot nobody can resolve or default is a card
    // row that can never be filled. `text` and `accountId` are the two `ADD_TRANSACTION` added.
    for (const action of ASSISTANT_ACTIONS) {
      const template = ACTION_TEMPLATES[action];
      for (const slot of [...template.requiredSlots, ...template.defaultedSlots]) {
        expect([
          'name',
          'text',
          'kind',
          'parentId',
          'accountId',
          // The one declared slot a *question may state* and the builder then **refuses** — it is how the
          // action sees a phrase it cannot honour instead of silently dropping it (`ActionSlotName`).
          'correctionId',
        ]).toContain(slot);
      }
      // A required slot is never also a defaulted one: "the question must say it" and "the proposal
      // fills it" are different claims about the same field.
      for (const slot of template.requiredSlots) {
        expect(template.defaultedSlots).not.toContain(slot);
      }
    }
  });
});
