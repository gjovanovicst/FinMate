import { describe, expect, it } from 'vitest';

import {
  RECEIPT_TOLERANCE_MINOR,
  isWithinTolerance,
  receiptTotals,
  roundingLineAmount,
  type ReceiptItemAmount,
} from './receipts';

/**
 * I-6's boundary is the whole point of the receipt flow, so every case is asserted on **both sides**
 * of the tolerance — a test that only checks the matching case cannot tell a tolerance from a typo,
 * and both failures are silent: too strict and every receipt is a mismatch, too loose and a missed
 * line is reported as correct.
 */

const items = (...amounts: bigint[]): readonly ReceiptItemAmount[] =>
  amounts.map((amountMinor) => ({ amountMinor }));

describe('isWithinTolerance', () => {
  it('accepts exactly one minor unit and rejects two, in both directions', () => {
    expect(isWithinTolerance(0n)).toBe(true);
    expect(isWithinTolerance(1n)).toBe(true);
    expect(isWithinTolerance(-1n)).toBe(true);
    expect(isWithinTolerance(2n)).toBe(false);
    expect(isWithinTolerance(-2n)).toBe(false);
    expect(RECEIPT_TOLERANCE_MINOR).toBe(1n);
  });
});

describe('receiptTotals', () => {
  it('is PENDING, not a mismatch, when no total has been read', () => {
    const totals = receiptTotals(items(8900n, 17900n), null);
    expect(totals.state).toBe('PENDING');
    expect(totals.itemsTotalMinor).toBe(26800n);
    // The variance is still reported — signed — so a screen can show what the lines add up to.
    expect(totals.varianceMinor).toBe(-26800n);
  });

  it('is MATCHED when the figures agree, including the rounding filler', () => {
    expect(receiptTotals(items(2000n, 50n), 2050n).state).toBe('MATCHED');
    expect(receiptTotals(items(2000n), 2001n).state).toBe('MATCHED');
    expect(receiptTotals(items(2000n), 1999n).state).toBe('MATCHED');
  });

  it('is MISMATCH the moment the gap exceeds one minor unit, and reports the signed gap', () => {
    const short = receiptTotals(items(2000n), 2050n);
    expect(short.state).toBe('MISMATCH');
    expect(short.varianceMinor).toBe(50n);

    const over = receiptTotals(items(2050n), 2000n);
    expect(over.state).toBe('MISMATCH');
    expect(over.varianceMinor).toBe(-50n);
  });

  it('is MANUAL when the agreement came from a hand-added line, at the same tolerance', () => {
    expect(receiptTotals(items(2000n, 50n), 2050n, { manual: true }).state).toBe('MANUAL');
    // The tolerance still governs: a manual flag cannot make a real gap match.
    expect(receiptTotals(items(2000n), 2100n, { manual: true }).state).toBe('MISMATCH');
  });

  it('sums an empty receipt to zero rather than throwing', () => {
    expect(receiptTotals([], 0n)).toEqual({
      itemsTotalMinor: 0n,
      varianceMinor: 0n,
      state: 'MATCHED',
    });
  });
});

describe('roundingLineAmount', () => {
  it('is the positive gap when the receipt claims more than its lines', () => {
    expect(roundingLineAmount(50n)).toBe(50n);
  });

  it('is null when the lines overshoot, because no non-negative line can absorb it', () => {
    expect(roundingLineAmount(-50n)).toBeNull();
    expect(roundingLineAmount(0n)).toBeNull();
  });
});
