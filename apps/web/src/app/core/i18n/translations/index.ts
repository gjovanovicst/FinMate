// The **narrow** entry, deliberately, not the `@finmate/domain` barrel: this module is on the eager
// path (the shell renders a title before any route loads), and the barrel re-exports the seed catalogue
// — 39 categories and 62 merchants, 6.1 KB gzipped of data no first paint needs. Importing the barrel
// here put it in the initial chunk and broke docs/07 §11's shell budget. See `tsconfig.base.json`.
import { toCyrillic } from '@finmate/domain/cyrillic';

import { en } from './en';

export type TranslationKey = keyof typeof en;
/** A complete catalogue. `Record`, not `Partial`: a missing key is a compile error. */
export type Catalogue = Record<TranslationKey, string>;

export { en };

/**
 * Catalogue loading — **lazy, per locale** (ADR-044).
 *
 * ADR-019 shipped one runtime catalogue and that is still right: switching language is a signal write
 * with no reload and no rebuild. What that design did not survive was a fourth language. Every
 * catalogue was imported statically into this module, so *all* of them sat in the initial bundle — and
 * the shell was already at 150.9 KB of its 156 KB budget (docs/07 §11). Five languages bundled that way
 * is not a slow first paint; it is a failed build.
 *
 * So `en` stays eager — it is the primary language, it is the fallback `t()` degrades to, and
 * `TranslationKey` is derived from it, so it cannot be deferred — and every other catalogue is a
 * **dynamic import**, fetched when it is first selected. The shell budget then does not grow with the
 * language count at all, which is the property that makes "add a language" a data change.
 *
 * The one cost is that a non-English first paint would flash English while the chunk arrives. That is
 * bought off rather than accepted: `I18nService.init()` is awaited by an app initializer before the
 * application renders (see `app.config.ts`), so the active catalogue is resident by first paint.
 */

/**
 * The single place a locale code is wired to a catalogue module.
 *
 * Adding a language is: add the module, add its `LOCALES` entry (with `direction`), add one line here.
 * Nothing else in the application names a locale.
 */
const LOADERS: Readonly<Record<string, () => Promise<Catalogue>>> = {
  'sr-Latn': async () => (await import('./sr-latn')).srLatn,
  // Cyrillic is **derived** from Serbian Latin rather than hand-maintained (ADR-019). The point is not
  // saving effort — a generated catalogue cannot be missing a key, so Cyrillic can never lag behind a
  // new string. `toCyrillic` handles the digraphs and exempts brand names, currency codes and
  // `{placeholders}`.
  'sr-Cyrl': async () => deriveCyrillic(await catalogueOrEnglish('sr-Latn')),
  de: async () => (await import('./de')).de,
  es: async () => (await import('./es')).es,
  fr: async () => (await import('./fr')).fr,
  ar: async () => (await import('./ar')).ar,
};

const cache = new Map<string, Catalogue>();

/** Serbian Cyrillic, generated from its Latin source. */
export function deriveCyrillic(source: Catalogue): Catalogue {
  return Object.fromEntries(
    (Object.keys(source) as TranslationKey[]).map((key) => [key, toCyrillic(source[key])]),
  ) as Catalogue;
}

/**
 * Load a catalogue, or `null` when this build has none for that locale.
 *
 * Never rejects. A chunk that fails to arrive (offline, a stale service-worker cache) degrades to
 * English rather than to a blank screen or a raw key.
 */
export async function loadCatalogue(code: string): Promise<Catalogue | null> {
  if (code === 'en') return en;
  const cached = cache.get(code);
  if (cached !== undefined) return cached;
  const loader = LOADERS[code];
  if (loader === undefined) return null;
  try {
    const catalogue = await loader();
    cache.set(code, catalogue);
    return catalogue;
  } catch (error) {
    console.warn(`Could not load the "${code}" catalogue; falling back to English.`, error);
    return null;
  }
}

/** The locales this build can render from a module. English is absent because it is eager. */
export function loadableLocales(): readonly string[] {
  return Object.keys(LOADERS);
}

/** "Loaded, or English" — for a locale that is derived from another and must always produce a value. */
async function catalogueOrEnglish(code: string): Promise<Catalogue> {
  return (await loadCatalogue(code)) ?? en;
}
