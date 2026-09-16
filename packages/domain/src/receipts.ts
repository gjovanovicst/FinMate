/**
 * Receipt reconciliation arithmetic — docs/01 F-14, docs/03 invariant I-6, docs/09 task 4.1.3.
 *
 * ## What this module owns
 *
 * I-6 is the one hard rule of the receipt flow: **a receipt's items must sum to its total within one
 * minor unit, or its `reconciliation` is not `MATCHED`** — and `commitReceipt` refuses to confirm the
 * Transaction until it is. That is arithmetic, so it lives here rather than in the API service, and
 * every boundary is asserted.
 *
 * ## Why the tolerance exists at all
 *
 * A printed receipt rounds each line and the total independently, so a two-decimal currency legitimately
 * disagrees by a filler. Zero tolerance would make every second receipt "mismatched" and train users to
 * ignore the warning; a large tolerance would hide a genuinely missed line. One minor unit is the
 * smallest value that means "a rounding filler" rather than "a mistake".
 *
 * ## Every state has a producer
 *
 * | State | Meaning |
 * |---|---|
 * | `PENDING` | No total is known yet — OCR has not read one and the user has not typed one. |
 * | `MATCHED` | The figures the receipt actually carries agree. |
 * | `MISMATCH` | They do not, and nothing has been done about it. |
 * | `MANUAL` | They agree **because the user added an absorbing line** (`ADD_ROUNDING_LINE`), so the agreement is the user's, not the receipt's. |
 *
 * The distinction between `MATCHED` and `MANUAL` is deliberate: a client may want to show that a
 * receipt was reconciled by hand, and collapsing the two would make that impossible to reconstruct.
 *
 * @module @finmate/domain
 */

/** Mirrors the `receipts.reconciliation` CHECK constraint (docs/03 §4). */
export type ReconciliationState = 'PENDING' | 'MATCHED' | 'MISMATCH' | 'MANUAL';

/**
 * The tolerance I-6 allows, in minor units.
 *
 * Exported rather than inlined so the API's validation, the evaluator-like tests and any client that
 * explains the rule all quote the same number.
 */
export const RECEIPT_TOLERANCE_MINOR = 1n;

/** The minimum a caller must know about an item to reconcile: its amount. */
export interface ReceiptItemAmount {
  readonly amountMinor: bigint;
}

export interface ReceiptTotals {
  /** Σ items. Minor units, always non-negative in aggregate only if the items are. */
  readonly itemsTotalMinor: bigint;
  /** `total − itemsTotal`, **signed**: positive means the receipt claims more than the lines. */
  readonly varianceMinor: bigint;
  readonly state: ReconciliationState;
}

/**
 * Whether a variance is within I-6's tolerance.
 *
 * `bigint` comparison, never `Number` — the money path has no floats (ADR-003), and this is the one
 * comparison the whole flow turns on.
 */
export function isWithinTolerance(varianceMinor: bigint): boolean {
  const magnitude = varianceMinor < 0n ? -varianceMinor : varianceMinor;
  return magnitude <= RECEIPT_TOLERANCE_MINOR;
}

/**
 * Sum a receipt's items and compare them with its total.
 *
 * `totalMinor === null` is `PENDING`, not a mismatch: "we have not read the total yet" and "the total
 * disagrees" are different facts, and conflating them would show a mismatch banner on every receipt
 * whose photograph was still being processed.
 *
 * `manual` marks the result as achieved by a hand-added line; the caller decides when that is the case
 * (see {@link ReceiptTotals} and `ADD_ROUNDING_LINE`), because only the caller knows *why* the numbers
 * agree.
 */
export function receiptTotals(
  items: readonly ReceiptItemAmount[],
  totalMinor: bigint | null,
  options: { readonly manual?: boolean } = {},
): ReceiptTotals {
  const itemsTotalMinor = items.reduce((sum, item) => sum + item.amountMinor, 0n);
  if (totalMinor === null) {
    return { itemsTotalMinor, varianceMinor: 0n - itemsTotalMinor, state: 'PENDING' };
  }

  const varianceMinor = totalMinor - itemsTotalMinor;
  if (!isWithinTolerance(varianceMinor)) {
    return { itemsTotalMinor, varianceMinor, state: 'MISMATCH' };
  }
  return {
    itemsTotalMinor,
    varianceMinor,
    state: options.manual === true ? 'MANUAL' : 'MATCHED',
  };
}

/**
 * The amount an absorbing line must carry, or `null` when no such line can exist.
 *
 * `receipt_items.amount_minor` is `CHECK (amount_minor >= 0)` (docs/03 §4), so the only line that can
 * be **added** is a positive one. That works when the receipt claims more than its lines sum to
 * (`variance > 0`: the receipt says 2 050, the lines say 2 000, and a 50 line absorbs it). When the
 * lines *overshoot* the total the variance is negative, and adding any non-negative line moves the sum
 * further away — so there is no rounding line, and the caller must adjust an item or the total instead.
 * Returning `null` rather than a negative amount keeps that rule out of the database's CHECK.
 */
export function roundingLineAmount(varianceMinor: bigint): bigint | null {
  return varianceMinor > 0n ? varianceMinor : null;
}
