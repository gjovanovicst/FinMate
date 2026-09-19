import { toCyrillic } from '@finmate/nlp';

import { en } from './en';
import { srLatn } from './sr-latn';

export type TranslationKey = keyof typeof en;
export type Catalogue = Record<TranslationKey, string>;

/**
 * Serbian Cyrillic is **derived** from Serbian Latin (ADR-019) rather than hand-maintained.
 *
 * The point is not saving effort — it is that a generated catalogue cannot be missing a key, so the
 * Cyrillic locale can never lag behind a new string. `toCyrillic` handles the digraphs and exempts
 * brand names, currency codes and `{placeholders}`.
 */
export const srCyrl: Catalogue = Object.fromEntries(
  (Object.keys(srLatn) as TranslationKey[]).map((key) => [key, toCyrillic(srLatn[key])]),
) as Catalogue;

/**
 * Every catalogue, keyed by locale.
 *
 * English is first and doubles as the fallback, so a gap degrades to a readable English string
 * rather than a raw key — but the type above means a gap cannot compile in the first place.
 */
export const CATALOGUES = {
  en,
  'sr-Latn': srLatn,
  'sr-Cyrl': srCyrl,
} as const;

export { en, srLatn };
