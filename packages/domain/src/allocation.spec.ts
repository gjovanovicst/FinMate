import { describe, expect, it } from 'vitest';

import { allocate, allocateEqually, money, MoneyError } from './money';
import { parseAmount, toMajorString } from './parse';

/**
 * Allocation and parsing.
 *
 * Allocation is the algorithm behind invariant I-1 (`sum(splits) == amount`), so it is asserted
 * exhaustively over a range rather than on a couple of examples — the failure mode is a one-para
 * drift that only appears at particular totals, which is exactly what example tests miss.
 */
describe('allocate (invariant I-1: parts must sum exactly)', () => {
  /**
   * Deliberately exhaustive — 5001 totals × 6 ratio sets — so it takes seconds rather than
   * milliseconds. The package's `testTimeout` covers it; see the comment in `vitest.config.mts`.
   */
  it('sums exactly to the total for every total up to 5000 across several ratio sets', () => {
    const ratioSets: readonly (readonly number[])[] = [
      [1, 1],
      [1, 1, 1],
      [1, 1, 2],
      [3, 5, 7],
      [1, 2, 3, 4, 5],
      [0.1, 0.2, 0.7],
    ];

    for (const ratios of ratioSets) {
      for (let total = 0n; total <= 5_000n; total += 1n) {
        const parts = allocate(money(total, 'RSD'), ratios);
        const sum = parts.reduce((acc, part) => acc + part.amountMinor, 0n);
        expect(sum).toBe(total);
        expect(parts).toHaveLength(ratios.length);
      }
    }
  });

  it('never produces a negative part', () => {
    for (let total = 1n; total <= 500n; total += 1n) {
      for (const part of allocate(money(total, 'RSD'), [1, 1, 1, 1, 1, 1, 1])) {
        expect(part.amountMinor).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('distributes the remainder to the largest fractional shares', () => {
    // 100 para split three ways: 34, 33, 33 — the extra goes to the first, deterministically.
    const parts = allocateEqually(money(100n, 'RSD'), 3);
    expect(parts.map((part) => part.amountMinor)).toEqual([34n, 33n, 33n]);
    expect(parts.reduce((acc, part) => acc + part.amountMinor, 0n)).toBe(100n);
  });

  it('is deterministic for equal remainders (ties break by index)', () => {
    const first = allocate(money(10n, 'RSD'), [1, 1, 1]).map((part) => part.amountMinor);
    const second = allocate(money(10n, 'RSD'), [1, 1, 1]).map((part) => part.amountMinor);
    expect(first).toEqual(second);
    expect(first).toEqual([4n, 3n, 3n]);
  });

  it('honours the weights', () => {
    const [small, large] = allocate(money(1_000n, 'RSD'), [1, 3]);
    expect(large!.amountMinor).toBe(750n);
    expect(small!.amountMinor).toBe(250n);
  });

  it('handles a total smaller than the number of parts', () => {
    // Two para across three parts: two get one each, one gets nothing — and it still sums.
    const parts = allocateEqually(money(2n, 'RSD'), 3);
    expect(parts.map((part) => part.amountMinor)).toEqual([1n, 1n, 0n]);
    expect(parts.reduce((acc, part) => acc + part.amountMinor, 0n)).toBe(2n);
  });

  it('allocates zero without inventing money', () => {
    const parts = allocateEqually(money(0n, 'RSD'), 4);
    expect(parts.every((part) => part.amountMinor === 0n)).toBe(true);
  });

  it('refuses degenerate inputs rather than returning nonsense', () => {
    expect(() => allocate(money(100n, 'RSD'), [])).toThrow(MoneyError);
    expect(() => allocate(money(100n, 'RSD'), [0, 0])).toThrow(/sum to zero/);
    expect(() => allocate(money(100n, 'RSD'), [-1, 2])).toThrow(/non-negative/);
    expect(() => allocateEqually(money(100n, 'RSD'), 0)).toThrow(/positive whole number/);
    expect(() => allocateEqually(money(100n, 'RSD'), 2.5)).toThrow(/positive whole number/);
  });
});

describe('parseAmount (docs/04 §3.1 — Serbian-first, ambiguity reported)', () => {
  const rsd = (input: string) => parseAmount(input, 'RSD');

  it('reads the documented thousands grouping', () => {
    expect(rsd('2.000').money?.amountMinor).toBe(200_000n);
    expect(rsd('1 200').money?.amountMinor).toBe(120_000n);
  });

  it('reads the documented decimal separator', () => {
    expect(rsd('2,50').money?.amountMinor).toBe(250n);
  });

  it('treats the LAST separator as the decimal one when both appear', () => {
    expect(rsd('2.000,50').money?.amountMinor).toBe(200_050n);
  });

  it('expands the k shorthand', () => {
    expect(rsd('2k').money?.amountMinor).toBe(200_000n);
    expect(rsd('1,5k').money?.amountMinor).toBe(150_000n);
    // docs/04 §3.1 documents `1.5k` → `1500` too, and for a long time the shorthand path read the
    // `.` as a group separator and produced `15k`. A shorthand expansion must agree with the
    // separator rules the non-shorthand path already follows.
    expect(rsd('1.5k').money?.amountMinor).toBe(150_000n);
    expect(rsd('1.200k').money?.amountMinor).toBe(120_000_000n);
    // Still no float: the expansion is exact past Number.MAX_SAFE_INTEGER.
    expect(rsd('10000000000000000k').money?.amountMinor).toBe(1_000_000_000_000_000_000_000n);
  });

  it('strips currency words and symbols', () => {
    expect(rsd('2.000 din').money?.amountMinor).toBe(200_000n);
    expect(rsd('2000 rsd').money?.amountMinor).toBe(200_000n);
    expect(rsd('20€').money?.amountMinor).toBe(2_000n);
  });

  it('REPORTS ambiguity instead of silently picking', () => {
    // `1.200` is either twelve hundred or one-point-two. A parser that guesses is a parser that is
    // sometimes wrong by a factor of a thousand.
    const result = rsd('1.200');
    expect(result.ambiguous).toBe(true);
    expect(result.candidates.length).toBeGreaterThan(1);
    // The Serbian reading leads.
    expect(result.money?.amountMinor).toBe(120_000n);
    expect(result.candidates.map((candidate) => candidate.amountMinor)).toContain(120n);
  });

  it('leads with the Serbian grouping reading for d.ddd', () => {
    // `2.000` is structurally the same shape as the `1.200` case docs/04 §3.1 names as ambiguous, so
    // it is flagged — but the grouping reading must lead, because that is what a Serbian household
    // means by it. A parser that silently chose "2.00" would understate a payment 1000-fold.
    const result = rsd('2.000');
    expect(result.money?.amountMinor).toBe(200_000n);
    expect(result.candidates.map((candidate) => candidate.amountMinor)).toContain(200n);
  });

  it('leads with the DECIMAL reading when the separator is a comma', () => {
    // Comma is Serbia's decimal separator, so it takes precedence even with three digits.
    const result = rsd('1,999');
    expect(result.money?.amountMinor).toBe(199n);
    expect(result.candidates.map((candidate) => candidate.amountMinor)).toContain(199_900n);
  });

  it('is unambiguous when only one reading exists', () => {
    expect(rsd('2,50').ambiguous).toBe(false);
    expect(rsd('1 200').ambiguous).toBe(false);
    expect(rsd('2.000,50').ambiguous).toBe(false);
  });

  it('handles whitespace and surrounding text noise', () => {
    expect(rsd('  2.000  ').money?.amountMinor).toBe(200_000n);
  });

  it('returns nothing for input with no digits', () => {
    expect(rsd('lidl').money).toBeNull();
    expect(rsd('').money).toBeNull();
    expect(rsd('   ').money).toBeNull();
  });

  it('rejects a negative reading rather than creating a signed amount', () => {
    // Money is non-negative; direction belongs to `kind` (ADR-003).
    expect(rsd('-500').money).toBeNull();
  });

  it('avoids float drift on a value that breaks naive multiplication', () => {
    // 2000.50 * 100 is 200050.00000000003 in binary floating point.
    expect(rsd('2.000,50').money?.amountMinor).toBe(200_050n);
    expect(rsd('0,07').money?.amountMinor).toBe(7n);
    expect(rsd('1234,56').money?.amountMinor).toBe(123_456n);
  });

  it('truncates below the smallest unit rather than inventing money', () => {
    // Three decimals is below a para; rounding up would create money from nothing.
    expect(rsd('1,999').money?.amountMinor).toBe(199n);
  });

  it('round-trips through toMajorString', () => {
    for (const minor of [0n, 7n, 250n, 200_050n, 123_456_789n]) {
      const value = money(minor, 'RSD');
      expect(parseAmount(toMajorString(value), 'RSD').money?.amountMinor).toBe(minor);
    }
  });
});
