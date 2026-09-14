/**
 * Supported locales.
 *
 * ADR-019: **one runtime catalogue**, switchable without a reload or a rebuild, rather than
 * per-locale bundles — a budget app has no SEO surface, and Serbian users switch script by
 * preference. Adding a locale is a data change, not a deployment.
 *
 * `code` is our own short identifier; `tag` is the BCP-47 tag handed to `Intl` for number, currency
 * and date formatting, and written to `<html lang>`.
 */
export type LocaleCode = 'en' | 'sr-Latn' | 'sr-Cyrl';

export interface LocaleDefinition {
  readonly code: LocaleCode;
  /** BCP-47 tag for `Intl` and `<html lang>`. */
  readonly tag: string;
  /** Name in its own language — a language picker that renames itself in a language you cannot
   *  read is useless to the person who needs it. */
  readonly nativeLabel: string;
  /** Name in English, for the `aria-label` and for logs. */
  readonly englishLabel: string;
}

export const LOCALES: readonly LocaleDefinition[] = [
  { code: 'en', tag: 'en', nativeLabel: 'English', englishLabel: 'English' },
  { code: 'sr-Latn', tag: 'sr-Latn-RS', nativeLabel: 'Srpski (latinica)', englishLabel: 'Serbian (Latin)' },
  { code: 'sr-Cyrl', tag: 'sr-Cyrl-RS', nativeLabel: 'Српски (ћирилица)', englishLabel: 'Serbian (Cyrillic)' },
];

/**
 * English is the product's primary language (docs/01 §7). It is also the **fallback** for any key a
 * translation is missing, so a gap degrades to a readable string rather than a raw key.
 */
export const DEFAULT_LOCALE: LocaleCode = 'en';

export function findLocale(code: string | null | undefined): LocaleDefinition | undefined {
  if (!code) return undefined;
  return LOCALES.find((locale) => locale.code === code || locale.tag === code);
}

/** Where the visitor's choice is remembered between page loads. */
export const LOCALE_STORAGE_KEY = 'finmate.locale';
