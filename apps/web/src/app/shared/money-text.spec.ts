import { describe, expect, it } from 'vitest';

import { moneyText, overrunText, overspendText, toMajorString } from './money-text';

const rsd = (amountMinor: string) => ({ amountMinor, currency: 'RSD' });

/**
 * `Intl` separates a currency code from its number with a **non-breaking** space (U+00A0), which is the
 * typographically correct choice and unreadable in a diff. The assertions below compare against an
 * ordinary space so a failure shows the four digits that changed rather than two identical-looking runs.
 */
const plain = (value: string | null): string | null => value?.replace(/\u00a0/g, ' ') ?? null;

/**
 * In-sentence money.
 *
 * The rule these pin is that a figure inside a sentence is formatted by the **same** formatter `fm-money`
 * renders through. It was not: this module used the domain's ungrouped `toMajorString` and appended the
 * currency by hand, so the dashboard showed "of 1200000.00 RSD" directly beneath an `fm-money` reading
 * "RSD 1,200,000.00" — two spellings of one quantity on one card (ADR-039 audit).
 */
describe('toMajorString', () => {
  it('renders major units with two decimals, and **only** the digits', () => {
    // This form goes into a text field that `parseAmount` reads back, so a currency code or a grouping
    // separator in here is a parsing bug rather than a nicety.
    expect(toMajorString(30000000n)).toBe('300000.00');
    expect(toMajorString(1700344n)).toBe('17003.44');
  });

  it('honours the currency scale instead of assuming two decimals', () => {
    // A hardcoded `slice(-2)` renders 1000 JPY as "10.00". The domain formatter knows JPY has none.
    expect(toMajorString(1000n, 'JPY')).toBe('1000');
  });

  it('pads amounts below one major unit instead of dropping the decimals', () => {
    expect(toMajorString(0n)).toBe('0.00');
    expect(toMajorString(5n)).toBe('0.05');
    expect(toMajorString(99n)).toBe('0.99');
  });

  it('keeps the sign for negative values rather than rendering a positive one', () => {
    expect(toMajorString(-150n)).toBe('-1.50');
  });
});

describe('the difference between the editable form and the sentence form', () => {
  it('is what stops a field from showing a currency, and a sentence from losing one', () => {
    expect(toMajorString(30000000n)).toBe('300000.00');
    expect(plain(moneyText({ amountMinor: '30000000', currency: 'RSD' }))).toBe('RSD 300,000.00');
  });

  it('groups in the locale it is given, so a Serbian household sees Serbian grouping', () => {
    // 'sr-Latn' uses a dot as the thousands separator and a comma for the decimal.
    expect(moneyText({ amountMinor: '30000000', currency: 'RSD' }, 'sr-Latn')).toContain('300.000');
  });
});

describe('moneyText', () => {
  it('renders the currency and the grouping, exactly as fm-money does', () => {
    expect(plain(moneyText(rsd('30000000')))).toBe('RSD 300,000.00');
  });

  it('renders nothing when the value is absent, so no stray "0.00" implies a budget of zero', () => {
    expect(moneyText(null)).toBe('');
    expect(moneyText(undefined)).toBe('');
  });
});

describe('overspendText', () => {
  it('reports the magnitude of a negative available, which is what "over budget" means', () => {
    // The bug this exists for: `available` is negative when the month is over, and `overrunText`'s own
    // sign gate returns null for it — so the dashboard's over-budget line never rendered. Found by the
    // visual pass with a month 9,4 M RSD over its available budget and no warning on screen.
    expect(plain(overspendText(rsd('-946112900')))).toBe('RSD 9,461,129.00');
  });

  it('is silent while the month is inside its available budget', () => {
    expect(overspendText(rsd('1455000'))).toBeNull();
    expect(overspendText(rsd('0'))).toBeNull();
    expect(overspendText(null)).toBeNull();
  });

  it('never prints a minus sign: the direction is the sentence, not the number', () => {
    expect(overspendText(rsd('-1'))).not.toContain('-');
  });
});

describe('overrunText', () => {
  it('renders a positive overrun', () => {
    expect(plain(overrunText(rsd('200000')))).toBe('RSD 2,000.00');
  });

  it('returns null for a NEGATIVE Balance, because a signed Balance is under budget', () => {
    // The regression this pins: the projection is negative on a healthy month. Rendering it
    // unconditionally put "over budget" on a month that was inside its budget.
    expect(overrunText(rsd('-27655402'))).toBeNull();
  });

  it('returns null at exactly zero — spending the budget exactly is not an overspend', () => {
    expect(overrunText(rsd('0'))).toBeNull();
  });

  it('returns null when there is no value at all', () => {
    expect(overrunText(null)).toBeNull();
  });
});
