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

import type { CopyPair } from '../../common/i18n/copy';

/**
 * The closed set of writes the assistant may **propose**.
 *
 * Six members, each added by the task that built its executor. docs/16's B.4–B.5 name one more that is
 * *not* built (`ADD_RECURRING_RULE`), and a template with no executor would be a trap — the closed
 * union is what makes that impossible to add by accident.
 */
export const ASSISTANT_ACTIONS = [
  'ADD_CATEGORY',
  'ADD_TRANSACTION',
  'SET_BUDGET',
  'ADD_GOAL',
  'ADD_TAG',
  // **Last, and the position is load-bearing.** `planAction` walks this list and takes the first
  // action whose object word occurs in the question, so a member declared earlier wins a question that
  // mentions two vocabularies. This one's objects (`ispravka`, `pravilo`) are the weakest evidence of
  // what a question means, so they are consulted only after every more specific action has declined.
  'CREATE_RULE_FROM_CORRECTION',
] as const;

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
  | 'period'
  // A goal's own two (B-4b), named as the **read** planner names them: `GOAL_REQUIRED_MONTHLY` already
  // speaks of a `targetMinor` and a `targetDate`, and a second word for the same concept is how the two
  // sides start describing one goal differently.
  | 'targetMinor'
  | 'targetDate'
  /**
   * The **correction** a rule is derived from (B-5) — an id the *backend* resolves, never one a
   * question supplies.
   *
   * It is a slot rather than only an `arg` for one reason: the planner captures whatever the question
   * said after the object word, and this action must **see** it to refuse it. A question that names a
   * correction (*"napravi pravilo od ispravke za Lidl"*) is asking for something this build cannot
   * resolve — corrections have no name to match on — and silently ignoring the phrase would be the
   * wrong proposal R-29 is about. The card flags the resolved row *chosen for you*, which is exactly
   * what happened: the question said "that correction" and the backend picked one (docs/06 §8.16).
   */
  | 'correctionId'
  // The two **preview-only** members (B-5): a Rule is a document, not a single value, so its diff rows
  // name the rule's parts rather than a slot a question could ever state. They exist because `slot` is
  // how the card identifies a row, and "which rule clause is this" is a real question for the renderer.
  | 'conditions'
  | 'actions';

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
  /**
   * A saving goal: a name the user invents and a target amount (B-4b).
   *
   * The undo is honest for the same reason `ADD_CATEGORY`'s is: `createSavingGoal` never overwrites
   * anything, so the soft delete removes exactly the row this action wrote.
   */
  ADD_GOAL: {
    mutation: 'createSavingGoal',
    requiredSlots: ['text'],
    defaultedSlots: [],
    role: 'MEMBER',
    undo: 'SOFT_DELETE',
    destroys: false,
  },
  /**
   * A tag: a name and nothing else (B-4c).
   *
   * `createTag` never overwrites, and `deleteTag` removes the Tag's **assignments** outright while
   * soft-deleting the row itself (`TagsService.remove` — `deleted_at`, not a `DELETE`; docs/03 §3.4).
   * Both halves are what make it an honest undo *here*: the row this action created has no assignments
   * to lose, and nothing it touched existed before, so nothing has to be restored.
   *
   * ⚠️ Corrected after the fact: this comment said "hard delete" until a review pass read the service.
   * The **decision** was right (the undo is `SOFT_DELETE`, the row leaves every list), the *mechanism*
   * was not — and a reason that is wrong about the mechanism is the kind of thing the next reader
   * relies on.
   */
  ADD_TAG: {
    mutation: 'createTag',
    requiredSlots: ['name'],
    // Nothing is filled: a tag is a name. ⚠️ The colour the `/tags` screen can set is deliberately
    // **not** filled here — the question never states one, and a colour has no consequence the reader
    // needs to confirm, unlike a goal's missing deadline (which changes what the ledger can compute).
    defaultedSlots: [],
    role: 'MEMBER',
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
  /**
   * A **Rule** derived from a Correction — ADR-010's confirmation, reached by a question (B-5).
   *
   * ⚠️ **Nothing has to be stated, and that is the whole difference from the four before it.** The
   * other actions take something the user invents or names in the question; this one's input already
   * exists in the database — it is the Household's most recent Correction — and the rule is derived
   * from *that*. So `requiredSlots` is empty and the question only has to say *"zapamti ovu ispravku"*.
   *
   * The one thing the preview fills is **which** correction, and it is declared here so the card can
   * mark the row *chosen for you*: the question said "this one" and the backend chose the latest. A
   * phrase that tries to name one is refused by the builder rather than ignored (the slot above).
   *
   * The undo is `deleteRule`, a **soft** delete (rules.service), and it is honest for the same reason
   * `ADD_CATEGORY`'s is: `createRuleFromCorrection` refuses to run twice for one correction, so the row
   * this action wrote is the only row its undo can touch.
   */
  CREATE_RULE_FROM_CORRECTION: {
    mutation: 'createRuleFromCorrection',
    requiredSlots: [],
    defaultedSlots: ['correctionId'],
    // `correctTransaction` carries no role guard, and this action is the same learning loop one step
    // further — the assistant must be neither stricter nor looser than the screen beside it. If a guard
    // is added there, this is where it is mirrored (see the ⚠️ in docs/06 §8.16 about `VIEWER`).
    role: 'MEMBER',
    undo: 'SOFT_DELETE',
    destroys: false,
  },
});

/**
 * One example of each action, in the words a person would actually type — the assistant screen's
 * **"or tell me to do something"** chips (docs/02 §4.16).
 *
 * ## Why this lives on the server, next to the registry
 *
 * A starter chip makes a claim: *say this and the app will offer that*. The claim is only true if the
 * sentence still **plans** to the action it is filed under, and `planAction`'s cue vocabulary is what
 * decides that — so a list hardcoded in the client would stop being true the first time a cue changed,
 * silently, in the one place nobody would look (exactly the drift `INTENT_TEMPLATES` and this registry
 * exist to prevent). `assistant-actions.spec.ts` asserts every entry below plans to its own action, so
 * a cue edit that breaks a chip is a red test rather than a lie on a screen.
 *
 * ## What is deliberately **not** here
 *
 * `CREATE_RULE_FROM_CORRECTION` has no starter example. It derives a Rule from a Correction the reader
 * made **earlier**, so on a Household that has not corrected anything yet the only honest answer is the
 * `NO_CORRECTION` refusal — a chip whose first click fails is worse than no chip. That action is
 * discovered in the moment it applies, right after a correction, not from an invitation list. (It stays
 * reachable by typing: the cue list is unchanged.)
 *
 * The other five need nothing but the question: three create a name the user invented, one creates a
 * row from a parsed fragment, and the budget example names a Category the seeded tree already has.
 */
export const ACTION_EXAMPLES: readonly {
  readonly action: AssistantAction;
  readonly question: CopyPair;
}[] = [
  // Ordered by how likely a reader is to want it, because the chips are read top to bottom: recording
  // an entry is the product's one-line promise, and naming a Category is the next thing somebody wants.
  // Each is a **copy pair**: a chip is printed verbatim and is a promise the sentence plans to its
  // action, so both languages are asserted against `planAction`'s cue vocabulary (ADR-040).
  {
    action: 'ADD_TRANSACTION',
    question: { en: 'add expense coffee 180', sr: 'dodaj trošak kafa 180' },
  },
  {
    action: 'ADD_CATEGORY',
    question: { en: 'add a new category Travel', sr: 'dodaj kategoriju Putovanja' },
  },
  {
    action: 'SET_BUDGET',
    question: { en: 'set a budget for food at 20000', sr: 'postavi budžet za hranu na 20000' },
  },
  {
    action: 'ADD_GOAL',
    question: { en: 'create a goal Vacation 200000', sr: 'napravi cilj Letovanje 200000' },
  },
  {
    action: 'ADD_TAG',
    question: { en: 'add a tag Holiday', sr: 'dodaj tag Odmor' },
  },
];

/** The next free action id, so a caller can assert the registry is closed rather than discover it. */
export function registeredMutations(): readonly string[] {
  return ASSISTANT_ACTIONS.map((action) => ACTION_TEMPLATES[action].mutation);
}
