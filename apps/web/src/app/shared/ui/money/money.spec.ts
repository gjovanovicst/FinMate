import { describe, expect, it } from 'vitest';

import { balance, formatBalance, money, formatMoney } from '@finmate/domain';

/**
 * Tests for the money rendering contract used by `fm-money`.
 *
 * The component itself is a thin wrapper; the logic worth testing is the wire→display conversion,
 * and doing it here keeps the test free of a DOM and an Angular TestBed. The component adds only
 * sign and aria handling on top of what is asserted below.
 */
describe('Money rendering contract (ADR-003 in the client)', () => {
  /** Mirrors MoneyComponent.formatted(): wire string → bigint → signed domain formatter. */
  function render(wire: { amountMinor: string; currency: string }, locale = 'sr-Latn-RS'): string {
    try {
      return formatBalance(balance(BigInt(wire.amountMinor), wire.currency), locale);
    } catch {
      return '—';
    }
  }

  it('renders the wire string faithfully, with no float rounding', () => {
    const formatted = render({ amountMinor: '200000', currency: 'RSD' }).replace(/\u00a0|\u202f/g, ' ');
    expect(formatted).toMatch(/2\.000/);
  });

  it('preserves an amount beyond Number.MAX_SAFE_INTEGER', () => {
    // 2^53 + 1. Comparing against a numeric literal would prove nothing: the literal itself rounds
    // to 2^53. The property that matters is that the STRING round-trips and `Number` does not —
    // which is exactly why the wire format is a string.
    const huge = '9007199254740993';

    expect(String(Number(huge))).not.toBe(huge); // rounding on the way in
    expect(String(BigInt(huge))).toBe(huge); // exact through bigint
    expect(render({ amountMinor: huge, currency: 'RSD' })).not.toBe('—');
  });

  it('renders a malformed amount as a placeholder rather than NaN', () => {
    // A visible "—" is honest; a plausible wrong number is not.
    expect(render({ amountMinor: 'not-a-number', currency: 'RSD' })).toBe('—');
    expect(render({ amountMinor: '100', currency: 'XXX' })).toBe('—');
  });

  it('handles zero without sign or special-casing', () => {
    const formatted = render({ amountMinor: '0', currency: 'RSD' }).replace(/\u00a0|\u202f/g, ' ');
    expect(formatted).toMatch(/0/);
  });

  it('renders a NEGATIVE balance with a minus, not the placeholder', () => {
    // A derived Balance may be negative (an overdraft). Rendering '—' here — which is what using
    // the non-negative Money formatter did — hid real data behind an error glyph.
    const formatted = render({ amountMinor: '-240000', currency: 'RSD' }).replace(/\u00a0|\u202f/g, ' ');
    expect(formatted).not.toBe('—');
    expect(formatted).toMatch(/-/);
    expect(formatted).toMatch(/2\.400/);
  });

  it('keeps the Money formatter strict, so amounts still cannot be negative', () => {
    // The distinction is deliberate: Money is a typed amount (never negative), Balance is derived.
    expect(() => money(-1n, 'RSD')).toThrow();
    expect(formatMoney(money(100n, 'RSD'), 'en-US')).toBeTruthy();
  });

  it('uses the requested locale for grouping', () => {
    const en = render({ amountMinor: '200000', currency: 'RSD' }, 'en-US');
    // Serbian groups with '.', English with ',' — a hardcoded formatter would produce one for both.
    expect(en).toMatch(/2,000/);
  });
});
