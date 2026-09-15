import { describe, expect, it } from 'vitest';

import {
  allowedNumerals,
  canonicaliseNumeral,
  extractNumerals,
  separatorsFor,
  validateNarration,
  type NumericPayload,
} from './numeric-validator';

/**
 * The validator is the thing that makes docs/06 §8.5's guarantee checkable, so its own tests are as
 * much about the **failure** direction as the success one: a validator that accepts everything looks
 * identical to a working one until a model invents a figure.
 *
 * `sr-Latn-RS` is the household default (`.` groups, `,` decimals) and `en-US` is used to prove the
 * separators come from the locale rather than from a hardcoded convention.
 */
const RS = 'sr-Latn-RS';
const EN = 'en-US';

const payload: NumericPayload = {
  formatted: {
    period: '2026-09-01 – 2026-09-30',
    headline: '46.650,00 RSD',
    currency: 'RSD',
  },
  rows: [
    { label: 'Hrana / Supermarket', value: '1745000', formatted: '17.450,00 RSD' },
    { label: 'Gorivo', value: '920000', formatted: '9.200,00 RSD' },
  ],
  totals: [
    { label: 'Spending', money: { amountMinor: '4665000', currency: 'RSD' }, formatted: '46.650,00 RSD' },
  ],
  transactionCount: 3,
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  ledgerCurrency: 'RSD',
};

describe('reading the locale’s separators', () => {
  it('takes them from Intl rather than hardcoding one convention', () => {
    expect(separatorsFor(RS)).toEqual({ group: '.', decimal: ',' });
    expect(separatorsFor(EN)).toEqual({ group: ',', decimal: '.' });
  });

  it('falls back instead of throwing on an unparseable tag, because `locale` is client input', () => {
    expect(separatorsFor('not a locale!!')).toEqual({ group: ',', decimal: '.' });
  });
});

describe('canonicalising one numeral', () => {
  it('compares values, so a dropped decimal part or a different grouping is not a lie', () => {
    expect(canonicaliseNumeral('27.450,00', RS)).toBe('27450');
    expect(canonicaliseNumeral('27.450', RS)).toBe('27450');
    expect(canonicaliseNumeral('0,00', RS)).toBe('0');
    expect(canonicaliseNumeral('1.234.567,89', RS)).toBe('1234567.89');
    expect(canonicaliseNumeral('1 234,50', RS)).toBe('1234.5');
    expect(canonicaliseNumeral('1\u00a0234,50', RS)).toBe('1234.5');
  });

  it('reads the same figure under an English locale', () => {
    expect(canonicaliseNumeral('27,450.00', EN)).toBe('27450');
    expect(canonicaliseNumeral('1,234,567.89', EN)).toBe('1234567.89');
  });

  it('refuses a token it cannot read, rather than guessing', () => {
    // Two decimal markers under a comma-decimal locale is `1,234,567` — grouped, or 1.234567? Nobody
    // can say, and a validator that picks one is inventing the number it is supposed to be checking.
    expect(canonicaliseNumeral('1,234,567', RS)).toBeNull();
    // Arabic-Indic digits are read as themselves — never folded to ASCII, because folding is how a
    // numeral in another digit set would become indistinguishable from the payload's own.
    expect(canonicaliseNumeral('٤٦', RS)).toBe('٤٦');
  });
});

describe('finding the numerals in a sentence', () => {
  it('splits a date range into its components instead of one unreadable token', () => {
    const found = extractNumerals('You spent 46.650,00 RSD (2026-09-01 – 2026-09-30).', RS);
    expect(found.map((numeral) => numeral.raw)).toEqual([
      '46.650,00',
      '2026',
      '09',
      '01',
      '2026',
      '09',
      '30',
    ]);
  });

  it('does not swallow a trailing sentence period or a currency code', () => {
    expect(extractNumerals('Total: 46.650,00 RSD.', RS).map((n) => n.raw)).toEqual(['46.650,00']);
    expect(extractNumerals('3 transakcije', RS).map((n) => n.raw)).toEqual(['3']);
  });

  it('finds nothing in a sentence without numerals', () => {
    expect(extractNumerals('You spent nothing on that.', RS)).toEqual([]);
  });
});

describe('the numerals a payload authorises', () => {
  it('includes the formatted strings, the formatted machine values, the count and the date parts', () => {
    const allowed = allowedNumerals(payload, RS);
    for (const value of ['46650', '17450', '9200', '3', '2026', '09', '01', '30']) {
      expect(allowed.has(value), value).toBe(true);
    }
  });

  it('does NOT authorise bare minor units, because 4 665 000 for 46.650,00 is wrong by 100×', () => {
    const allowed = allowedNumerals(payload, RS);
    expect(allowed.has('4665000')).toBe(false);
    expect(allowed.has('1745000')).toBe(false);
  });

  it('allows the day endpoints of the range, which is how a period is written', () => {
    // "1–30 September" is true about a 2026-09-01..2026-09-30 range.
    expect(allowedNumerals(payload, RS).has('1')).toBe(true);
    // …and a day the payload does not mention is not.
    expect(allowedNumerals(payload, RS).has('15')).toBe(false);
  });
});

describe('validating a narration', () => {
  it('accepts the answer the payload supports, in either formatting of the same value', () => {
    const verbatim = validateNarration('You spent 46.650,00 RSD on Hrana / Supermarket, through 3 transactions (2026-09-01 – 2026-09-30).', payload, RS);
    expect(verbatim).toEqual({ ok: true, unaccounted: [], checked: 8 });

    const trimmed = validateNarration('You spent 46.650 RSD, through 3 transactions.', payload, RS);
    expect(trimmed.ok).toBe(true);
  });

  it('refuses an invented figure, which is the whole point', () => {
    const result = validateNarration('You spent 99.999,00 RSD on Hrana.', payload, RS);
    expect(result.ok).toBe(false);
    expect(result.unaccounted).toEqual(['99.999,00']);
  });

  it('refuses a wrong count even when the amount is right', () => {
    const result = validateNarration('You spent 46.650,00 RSD through 23 transactions.', payload, RS);
    expect(result.ok).toBe(false);
    expect(result.unaccounted).toEqual(['23']);
  });

  it('refuses the machine value printed as digits — the same money said 100× wrong', () => {
    const result = validateNarration('You spent 4665000 RSD.', payload, RS);
    expect(result.ok).toBe(false);
    expect(result.unaccounted).toEqual(['4665000']);
  });

  it('refuses a numeral written in another digit set', () => {
    const result = validateNarration('You spent ٤٦.٦٥٠,٠٠ RSD.', payload, RS);
    expect(result.ok).toBe(false);
    expect(result.unaccounted).toEqual(['٤٦.٦٥٠,٠٠']);
  });

  it('reports each distinct unaccounted numeral once, in the order it appears', () => {
    const result = validateNarration('You spent 12,00 RSD and then 12,00 again, not 99,00.', payload, RS);
    expect(result.unaccounted).toEqual(['12,00', '99,00']);
    expect(result.checked).toBe(3);
  });

  it('accepts an empty answer, because a narration with no numerals invented nothing', () => {
    expect(validateNarration('', payload, RS)).toEqual({ ok: true, unaccounted: [], checked: 0 });
  });

  it('is locale-driven: the same sentence is judged against the locale’s own convention', () => {
    const english: NumericPayload = {
      ...payload,
      formatted: { headline: '46,650.00 RSD' },
      rows: [{ label: 'Groceries', value: '1745000', formatted: '17,450.00 RSD' }],
      totals: [
        { label: 'Spending', money: { amountMinor: '4665000', currency: 'RSD' }, formatted: '46,650.00 RSD' },
      ],
    };
    expect(validateNarration('You spent 46,650.00 RSD.', english, EN).ok).toBe(true);
    // Under `en-US` the Serbian spelling reads as 46.65, which the payload does not authorise.
    expect(validateNarration('You spent 46.650,00 RSD.', english, EN).ok).toBe(false);
  });

  it('accepts a zero answer when the payload says zero', () => {
    const zero: NumericPayload = {
      ...payload,
      formatted: { headline: '0,00 RSD' },
      rows: [],
      totals: [{ label: 'Spending', money: { amountMinor: '0', currency: 'RSD' }, formatted: '0,00 RSD' }],
      transactionCount: 0,
    };
    expect(validateNarration('You spent 0,00 RSD in that period.', zero, RS).ok).toBe(true);
    // `2` rather than `1`, deliberately: the period's first day authorises a bare `1`, so it is not a
    // probe of anything.
    expect(validateNarration('You spent 2,00 RSD in that period.', zero, RS).ok).toBe(false);
  });
});
