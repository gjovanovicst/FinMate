/**
 * Server-rendered copy, in the reader's language.
 *
 * ## Why the API now has a catalogue
 *
 * ADR-019 made the **client** the owner of interface wording and said server messages carry a stable
 * code rather than a sentence. That still holds for anything a screen can phrase itself — but three
 * kinds of text cannot: a **notification** (stored in `notifications.title/body` and then emailed and
 * pushed), an **email**, and a **stored name** (a synthesised Rule, a default Household). Those are
 * composed once, server-side, and rendered verbatim later. Before this module the API was inconsistent
 * in both directions: `mail.service.ts` was Serbian-only, `notification-copy.ts` and
 * `narration-template.ts` were English-only, and `assistant-action.service.ts` was the single module
 * that had both. A Serbian reader got English notifications; an English reader got a Serbian email and
 * a Serbian rule name. See ADR-040.
 *
 * ## The contract
 *
 * - A caller resolves its locale once with {@link resolveCopyLocale} and passes it down.
 * - Copy is a pair of **templates**, transliterated *first* and interpolated *second*
 *   ({@link tr}) — never a rendered string transliterated afterwards, which would rewrite a user's own
 *   Category or Merchant name into the Cyrillic script.
 * - English is the fallback for anything unrecognised, because it is the product's primary language
 *   (docs/01 §7).
 *
 * @module apps/api/src/common/i18n
 */

import { toCyrillic } from '@finmate/nlp';

/** The three catalogues the product ships: English, Serbian Latin and Serbian Cyrillic. */
export type CopyLocale = 'en' | 'sr-Latn' | 'sr-Cyrl';

/** A string in both languages. Serbian Cyrillic is derived from `sr` at render time. */
export interface CopyPair {
  readonly en: string;
  readonly sr: string;
}

/** The same, for copy that varies by more than a value — a list, a label set, a function. */
export type CopyVariants<T> = { readonly en: T; readonly sr: T };

/**
 * Map a BCP-47 tag to a catalogue.
 *
 * Anything Serbian is Serbian; everything else is English. `sr-Cyrl` is kept distinct from `sr-Latn`
 * rather than collapsed, because the script decides whether {@link tr} transliterates.
 */
export function resolveCopyLocale(tag: string | null | undefined, fallback: CopyLocale = 'en'): CopyLocale {
  if (tag === null || tag === undefined || tag.length === 0) return fallback;
  const lower = tag.toLowerCase();
  if (!lower.startsWith('sr')) return lower.startsWith('en') ? 'en' : fallback;
  return lower.includes('cyrl') ? 'sr-Cyrl' : 'sr-Latn';
}

/** Pick the variant for a locale, transliterating a Serbian string when the locale is Cyrillic. */
export function tr(
  locale: CopyLocale,
  pair: CopyPair,
  params?: Readonly<Record<string, string | number>>,
): string {
  const raw = locale === 'en' ? pair.en : pair.sr;
  // Transliterate the **template**, so `{category}` is still a placeholder here and the user's own
  // Category name is interpolated untouched afterwards.
  const template = locale === 'sr-Cyrl' ? toCyrillic(raw) : raw;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** Pick the variant for a locale when the value is not a plain string (a list, a map). */
export function pick<T>(locale: CopyLocale, variants: CopyVariants<T>): T {
  return locale === 'en' ? variants.en : variants.sr;
}

/**
 * The locale handed to `Intl` for money formatting *inside server copy*.
 *
 * It follows the copy's own language rather than the raw tag, so a Serbian sentence cannot contain an
 * amount grouped for English — the mismatch docs/15 records as the reason `locale` is passed at all.
 */
export function copyIntlLocale(locale: CopyLocale): string {
  switch (locale) {
    case 'sr-Latn':
      return 'sr-Latn-RS';
    case 'sr-Cyrl':
      return 'sr-Cyrl-RS';
    default:
      return 'en-US';
  }
}
