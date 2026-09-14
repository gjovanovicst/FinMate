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
  MoneyError,
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
