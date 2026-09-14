import { describe, expect, it } from 'vitest';

import {
  extractFragment,
  extractFragments,
  type ExtractOptions,
  type TransactionFragment,
} from './extract';

/** A Monday, so `prošli petak` has an unambiguous previous week. */
const TODAY = '2026-09-14';

const options: ExtractOptions = { currency: 'RSD', today: TODAY };

function fragment(text: string, overrides: Partial<ExtractOptions> = {}): TransactionFragment {
  return extractFragment(text, { ...options, ...overrides });
}

describe('extractFragment — amounts', () => {
  const amountCases: readonly (readonly [string, bigint])[] = [
    ['2000', 200_000n],
    ['2.000', 200_000n],
    ['2 000', 200_000n],
    ['1.250,50', 125_050n],
    ['2k', 200_000n],
    ['1.5k', 150_000n],
    ['1,5k', 150_000n],
  ];

  it.each(amountCases)('reads `%s` as %s minor units', (text, expected) => {
    const result = fragment(`Lidl ${text}`);
    expect(result.amountMinor).toBe(expected);
    expect(typeof result.amountMinor).toBe('bigint');
  });

  it('reads the currency-suffix forms docs/04 §3.1 names', () => {
    const din = fragment('2000din');
    expect(din.amountMinor).toBe(200_000n);
    expect(din.currency).toBe('RSD');

    expect(fragment('2.000 rsd').currency).toBe('RSD');
    expect(fragment('1500 dindži').currency).toBe('RSD');
    expect(fragment('1500 dindzi').currency).toBe('RSD');
    expect(fragment('1500 dinara').currency).toBe('RSD');

    const eur = fragment('20€');
    expect(eur.amountMinor).toBe(2_000n);
    expect(eur.currency).toBe('EUR');
    expect(fragment('20 eur').currency).toBe('EUR');
    expect(fragment('20$').currency).toBe('USD');
  });

  it('leaves currency null when the text names none, so the ledger currency is inherited', () => {
    expect(fragment('Lidl 2000').currency).toBeNull();
    expect(fragment('Lidl 2000', { currency: 'EUR' }).currency).toBeNull();
  });

  it('parses a foreign-currency amount in that currency, not the ledger one', () => {
    // 20€ is 2000 euro cents regardless of the household ledger currency.
    const result = fragment('Lidl 20€', { currency: 'RSD' });
    expect(result.amountMinor).toBe(2_000n);
    expect(result.currency).toBe('EUR');
  });

  it('treats an unrecognised suffix as text, never as currency or shorthand', () => {
    const result = fragment('2000kg');
    expect(result.amountMinor).toBe(200_000n);
    expect(result.currency).toBeNull();
    // `2000k` would be two million; the `kg` lookahead must prevent that.
    expect(result.tokens).toContain('kg');
  });

  it('finds the amount inside surrounding words', () => {
    expect(fragment('kupovina u Lidlu 1.250,50 juče').amountMinor).toBe(125_050n);
  });
});

describe('extractFragment — ambiguity is surfaced, never resolved', () => {
  it('returns both readings of 1.200 with the Serbian one first', () => {
    const result = fragment('Lidl 1.200');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.amountMinor).toBe(120_000n);
    expect(result.candidates[1]!.amountMinor).toBe(120n);
    expect(result.amountMinor).toBe(120_000n);
  });

  it('returns both readings of 2.000, grouping first', () => {
    const result = fragment('Lidl 2.000');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]!.amountMinor).toBe(200_000n);
    expect(result.candidates[1]!.amountMinor).toBe(200n);
  });

  it('reports a single reading for an unambiguous amount', () => {
    expect(fragment('Lidl 2,50').candidates).toHaveLength(1);
    expect(fragment('Lidl 2000').candidates).toHaveLength(1);
  });

  it('gives every candidate a non-empty reason', () => {
    for (const candidate of fragment('Lidl 1.200').candidates) {
      expect(candidate.reason.length).toBeGreaterThan(0);
    }
  });

  it('has no candidates when there is no amount', () => {
    expect(fragment('Lidl').candidates).toEqual([]);
  });
});

describe('extractFragment — dates', () => {
  it('reads the relative days', () => {
    expect(fragment('Lidl juče 2000').occurredOn).toBe('2026-09-13');
    expect(fragment('Lidl danas 2000').occurredOn).toBe('2026-09-14');
    expect(fragment('Lidl prekjuče 2000').occurredOn).toBe('2026-09-12');
    expect(fragment('Lidl juce 2000').occurredOn).toBe('2026-09-13');
    expect(fragment('Лиди јуче 2000').occurredOn).toBe('2026-09-13');
  });

  it('reads `prošli petak` as the Friday of the previous week', () => {
    // TODAY is Monday 2026-09-14; the previous ISO week is 09-07..09-13, so its Friday is 09-11.
    expect(fragment('Lidl prošli petak 2000').occurredOn).toBe('2026-09-11');
    expect(fragment('Lidl prosli petak 2000').occurredOn).toBe('2026-09-11');
  });

  it('is not merely "the last Friday"', () => {
    // On Sunday 2026-09-20 the last Friday is the 18th, but `prošli petak` is still the 11th.
    expect(fragment('Lidl prošli petak 2000', { today: '2026-09-20' }).occurredOn).toBe(
      '2026-09-11',
    );
  });

  it('reads absolute dates', () => {
    expect(fragment('Lidl 1.9. 2000').occurredOn).toBe('2026-09-01');
    expect(fragment('Lidl 01.09.2026 2000').occurredOn).toBe('2026-09-01');
    expect(fragment('Lidl 1.9.2026. 2000').occurredOn).toBe('2026-09-01');
    expect(fragment('Lidl 1/9 2000').occurredOn).toBe('2026-09-01');
    expect(fragment('Lidl 1.9.2025 2000').occurredOn).toBe('2025-09-01');
    expect(fragment('Lidl 1/9/2025 2000').occurredOn).toBe('2025-09-01');
    expect(fragment('Lidl 01.09.26 2000').occurredOn).toBe('2026-09-01');
  });

  it('resolves a year-less date to the most recent day not in the future', () => {
    // January: `1.9.` means last September, not a date eight months ahead.
    expect(fragment('Lidl 1.9. 2000', { today: '2027-01-15' }).occurredOn).toBe('2026-09-01');
    // December: the same text is this year's September.
    expect(fragment('Lidl 1.9. 2000', { today: '2026-12-15' }).occurredOn).toBe('2026-09-01');
    // The boundary is inclusive: the named day itself is not "in the future".
    expect(fragment('Lidl 14.9. 2000', { today: '2026-09-14' }).occurredOn).toBe('2026-09-14');
    // The day before it, the same text is still last year's occurrence.
    expect(fragment('Lidl 14.9. 2000', { today: '2026-09-13' }).occurredOn).toBe('2025-09-14');
  });

  it('handles 29 February by walking back to the most recent leap year', () => {
    expect(fragment('Lidl 29.2. 2000', { today: '2026-03-01' }).occurredOn).toBe('2024-02-29');
  });

  it('does not mistake an amount for a date', () => {
    expect(fragment('Lidl 2.000').occurredOn).toBeNull();
    expect(fragment('Lidl 1.250,50').occurredOn).toBeNull();
    expect(fragment('Lidl 2.5').occurredOn).toBeNull();
    expect(fragment('Lidl 150000').occurredOn).toBeNull();
  });

  it('rejects an impossible calendar day rather than inventing one', () => {
    expect(fragment('Lidl 31.02.2026 2000').occurredOn).toBeNull();
  });

  it('has no date when the text names none', () => {
    expect(fragment('Lidl 2000').occurredOn).toBeNull();
  });
});

describe('extractFragment — direction', () => {
  it.each([
    'plata',
    'penzija',
    'uplata',
    'primio',
    'refundacija',
    'povraćaj',
    'povrat',
    'honorar',
  ])('reads %s as INCOME', (marker) => {
    expect(fragment(`${marker} 150000`).kind).toBe('INCOME');
  });

  it('reads the Cyrillic income markers too', () => {
    expect(fragment('плата 150000').kind).toBe('INCOME');
    expect(fragment('пензија 150000').kind).toBe('INCOME');
  });

  it('covers the §3.1 phrase `rata kredita primljena`', () => {
    expect(fragment('rata kredita primljena 150000').kind).toBe('INCOME');
  });

  it('defaults to EXPENSE when there is an amount and no income marker', () => {
    expect(fragment('Lidl 2000').kind).toBe('EXPENSE');
    expect(fragment('gorivo 3500').kind).toBe('EXPENSE');
  });

  it('is UNKNOWN when there is neither an amount nor a direction marker', () => {
    const result = fragment('Lidl');
    expect(result.amountMinor).toBeNull();
    expect(result.kind).toBe('UNKNOWN');
    expect(fragment('septička jama').kind).toBe('UNKNOWN');
  });

  it('keeps INCOME with no amount, because the marker is itself a direction signal', () => {
    expect(fragment('plata').kind).toBe('INCOME');
  });

  it('flags a refund for confirmation instead of guessing a sign', () => {
    const refund = fragment('vraćeno 2000');
    expect(refund.needsDirectionConfirmation).toBe(true);
    expect(refund.amountMinor).toBe(200_000n);
    expect(refund.kind).toBe('EXPENSE');
    expect(fragment('storno 2000').needsDirectionConfirmation).toBe(true);
    expect(fragment('refund 2000').needsDirectionConfirmation).toBe(true);
  });

  it('does not flag an ordinary fragment', () => {
    expect(fragment('Lidl 2000').needsDirectionConfirmation).toBe(false);
    expect(fragment('Lidl').needsDirectionConfirmation).toBe(false);
  });
});

describe('extractFragment — description and tokens', () => {
  it('removes the amount and the date but preserves the original characters', () => {
    const result = fragment('Septička jama 3.600');
    expect(result.description).toBe('Septička jama');
    expect(result.description).toContain('Septička');
  });

  it('keeps case and diacritics in the display text while folding the tokens', () => {
    const result = fragment('Đorđe Šećer 2.000');
    expect(result.description).toBe('Đorđe Šećer');
    expect(result.tokens).toEqual(['dorde', 'secer']);
  });

  it('removes a relative date and a currency suffix from the description', () => {
    expect(fragment('Lidl juče 2000din').description).toBe('Lidl');
    expect(fragment('Lidl 2.000 rsd').description).toBe('Lidl');
    expect(fragment('Lidl 1.9. 2000').description).toBe('Lidl');
  });

  it('excludes the amount and date tokens', () => {
    const result = fragment('Lidl juče 2000');
    expect(result.tokens).toEqual(['lidl']);
    expect(result.tokens).not.toContain('2000');
    expect(result.tokens).not.toContain('juce');
  });

  it('folds tokens so a Cyrillic and a Latin spelling agree', () => {
    expect(extractFragment('Лидл 2000', options).tokens).toEqual(
      extractFragment('Lidl 2000', options).tokens,
    );
  });

  it('gives an UNKNOWN fragment its content tokens', () => {
    expect(fragment('Septička jama').tokens).toEqual(['septicka', 'jama']);
  });

  it('keeps the raw text exactly as typed', () => {
    expect(fragment('  Lidl   2000  ').rawText).toBe('Lidl   2000');
  });
});

describe('extractFragment — money discipline (ADR-003)', () => {
  it('never lets a number reach amountMinor', () => {
    for (const text of ['Lidl 2.000', 'plata 1.5k', '20€', 'Lidl 1.250,50']) {
      expect(typeof fragment(text).amountMinor).toBe('bigint');
    }
  });

  it('parses exactly past Number.MAX_SAFE_INTEGER', () => {
    const digits = '9007199254740993';
    const result = fragment(`Lidl ${digits}`);
    expect(result.amountMinor).toBe(900_719_925_474_099_300n);
    // What a float path would have done: Number rounds the digits before any scaling.
    expect(BigInt(Number(digits))).not.toBe(BigInt(digits));
  });

  it('parses a 21-digit input exactly', () => {
    const result = fragment('Lidl 999999999999999999999');
    expect(result.amountMinor).toBe(99_999_999_999_999_999_999_900n);
  });

  it('keeps every candidate a bigint', () => {
    for (const candidate of fragment('Lidl 1.200').candidates) {
      expect(typeof candidate.amountMinor).toBe('bigint');
    }
  });
});

describe('extractFragments', () => {
  it('parses the exit-criterion line into three independent fragments', () => {
    const result = extractFragments('Lidl 2000, gorivo 3500, plata 150000', options);
    expect(result).toHaveLength(3);

    expect(result[0]!.rawText).toBe('Lidl 2000');
    expect(result[0]!.amountMinor).toBe(200_000n);
    expect(result[0]!.kind).toBe('EXPENSE');
    expect(result[0]!.description).toBe('Lidl');

    expect(result[1]!.description).toBe('gorivo');
    expect(result[1]!.amountMinor).toBe(350_000n);
    expect(result[1]!.kind).toBe('EXPENSE');

    expect(result[2]!.description).toBe('plata');
    expect(result[2]!.amountMinor).toBe(15_000_000n);
    expect(result[2]!.kind).toBe('INCOME');
  });

  it('returns nothing for blank input', () => {
    expect(extractFragments('   ', options)).toEqual([]);
    expect(extractFragments('', options)).toEqual([]);
  });
});
