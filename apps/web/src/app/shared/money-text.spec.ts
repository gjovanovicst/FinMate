import { describe, expect, it } from 'vitest';

import { moneyText, overrunText, overspendText, toMajorString } from './money-text';

const rsd = (amountMinor: string) => ({ amountMinor, currency: 'RSD' });

describe('toMajorString', () => {
  it('renders major units with two decimals', () => {
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

describe('moneyText', () => {
  it('appends the currency', () => {
    expect(moneyText(rsd('30000000'))).toBe('300000.00 RSD');
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
    expect(overspendText(rsd('-946112900'))).toBe('9461129.00 RSD');
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
    expect(overrunText(rsd('200000'))).toBe('2000.00 RSD');
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
