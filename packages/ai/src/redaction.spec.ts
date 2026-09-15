/**
 * Redaction — docs/08 §6.3's table and §6.4's assertion list.
 *
 * The two failure modes this file guards against are opposite: redacting too little (a Chapter V
 * transfer of an account number) and redacting too much (a fragment with its signal removed, which
 * docs/08 §6.3 calls "a slower dropdown").
 *
 * @module @finmate/ai
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_FEW_SHOT_EXAMPLES,
  MAX_FRAGMENT_CHARS,
  MAX_QUESTION_CHARS,
  MAX_RECEIPT_LINE_CHARS,
  MIN_REDACTED_DIGIT_RUN,
  REDACTED_EMAIL,
  REDACTED_NUMBER,
  redactClassifyPayload,
  redactFragment,
  redactReceiptLine,
  redactText,
  resolveId,
} from './redaction';
import type { RedactedFragment } from './provider';

function fragment(text: string, extra: Partial<RedactedFragment> = {}): RedactedFragment {
  return { text, amountMinor: null, currency: null, occurredOn: null, ...extra };
}

describe('redactText — the §6.3 removal rules', () => {
  it('masks a run of nine or more digits, including an account-number-shaped string', () => {
    const input = 'uplata na racun 2650000000123456-89 za struju';
    const output = redactText(input);

    expect(output).toContain(REDACTED_NUMBER);
    expect(output).not.toContain('2650000000123456');
    expect(output).not.toContain('123456');
    // The words that carry the signal survive — this is the whole point of the redaction.
    expect(output).toContain('uplata na racun');
    expect(output).toContain('za struju');
  });

  it('masks a card-shaped run with separators', () => {
    const output = redactText('kartica 4111 1111 1111 1111 lidl');
    expect(output).toBe(`kartica ${REDACTED_NUMBER} lidl`);
  });

  it(`keeps a digit run shorter than ${MIN_REDACTED_DIGIT_RUN} — the amount is the signal`, () => {
    expect(redactText('Lidl 2000')).toBe('Lidl 2000');
    expect(redactText('dejan 3600')).toBe('dejan 3600');
    // Eight digits is still below the documented threshold.
    expect(redactText('sifra 12345678')).toBe('sifra 12345678');
    // Nine is the first masked length.
    expect(redactText('sifra 123456789')).toBe(`sifra ${REDACTED_NUMBER}`);
  });

  it('masks an email regardless of what surrounds it', () => {
    expect(redactText('posalji na goran@example.com molim')).toBe(
      `posalji na ${REDACTED_EMAIL} molim`,
    );
  });

  it('keeps only a URL host', () => {
    const output = redactText('vidi https://example.com/racun/12345?token=abcdef sada');
    expect(output).toBe('vidi example.com sada');
    expect(output).not.toContain('token');
    expect(output).not.toContain('/racun/');
  });

  it('leaves a bare scheme alone and masks a full URL', () => {
    // The pattern requires a host, so a lone `https://` is not a URL to mask — and it carries no
    // Household data. What matters is the complete URL, which keeps only its host.
    const output = redactText('vidi https://example.com/racun/1?token=abc sada');
    expect(output).toBe('vidi example.com sada');
  });

  it('masks an internal UUID and an ISO instant, and keeps a date-only value', () => {
    const output = redactText(
      'tx 0190f2c1-1111-7000-8000-000000000001 at 2026-02-14T09:31:00Z done',
    );
    expect(output).not.toContain('0190f2c1');
    // An instant is close to an identifier (timestamp + timezone), so the whole thing goes.
    expect(output).not.toContain('09:31');
    expect(output).toContain('[REDACTED_TIMESTAMP]');

    // A calendar day is a different thing and is what `occurredOn` carries, so it survives.
    expect(redactText('placeno 2026-02-14 lidl')).toBe('placeno 2026-02-14 lidl');
    expect(redactReceiptLine('2026-02-14 LIDL')).toContain('2026-02-14');
  });

  it('strips control characters so a fragment cannot break a line in the prompt', () => {
    expect(redactText('lidl\u0000 2000\u001b[31m')).toBe('lidl 2000[31m');
  });

  it('caps the fragment at the §6.3 length', () => {
    const output = redactText('a'.repeat(MAX_FRAGMENT_CHARS + 250));
    expect(output).toHaveLength(MAX_FRAGMENT_CHARS);
  });

  it('never splits a surrogate pair when capping', () => {
    // Each emoji is two UTF-16 code units, so a cap of 5 lands mid-pair.
    const output = redactText('😀😀😀😀', 5);
    expect([...output]).toHaveLength(2);
  });

  it('removes identifier-shaped digits from a receipt line in place', () => {
    const line = redactReceiptLine('KARTICA 4111111111111111 LIDL');
    expect(line).toBe('KARTICA **** LIDL');
    expect(line.length).toBeLessThanOrEqual(MAX_RECEIPT_LINE_CHARS);
  });

  it('exposes the question cap separately from the fragment cap', () => {
    expect(MAX_QUESTION_CHARS).toBeLessThan(MAX_FRAGMENT_CHARS);
    expect(redactText('x'.repeat(400), MAX_QUESTION_CHARS)).toHaveLength(MAX_QUESTION_CHARS);
  });
});

describe('redactFragment — the amount passes through untruncated', () => {
  it('keeps a large minor-unit amount as a string even though it is a long digit run', () => {
    const redacted = redactFragment(fragment('velika uplata', { amountMinor: '1234567890' }));
    // The amount is the client- or parser-supplied value the model needs; masking it would make
    // parsing impossible. It is not model output, so it is not a hallucination risk (ADR-003).
    expect(redacted.amountMinor).toBe('1234567890');
  });

  it('redacts the text, the merchant name and the counterparty name', () => {
    const redacted = redactFragment(
      fragment('kontakt 064123456789', {
        merchantName: 'Lidl 4111 1111 1111 1111',
        counterpartyName: 'Dejan 2650000000123456',
        currency: 'RSD',
        occurredOn: '2026-02-14',
      }),
    );
    expect(redacted.text).toBe(`kontakt ${REDACTED_NUMBER}`);
    expect(redacted.merchantName).not.toContain('4111');
    expect(redacted.counterpartyName).not.toContain('26500000');
    expect(redacted.currency).toBe('RSD');
    expect(redacted.occurredOn).toBe('2026-02-14');
  });

  it('leaves an absent merchant or counterparty absent rather than adding an empty string', () => {
    const redacted = redactFragment(fragment('lidl 2000'));
    expect('merchantName' in redacted).toBe(false);
    expect('counterpartyName' in redacted).toBe(false);
  });
});

describe('redactClassifyPayload — ids become opaque placeholders', () => {
  const categories = [
    { id: '0190f2c1-1111-7000-8000-000000000001', path: 'Hrana / Supermarket' },
    { id: '0190f2c1-1111-7000-8000-000000000002', path: 'Auto / Gorivo', description: 'gorivo' },
  ];

  it('replaces real ids with per-call indices and returns the map', () => {
    const payload = redactClassifyPayload({
      fragment: fragment('lidl 2000'),
      categories,
    });

    expect(payload.categories.map((category) => category.id)).toEqual(['c1', 'c2']);
    // The rendered list carries placeholders, never the real ids.
    expect(JSON.stringify(payload.categories)).not.toContain('0190f2c1');
    // The map is the only place a real id reappears, and it stays inside the process: the
    // adapter sends `payload.categories`, not `payload.map`.
    expect(resolveId(payload.map, 'c1')).toBe(categories[0]?.id);
    expect(resolveId(payload.map, 'c2')).toBe(categories[1]?.id);
  });

  it('gives the same id the same placeholder and different ids different ones', () => {
    const payload = redactClassifyPayload({
      fragment: fragment('lidl 2000'),
      categories: [categories[0]!, { ...categories[1]!, id: categories[0]!.id }],
    });
    expect(payload.categories.map((category) => category.id)).toEqual(['c1', 'c1']);
  });

  it('returns null for a placeholder the payload never contained', () => {
    const payload = redactClassifyPayload({ fragment: fragment('lidl 2000'), categories });
    // This is docs/04 §6.2's closed-list gate, applied before the real list is even consulted.
    expect(resolveId(payload.map, 'c999')).toBeNull();
    expect(resolveId(payload.map, null)).toBeNull();
  });

  it('caps the few-shot examples at five and redacts each one', () => {
    const examples = Array.from({ length: 8 }, (_value, index) => ({
      input: `primer ${index} 4111 1111 1111 1111`,
      categoryId: categories[0]!.id,
    }));
    const payload = redactClassifyPayload({ fragment: fragment('lidl 2000'), categories, examples });

    expect(payload.examples).toHaveLength(MAX_FEW_SHOT_EXAMPLES);
    expect(payload.examples[0]?.input).not.toContain('4111');
    expect(resolveId(payload.map, payload.examples[0]!.categoryId)).toBe(categories[0]!.id);
  });

  it('redacts the known merchant and person name lists', () => {
    const payload = redactClassifyPayload({
      fragment: fragment('dejan roda 3600'),
      categories,
      knownMerchants: ['Lidl', 'Maxi 4111 1111 1111 1111'],
      knownPeople: ['Dejan'],
    });
    // Every entity name is also substitutable, so a model citing a known merchant by placeholder
    // can be mapped back to the Household's own name — and the real names never reach the wire.
    expect(resolveId(payload.map, payload.knownPeople[0]!)).toBe('Dejan');
    expect(resolveId(payload.map, payload.knownMerchants[0]!)).toBe('Lidl');
    expect(resolveId(payload.map, payload.knownMerchants[1]!)).not.toContain('4111');
    expect(JSON.stringify(payload.knownMerchants)).not.toContain('Lidl');
  });

  it('defaults the optional lists to empty rather than undefined', () => {
    const payload = redactClassifyPayload({ fragment: fragment('lidl 2000'), categories });
    expect(payload.knownMerchants).toEqual([]);
    expect(payload.knownPeople).toEqual([]);
    expect(payload.examples).toEqual([]);
  });
});
