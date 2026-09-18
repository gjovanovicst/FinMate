import { describe, expect, it } from 'vitest';

import { extractFragment } from './extract';
import { foldForMatching } from './transliterate';

/**
 * The **value** half of the language work — ADR-036 C-5.
 *
 * ## Why this file exists
 *
 * ADR-036 let a model route a sentence in any language to a registered member. That buys the *intent*
 * and nothing else: an amount, a date and a direction must still be read by this package, because
 * ADR-001/ADR-003 forbid a model from producing a figure. So a language the assistant can route but
 * whose *values* this package cannot read is worse than one it cannot route at all — it produces a
 * confidently wrong row rather than a refusal.
 *
 * The first live measurement (C-3) made that concrete, and it found two defects in a **shipped**
 * language: `salary 85000` was recorded as an **expense** because the direction vocabulary was
 * Serbian-only, and `today`/`yesterday` never parsed because the relative-day table was too.
 *
 * ## What is asserted, and why it is written per language rather than from the tables
 *
 * A test that iterated `RELATIVE_DAY_OFFSETS` would pass for any table, including an empty one. These
 * expectations are written out **per language**, so the set of languages the fixture battery exercises
 * (Serbian, English, German, Spanish, Croatian) has a value vocabulary, and a language cannot be
 * promised by the routing half while this half silently reads nothing.
 */
const CONTEXT = { currency: 'RSD' as never, today: '2026-09-18' as never };

/** Each language with the words a person actually types, and what each must resolve to. */
const RELATIVE_DAYS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  Serbian: [
    ['danas', '2026-09-18'],
    ['juče', '2026-09-17'],
    ['prekjuče', '2026-09-16'],
  ],
  English: [
    ['today', '2026-09-18'],
    ['yesterday', '2026-09-17'],
  ],
  German: [
    ['heute', '2026-09-18'],
    ['gestern', '2026-09-17'],
    ['vorgestern', '2026-09-16'],
  ],
  Spanish: [
    ['hoy', '2026-09-18'],
    ['ayer', '2026-09-17'],
    ['anteayer', '2026-09-16'],
  ],
  Croatian: [
    ['danas', '2026-09-18'],
    ['jučer', '2026-09-17'],
    ['prekjučer', '2026-09-16'],
  ],
};

const INCOME_WORDS: Readonly<Record<string, readonly string[]>> = {
  Serbian: ['plata', 'penzija'],
  English: ['salary', 'wage', 'pension'],
  German: ['gehalt', 'lohn', 'rente'],
  Spanish: ['sueldo', 'salario', 'nómina'],
  Croatian: ['plaća'],
};

const REFUND_NOUNS: Readonly<Record<string, readonly string[]>> = {
  English: ['refund', 'reimbursement'],
  German: ['Rückerstattung'],
  Spanish: ['reembolso', 'devolución'],
};

const UNCERTAIN_WORDS: Readonly<Record<string, readonly string[]>> = {
  Serbian: ['vraćeno', 'storno'],
  English: ['refunded'],
  German: ['erstattet'],
  Spanish: ['devuelto'],
};

describe('the value vocabulary is per language (ADR-036 C-5)', () => {
  it('resolves a relative day in every language, and takes the word out of the description', () => {
    for (const [language, words] of Object.entries(RELATIVE_DAYS)) {
      for (const [word, expected] of words) {
        const fragment = extractFragment(`kafa 3,50 ${word}`, CONTEXT);
        expect(fragment.occurredOn, `${language} ${word}`).toBe(expected);
        // ⚠️ The description matters as much as the date: leaving the word in it is how the English
        // defect hid — the row was filed on the right *day* by accident and read `coffee today`.
        expect(fragment.description, `${language} ${word}`).toBe('kafa');
      }
    }
  });

  it('reads a direction marker in every language, so a salary is never an expense', () => {
    for (const [language, words] of Object.entries(INCOME_WORDS)) {
      for (const word of words) {
        const fragment = extractFragment(`${word} 85000`, CONTEXT);
        expect(fragment.kind, `${language} ${word}`).toBe('INCOME');
        expect(fragment.needsDirectionConfirmation, `${language} ${word}`).toBe(false);
      }
    }
  });

  it('biases a refund noun to income, and marks a returned participle as uncertain', () => {
    // The two classes are easy to conflate, so both are pinned: a *noun* for money coming back is
    // income (matching the Serbian `refundacija`), while a *participle* that says only "it was
    // returned" flags for confirmation (matching `vraćeno`).
    for (const [language, words] of Object.entries(REFUND_NOUNS)) {
      for (const word of words) {
        expect(extractFragment(`${word} 2000`, CONTEXT).kind, `${language} ${word}`).toBe('INCOME');
      }
    }
    for (const [language, words] of Object.entries(UNCERTAIN_WORDS)) {
      for (const word of words) {
        expect(
          extractFragment(`${word} 2000`, CONTEXT).needsDirectionConfirmation,
          `${language} ${word}`,
        ).toBe(true);
      }
    }
  });

  it('reads the currency words those languages write, and refuses to invent one', () => {
    // A stated currency is used; an unstated one is the Household's (ADR-011). The failure this pins is
    // the silent one: `5 euros` read as "no currency" becomes five *dinars* on an RSD ledger.
    for (const [text, currency] of [
      ['kafa 5 eura', 'EUR'],
      ['café 5 euros', 'EUR'],
      ['coffee 5 dollars', 'USD'],
      ['café 5 dólares', 'USD'],
      ['coffee 5 usd', 'USD'],
    ] as const) {
      expect(extractFragment(text, CONTEXT).currency, text).toBe(currency);
    }
    // `CHF` is deliberately absent: no market this product targets uses it, and a currency nobody asked
    // for is an assumption the ledger would carry.
    const francs = extractFragment('Kaffee 5 Franken', CONTEXT);
    expect(francs.currency).toBeNull();
    // …and the amount still parses, so the row is usable — the currency is simply not claimed.
    expect(francs.amountMinor).toBe(500n);
  });

  it('reads the number formats those languages write', () => {
    // Amounts were never the gap — the matcher is already format-agnostic — and this pins that they stay
    // so, because "any language" fails first on a number read the other way round (`1.200` is 1200 in
    // Belgrade and 1.2 in Boston, and the parser reports both readings rather than guessing).
    for (const [text, minor] of [
      ['café 1.200,50', 120050n],
      ['coffee 1,200.50', 120050n],
      ['Kaffee 1.200,50', 120050n],
      ['kafa 1.200,50', 120050n],
    ] as const) {
      expect(extractFragment(text, CONTEXT).amountMinor, text).toBe(minor);
    }
  });

  it('stores every marker folded, because that is what the matcher compares', () => {
    // The trap docs/15 records for cue lists applies here too: a word written with a diacritic must be
    // stored as the fold produces it, or it never matches.
    const fragment = extractFragment('Rückerstattung 2000', CONTEXT);
    expect(fragment.kind).toBe('INCOME');
    expect(foldForMatching('Rückerstattung')).toBe('ruckerstattung');
    expect(foldForMatching('plaća')).toBe('placa');
  });
});
