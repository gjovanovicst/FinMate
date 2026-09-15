import { foldForMatching, pgTrigramSimilarity } from '@finmate/nlp';

/**
 * Duplicate-**suspect** detection — docs/06 §5.2.2's third mechanism.
 *
 * This is deliberately the weakest of the three and it is pure, so it can be tested exhaustively
 * without a database:
 *
 * | Mechanism | Job | Strength |
 * |---|---|---|
 * | `idempotencyKey` | retry safety (I-10) | **authoritative** — the unique index refuses the row |
 * | `clientId` | offline dedupe | **authoritative** — same |
 * | this | "you may have just entered this twice" | **advisory** — the row is written and flagged |
 *
 * The third one must never block. [01 §6](../../../../docs/01-product-requirements.md) says *"I am
 * warned … rather than silently creating it"*, not *"I am prevented"*, because blocking a legitimate
 * second purchase is a worse failure than showing an unwanted chip. So nothing here can refuse a row;
 * it can only return a match for the payload to report.
 *
 * ## The three windows the docs state, and which one this implements
 *
 * - docs/06 §5.2.2's table: a **60-second** window, "configurable".
 * - docs/06 §5.2.2's matching rules: `occurred_local_date` within **±2 days**.
 * - docs/02 §3's capture spec: the same day, "within **5 minutes**".
 *
 * They are answering two different questions, so both survive: the **submission** window bounds how
 * long ago the *existing* row was created (`createdAt`), and the **date tolerance** bounds how far
 * apart the two rows say the money moved (`occurredLocalDate`). This implements the more generous
 * submission window — 5 minutes — because it is the UX-facing statement, it strictly contains the
 * 60-second one, and a warning costs the user a glance while a missed duplicate costs them a wrong
 * total. Being generous is only safe *because* the mechanism never blocks; a blocking version would
 * have to take the tighter window. All three numbers are named constants, and a later settings task
 * can read them from `households.settings` without touching this logic.
 *
 * @module apps/api/src/modules/ledger
 */

/** How long after the existing row was written a new row can still look like a repeat of it. */
export const DUPLICATE_SUBMISSION_WINDOW_MS = 5 * 60_000;

/** How far apart the two rows' `occurred_local_date` may be and still be compared at all. */
export const DUPLICATE_DATE_TOLERANCE_DAYS = 2;

/** docs/06 §5.2.2 rule 4: folded-description trigram similarity at or above this qualifies. */
export const DUPLICATE_DESCRIPTION_SIMILARITY = 0.85;

/** The `matchedOn` vocabulary docs/06 §5.2.2's `DuplicateSuspect` declares. */
export const MATCHED_ON = Object.freeze({
  amount: 'amount',
  merchant: 'merchant',
  description: 'description',
  date: 'date',
});

/** One existing Transaction a newly written row is compared against. */
export interface DuplicateCandidate {
  readonly id: string;
  readonly accountId: string;
  readonly kind: string;
  readonly amountMinor: bigint;
  readonly occurredLocalDate: string;
  readonly description: string;
  readonly merchantId: string | null;
  readonly createdAt: Date;
}

/** The row that was just written. */
export interface DuplicateSubject {
  readonly transactionId: string;
  readonly accountId: string;
  readonly kind: string;
  readonly amountMinor: bigint;
  readonly occurredLocalDate: string;
  readonly description: string;
  readonly merchantId: string | null;
  readonly createdAt: Date;
}

export interface DuplicateMatch {
  readonly existingTransactionId: string;
  /**
   * The folded-description trigram similarity, even when the match qualified on the merchant.
   *
   * Reported rather than faked to `1` for a merchant match: a UI that says "looks like a duplicate"
   * should be able to show *how* alike the two rows actually are, and two different baskets at the
   * same shop are a merchant match with a low similarity — which is worth the user's attention
   * precisely because it is the weak case.
   */
  readonly similarity: number;
  readonly matchedOn: readonly string[];
}

/**
 * The best match for `subject` among `candidates`, or `null`.
 *
 * "Best" is the highest description similarity, with the most recent `createdAt` breaking a tie, so
 * the chip points at the row the user most plausibly just re-entered rather than an arbitrary one
 * when several qualify. One suspect per written row, matching docs/06 §5.2.2's shape.
 */
export function findDuplicateSubject(args: {
  readonly subject: DuplicateSubject;
  readonly candidates: readonly DuplicateCandidate[];
}): DuplicateMatch | null {
  const { subject } = args;
  const subjectDescription = foldForMatching(subject.description);

  let best: DuplicateMatch | null = null;
  let bestCreatedAt = -Infinity;

  for (const candidate of args.candidates) {
    // A row is never a duplicate of itself. Both ids are distinct rows, so this only fires when a
    // caller passes the subject in its own candidate set — which the ledger does, because the whole
    // batch is inside the same window and an intra-batch repeat is a duplicate worth flagging.
    if (candidate.id === subject.transactionId) continue;

    // Rules 1–3, all hard requirements (docs/06 §5.2.2).
    if (candidate.accountId !== subject.accountId) continue;
    if (candidate.kind !== subject.kind) continue;
    if (candidate.amountMinor !== subject.amountMinor) continue;
    if (!withinSubmissionWindow(subject.createdAt, candidate.createdAt)) continue;
    if (
      dayDistance(subject.occurredLocalDate, candidate.occurredLocalDate) >
      DUPLICATE_DATE_TOLERANCE_DAYS
    ) {
      continue;
    }

    // Rule 4: either signal qualifies on its own.
    const similarity = pgTrigramSimilarity(subjectDescription, foldForMatching(candidate.description));
    const merchantMatch =
      subject.merchantId !== null && subject.merchantId === candidate.merchantId;
    const descriptionMatch = similarity >= DUPLICATE_DESCRIPTION_SIMILARITY;
    if (!merchantMatch && !descriptionMatch) continue;

    if (best !== null && !isBetter(similarity, candidate.createdAt, best, bestCreatedAt)) continue;

    best = {
      existingTransactionId: candidate.id,
      similarity,
      matchedOn: [
        MATCHED_ON.amount,
        ...(merchantMatch ? [MATCHED_ON.merchant] : []),
        ...(descriptionMatch ? [MATCHED_ON.description] : []),
        MATCHED_ON.date,
      ],
    };
    bestCreatedAt = candidate.createdAt.getTime();
  }

  return best;
}

function isBetter(
  similarity: number,
  createdAt: Date,
  current: DuplicateMatch,
  currentCreatedAt: number,
): boolean {
  if (similarity !== current.similarity) return similarity > current.similarity;
  return createdAt.getTime() > currentCreatedAt;
}

/**
 * True when the existing row was written within the submission window of the new one.
 *
 * A **negative** difference — the candidate was written *after* the subject — is inside the window
 * too, and deliberately so: within one `captureCommit` the rows are written in order, so the second
 * of two identical rows has an earlier `createdAt` than the first. Rejecting negative deltas would
 * make the second row miss the first, which is the clearest duplicate there is.
 */
function withinSubmissionWindow(subjectCreatedAt: Date, candidateCreatedAt: Date): boolean {
  return Math.abs(subjectCreatedAt.getTime() - candidateCreatedAt.getTime()) <= DUPLICATE_SUBMISSION_WINDOW_MS;
}

/**
 * Whole days between two `YYYY-MM-DD` calendar days, as an absolute value.
 *
 * Exact because both sides are parsed as UTC midnight: no DST, no offset, no rounding. This is a
 * *calendar-day* question (docs/03 §3.2), so it must not be asked of instants.
 */
function dayDistance(a: string, b: string): number {
  const left = Date.parse(`${a}T00:00:00.000Z`);
  const right = Date.parse(`${b}T00:00:00.000Z`);
  if (Number.isNaN(left) || Number.isNaN(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86_400_000;
}
