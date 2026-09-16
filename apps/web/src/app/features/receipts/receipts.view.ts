import type { TranslationKey } from '../../core/i18n/translations';

/**
 * The receipt-attachment component's decisions, as pure functions.
 *
 * F-14 and F-34 own the feature; docs/06 §9.2 owns the wire. What lives here is the part that is
 * **wrong silently**: which files may be uploaded, whether a hash is really a hash, how far a progress
 * bar has moved, and what a scan state means to the person looking at the picture. All of it is tested
 * without a DOM, which is also why the component itself is thin.
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
