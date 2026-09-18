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
 * Two members, each added by the task that built its executor: docs/16's B.4–B.5 still name five more
 * (`ADD_TAG`, `ADD_GOAL`, `SET_BUDGET`, `ADD_RECURRING_RULE`, `CREATE_RULE_FROM_CORRECTION`), and a
 * template with no executor would be a trap — `ASSISTANT_ACTIONS` being closed is what makes that
 * impossible to add by accident.
 */
export const ASSISTANT_ACTIONS = ['ADD_CATEGORY', 'ADD_TRANSACTION', 'SET_BUDGET'] as const;

export type AssistantAction = (typeof ASSISTANT_ACTIONS)[number];

/**
 * The slots an action may take.
 *
 * **Its own union, not the planner's `SlotName`.** Every read slot is a period, an id resolved from
 * the database, or a count; `name` is text the user invents in the same breath as the request, and
 * ADR-035 decision 5 adds that kind here first. Sharing the union would let a read template ask for a
 * slot nothing resolves, and vice versa.
 */
export type ActionSlotName =
  | 'name'
  | 'text'
  | 'kind'
  | 'parentId'
  | 'accountId'
  // The **resolved** slots (B-4a): a Category id that comes from the Household's own tree and an
  // amount that comes from the parser. Neither is inventable, which is why the registry declares them
  // only where the builder fills them (ADR-035 decision 5).
  | 'categoryId'
  | 'amountMinor'
  | 'period';

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
   * The slots this action's preview is **allowed** to fill rather than the question stating, and the
   * set the card may therefore offer to change.
   *
   * Two different permissions live here, and the difference matters:
   *
   * - *May* fill. `createCategory` requires a `kind` nobody says out loud, and a transaction needs an
   *   account the question rarely names, so both proposals supply one and the card shows it, because
   *   guessing silently is not an option and guessing visibly is.
   * - *Whether it did* is decided **per proposal**, not here: a transaction whose text said
   *   *"plata 85000"* stated its direction, and a card must not offer to change a value the user gave.
   *   `ADD_CATEGORY.kind` is always filled; `ADD_TRANSACTION.kind` only when the parser found no
   *   direction signal.
   *
   * A slot that is not listed here can never be flagged `defaulted`, which is the guard that keeps a
   * card from offering to edit something the action does not own.
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
  /**
   * The capture path, reached by a question — docs/16 B.3.
   *
   * `mutation` is `captureCommit`, the very method `/capture`'s Confirm calls, so this action inherits
   * the whole pipeline: `parseAmount` (ADR-003), the deterministic-first classification
   * (ADR-002), the I-3 direction reconciliation, the confidence gate that sends a blocking row to the
   * review queue as `PENDING`, duplicate-suspect detection, and I-10 idempotency. What it does *not*
   * inherit is the screen's editing surface: the proposal carries **one** row, and a text that parses
   * to more than one is refused rather than half-shown (see `assistant-action.service.ts`).
   */
  /**
   * A spending limit for one Category (B-4a).
   *
   * ⚠️ **It sets a budget where none exists and refuses to overwrite one**, which is narrower than
   * `upsertBudget` itself. The reason is the undo: overwriting would have to *restore* the previous
   * amount to be reversible, and this build has no operation for that — `deleteBudget` would destroy
   * the budget the user already had. ADR-035 decision 7 says an action whose undo does not exist is not
   * offered, so v1 offers the creation and refuses the change, naming `/budgets` in the refusal.
   */
  SET_BUDGET: {
    mutation: 'upsertBudget',
    requiredSlots: ['text'],
    // Nothing is filled rather than stated: the Category and the amount both come out of the text, and
    // the period is a fixed part of what this action means (see the service).
    defaultedSlots: [],
    role: 'MEMBER',
    // `deleteBudget` — correct **because** the action refuses to overwrite: the row it created is the
    // only row its undo touches.
    undo: 'SOFT_DELETE',
    destroys: false,
  },
  ADD_TRANSACTION: {
    mutation: 'captureCommit',
    requiredSlots: ['text'],
    // The account and — only when the text stated no direction — the kind.
    defaultedSlots: ['accountId', 'kind'],
    role: 'MEMBER',
    // `undoCapture`: docs/02 §3's undo toast, the same call it makes, all-or-nothing and per id.
    undo: 'UNDO_CAPTURE',
    destroys: false,
  },
});

/** The next free action id, so a caller can assert the registry is closed rather than discover it. */
export function registeredMutations(): readonly string[] {
  return ASSISTANT_ACTIONS.map((action) => ACTION_TEMPLATES[action].mutation);
}
