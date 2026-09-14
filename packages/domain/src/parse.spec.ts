import { describe, expect, it } from 'vitest';

import { parseAmount, toMajorString } from './parse';

/**
 * The amount parser, tested on its own.
 *
 * This file exists because the parser previously had no focused spec: its coverage came indirectly
 * through `allocation.spec.ts`, which meant a change to the money path could be verified only by a
 * test about splitting. Two things follow from that, and both matter more here than anywhere else in
 * the repo:
 *
 *  - **Every branch of the shorthand separator logic is exercised directly**, because doc 10 sets
 *    `packages/domain` at 100 % line *and branch* coverage and this is the money path (ADR-003).
 *  - **Amounts are asserted in minor units as `bigint`.** A float would survive a test that only
 *    checked small values, so the precision cases below use integers past `Number.MAX_SAFE_INTEGER`.
 */

const rsd = (input: string) => parseAmount(input, 'RSD');

describe('parseAmount — separators', () => {
  it('reads `.` and a space as thousands grouping', () => {
    expect(rsd('2000').money?.amountMinor).toBe(200_000n);
    expect(rsd('2.000').money?.amountMinor).toBe(200_000n);
    expect(rsd('2 000').money?.amountMinor).toBe(200_000n);
  });

  it('reads `,` as the decimal separator', () => {
    expect(rsd('2,50').money?.amountMinor).toBe(250n);
    expect(rsd('1.250,50').money?.amountMinor).toBe(125_050n);
  });

  it('treats the last separator as the decimal point when both appear', () => {
    // `1.200,50` is 1200.50 — the `.` groups, the `,` decimals.
    expect(rsd('1.200,50').money?.amountMinor).toBe(120_050n);
  });

  it('pads a value below one major unit rather than dropping it', () => {
    expect(rsd('0,05').money?.amountMinor).toBe(5n);
    expect(rsd('0,5').money?.amountMinor).toBe(50n);
  });

  it('returns null money for input with no number in it', () => {
    expect(rsd('Lidl').money).toBeNull();
    expect(rsd('').money).toBeNull();
  });
});

describe('parseAmount — k shorthand', () => {
  it('expands a whole-number shorthand', () => {
    expect(rsd('2k').money?.amountMinor).toBe(200_000n);
  });

  it('expands a fractional shorthand as a decimal, not as a stripped group', () => {
    // The regression this file was created for: the old implementation removed the `.` as though it
    // were a thousands separator, so `1.5k` became `15k` — a tenfold overstatement of money.
    expect(rsd('1.5k').money?.amountMinor).toBe(150_000n);
    expect(rsd('1,5k').money?.amountMinor).toBe(150_000n);
    expect(rsd('0.5k').money?.amountMinor).toBe(50_000n);
  });

  it('still reads a well-formed thousands group as grouping', () => {
    // `1.200k` is 1200 thousand, not 1.2 thousand: three trailing digits is a group, one is not.
    expect(rsd('2.000k').money?.amountMinor).toBe(200_000_000n);
    expect(rsd('1.200k').money?.amountMinor).toBe(120_000_000n);
  });

  it('handles a fractional part on a grouped base', () => {
    // 1200.50 thousand = 1 200 500.
    expect(rsd('1.200,50k').money?.amountMinor).toBe(120_050_000n);
  });

  it('is exactly a factor of a thousand, with no intermediate float', () => {
    // A float would round this at 2^53 and lose the tail.
    expect(rsd('9007199254740993').money?.amountMinor).toBe(900_719_925_474_099_300n);
    expect(rsd('10000000000000000k').money?.amountMinor).toBe(1_000_000_000_000_000_000_000n);
    // 9007199254740993 thousand RSD, in para: x1000 for `k`, then x100 for the currency scale.
    expect(rsd('9007199254740993k').money?.amountMinor).toBe(900_719_925_474_099_300_000n);
  });

  it('does not treat a `k` that starts a unit as shorthand', () => {
    // `2000kg` is two thousand kilograms, not two million of anything.
    expect(rsd('2000kg').money?.amountMinor).toBe(200_000n);
  });
});

describe('parseAmount — ambiguity is surfaced, never resolved', () => {
  it('returns both readings for a structurally ambiguous group', () => {
    // docs/04 §3.1: the parser "never silently picks". `1.200` is 1200 under Serbian grouping or
    // 1.2 under English decimals, so both are offered with the Serbian reading first.
    const result = rsd('1.200');
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.money?.amountMinor).toBe(120_000n);
    expect(result.candidates.map((candidate) => candidate.amountMinor)).toEqual([
      120_000n,
      // 1.2 RSD is 120 para — the English-decimal reading, offered but not chosen.
      120n,
    ]);
  });

  it('is not ambiguous when only one reading is defensible', () => {
    expect(rsd('1.234,56').ambiguous).toBe(false);
    expect(rsd('2k').candidates).toHaveLength(1);
  });
});

describe('parseAmount — currency handling', () => {
  it('reports the currency it was asked to parse in', () => {
    expect(rsd('2000').currency).toBe('RSD');
    expect(parseAmount('2000', 'EUR').currency).toBe('EUR');
  });

  it('honours a 0-decimal currency instead of assuming two digits', () => {
    // JPY has no minor unit, so the value is the amount.
    expect(parseAmount('1000', 'JPY').money?.amountMinor).toBe(1000n);
  });

  it('rejects a currency it has no scale for rather than guessing', () => {
    expect(() => parseAmount('2000', 'XYZ')).toThrow();
  });
});

describe('toMajorString', () => {
  it('round-trips a parsed amount back to its major-unit text', () => {
    // The formatter and the parser must agree, or an edit-then-save changes the number.
    for (const input of ['2000', '2.000', '1.250,50', '2,50']) {
      const money = rsd(input).money;
      expect(money).not.toBeNull();
      expect(parseAmount(toMajorString(money!), 'RSD').money?.amountMinor).toBe(money?.amountMinor);
    }
  });
});
