import { describe, expect, it } from 'vitest';

import {
  addBalance,
  addMoney,
  applyMovement,
  balance,
  formatBalance,
  subtractBalance,
  toBalance,
  zeroBalance,
  equalsMoney,
  formatMoney,
  fractionDigitsOf,
  isSupportedCurrency,
  MINOR_UNITS_PER_MAJOR,
  MoneyError,
  minorUnitsPerMajor,
  money,
  subtractMoney,
} from './money';

describe('Money (ADR-003: integer minor units, never float)', () => {
  it('represents 2.000 RSD as 200000 minor units', () => {
    expect(money(200_000n, 'RSD').amountMinor).toBe(200_000n);
  });

  it('rejects a float/number amount, because that means a float leaked into the money path', () => {
    // @ts-expect-error — deliberately passing a number to prove the runtime guard fires.
    expect(() => money(2000, 'RSD')).toThrow(MoneyError);
  });

  it('rejects a negative amount: direction is carried by kind, not a sign', () => {
    expect(() => money(-1n, 'RSD')).toThrow(/non-negative/);
  });

  it('rejects an unsupported currency', () => {
    expect(() => money(100n, 'XXX')).toThrow(/Unsupported currency/);
  });

  it('adds same-currency amounts exactly', () => {
    expect(addMoney(money(199_999n, 'RSD'), money(1n, 'RSD')).amountMinor).toBe(200_000n);
  });

  it('refuses to combine different currencies', () => {
    expect(() => addMoney(money(100n, 'RSD'), money(100n, 'EUR'))).toThrow(/Currency mismatch/);
  });

  it('refuses subtraction that would go negative rather than silently producing a sign', () => {
    expect(() => subtractMoney(money(1n, 'RSD'), money(2n, 'RSD'))).toThrow(/negative/);
  });

  it('compares structurally', () => {
    expect(equalsMoney(money(100n, 'RSD'), money(100n, 'RSD'))).toBe(true);
    expect(equalsMoney(money(100n, 'RSD'), money(100n, 'EUR'))).toBe(false);
  });

  it('formats RSD with Serbian grouping (thousands separator, no float drift)', () => {
    // Intl may render a non-breaking space; normalise before asserting.
    const formatted = formatMoney(money(200_000n, 'RSD'), 'sr-Latn-RS').replace(/\u00a0|\u202f/g, ' ');
    expect(formatted).toMatch(/2\.000/);
    expect(formatted).toMatch(/RSD|din/);
  });

  it('is immutable — a Money value cannot be mutated after construction', () => {
    const m = money(100n, 'RSD');
    expect(Object.isFrozen(m)).toBe(true);
  });
});

describe('Balance (a derived, SIGNED quantity — distinct from Money)', () => {
  it('allows a negative balance, which Money forbids', () => {
    // The distinction that matters: an overdrawn account is valid data, not a sign bug.
    expect(balance(-240_000n, 'RSD').amountMinor).toBe(-240_000n);
    // Meanwhile the amount that produced it must still be non-negative.
    expect(() => money(-240_000n, 'RSD')).toThrow(/non-negative/);
  });

  it('subtracts into the negative rather than throwing', () => {
    const result = subtractBalance(balance(120_000n, 'RSD'), balance(360_000n, 'RSD'));
    expect(result.amountMinor).toBe(-240_000n);
  });

  it('still refuses to mix currencies', () => {
    expect(() => subtractBalance(balance(1n, 'RSD'), balance(1n, 'EUR'))).toThrow(/Currency mismatch/);
  });

  it('applies income and expense with the right sign, in one place', () => {
    const opening = balance(245_000_00n, 'RSD');
    const afterIncome = applyMovement(opening, 'INCOME', money(145_000_00n, 'RSD'));
    const afterExpense = applyMovement(afterIncome, 'EXPENSE', money(2_340_50n, 'RSD'));

    expect(afterIncome.amountMinor).toBe(245_000_00n + 145_000_00n);
    expect(afterExpense.amountMinor).toBe(245_000_00n + 145_000_00n - 2_340_50n);
  });

  it('lets an expense exceed the opening balance without throwing', () => {
    const result = applyMovement(balance(0n, 'RSD'), 'EXPENSE', money(500_000n, 'RSD'));
    expect(result.amountMinor).toBe(-500_000n);
  });

  it('rejects a non-bigint, keeping floats out of the money path', () => {
    // @ts-expect-error — deliberately passing a number.
    expect(() => balance(240_000, 'RSD')).toThrow(/bigint/);
  });

  it('formats a negative balance with a minus sign', () => {
    const formatted = formatBalance(balance(-240_000n, 'RSD'), 'sr-Latn-RS').replace(/\u00a0|\u202f/g, ' ');
    expect(formatted).toMatch(/-/);
    expect(formatted).toMatch(/2\.400/);
  });

  it('promotes Money into a Balance without changing the value', () => {
    expect(toBalance(money(150_000n, 'RSD')).amountMinor).toBe(150_000n);
  });

  it('has a zero identity that leaves a balance unchanged', () => {
    const original = balance(-500n, 'RSD');
    expect(addBalance(original, zeroBalance('RSD')).amountMinor).toBe(-500n);
  });
});

/**
 * The currency table (ADR-045).
 *
 * `MINOR_UNITS_PER_MAJOR` is hand-written static data, because deriving it from `Intl` at load costs
 * 61 ms on the client's first-paint path. These tests are what make that safe: they check the shipped
 * data against the platform's own CLDR figures, so a wrong exponent is a failing test rather than a
 * mis-formatted amount in a Household's ledger.
 */
describe('MINOR_UNITS_PER_MAJOR (ADR-045)', () => {
  /** CLDR's own minor-unit count for a currency. */
  const cldrDigits = (currency: string): number =>
    new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;

  it('agrees with Intl on every currency it ships', () => {
    const wrong = Object.entries(MINOR_UNITS_PER_MAJOR)
      .filter(([code, exponent]) => exponent !== 10n ** BigInt(cldrDigits(code)))
      .map(([code]) => code);
    expect(wrong).toEqual([]);
  });

  it('covers the markets the product targets, with the awkward exponents present', () => {
    // The three families that a hardcoded 100 gets wrong, named so a regression is legible.
    expect(minorUnitsPerMajor('JPY')).toBe(1n); // no minor unit
    expect(minorUnitsPerMajor('KWD')).toBe(1000n); // three minor units
    expect(minorUnitsPerMajor('HUF')).toBe(1n); // CLDR writes it with none
    // Markets beyond the original RSD/EUR/USD/JPY quartet.
    for (const code of ['GBP', 'CHF', 'PLN', 'SEK', 'EGP', 'INR', 'BRL', 'ZAR', 'ARS']) {
      expect(isSupportedCurrency(code)).toBe(true);
    }
  });

  it('rejects a currency it does not carry, rather than accepting and later throwing', () => {
    expect(isSupportedCurrency('XXX')).toBe(false);
    expect(isSupportedCurrency('GB')).toBe(false);
    expect(() => minorUnitsPerMajor('XXX')).toThrow(/Unsupported currency/);
    // `money()` is the floor: a Household currency that reaches here unsupported must fail loudly,
    // because the alternative is a ledger that cannot record a transaction.
    expect(() => money(100n, 'XXX')).toThrow(/Unsupported currency/);
  });

  it('derives decimal places from the exponent, not from an assumed two', () => {
    expect(fractionDigitsOf('JPY')).toBe(0);
    expect(fractionDigitsOf('EUR')).toBe(2);
    expect(fractionDigitsOf('KWD')).toBe(3);
  });

  it('renders a three-decimal currency to three places', () => {
    // The formatters hardcoded `scale === 1 ? 0 : 2`, so a Kuwaiti dinar was rendered to two places
    // and 1.234 KWD displayed as 1.23 — a silently wrong amount, which is the worst kind.
    const formatted = formatMoney(money(1234n, 'KWD'), 'en-US').replace(/\u00a0|\u202f/g, ' ');
    expect(formatted).toMatch(/1\.234/);
  });
});
