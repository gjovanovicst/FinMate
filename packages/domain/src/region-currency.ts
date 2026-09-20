/**
 * The ledger currency a new Household should start in (ADR-045).
 *
 * ADR-011 keeps **one ledger currency per Household**, and until ADR-045 the code simply wrote `'RSD'`
 * at signup. That was right for a Serbia-first product and wrong for an international one: a Household
 * in Berlin was born with a dinar ledger and had to be corrected by hand, and nothing on the signup
 * screen ever asked.
 *
 * So the currency is *chosen* — the client pre-fills it from the reader's own locale and the person
 * confirms. This module is the "pre-fill" half: a region → currency table plus a locale resolver, kept
 * in the domain package because both the client (to pre-fill the form) and the server (to validate, and
 * to default a client that sends no currency) need the same answer.
 *
 * It deliberately carries **no** dependency on `Intl.NumberFormat`: it is pure data plus
 * `Intl.Locale.maximize()`, which resolves a bare language tag (`de`) to its likely region (`DE`) using
 * CLDR. That maximisation is what makes `navigator.language` useful here — Chrome reports `de`, not
 * `de-DE`, for most German users.
 *
 * @module @finmate/domain
 */

import { DEFAULT_LEDGER_CURRENCY, isSupportedCurrency, type CurrencyCode } from './money';

/**
 * Currency by ISO-3166 alpha-2 region.
 *
 * Only regions whose currency this build supports appear; anything else resolves to `null` and the
 * caller falls back. The list covers the markets the product targets plus the majors — the same set as
 * `MINOR_UNITS_PER_MAJOR` (ADR-045), so a Household can never be created in a currency the ledger
 * cannot keep.
 */
export const CURRENCY_BY_REGION: Readonly<Record<string, CurrencyCode>> = Object.freeze({
  // Balkans and wider Europe
  RS: 'RSD',
  ME: 'EUR',
  BA: 'BAM',
  MK: 'MKD',
  AL: 'ALL',
  BG: 'BGN',
  RO: 'RON',
  HR: 'EUR',
  SI: 'EUR',
  DE: 'EUR',
  AT: 'EUR',
  FR: 'EUR',
  ES: 'EUR',
  IT: 'EUR',
  PT: 'EUR',
  NL: 'EUR',
  BE: 'EUR',
  IE: 'EUR',
  FI: 'EUR',
  GR: 'EUR',
  SK: 'EUR',
  EE: 'EUR',
  LV: 'EUR',
  LT: 'EUR',
  LU: 'EUR',
  MT: 'EUR',
  CY: 'EUR',
  GB: 'GBP',
  CH: 'CHF',
  SE: 'SEK',
  NO: 'NOK',
  DK: 'DKK',
  PL: 'PLN',
  CZ: 'CZK',
  HU: 'HUF',
  IS: 'ISK',
  MD: 'MDL',
  UA: 'UAH',
  TR: 'TRY',
  // Americas
  US: 'USD',
  CA: 'CAD',
  MX: 'MXN',
  BR: 'BRL',
  AR: 'ARS',
  CL: 'CLP',
  CO: 'COP',
  PE: 'PEN',
  // Asia-Pacific
  JP: 'JPY',
  CN: 'CNY',
  KR: 'KRW',
  IN: 'INR',
  ID: 'IDR',
  MY: 'MYR',
  SG: 'SGD',
  HK: 'HKD',
  TW: 'TWD',
  TH: 'THB',
  PH: 'PHP',
  VN: 'VND',
  AU: 'AUD',
  NZ: 'NZD',
  PK: 'PKR',
  BD: 'BDT',
  // Middle East, Africa
  AE: 'AED',
  SA: 'SAR',
  QA: 'QAR',
  KW: 'KWD',
  BH: 'BHD',
  OM: 'OMR',
  JO: 'JOD',
  IL: 'ILS',
  EG: 'EGP',
  ZA: 'ZAR',
  NG: 'NGN',
  KE: 'KES',
  MA: 'MAD',
  TN: 'TND',
  GH: 'GHS',
  TZ: 'TZS',
  UG: 'UGX',
});

/** The currency for a region, or `null` when the build does not support one for it. */
export function currencyForRegion(region: string | null | undefined): CurrencyCode | null {
  if (region === null || region === undefined) return null;
  const currency = CURRENCY_BY_REGION[region.trim().toUpperCase()];
  return currency !== undefined && isSupportedCurrency(currency) ? currency : null;
}

/**
 * The region a locale tag implies, using CLDR's own likely-subtags data.
 *
 * `Intl.Locale.maximize()` is what turns `de` into `de-Latn-DE` — the browser reports a bare language
 * for most readers, so reading a region out of the raw tag would come up empty far more often than not.
 * Returns `null` when maximisation cannot produce a region (a tag like `en` maximises to `en-Latn-US`,
 * so an English speaker does resolve; a constructed or unknown one may not).
 */
export function regionForLocale(tag: string | null | undefined): string | null {
  if (tag === null || tag === undefined || tag.trim().length === 0) return null;
  try {
    const region = new Intl.Locale(tag.trim()).maximize().region;
    return region ?? null;
  } catch {
    // `Intl.Locale` throws on a malformed tag; an unparseable tag is simply "no suggestion".
    return null;
  }
}

/**
 * The currency to pre-fill for a reader, from whatever their environment reports.
 *
 * The **fallback is deliberate and is not a recommendation**: a reader whose region has no supported
 * currency gets the product's default rather than a silent guess, and confirms it on the signup form.
 */
export function suggestCurrencyForLocale(
  tag: string | null | undefined,
  fallback: CurrencyCode = DEFAULT_LEDGER_CURRENCY,
): CurrencyCode {
  return currencyForRegion(regionForLocale(tag)) ?? fallback;
}
