import type { ReconciliationState } from '@finmate/domain';

import type { TranslationKey } from '../../core/i18n/translations';

/**
 * The receipts feature's decisions, as pure functions.
 *
 * F-14 and F-34 own the feature; docs/06 §9.2 owns the wire and docs/02 §4.11 owns the screens. What
 * lives here is the part that is **wrong silently**: which files may be uploaded, whether a hash is
 * really a hash, how far a progress bar has moved, what a scan state means to the person looking at
 * the picture — and, for the library and the mismatch screen, which reconciliation state is which,
 * where the confidence bands fall, and whether a receipt may be posted at all. All of it is tested
 * without a DOM, which is also why the components themselves are thin.
 *
 * ## Why this flow accepts fewer types than the API does
 *
 * `ALLOWED_MIME_TYPES` in `apps/api/src/modules/files/files.service.ts` includes `application/pdf`,
 * because the same presign route also serves imports and avatars. A *receipt photo* flow is fed by the
 * camera and the photo library, and both produce images — so the four image types are the honest
 * allowlist here. Offering a PDF picker would promise a capture path that does not exist.
 *
 * ## Why `SKIPPED` is never rendered as safe
 *
 * This build has no virus scanner (`SCANNER` is inert, docs/08 §9.4), so a committed upload is recorded
 * as `SKIPPED`, which means **not scanned** — never *verified*. {@link receiptNoteKeys} exists so a
 * caller cannot turn that state into a clean bill of health by accident.
 *
 * @module apps/web/src/app/features/receipts
 */

/** The four image types a camera or a photo library produces. `application/pdf` is deliberately absent. */
export const ALLOWED_RECEIPT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
] as const;

/** docs/06 §9.2: 12 MiB, sized for a phone photo at full resolution. Mirrors the API's own cap. */
export const MAX_RECEIPT_BYTES = 12 * 1024 * 1024;

export type ReceiptProblem = 'type' | 'size' | null;

/**
 * What is wrong with a chosen file, or `null`.
 *
 * The type is checked before the size, so an unsupported file is reported for the thing that makes it
 * unsupported rather than for a limit that would not have mattered. The size boundary is inclusive:
 * exactly {@link MAX_RECEIPT_BYTES} is accepted, because that is what the API accepts.
 */
export function receiptProblem(input: {
  readonly mimeType: string;
  readonly byteSize: number;
}): ReceiptProblem {
  if (!(ALLOWED_RECEIPT_MIME_TYPES as readonly string[]).includes(input.mimeType)) return 'type';
  if (input.byteSize > MAX_RECEIPT_BYTES) return 'size';
  return null;
}

/** Lower-case hex, two digits per byte. */
export function toHex(bytes: ArrayBuffer): string {
  let hex = '';
  for (const byte of new Uint8Array(bytes)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Thrown when the platform cannot hash, so a caller can tell it apart from a rejected upload. */
export class ReceiptCryptoUnavailableError extends Error {
  constructor() {
    super('crypto.subtle is unavailable, so the file cannot be hashed.');
    this.name = 'ReceiptCryptoUnavailableError';
  }
}

/**
 * The SHA-256 the presign request declares, as lower-case hex.
 *
 * The API verifies it against the object's own metadata on commit, so returning `''` here would look
 * like a successful presign and fail later as a confusing mismatch. Throwing makes the missing-Web-Crypto
 * case (an insecure origin, a stripped build) legible at its cause instead.
 */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  // Declared as possibly-undefined because the runtime answer is what matters: `crypto.subtle` is
  // absent on an insecure origin even though the DOM type says it is always there.
  const subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle;
  if (subtle === undefined) throw new ReceiptCryptoUnavailableError();
  return toHex(await subtle.digest('SHA-256', bytes));
}

/** Upload completion as a whole 0–100, and 0 when the server never stated a total. */
export function uploadPercent(loaded: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(loaded) || loaded <= 0) return 0;
  return Math.min(100, Math.round((loaded / total) * 100));
}

/**
 * True when the browser can open a camera stream at all.
 *
 * A missing `mediaDevices` is the normal answer on an insecure origin, so the caller shows the
 * file-input fallback **with an explanation** instead of a button that can only fail.
 */
export function cameraSupported(nav: {
  readonly mediaDevices?: { readonly getUserMedia?: unknown };
}): boolean {
  return typeof nav.mediaDevices?.getUserMedia === 'function';
}

/**
 * The i18n key for a REST presign failure, by HTTP status (docs/06 §9.2).
 *
 * `400` is the allowlist or the household's rate limit refusing the request and `429` is the rate limit
 * specifically. Anything else is not a failure the person can act on differently, so it gets one honest
 * generic message.
 */
export function messageKeyForStatus(status: number): TranslationKey {
  if (status === 400) return 'receipts.error.rejected';
  if (status === 429) return 'receipts.error.rateLimited';
  return 'receipts.error.generic';
}

/**
 * The notes the preview carries, in the order they read, or an empty list.
 *
 * The two facts are independent — an unscanned upload that storage cannot link yet is both — so this
 * returns every applicable note rather than choosing one and losing the other.
 */
export function receiptNoteKeys(input: {
  readonly scanState: string;
  readonly hasPreview: boolean;
}): readonly TranslationKey[] {
  const keys: TranslationKey[] = [];
  if (!input.hasPreview) keys.push('receipts.note.noPreview');
  // `SKIPPED` is *not scanned*. Saying so is the whole point of the note (docs/08 §9.4).
  if (input.scanState === 'SKIPPED') keys.push('receipts.note.skipped');
  return keys;
}

// -------------------------------------------------------------------------------------------
// The library and the mismatch screen (F-14; docs/02 §4.11; tasks 4.1.4b and 4.1.5)
// -------------------------------------------------------------------------------------------

/**
 * The four states of I-6, as the label the reader sees.
 *
 * `MANUAL` is not a degraded `MATCHED`: the numbers agree **because** the user added an absorbing
 * line, and saying so is the difference between "the receipt said this" and "you decided this".
 * Collapsing the two would erase who answered the question.
 */
export function reconciliationLabelKey(state: ReconciliationState): TranslationKey {
  switch (state) {
    case 'PENDING':
      return 'receipts.state.pending';
    case 'MATCHED':
      return 'receipts.state.matched';
    case 'MISMATCH':
      return 'receipts.state.mismatch';
    case 'MANUAL':
      return 'receipts.state.manual';
  }
}

/**
 * The tone a state is drawn in.
 *
 * `MATCHED` is fine, `MANUAL` is a notice (the agreement is the user's, not the receipt's), and
 * `MISMATCH` is the one state that needs an answer. `PENDING` is neutral: there is nothing wrong
 * with a receipt whose total has not been read yet, so it must not be painted like a failure.
 */
export type ReconciliationTone = 'ok' | 'warn' | 'danger' | 'muted';

export function toneForState(state: ReconciliationState): ReconciliationTone {
  switch (state) {
    case 'MATCHED':
      return 'ok';
    case 'MANUAL':
      return 'warn';
    case 'MISMATCH':
      return 'danger';
    case 'PENDING':
      return 'muted';
  }
}

/**
 * docs/02 §4.11's confidence badge: green at or above 0.90, yellow down to 0.60, red below, and a
 * white circle when **nothing was ever measured**.
 *
 * `null` is not `0`. A receipt item that was never classified has no confidence at all, and drawing
 * the absence as "0 %" would present a missing fact as a measurement (the same distinction
 * `shared/confidence.ts` makes). The icon and the label are returned together so a caller cannot
 * render one without the other: the colour is decoration, the words are the answer.
 */
export function confidenceBadge(confidence: number | null): {
  readonly icon: string;
  readonly labelKey: TranslationKey;
} {
  if (confidence === null) return { icon: '⚪', labelKey: 'receipts.confidence.none' };
  if (confidence >= 0.9) return { icon: '🟢', labelKey: 'receipts.confidence.high' };
  if (confidence >= 0.6) return { icon: '🟡', labelKey: 'receipts.confidence.medium' };
  return { icon: '🔴', labelKey: 'receipts.confidence.low' };
}

/** What `canPost` needs to know: the state, and whether every line can become a Split. */
export interface PostableReceipt {
  readonly reconciliation: ReconciliationState;
  readonly items: readonly { readonly categoryId: string | null }[];
}

/**
 * Whether *Napravi transakciju* may be pressed.
 *
 * Two gates, and both are the server's too (`ReceiptsService.commit`): **I-6** must be satisfied
 * (`MATCHED` or `MANUAL`) and **every line must have a Category**, because the Transaction is one
 * Split per Category (ADR-015, I-1). This is a hint, not a substitute for the API's refusal — the
 * button being disabled is the courtesy, the 400 is the guarantee.
 *
 * The state is checked first on purpose: a mismatch on an uncategorised receipt should be answered
 * by reconciling, not by categorising lines that may still be wrong.
 */
export function canPost(receipt: PostableReceipt): boolean {
  if (receipt.reconciliation !== 'MATCHED' && receipt.reconciliation !== 'MANUAL') return false;
  return receipt.items.every((item) => item.categoryId !== null);
}

/** Why the post button is disabled, or `null` when it is not. */
export function postHintKey(receipt: PostableReceipt): TranslationKey | null {
  if (receipt.reconciliation !== 'MATCHED' && receipt.reconciliation !== 'MANUAL') {
    return 'receipts.actions.postNeedsMatch';
  }
  if (!receipt.items.every((item) => item.categoryId !== null)) {
    return 'receipts.actions.postNeedsCategories';
  }
  return null;
}

/**
 * The sentence beside the difference.
 *
 * The amount itself is **never** in this string: it is rendered through `fm-money` next to it, so a
 * difference can never be printed as a percentage or formatted by hand (docs/02 §4.11). The key
 * only says which way the disagreement runs.
 */
export function varianceLabelKey(
  state: ReconciliationState,
  varianceMinor: bigint,
): TranslationKey {
  switch (state) {
    case 'PENDING':
      return 'receipts.banner.pending';
    case 'MATCHED':
      return 'receipts.banner.matched';
    case 'MANUAL':
      return 'receipts.banner.manual';
    case 'MISMATCH':
      // A negative variance means the lines overshoot the total, which reads the other way round.
      return varianceMinor > 0n ? 'receipts.banner.mismatchMore' : 'receipts.banner.mismatchLess';
  }
}

/**
 * Whether `ADD_ROUNDING_LINE` can absorb this difference.
 *
 * `receipt_items.amount_minor` is `CHECK (amount_minor >= 0)` (docs/03 §4), so the only line that
 * can be **added** is a positive one: the arm works exactly when the receipt claims more than its
 * lines sum to. At `0n` there is nothing to absorb and below it any added line would push the sum
 * further away, so both are refused here rather than by the database.
 */
export function variantForRounding(varianceMinor: bigint): boolean {
  return varianceMinor > 0n;
}

/**
 * A captured instant as the reader's own date, e.g. `12.10.2026.`.
 *
 * `capturedAt` is a `DateTime`, so unlike the ledger's `LocalDate` values it names an instant; it is
 * formatted in the browser's timezone because that is where the photo was taken from the reader's
 * point of view. Never through the money formatter (docs/02 §4.11).
 */
export function capturedLabel(instant: string, tag: string): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return '';
  return new Intl.DateTimeFormat(tag, { dateStyle: 'medium' }).format(at);
}
