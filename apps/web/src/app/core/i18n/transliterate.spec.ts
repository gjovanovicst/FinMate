import { describe, expect, it } from 'vitest';

import { toCyrillic } from './transliterate';

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
});
