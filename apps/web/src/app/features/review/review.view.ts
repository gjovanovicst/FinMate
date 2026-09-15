/**
 * The review queue's decisions, as pure functions.
 *
 * docs/02 §4.6 owns the screen and F-08 owns the feature. Everything here is the part of that screen
 * that can be **wrong silently** — what a keystroke means, which category each resolution writes,
 * whether a checkbox will do anything at all — so it lives outside the component and is tested
 * without a DOM.
 *
 * ## Why this screen does not auto-resolve anything
 *
 * docs/02 §4.6: *"The queue never auto-resolves anything."* The whole point of the blocking lane
 * (invariant I-8) is that the system does not know the answer, so the one action that must be
 * impossible is "confirm the suggestion" on a row that has no suggestion. {@link resolvePlan}
 * returning `null` for that case is what enforces it: the Resolve button is disabled and `Enter`
 * does nothing, rather than writing a `null` category and clearing the flag — which would remove the
 * row from the queue while leaving the question unanswered, and would be invisible in every report.
 *
 * ## Why `remember` and `applyToSimilar` are gated by pure predicates
 *
 * A checkbox the server will ignore is worse than no checkbox: the user ticks it, nothing happens,
 * and they conclude the learning loop does not work. `rememberForFuture` is honoured **only** on the
 * correction path (docs/06 §5.5), and `applyToSimilar` finds peers **only** when the row has a
 * resolved Merchant or Counterparty (`similarQueuedRows` returns nothing otherwise). Both facts are
 * encoded here so the template cannot offer a control that does nothing.
 *
 * @module apps/web/src/app/features/review
 */

import { confidenceBand, type ConfidenceBand } from '../../shared/confidence';
import type { MoneyWire } from '../../shared/ui/money/money.component';

/** docs/02 §4.6 lists three numbered accelerators. */
export const MAX_ALTERNATIVES = 3;

/** Invariant I-8's two disjuncts, as the API reports them (docs/06 §4.2). */
export type ReviewReason = 'LOW_CONFIDENCE' | 'UNCATEGORISED';

/** One losing proposal. `confidence` here is the **raw** model number, recorded not gated. */
export interface ReviewCandidate {
  readonly categoryId: string;
  readonly confidence: number;
}

/** The Transaction a queued item is about. A subset of `TransactionModel` (docs/06 §5). */
export interface ReviewTransaction {
  readonly id: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly status: 'CONFIRMED' | 'PENDING' | 'VOID';
  readonly amount: MoneyWire;
  readonly description: string;
  readonly occurredLocalDate: string;
  readonly categoryId: string | null;
  readonly merchantId: string | null;
  readonly counterpartyId: string | null;
}

/** One row awaiting a decision — `ReviewQueueItemModel` as the screen needs it (docs/06 §4.2). */
export interface ReviewItem {
  readonly id: string;
  readonly reason: ReviewReason;
  /**
   * The calibrated confidence, or `null` when no decision was ever recorded. The API keeps those
   * distinct on purpose, and so does the badge — see {@link ConfidenceBand}.
   */
  readonly confidence: number | null;
  /** What the pipeline chose. `null` for an uncategorised row: there is nothing to accept. */
  readonly suggestedCategoryId: string | null;
  readonly candidates: readonly ReviewCandidate[];
  /** Hours since the row was recorded — the queue's sort key, so nothing starves. */
  readonly ageHours: number;
  readonly transaction: ReviewTransaction;
}

/** The row's gate state, for docs/02 §4.6's badge. */
export function badgeOf(item: ReviewItem): ConfidenceBand {
  return confidenceBand(item.confidence);
}

/**
 * The numbered alternatives, best first, de-duplicated, capped at {@link MAX_ALTERNATIVES}.
 *
 * The suggestion leads because it is what the pipeline would apply, and accepting it is the common
 * case; the losing candidates follow by descending confidence. **De-duplication is the load-bearing
 * part**: `ReviewService.enrich` sets `suggestedCategoryId` from the stored category, which is
 * usually also the top candidate, so without it `1` and `2` would silently be the same category —
 * the accelerator would look like it did something while changing nothing.
 *
 * A `null` or non-string `categoryId` in the audit blob is dropped rather than rendered, because the
 * blob is written defensively-parsed JSON and a row of `[1] undefined` teaches the user to distrust
 * the numbers.
 */
export function choicesOf(item: ReviewItem): readonly string[] {
  const ordered: string[] = [];
  if (item.suggestedCategoryId !== null) ordered.push(item.suggestedCategoryId);

  for (const candidate of [...item.candidates].sort((a, b) => b.confidence - a.confidence)) {
    if (typeof candidate.categoryId !== 'string' || candidate.categoryId === '') continue;
    if (!ordered.includes(candidate.categoryId)) ordered.push(candidate.categoryId);
  }

  return ordered.slice(0, MAX_ALTERNATIVES);
}

/** What a resolution actually has to send. */
export interface ReviewResolutionPlan {
  /** `ACCEPT_SUGGESTION` confirms what is stored; `SET_CATEGORY` writes a new category. */
  readonly action: 'ACCEPT_SUGGESTION' | 'SET_CATEGORY';
  /** The category to send. `null` for `ACCEPT_SUGGESTION`, which carries none. */
  readonly categoryId: string | null;
  /**
   * `true` when this goes through the correction path, so a `Correction` is recorded and the
   * checkbox can create a rule (ADR-010). Also exactly when {@link rememberAvailable} is true.
   */
  readonly learns: boolean;
}

/**
 * Decide what resolving this row sends, or `null` when there is nothing to resolve.
 *
 * The comparison is against the **stored** category (`transaction.categoryId`), not against the
 * suggestion, because that is what the server compares: `resolveReviewItem`'s `SET_CATEGORY` arm
 * calls `correctTransaction` only when the chosen category differs from the row's current one, and
 * `ACCEPT_SUGGESTION` refuses a row whose category is `null`.
 *
 * `ACCEPT_SUGGESTION` is deliberately *not* a correction. Confirming what the pipeline already
 * applied is a positive signal the current schema cannot store (a `Correction` means "this changed"),
 * and writing one anyway would fill the calibration re-fit with rows that say nothing changed.
 */
export function resolvePlan(item: ReviewItem, chosenCategoryId: string | null): ReviewResolutionPlan | null {
  // Nothing chosen: refuse. An uncategorised row has no suggestion to accept, and inventing one is
  // what the queue exists to avoid (docs/02 §4.6).
  if (chosenCategoryId === null) return null;

  if (chosenCategoryId === item.transaction.categoryId) {
    return { action: 'ACCEPT_SUGGESTION', categoryId: null, learns: false };
  }

  return { action: 'SET_CATEGORY', categoryId: chosenCategoryId, learns: true };
}

/**
 * Whether the "Zapamti za ubuduće" checkbox will be honoured.
 *
 * `true` exactly when the resolution records a Correction — `correctTransaction` is the only path
 * that reads `rememberForFuture` (docs/06 §5.5), and it is only reached for a category **change**.
 */
export function rememberAvailable(item: ReviewItem, chosenCategoryId: string | null): boolean {
  return resolvePlan(item, chosenCategoryId)?.learns === true;
}

/**
 * Whether "apply to similar rows too" can find any peer at all.
 *
 * `TransactionsService.similarQueuedRows` returns nothing when the row resolved to neither a
 * Merchant nor a Counterparty — "uncategorised rows of the same kind" is not a group a person would
 * recognise. Offering the checkbox there would promise a sweep that cannot happen.
 */
export function canApplyToSimilar(item: ReviewItem): boolean {
  return item.transaction.merchantId !== null || item.transaction.counterpartyId !== null;
}

/**
 * docs/02 §8: *"a single-letter shortcut never fires while a text input, textarea or contenteditable
 * has focus."*
 *
 * `SELECT` is included beyond that list's letter, deliberately. A native select consumes `1`–`3` to
 * jump between options and the arrow keys to change the value, so letting the queue's accelerators
 * through would either fight the control or (worse) silently change the row's category while the
 * user was navigating the dropdown. Buttons and links are **not** excluded: `Enter` on a focused
 * button is that button's activation, and the queue's `Enter` is the resolve action the user is
 * already looking at.
 */
export function isEditableTarget(targetTag: string, targetEditable: boolean): boolean {
  if (targetEditable) return true;
  const tag = targetTag.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Everything {@link commandFor} needs to know about the keystroke. */
export interface KeyContext {
  readonly key: string;
  /** Ctrl/⌘/Alt held. Those combinations belong to the browser and the shell, never to this list. */
  readonly modified: boolean;
  readonly targetTag: string;
  readonly targetEditable: boolean;
}

/** What a keystroke asks the queue to do. */
export type ReviewCommand =
  | { readonly kind: 'MOVE'; readonly delta: -1 | 1 }
  | { readonly kind: 'CHOOSE'; readonly categoryId: string }
  | { readonly kind: 'RESOLVE' }
  | { readonly kind: 'FOCUS_CATEGORY' }
  | { readonly kind: 'NONE' };

const NONE: ReviewCommand = { kind: 'NONE' };

/**
 * docs/02 §4.6's keyboard model: `j`/`k` move, `1`–`3` apply the listed alternatives, `Enter`
 * resolves. docs/02 §8 adds `c` for "set Category on the selection", which on this screen is the
 * row's own category picker.
 *
 * Only lowercase letters are accepted, so `Shift+J`/`Shift+K` — docs/02 §8's "extend selection" —
 * fall through instead of silently moving the cursor. Multi-select is not built anywhere in the app,
 * and a shortcut that half-works is worse than one that does not exist.
 */
export function commandFor(context: KeyContext, choices: readonly string[]): ReviewCommand {
  if (context.modified) return NONE;
  // Re-checked here rather than only by the caller: this is the function whose contract the
  // §8 rule is about, and a caller that forgets the guard would break it invisibly.
  if (isEditableTarget(context.targetTag, context.targetEditable)) return NONE;

  switch (context.key) {
    case 'j':
      return { kind: 'MOVE', delta: 1 };
    case 'k':
      return { kind: 'MOVE', delta: -1 };
    case 'c':
      return { kind: 'FOCUS_CATEGORY' };
    case 'Enter':
      return { kind: 'RESOLVE' };
    default:
      break;
  }

  const digit = Number(context.key);
  if (Number.isInteger(digit) && digit >= 1 && digit <= MAX_ALTERNATIVES) {
    const categoryId = choices[digit - 1];
    return categoryId === undefined ? NONE : { kind: 'CHOOSE', categoryId };
  }

  return NONE;
}

/**
 * Move the cursor by `delta`, **clamped**, never wrapping.
 *
 * Wrapping is the tempting choice and the wrong one: on a row that resolves and disappears, a `j`
 * at the bottom would jump to the top and the user would lose the place they were working through.
 * Stopping at the end is a smaller surprise, and the end is visible on screen.
 */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const next = current + delta;
  if (next < 0) return 0;
  if (next > length - 1) return length - 1;
  return next;
}

/**
 * Where the cursor goes after the row at `index` leaves the queue.
 *
 * The row below slides up into this position, so the cursor stays put — except at the end of the
 * list, where it moves up to the new last row. Without this a 20-row queue walked with `Enter`
 * would leave the cursor past the end and `Enter` would resolve nothing, which reads as the queue
 * having stopped working.
 */
export function cursorAfterRemoval(index: number, remainingLength: number): number {
  if (remainingLength <= 0) return 0;
  return Math.min(index, remainingLength - 1);
}

/** `Math.round(confidence * 100)`, or `null` when there is no confidence to show. */
export function percentOf(confidence: number | null): number | null {
  return confidence === null ? null : Math.round(confidence * 100);
}
