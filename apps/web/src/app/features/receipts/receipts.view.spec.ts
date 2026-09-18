import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ALLOWED_RECEIPT_MIME_TYPES,
  MAX_RECEIPT_BYTES,
  ReceiptCryptoUnavailableError,
  cameraSupported,
  canPost,
  capturedLabel,
  confidenceBadge,
  extractReport,
  messageKeyForStatus,
  postHintKey,
  receiptNoteKeys,
  receiptProblem,
  reconciliationLabelKey,
  sha256Hex,
  toHex,
  toneForState,
  uploadPercent,
  variantForRounding,
  varianceLabelKey,
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

describe('reconciliationLabelKey', () => {
  it('gives every state of I-6 its own words', () => {
    expect(reconciliationLabelKey('PENDING')).toBe('receipts.state.pending');
    expect(reconciliationLabelKey('MATCHED')).toBe('receipts.state.matched');
    expect(reconciliationLabelKey('MISMATCH')).toBe('receipts.state.mismatch');
    // `MANUAL` is not a degraded `MATCHED`: the numbers agree *because* the user added a line.
    expect(reconciliationLabelKey('MANUAL')).toBe('receipts.state.manual');
  });
});

describe('toneForState', () => {
  it('does not paint a receipt whose total is merely unknown as a failure', () => {
    expect(toneForState('PENDING')).toBe('muted');
    expect(toneForState('MATCHED')).toBe('ok');
    expect(toneForState('MANUAL')).toBe('warn');
    expect(toneForState('MISMATCH')).toBe('danger');
  });
});

describe('confidenceBadge', () => {
  it('is green exactly at the 0.90 auto-apply floor', () => {
    expect(confidenceBadge(0.9)).toEqual({ icon: '🟢', labelKey: 'receipts.confidence.high' });
    expect(confidenceBadge(1)).toEqual({ icon: '🟢', labelKey: 'receipts.confidence.high' });
    expect(confidenceBadge(0.899)).toEqual({ icon: '🟡', labelKey: 'receipts.confidence.medium' });
  });

  it('is yellow exactly at the 0.60 verify floor and red one step below', () => {
    expect(confidenceBadge(0.6)).toEqual({ icon: '🟡', labelKey: 'receipts.confidence.medium' });
    expect(confidenceBadge(0.89)).toEqual({ icon: '🟡', labelKey: 'receipts.confidence.medium' });
    expect(confidenceBadge(0.599)).toEqual({ icon: '🔴', labelKey: 'receipts.confidence.low' });
    expect(confidenceBadge(0)).toEqual({ icon: '🔴', labelKey: 'receipts.confidence.low' });
  });

  it('draws a missing measurement as a white circle, never as zero', () => {
    // `null` means "nothing was recorded"; rendering it as 0 would present a missing fact as a
    // measurement (the same distinction `shared/confidence.ts` makes).
    expect(confidenceBadge(null)).toEqual({ icon: '⚪', labelKey: 'receipts.confidence.none' });
  });
});

describe('canPost', () => {
  const categorised = [{ categoryId: 'c1' }, { categoryId: 'c2' }];

  it('allows a matched or hand-reconciled receipt whose lines all have categories', () => {
    expect(canPost({ reconciliation: 'MATCHED', items: categorised })).toBe(true);
    expect(canPost({ reconciliation: 'MANUAL', items: categorised })).toBe(true);
  });

  it('refuses a mismatch or a receipt with no total, whatever the lines say', () => {
    expect(canPost({ reconciliation: 'MISMATCH', items: categorised })).toBe(false);
    expect(canPost({ reconciliation: 'PENDING', items: categorised })).toBe(false);
  });

  it('refuses one uncategorised line, because each becomes a Split (ADR-015, I-1)', () => {
    expect(
      canPost({ reconciliation: 'MATCHED', items: [{ categoryId: 'c1' }, { categoryId: null }] }),
    ).toBe(false);
  });
});

describe('postHintKey', () => {
  it('says which gate is closed, and nothing when the button is live', () => {
    expect(postHintKey({ reconciliation: 'MATCHED', items: [{ categoryId: 'c1' }] })).toBeNull();
    expect(postHintKey({ reconciliation: 'MISMATCH', items: [{ categoryId: 'c1' }] })).toBe(
      'receipts.actions.postNeedsMatch',
    );
    // The state wins: a mismatch on an uncategorised receipt is answered by reconciling first.
    expect(postHintKey({ reconciliation: 'MISMATCH', items: [{ categoryId: null }] })).toBe(
      'receipts.actions.postNeedsMatch',
    );
    expect(postHintKey({ reconciliation: 'MANUAL', items: [{ categoryId: null }] })).toBe(
      'receipts.actions.postNeedsCategories',
    );
  });
});

describe('varianceLabelKey', () => {
  it('says which way the disagreement runs, never how big it is', () => {
    expect(varianceLabelKey('PENDING', -2000n)).toBe('receipts.banner.pending');
    expect(varianceLabelKey('MATCHED', 0n)).toBe('receipts.banner.matched');
    expect(varianceLabelKey('MANUAL', 0n)).toBe('receipts.banner.manual');
  });

  it('reads the sign of the variance', () => {
    expect(varianceLabelKey('MISMATCH', 1n)).toBe('receipts.banner.mismatchMore');
    expect(varianceLabelKey('MISMATCH', -1n)).toBe('receipts.banner.mismatchLess');
    // Unreachable through `receiptTotals` (a zero variance is within tolerance), but a caller that
    // passed it must not be told the receipt claims more than its lines.
    expect(varianceLabelKey('MISMATCH', 0n)).toBe('receipts.banner.mismatchLess');
  });
});

describe('variantForRounding', () => {
  it('offers the absorbing line only when the receipt claims more than its lines', () => {
    // `receipt_items.amount_minor` is non-negative, so only a positive gap has a legal line.
    expect(variantForRounding(1n)).toBe(true);
    expect(variantForRounding(0n)).toBe(false);
    expect(variantForRounding(-1n)).toBe(false);
  });
});

describe('capturedLabel', () => {
  it('formats a captured instant as the reader’s own date', () => {
    expect(capturedLabel('2026-10-12T10:00:00.000Z', 'en-GB')).toContain('2026');
    expect(capturedLabel('2026-10-12T10:00:00.000Z', 'en-GB')).toContain('Oct');
  });

  it('renders nothing rather than "Invalid Date" for a value it cannot read', () => {
    // The API always sends an instant, so this is a defensive answer, not a state the wire produces.
    expect(capturedLabel('not-a-date', 'en-GB')).toBe('');
  });
});

describe('extractReport', () => {
  it('says how many lines were written when the reader answered', () => {
    const report = extractReport({
      extracted: true,
      itemsWritten: 7,
      reason: null,
      linesWithoutAmount: 0,
    });
    expect(report.messageKey).toBe('receipts.extract.wrote');
    expect(report.tone).toBe('info');
    // Nothing failed, so there is no machine answer to quote.
    expect(report.showCode).toBe(false);
  });

  it('tells a missing reader from a failed one, and shows the code for both', () => {
    // The two refusals look identical on screen and are not the same problem: one is a deployment
    // state an operator fixes, the other may succeed on a retry. Printing the reason is the whole
    // difference between them (ADR-037).
    const withoutProvider = extractReport({
      extracted: false,
      itemsWritten: 0,
      reason: 'AI_UNAVAILABLE:no-provider-configured',
      linesWithoutAmount: 0,
    });
    expect(withoutProvider.messageKey).toBe('receipts.extract.unavailable');
    expect(withoutProvider.tone).toBe('info');
    expect(withoutProvider.showCode).toBe(true);

    const failed = extractReport({
      extracted: false,
      itemsWritten: 0,
      reason: 'AI_ERROR:PROVIDER_UNAVAILABLE:TIMEOUT',
      linesWithoutAmount: 0,
    });
    expect(failed.messageKey).toBe('receipts.extract.failed');
    expect(failed.tone).toBe('warn');
    expect(failed.showCode).toBe(true);
  });

  it('treats a refusal with no reason as a failure rather than as success', () => {
    // A `null` reason is not a state the API produces, and reading it as "nothing to report" would
    // hide a refusal behind an empty line.
    const report = extractReport({
      extracted: false,
      itemsWritten: 0,
      reason: null,
      linesWithoutAmount: 0,
    });
    expect(report.messageKey).toBe('receipts.extract.failed');
    expect(report.showCode).toBe(true);
  });
});
