/**
 * A **test double** for the caller's `TextFolder`.
 *
 * Not product code and not a second fold: the product's single fold lives in `@finmate/nlp`
 * (`foldForMatching` / `foldTokens`) and is **injected** by the caller, because the eslint boundary
 * forbids `scope:rules` → `scope:nlp` and AGENTS.md forbids copying it. These doubles exist so the
 * rules-engine specs can prove (a) the engine folds both sides through whatever it was given and
 * (b) — using {@link createNaiveFolder} — that it has no hidden fold of its own.
 *
 * The Cyrillic table is deliberately only the letters the specs use. It is a fixture, not a
 * transliterator; `packages/nlp/src/transliterate.spec.ts` owns transliteration correctness.
 *
 * @module @finmate/rules-engine/testing
 */

import type { TextFolder } from '../types';

/** Only the letters the specs exercise. Fixture data, not a general table. */
const MINIMAL_CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = Object.freeze({
  с: 's',
  е: 'e',
  п: 'p',
  т: 't',
  и: 'i',
  ч: 'c',
  к: 'k',
  а: 'a',
});

function foldWith(transliterate: boolean, value: string): string {
  let result = '';
  for (const character of value.trim().toLowerCase()) {
    result += transliterate ? (MINIMAL_CYRILLIC_TO_LATIN[character] ?? character) : character;
  }
  return result
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ');
}

function tokenize(folded: string): readonly string[] {
  if (folded.length === 0) return [];
  return folded.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

/** A folder that behaves like a (minimal) `@finmate/nlp` folder: transliterate, case, diacritics. */
export function createTextFolder(): TextFolder {
  return {
    fold: (value) => foldWith(true, value),
    tokens: (value) => tokenize(foldWith(true, value)),
  };
}

/**
 * A folder that does **not** transliterate or strip diacritics. Used to prove the engine has no
 * folding of its own: what the injected folder does not do, the engine cannot do either.
 */
export function createNaiveFolder(): TextFolder {
  return {
    fold: (value) => foldWith(false, value),
    tokens: (value) => tokenize(foldWith(false, value)),
  };
}

export interface RecordingFolder extends TextFolder {
  readonly foldCalls: string[];
  readonly tokenCalls: string[];
}

/** Wrap a folder and record every call, so a spec can assert both sides were folded. */
export function createRecordingFolder(inner: TextFolder = createTextFolder()): RecordingFolder {
  const foldCalls: string[] = [];
  const tokenCalls: string[] = [];
  return {
    foldCalls,
    tokenCalls,
    fold: (value) => {
      foldCalls.push(value);
      return inner.fold(value);
    },
    tokens: (value) => {
      tokenCalls.push(value);
      return inner.tokens(value);
    },
  };
}
