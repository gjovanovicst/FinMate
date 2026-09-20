/**
 * Server-rendered copy, in the reader's language.
 *
 * ## Why the API has a catalogue
 *
 * ADR-019 made the **client** the owner of interface wording and said server messages carry a stable
 * code rather than a sentence. That still holds for anything a screen can phrase itself — but three
 * kinds of text cannot: a **notification** (stored in `notifications.title/body` and then emailed and
 * pushed), an **email**, and a **stored name** (a synthesised Rule, a default Household). Those are
 * composed once, server-side, and rendered verbatim later. Before this module the API was inconsistent
 * in both directions: `mail.service.ts` was Serbian-only, `notification-copy.ts` and
 * `narration-template.ts` were English-only, and `assistant-action.service.ts` was the single module
 * that had both. See ADR-040.
 *
 * ## The contract
 *
 * - A caller resolves its locale once with {@link resolveCopyLocale} and passes it down.
 * - Copy is a **map of templates**, transliterated *first* and interpolated *second*
 *   ({@link tr}) — never a rendered string transliterated afterwards, which would rewrite a user's own
 *   Category or Merchant name into the Cyrillic script.
 * - English is the fallback for anything unrecognised, because it is the product's primary language
 *   (docs/01 §7).
 *
 * ## What ADR-044 changed here
 *
 * Two things, both of which made a third language unreachable:
 *
 * 1. `CopyLocale` was the literal union `'en' | 'sr-Latn' | 'sr-Cyrl'`, and `resolveCopyLocale` mapped
 *    **every non-Serbian, non-English tag to `'en'`**. Since signup stores that result in
 *    `users.locale`, a German reader was *persisted as English* — so every later notification and email
 *    was English no matter what they did in the picker. It is now an open language code, and the
 *    resolver returns the language the tag actually names.
 * 2. Copy was a `CopyPair` of exactly `{ en, sr }` — a type that **cannot hold a third language**, by
 *    construction. It is now a map keyed by language, with `sr` (Serbian **Latin**) as the one special
 *    key, because `sr-Cyrl` is derived from it rather than stored.
 *
 * @module apps/api/src/common/i18n
 */

import { toCyrillic } from '@finmate/domain';

/**
 * A language identifier for server-composed copy.
 *
 * Deliberately a bare `string` rather than a union (ADR-044): the set of languages is data, and a union
 * made "add German" a type change in the API. An unrecognised code is not an error — {@link tr} falls
 * back to English for it.
 */
export type CopyLocale = string;

/**
 * A string in one or more languages.
 *
 * `en` is required and is the fallback. Every other key is a language code; `sr` holds Serbian **Latin**
 * and is the source `sr-Cyrl` is transliterated from at render time.
 */
export interface CopyMap {
  readonly en: string;
  readonly sr?: string;
  readonly [locale: string]: string | undefined;
}

/** The same, for copy that varies by more than a value — a list, a label set, a function. */
export type CopyVariants<T> = {
  readonly en: T;
  readonly sr?: T;
  readonly [locale: string]: T | undefined;
};

/**
 * Map a BCP-47 tag to the language its copy is written in.
 *
 * Anything Serbian is Serbian — and the *script subtag* decides which catalogue, so `sr`, `sr-RS` and
 * `sr-Latn-RS` are Latin while `sr-Cyrl` and `sr-Cyrl-RS` are Cyrillic. Collapsing `sr-RS` to whichever
 * Serbian catalogue happens to be first is how a Cyrillic reader gets Latin. The web client's
 * `findLocale` applies the identical rule, deliberately, so a screen and a notification cannot
 * disagree about what language the reader is in.
 *
 * Everything else resolves to its **primary language subtag**: `de-DE` and `de-AT` are both `de`,
 * `es-419` is `es`. Returning the language rather than `'en'` is the ADR-044 fix — the old collapse is
 * what stored a German reader as English.
 */
export function resolveCopyLocale(tag: string | null | undefined, fallback: CopyLocale = 'en'): CopyLocale {
  if (tag === null || tag === undefined) return fallback;
  const lower = tag.trim().toLowerCase();
  if (lower.length === 0) return fallback;

  const [primary, ...rest] = lower.split('-');
  if (primary === undefined || primary.length === 0) return fallback;
  if (primary === 'sr') return rest.includes('cyrl') ? 'sr-Cyrl' : 'sr-Latn';
  return primary;
}

/**
 * The keys in a copy map that hold a locale's strings, most specific first.
 *
 * Serbian is the special case: it is stored under `sr`, so both Serbian locales read that key and
 * `sr-Cyrl` transliterates afterwards.
 */
function copyKeys(locale: string): readonly string[] {
  const lower = locale.trim().toLowerCase();
  if (lower === 'sr' || lower === 'sr-latn' || lower.startsWith('sr-latn-')) return ['sr'];
  if (lower === 'sr-cyrl' || lower.startsWith('sr-cyrl-')) return ['sr'];
  const primary = lower.split('-')[0] ?? '';
  return lower === primary ? [primary] : [lower, primary];
}

/** True when this locale's script is Cyrillic, and so its copy must be transliterated. */
function isCyrillicScript(locale: string): boolean {
  const lower = locale.trim().toLowerCase();
  return lower === 'sr-cyrl' || lower.startsWith('sr-cyrl-');
}

/** Pick the variant for a locale: its own language, else its primary subtag, else English. */
function select<T>(locale: string, variants: CopyVariants<T>): T {
  for (const key of copyKeys(locale)) {
    const value = variants[key];
    if (value !== undefined) return value;
  }
  return variants.en;
}

/** Pick the variant for a locale, transliterating a Serbian string when the locale is Cyrillic. */
export function tr(
  locale: CopyLocale,
  map: CopyMap,
  params?: Readonly<Record<string, string | number>>,
): string {
  const raw = select(locale, map);
  // Transliterate the **template**, so `{category}` is still a placeholder here and the user's own
  // Category name is interpolated untouched afterwards.
  const template = isCyrillicScript(locale) ? toCyrillic(raw) : raw;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Pick the variant for a locale when the value is not a plain string (a list, a map).
 *
 * Cyrillic is *not* derived here — transliterating a structured value is each string's own job, through
 * {@link tr}. This returns the Serbian variant unchanged for both Serbian locales.
 */
export function pick<T>(locale: CopyLocale, variants: CopyVariants<T>): T {
  return select(locale, variants);
}

/**
 * The locale handed to `Intl` for money formatting *inside server copy*.
 *
 * It follows the copy's own language rather than the raw tag, so a Serbian sentence cannot contain an
 * amount grouped for English — the mismatch docs/15 records as the reason `locale` is passed at all.
 * An unrecognised language is passed through: `Intl` accepts a bare language subtag, and formatting in
 * the reader's own conventions is the point.
 */
export function copyIntlLocale(locale: CopyLocale): string {
  switch (locale.trim().toLowerCase()) {
    case 'sr-latn':
      return 'sr-Latn-RS';
    case 'sr-cyrl':
      return 'sr-Cyrl-RS';
    case 'en':
      return 'en-US';
    default:
      return locale;
  }
}
