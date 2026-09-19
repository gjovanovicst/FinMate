// The **narrow** entry, deliberately, not the `@finmate/domain` barrel: this module is on the eager
// path (the shell renders a title before any route loads), and the barrel re-exports the seed catalogue
// — 39 categories and 62 merchants, 6.1 KB gzipped of data no first paint needs. Importing the barrel
// here put it in the initial chunk and broke docs/07 §11's shell budget. See `tsconfig.base.json`.
import { toCyrillic } from '@finmate/domain/cyrillic';

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
