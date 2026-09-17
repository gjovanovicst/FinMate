/**
 * The assistant's **write** registry — docs/06 §8.16, ADR-035.
 *
 * The read side is closed by `INTENT_TEMPLATES`: a `Record<AssistantIntent, IntentTemplate>` means
 * there is no `default:` arm to fall into, so "the model asked for something nobody wrote" is a
 * compile error. Writes get exactly the same treatment, and the argument is stronger: a wrong answer
 * is recoverable and a wrong ledger write is not.
 *
 * ## `mutation` names a method the UI already calls
 *
 * The assistant gets **no** privilege the UI lacks — same service method, same `TenantContext`, same
 * validation, same audit. `createCategory` below is the very method `createCategory`'s GraphQL
 * mutation calls (docs/06 §4.2), which is why the string is here as provenance rather than as a
 * dispatch key: `ACTION_EXECUTORS` in `assistant-action.service.ts` performs the call, and it is a
 * `Record<AssistantAction, …>`, so a member added to this file without an executor fails `tsc`.
 *
 * ## Adding an action is three compile-time edits
 *
 * 1. a member in {@link ASSISTANT_ACTIONS},
 * 2. its {@link ActionTemplate} in {@link ACTION_TEMPLATES},
 * 3. its executor in `ACTION_EXECUTORS`.
 *
 * Nothing else can make an action reachable, which is the whole point.
 *
 * @module apps/api/src/modules/assistant
 */

/**
 * The closed set of writes the assistant may **propose**.
 *
 * One member in v1, deliberately: docs/16's B.3–B.5 name six more (`ADD_TRANSACTION`, `ADD_TAG`,
 * `ADD_GOAL`, `SET_BUDGET`, `ADD_RECURRING_RULE`, `CREATE_RULE_FROM_CORRECTION`), and each is added by
 * the task that builds its executor — a template with no executor would be a trap, and
 * `ASSISTANT_ACTIONS` being closed is what makes that impossible to add by accident.
 */
export const ASSISTANT_ACTIONS = ['ADD_CATEGORY'] as const;

export type AssistantAction = (typeof ASSISTANT_ACTIONS)[number];

/**
 * The slots an action may take.
 *
 * **Its own union, not the planner's `SlotName`.** Every read slot is a period, an id resolved from
 * the database, or a count; `name` is text the user invents in the same breath as the request, and
 * ADR-035 decision 5 adds that kind here first. Sharing the union would let a read template ask for a
 * slot nothing resolves, and vice versa.
 */
export type ActionSlotName = 'name' | 'kind' | 'parentId';

/** How thoroughly an action can be undone. `NONE` is why `destroys` exists (ADR-035 decision 7). */
export type ActionUndo = 'SOFT_DELETE' | 'UNDO_CAPTURE' | 'NONE';

export interface ActionTemplate {
  /**
   * The service method this action performs, as the UI's own mutation calls it. Provenance, not
   * dispatch — see the module doc.
   */
  readonly mutation: string;
  /** Slots the proposal cannot be built without. A missing one is a refusal, not a guess. */
  readonly requiredSlots: readonly ActionSlotName[];
  /**
   * Slots the preview **fills** rather than the planner resolves, and says so on the card.
   *
   * `createCategory` requires a `kind`, and nobody says *"add an income category"* when they mean
   * *"add a category"* — so the proposal defaults it and the card shows it, because guessing silently
   * is not an option and guessing visibly is.
   */
  readonly defaultedSlots: readonly ActionSlotName[];
  /**
   * The role the caller must have. `MEMBER` for `ADD_CATEGORY` because that is what the UI allows —
   * `createCategory` carries no role guard today, and the assistant must not be stricter *or* looser
   * than the screen beside it. If a guard is ever added to that mutation, this field is where it is
   * mirrored.
   */
  readonly role: 'OWNER' | 'ADMIN' | 'MEMBER';
  readonly undo: ActionUndo;
  /**
   * Whether the action destroys data it cannot restore. `true` actions are **not offered at all**
   * (ADR-035 decision 7): a confirmation is consent to *a* change, not to an irreversible one.
   */
  readonly destroys: boolean;
}

export const ACTION_TEMPLATES: Readonly<Record<AssistantAction, ActionTemplate>> = Object.freeze({
  ADD_CATEGORY: {
    mutation: 'createCategory',
    requiredSlots: ['name'],
    defaultedSlots: ['kind'],
    role: 'MEMBER',
    undo: 'SOFT_DELETE',
    destroys: false,
  },
});

/** The next free action id, so a caller can assert the registry is closed rather than discover it. */
export function registeredMutations(): readonly string[] {
  return ASSISTANT_ACTIONS.map((action) => ACTION_TEMPLATES[action].mutation);
}
