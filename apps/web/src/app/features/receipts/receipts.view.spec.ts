import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ALLOWED_RECEIPT_MIME_TYPES,
  MAX_RECEIPT_BYTES,
  ReceiptCryptoUnavailableError,
  cameraSupported,
  messageKeyForStatus,
  receiptNoteKeys,
  receiptProblem,
  sha256Hex,
  toHex,
  uploadPercent,
} from './receipts.view';

/**
 * The receipt flow's decisions. Three are silent when wrong: an allowlist that admits a type the API
 * refuses (a rejected upload after the photo was taken), a hash that is not a hash (a commit that fails
 * on a mismatch), and a `SKIPPED` scan state rendered as though the file had been checked.
 */

afterEach(() => vi.unstubAllGlobals());

describe('receiptProblem', () => {
  it('accepts every image type the camera or the photo library can produce', () => {
    for (const mimeType of ALLOWED_RECEIPT_MIME_TYPES) {
      expect(receiptProblem({ mimeType, byteSize: 1024 })).toBeNull();
    }
  });

  it('refuses a type outside the image allowlist', () => {
    // `application/pdf` is on the API's allowlist but not on a *receipt photo* flow's.
    expect(receiptProblem({ mimeType: 'application/pdf', byteSize: 1024 })).toBe('type');
    expect(receiptProblem({ mimeType: 'image/gif', byteSize: 1024 })).toBe('type');
  });

  it('accepts the size limit exactly and refuses one byte more', () => {
    expect(receiptProblem({ mimeType: 'image/jpeg', byteSize: MAX_RECEIPT_BYTES })).toBeNull();
    expect(receiptProblem({ mimeType: 'image/jpeg', byteSize: MAX_RECEIPT_BYTES + 1 })).toBe('size');
  });

  it('reports an unsupported type before an oversized one', () => {
    expect(receiptProblem({ mimeType: 'application/pdf', byteSize: MAX_RECEIPT_BYTES + 1 })).toBe('type');
  });
});

describe('toHex', () => {
  it('renders lower-case hex, two digits per byte', () => {
    expect(toHex(new Uint8Array([0, 15, 255]).buffer)).toBe('000fff');
    expect(toHex(new ArrayBuffer(0))).toBe('');
  });
});

describe('sha256Hex', () => {
  it('matches the known digest of the empty buffer', async () => {
    await expect(sha256Hex(new ArrayBuffer(0))).resolves.toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('throws a named error rather than returning an empty digest when Web Crypto is missing', async () => {
    // An insecure origin has no `crypto.subtle`; an empty string would pass argument validation and
    // fail later as an opaque digest mismatch, so the failure has to happen here and say why.
    vi.stubGlobal('crypto', {});
    await expect(sha256Hex(new ArrayBuffer(0))).rejects.toThrow(ReceiptCryptoUnavailableError);
    await expect(sha256Hex(new ArrayBuffer(0))).rejects.toMatchObject({
      name: 'ReceiptCryptoUnavailableError',
    });
  });
});

describe('uploadPercent', () => {
  it('is zero when there is no total to divide by', () => {
    expect(uploadPercent(0, 0)).toBe(0);
    expect(uploadPercent(10, 0)).toBe(0);
    expect(uploadPercent(10, -5)).toBe(0);
  });

  it('rounds to a whole percentage', () => {
    expect(uploadPercent(0, 100)).toBe(0);
    expect(uploadPercent(50, 100)).toBe(50);
    expect(uploadPercent(1, 3)).toBe(33);
    expect(uploadPercent(2, 3)).toBe(67);
  });

  it('clamps above 100 and below 0, because a proxy can report more bytes than were declared', () => {
    expect(uploadPercent(200, 100)).toBe(100);
    expect(uploadPercent(-10, 100)).toBe(0);
  });
});

describe('cameraSupported', () => {
  it('is true only when getUserMedia is callable', () => {
    expect(cameraSupported({ mediaDevices: { getUserMedia: () => undefined } })).toBe(true);
    expect(cameraSupported({})).toBe(false);
    expect(cameraSupported({ mediaDevices: {} })).toBe(false);
  });
});

describe('messageKeyForStatus', () => {
  it('maps the REST presign failures to their own wording', () => {
    expect(messageKeyForStatus(400)).toBe('receipts.error.rejected');
    expect(messageKeyForStatus(429)).toBe('receipts.error.rateLimited');
    expect(messageKeyForStatus(403)).toBe('receipts.error.generic');
    expect(messageKeyForStatus(500)).toBe('receipts.error.generic');
    expect(messageKeyForStatus(0)).toBe('receipts.error.generic');
  });
});

describe('receiptNoteKeys', () => {
  it('says a skipped file was not scanned rather than implying it is safe', () => {
    expect(receiptNoteKeys({ scanState: 'SKIPPED', hasPreview: true })).toEqual([
      'receipts.note.skipped',
    ]);
    // `CLEAN` is the only state that would justify silence, and this build cannot produce it.
    expect(receiptNoteKeys({ scanState: 'CLEAN', hasPreview: true })).toEqual([]);
  });

  it('explains a missing preview, and can carry both facts at once', () => {
    expect(receiptNoteKeys({ scanState: 'PENDING', hasPreview: false })).toEqual([
      'receipts.note.noPreview',
    ]);
    expect(receiptNoteKeys({ scanState: 'SKIPPED', hasPreview: false })).toEqual([
      'receipts.note.noPreview',
      'receipts.note.skipped',
    ]);
  });
});
