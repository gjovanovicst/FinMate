/**
 * Fragment normalization: the match fold plus tokenization.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §3.1.
 *
 * **Nothing here mutates display text.** `rawText` and `description` keep the user's own characters;
 * the folded text and the tokens exist only for comparison and classification.
 *
 * @module @finmate/nlp
 */

import { foldForMatching } from './transliterate';

/**
 * A fragment after normalization.
 *
 * `rawText` is carried through unchanged so extraction can compute the display `description` from
 * the original characters rather than reconstructing it from the fold.
 */
export interface NormalizedFragment {
  /** The fragment exactly as the user typed it, trimmed. */
  readonly rawText: string;
  /** {@link foldForMatching} of `rawText`; for comparison only. */
  readonly foldedText: string;
  /** Folded content tokens: the folded text split on anything that is not a letter or digit. */
  readonly tokens: readonly string[];
}

/** Split folded text into content tokens. Punctuation, separators and currency symbols drop out. */
export function foldTokens(value: string): readonly string[] {
  const folded = foldForMatching(value);
  if (folded.length === 0) return [];
  return folded.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0);
}

/** Fold a fragment and tokenize it, without touching the display text. */
export function normalizeFragment(rawText: string): NormalizedFragment {
  const trimmed = rawText.trim();
  return {
    rawText: trimmed,
    foldedText: foldForMatching(trimmed),
    tokens: foldTokens(trimmed),
  };
}
