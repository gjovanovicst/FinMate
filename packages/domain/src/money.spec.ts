import { describe, expect, it } from 'vitest';

import {
  addMoney,
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
