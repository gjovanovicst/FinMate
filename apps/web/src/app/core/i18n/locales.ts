/**
 * Supported locales — an **open registry**, not a closed union (ADR-044).
 *
 * ADR-019 built the right machine and then bolted the door: one runtime catalogue, switchable without
 * a reload or a rebuild, but `LocaleCode` was the literal union `'en' | 'sr-Latn' | 'sr-Cyrl'` and the
 * catalogue map was a static object. Adding a language meant editing a type, a map and a picker — a
 * code change in three files, in a product whose central promise is that it costs a *data* change.
 * ADR-044 opens it: a locale is an entry in {@link LOCALES} plus (optionally) a catalogue module.
 *
 * `code` is our own short identifier and is what a User's `locale` column stores; `tag` is the
 * BCP-47 tag handed to `Intl` for number, currency and date formatting and written to `<html lang>`.
 *
 * `direction` is why an open registry has to carry more than a tag: Arabic is a shipped target, and
 * hardcoding `dir = 'ltr'` in the service meant the one locale that most needs the attribute was the
 * one that could never set it. The stylesheet was already written in logical properties (docs/07 §3,
 * ADR-039), so the direction attribute is very nearly the whole of RTL support.
 */

/** A locale identifier. Deliberately `string`: see the module note above. */
export type LocaleCode = string;

/** Writing direction. `Intl` has no runtime API for this, so it is declared per locale. */
export type TextDirection = 'ltr' | 'rtl';

export interface LocaleDefinition {
  readonly code: LocaleCode;
  /** BCP-47 tag for `Intl` and `<html lang>`. */
  readonly tag: string;
  /** Name in its own language — a language picker that renames itself in a language you cannot
   *  read is useless to the person who needs it. */
  readonly nativeLabel: string;
  /** Name in English, for the `aria-label`, for logs, and for "what is this language called". */
  readonly englishLabel: string;
  /** `ltr` or `rtl`; drives `documentElement.dir`. */
  readonly direction: TextDirection;
}

/**
 * Every locale the product can render. **Order is the picker's order**, and English stays first
 * because it is the primary language and the fallback (docs/01 §7).
 *
 * `sr-Cyrl` is kept as its own entry rather than derived into `sr-Latn` at the picker level: the
 * script is a user preference, and a Serbian reader who wants Cyrillic should not have to argue with
 * their operating system about it.
 */
export const LOCALES: readonly LocaleDefinition[] = [
  { code: 'en', tag: 'en', nativeLabel: 'English', englishLabel: 'English', direction: 'ltr' },
  {
    code: 'sr-Latn',
    tag: 'sr-Latn-RS',
    nativeLabel: 'Srpski (latinica)',
    englishLabel: 'Serbian (Latin)',
    direction: 'ltr',
  },
  {
    code: 'sr-Cyrl',
    tag: 'sr-Cyrl-RS',
    nativeLabel: 'Српски (ћирилица)',
    englishLabel: 'Serbian (Cyrillic)',
    direction: 'ltr',
  },
  { code: 'de', tag: 'de-DE', nativeLabel: 'Deutsch', englishLabel: 'German', direction: 'ltr' },
  { code: 'es', tag: 'es-ES', nativeLabel: 'Español', englishLabel: 'Spanish', direction: 'ltr' },
  { code: 'fr', tag: 'fr-FR', nativeLabel: 'Français', englishLabel: 'French', direction: 'ltr' },
  { code: 'ar', tag: 'ar', nativeLabel: 'العربية', englishLabel: 'Arabic', direction: 'rtl' },
];

/**
 * English is the product's primary language (docs/01 §7). It is also the **fallback** for any key a
 * translation is missing, so a gap degrades to a readable string rather than a raw key.
 */
export const DEFAULT_LOCALE: LocaleCode = 'en';

/**
 * Match a BCP-47 tag (or one of our own codes) to a shipped locale.
 *
 * Region- and script-qualified tags have to resolve, because that is what a browser actually reports:
 * `de-AT`, `fr-CA` and `es-419` are all people who should get their language, not English. Resolution
 * is exact tag → exact code → **script-aware prefix match**.
 *
 * Serbian is the one language where the prefix match alone is not enough. A browser reports `sr`,
 * `sr-RS` or `sr-Cyrl-RS`, and `sr-RS` names no script at all — collapsing it to whichever Serbian
 * entry happens to be listed first is how a Cyrillic reader gets Latin. So `sr` resolves on the
 * *script subtag*: `cyrl` means Cyrillic, anything else means Latin. The API's `resolveCopyLocale`
 * applies the identical rule, deliberately, so the interface and a notification cannot disagree.
 */
export function findLocale(code: string | null | undefined): LocaleDefinition | undefined {
  if (!code) return undefined;
  const raw = code.trim();
  if (raw.length === 0) return undefined;

  const exact = LOCALES.find((locale) => locale.code === raw || locale.tag === raw);
  if (exact) return exact;

  const lower = raw.toLowerCase();
  const [language] = lower.split('-');

  if (language === 'sr') {
    const code = lower.includes('cyrl') ? 'sr-Cyrl' : 'sr-Latn';
    return LOCALES.find((locale) => locale.code === code);
  }

  return LOCALES.find((locale) => locale.code === language);
}

/** Where the visitor's choice is remembered between page loads. */
export const LOCALE_STORAGE_KEY = 'finmate.locale';
