import { MINOR_UNITS_PER_MAJOR } from '@finmate/domain';

/**
 * Currency names, in the reader's language.
 *
 * `Intl.DisplayNames` is CLDR's own currency-name table, so `EUR` reads as *Euro* in English, *evro* in
 * Serbian Latin, *евро* in Serbian Cyrillic, *Währung*… rather than as a bare code — and, crucially,
 * without hand-translating sixty currency names into six catalogues (ADR-045).
 *
 * That matters beyond effort: a hand-written table is sixty strings per language that no test can
 * validate and that silently go stale, whereas this follows the same CLDR data that formats the amounts.
 */

/** Currencies a Household's ledger may be kept in, alphabetical by code. */
export const SUPPORTED_CURRENCIES: readonly string[] = Object.freeze(
  Object.keys(MINOR_UNITS_PER_MAJOR).sort(),
);

/**
 * The name of a currency in `locale`, falling back to the code itself.
 *
 * The fallback is the important part: `Intl.DisplayNames` can throw on a malformed tag, and an unknown
 * currency resolves to `undefined`. A select that renders `undefined` beside every amount is worse than
 * one that renders `EUR`.
 */
export function currencyDisplayName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** `"EUR — Euro"`: the code a person recognises, and the name that explains it. */
export function currencyOptionLabel(code: string, locale: string): string {
  const name = currencyDisplayName(code, locale);
  return name === code ? code : `${code} — ${name}`;
}
