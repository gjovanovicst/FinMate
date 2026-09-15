import { toLocalDate, uuidv7, type LocalDate } from '@finmate/domain';
import { extractFragments, type TransactionFragment } from '@finmate/nlp';

/**
 * The capture preview's state machine, as pure functions.
 *
 * docs/02 §3 owns the interaction; this file owns the *decisions* it makes, so they can be tested
 * without mounting a component. Everything here is deterministic — no clock, no network, no DI — and
 * the two things that are genuinely environmental (`today`, the currency) are arguments.
 *
 * ## Why the local parse matters
 *
 * docs/02 §3: "`packages/nlp` runs **in-browser, synchronously, per keystroke** (~2 ms)… Structure is
 * visible before any network call." So a row exists as soon as the text yields an amount and a
 * description, in the ⚪ *awaiting server* state, and the server response only ever fills in a badge
 * — a row never appears out of nowhere and never disappears on response. That is why
 * {@link mergeLocalRows} carries state across keystrokes and {@link applyFragments} merges by
 * position instead of replacing the list.
 *
 * ## Nothing here formats money
 *
 * Amounts stay `bigint` minor units all the way to `fm-money`. A `Number` in this file would be a
 * float in the money path (ADR-003), and formatting belongs to the one component that does it.
 */

/** A candidate reading of an ambiguous amount (`1.200` → 1200 or 1.2; docs/04 §3.1). */
export interface AmountCandidate {
  readonly amountMinor: bigint;
  readonly reason: string;
}

/** The server's classification for one row (docs/06 §5.1 `Proposal`). */
export interface CaptureProposal {
  readonly id: string;
  readonly categoryId: string | null;
  readonly decidedBy: string;
  /** The **calibrated** confidence — what the gate and the badge use (ADR-009). */
  readonly confidence: number;
  readonly needsReview: boolean;
  readonly advisory: boolean;
  readonly rationale: string;
  readonly merchantId: string | null;
  readonly alternatives: readonly { readonly categoryId: string; readonly confidence: number }[];
  /** The server's own reading of the amount, when it disagrees with the local one. */
  readonly amountMinor: bigint | null;
  readonly currency: string | null;
  readonly description: string;
  readonly needsDirectionConfirmation: boolean;
}

/** One preview row. */
export interface CaptureRow {
  /**
   * Stable across keystrokes, so focus, an edit and a removal survive a re-parse.
   *
   * Generated once, when the row first appears — never recomputed. Two rows with the same text are
   * still two rows.
   */
  readonly clientRowId: string;
  /**
   * The offline-identity pair. **Generated with the row and never regenerated**, which is the whole
   * point: a retry after a network failure must carry the same `idempotencyKey`, or I-10 cannot
   * collapse it and the user gets a duplicate. A key minted at submit time would defeat idempotency
   * exactly when it is needed.
   */
  readonly idempotencyKey: string;
  readonly clientId: string;
  readonly rawText: string;
  readonly kind: 'EXPENSE' | 'INCOME' | 'UNKNOWN';
  readonly candidates: readonly AmountCandidate[];
  /** The reading the user picked, when the parser found more than one. */
  readonly pickedAmountMinor: bigint | null;
  readonly currency: string;
  readonly description: string;
  readonly occurredOn: string | null;
  readonly needsDirectionConfirmation: boolean;
  readonly proposal: CaptureProposal | null;
  /** The user's explicit category choice, which outranks the proposal. */
  readonly categoryId: string | null;
  /** Removed from the batch; still rendered, so the removal can be undone. */
  readonly removed: boolean;
}

/** The row's confidence lane, as docs/02 §3's four-state badge. */
export type CaptureLane = 'AWAITING' | 'AUTO' | 'ADVISORY' | 'ASK';

/** docs/04 §7's thresholds, mirrored for the badge. The server is the authority; this is the label. */
export const AUTO_APPLY_MIN = 0.9;
export const VERIFY_MIN = 0.6;

/** Local (device) calendar day. The server derives the Household's own day from this or from now. */
export function todayLocally(now: Date = new Date()): LocalDate {
  // The device zone, not UTC: `extractFragments` reads "juče"/"danas" and a UTC day would be wrong
  // for most of the world's evening and morning.
  return toLocalDate(now, Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/** One extracted fragment → a fresh row. */
function rowFromFragment(
  fragment: TransactionFragment,
  currency: string,
  today: LocalDate,
): CaptureRow {
  return {
    clientRowId: uuidv7(),
    idempotencyKey: uuidv7(),
    clientId: uuidv7(),
    rawText: fragment.rawText,
    kind: fragment.kind,
    candidates: fragment.candidates.map((candidate) => ({
      amountMinor: candidate.amountMinor,
      reason: candidate.reason,
    })),
    pickedAmountMinor: null,
    currency: fragment.currency ?? currency,
    description: fragment.description,
    // A fragment that names no day is *today*: the server needs a date on every row, and asking the
    // user to pick one for "Lidl 2000" would be the friction F-05 exists to remove (I-2 — the day is
    // the device's, which is the honest guess for a person typing on their own phone).
    occurredOn: fragment.occurredOn ?? today,
    needsDirectionConfirmation: fragment.needsDirectionConfirmation,
    proposal: null,
    categoryId: null,
    removed: false,
  };
}

/**
 * Parse the field's text locally, carrying the user's edits across keystrokes.
 *
 * `previous` is the row list from the last keystroke. A row is carried over when its `rawText` is
 * unchanged **and** no earlier carry-over already claimed that text, so typing a second `Lidl 2000`
 * produces two rows rather than one row edited twice. That is also what keeps a `clientRowId`, an
 * `idempotencyKey` and a category override attached to the row the user was editing instead of
 * sliding onto the row below it.
 */
export function parseLocally(
  text: string,
  options: {
    readonly currency: string;
    readonly today: LocalDate;
    readonly previous?: readonly CaptureRow[];
  },
): readonly CaptureRow[] {
  const fragments = extractFragments(text, { currency: options.currency, today: options.today });
  const unused = [...(options.previous ?? [])];

  return fragments.map((fragment) => {
    const carried = unused.findIndex((row) => row.rawText === fragment.rawText);
    if (carried >= 0) {
      const row = unused.splice(carried, 1)[0]!;
      // The local parse is fresher than the carried row for everything it extracts; the *edits* —
      // category, date, removal, idempotency key — are what survives.
      return {
        ...row,
        kind: fragment.kind,
        candidates: fragment.candidates.map((candidate) => ({
          amountMinor: candidate.amountMinor,
          reason: candidate.reason,
        })),
        currency: fragment.currency ?? row.currency,
        description: fragment.description,
        // `?? row.occurredOn` keeps a date the user picked: the fragment names no day, so the fresh
        // value is `null` and overwriting with it would silently reset the edit on the next keystroke.
        occurredOn: fragment.occurredOn ?? row.occurredOn,
        needsDirectionConfirmation: fragment.needsDirectionConfirmation,
      };
    }
    return rowFromFragment(fragment, options.currency, options.today);
  });
}

/** The server's fragments, mapped onto the rows they belong to, in input order. */
export function applyFragments(
  rows: readonly CaptureRow[],
  fragments: readonly CaptureProposal[],
): readonly CaptureRow[] {
  // Positional, because both sides run the same segmenter over the same text. A server fragment with
  // no local row cannot happen while the response matches the current text — and the caller checks
  // that (`rawText`), which is what makes "supersede the in-flight request" true.
  return rows.map((row, index) => {
    const proposal = fragments[index];
    if (proposal === undefined) return row;
    return {
      ...row,
      // The user's explicit choice is never overwritten by a later server answer.
      categoryId: row.categoryId,
      proposal,
    };
  });
}

/** The reading to use: the user's pick, else the parser's preferred candidate. */
export function chosenAmountMinor(row: CaptureRow): bigint | null {
  if (row.pickedAmountMinor !== null) return row.pickedAmountMinor;
  return row.candidates[0]?.amountMinor ?? null;
}

/**
 * True when the parser found more than one reading and the user has not chosen.
 *
 * docs/02 §3: "commit is refused until one is chosen — the parser never silently picks". Refusing the
 * whole commit (rather than that row) is deliberate: the alternative is writing a tenfold-wrong
 * amount and hoping the user notices in the preview.
 */
export function needsAmountChoice(row: CaptureRow): boolean {
  const distinct = new Set(row.candidates.map((candidate) => candidate.amountMinor.toString()));
  return distinct.size > 1 && row.pickedAmountMinor === null;
}

/** docs/02 §3's four-state badge. The server's gate is the authority; this only labels it. */
export function laneOf(row: CaptureRow): CaptureLane {
  if (row.proposal === null) return 'AWAITING';
  // A null category blocks whatever the confidence (invariant I-8).
  if (row.proposal.categoryId === null) return 'ASK';
  if (row.proposal.confidence >= AUTO_APPLY_MIN) return 'AUTO';
  if (row.proposal.confidence >= VERIFY_MIN) return 'ADVISORY';
  return 'ASK';
}

/** The rows the user has not removed. */
export function activeRows(rows: readonly CaptureRow[]): readonly CaptureRow[] {
  return rows.filter((row) => !row.removed);
}

/** Rows the confirm button will send, in order. */
export function confirmableRows(rows: readonly CaptureRow[]): readonly CaptureRow[] {
  return activeRows(rows).filter((row) => chosenAmountMinor(row) !== null);
}

/** Rows that will land in the review queue: the blocking lane only (invariant I-8). */
export function blockedRows(rows: readonly CaptureRow[]): readonly CaptureRow[] {
  return activeRows(rows).filter((row) => laneOf(row) === 'ASK');
}

/** Rows with an amount reading the user must settle first. */
export function ambiguousRows(rows: readonly CaptureRow[]): readonly CaptureRow[] {
  return activeRows(rows).filter((row) => needsAmountChoice(row));
}

/**
 * Whether the batch can be sent at all.
 *
 * An amountless row — a bare word the segmenter produced — does **not** block the batch; it is
 * simply not a Transaction and is excluded from the count the button shows. An unresolved ambiguity
 * does block it: writing the wrong reading of `1.200` would be a tenfold error in the user's money,
 * and there is no lane for "probably 1200" (ADR-003, docs/02 §3).
 */
export function canCommit(rows: readonly CaptureRow[]): boolean {
  return confirmableRows(rows).length > 0 && ambiguousRows(rows).length === 0;
}

/** One row of `captureCommit`'s `rows` argument (docs/06 §5.2). */
export interface CommitRowPayload {
  readonly clientRowId: string;
  readonly idempotencyKey: string;
  readonly clientId: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly amount: { readonly amountMinor: string; readonly currency: string };
  readonly categoryId: string | null;
  readonly description: string;
  readonly occurredOn: string | null;
  readonly acceptedProposalId: string | null;
  readonly confirmDespiteLowConfidence: boolean;
}

/**
 * Build the commit payload.
 *
 * Two subtleties, both about what the server will conclude from the presence of a field:
 *
 * 1. **`categoryId` is sent only when it differs from the proposal's.** The server reads a present
 *    `categoryId` as "the user overrode this" and records the proposal as rejected, which is the
 *    negative half of the calibration label. Echoing the proposal's own category back would mark
 *    every accepted proposal as a correction and poison the re-fit (docs/04 §6.4).
 * 2. **`confirmDespiteLowConfidence` stays false.** `⌘Enter`'s "confirm everything, blocked rows to
 *    PENDING" is the default: writing a sub-0.60 row as CONFIRMED is a deliberate act the user has
 *    to make per row, not something a batch shortcut does on their behalf.
 */
export function toCommitRows(rows: readonly CaptureRow[]): readonly CommitRowPayload[] {
  return confirmableRows(rows).map((row) => {
    const amount = chosenAmountMinor(row)!;
    const proposalCategory = row.proposal?.categoryId ?? null;
    const overridden = row.categoryId !== null && row.categoryId !== proposalCategory;

    return {
      clientRowId: row.clientRowId,
      idempotencyKey: row.idempotencyKey,
      clientId: row.clientId,
      // A fragment the parser could not place is EXPENSE by default in the *preview*, but it must not
      // be committed as a guess: the server's `TransactionKind` has no UNKNOWN arm, so the row is
      // refused here rather than silently becoming an expense.
      kind: row.kind === 'INCOME' ? 'INCOME' : 'EXPENSE',
      amount: { amountMinor: amount.toString(), currency: row.currency },
      categoryId: overridden ? row.categoryId : null,
      description: row.description,
      occurredOn: row.occurredOn,
      acceptedProposalId: row.proposal?.id ?? null,
      confirmDespiteLowConfidence: false,
    };
  });
}

/** True when a row's direction is a guess the user should look at (docs/04 §3.1). */
export function directionUnsure(row: CaptureRow): boolean {
  return row.needsDirectionConfirmation || row.kind === 'UNKNOWN';
}

/** How the row's category was chosen, for the provenance line (docs/02 §3). */
export function provenanceOf(row: CaptureRow): string {
  if (row.categoryId !== null && row.categoryId !== (row.proposal?.categoryId ?? null)) return 'USER';
  return row.proposal?.decidedBy ?? 'NONE';
}
