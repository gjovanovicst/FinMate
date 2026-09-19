import { describe, expect, it } from 'vitest';

import { toCyrillic } from './cyrillic';

describe('toCyrillic (ADR-019: sr-Cyrl is generated, not hand-maintained)', () => {
  it('transliterates plain words', () => {
    expect(toCyrillic('Računi')).toBe('Рачуни');
    expect(toCyrillic('Prijava')).toBe('Пријава');
  });

  it('handles the digraphs that a naive character pass gets wrong', () => {
    // These are the reason this is not a simple map: lj/nj/dž are single Cyrillic letters.
    expect(toCyrillic('Ljubav')).toBe('Љубав');
    expect(toCyrillic('Njegoš')).toBe('Његош');
    expect(toCyrillic('džak')).toBe('џак');
    expect(toCyrillic('Đak')).toBe('Ђак');
  });

  it('prefers the longer digraph', () => {
    // "Njegoš" must not become "Нјегош".
    expect(toCyrillic('Njegoš')).not.toContain('Нј');
  });

  it('preserves brand names and acronyms', () => {
    expect(toCyrillic('FinMate')).toBe('FinMate');
    expect(toCyrillic('Lidl')).toBe('Lidl');
    expect(toCyrillic('RSD')).toBe('RSD');
    expect(toCyrillic('IBAN')).toBe('IBAN');
  });

  it('leaves placeholders untouched, so interpolation still works after transliteration', () => {
    expect(toCyrillic('Najmanje {min} znakova.')).toContain('{min}');
  });

  it('leaves URLs untouched', () => {
    expect(toCyrillic('Idi na https://example.com/racuni')).toContain('https://example.com/racuni');
  });

  it('preserves punctuation and spacing', () => {
    expect(toCyrillic('Da, može — naravno!')).toBe('Да, може — наравно!');
  });

  it('is idempotent for already-Cyrillic text', () => {
    // Cyrillic letters are not in the Latin map, so passing them through must be a no-op.
    expect(toCyrillic('Рачуни')).toBe('Рачуни');
  });

  /**
   * The regression cases, each one a string the catalogue actually ships.
   *
   * These are here because the defects were **invisible to every other test**: the suite only checked
   * `Računi`, `Njegoš` and `džak`, and the rule that broke the sign-out button was a positional one
   * none of them reached.
   */
  it('treats `dj` as `ђ` only at the start of a word', () => {
    // Shipped: the sign-out control and the sentences around it. Mid-word `dj` is `д` + `ј`.
    expect(toCyrillic('Odjavi se')).toBe('Одјави се');
    expect(toCyrillic('Odjavljivanje…')).toBe('Одјављивање…');
    expect(toCyrillic('odjavljeni')).toBe('одјављени');
    expect(toCyrillic('predjelo')).toBe('предјело');
    // …and the convention it exists for still works.
    expect(toCyrillic('Đak')).toBe('Ђак');
    expect(toCyrillic('Djordje')).toBe('Ђорђе');
  });

  it('transliterates the Latin letters Serbian does not use, inside a word', () => {
    // These survived inside Cyrillic text and read as a script error. The assertion is that no ASCII
    // letter is left behind rather than a particular spelling: `Excel` is a foreign word whose Serbian
    // form is a judgement call, and this function's contract is transliteration, not loanword spelling.
    for (const word of ['Wi-Fi', 'Excel', 'Linux']) {
      const out = toCyrillic(word);
      expect(out, word).not.toMatch(/[A-Za-z]/);
      expect(out, word).toMatch(/[\u0400-\u04FF]/);
    }
    expect(toCyrillic('Wi-Fi')).toBe('Ви-Фи');
    expect(toCyrillic('Linux')).toBe('Линукс');
  });

  it('preserves the technical tokens the catalogue prints', () => {
    for (const token of ['iPhone', 'iPad', 'RFC', 'Ctrl', 'Enter', 'JPEG', 'PNG', 'HEIC', 'WebP', 'MiB', 'Safari']) {
      expect(toCyrillic(token), token).toBe(token);
    }
    // An inflected loanword the copy contains, which an exact-token list would have missed.
    expect(toCyrillic('Proveri emaila')).toBe('Провери emaila');
  });
});
