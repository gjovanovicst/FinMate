import { describe, expect, it } from 'vitest';

import { isSupportedCurrency, MINOR_UNITS_PER_MAJOR } from './money';
import {
  CURRENCY_BY_REGION,
  currencyForRegion,
  regionForLocale,
  suggestCurrencyForLocale,
} from './region-currency';

/**
 * Choosing a Household's currency (ADR-045).
 *
 * The failure this prevents is specific: signing up in Berlin used to write `ledger_currency = 'RSD'`,
 * because the value was a literal rather than a question. These tests pin both halves — the region
 * table, and the locale → region step that makes `navigator.language` usable (a browser reports `de`,
 * not `de-DE`).
 */
describe('currencyForRegion', () => {
  it('maps the markets the product targets', () => {
    expect(currencyForRegion('RS')).toBe('RSD');
    expect(currencyForRegion('DE')).toBe('EUR');
    expect(currencyForRegion('GB')).toBe('GBP');
    expect(currencyForRegion('CH')).toBe('CHF');
    expect(currencyForRegion('PL')).toBe('PLN');
    expect(currencyForRegion('EG')).toBe('EGP');
    expect(currencyForRegion('KW')).toBe('KWD');
  });

  it('is case-insensitive and tolerates a null region', () => {
    expect(currencyForRegion('de')).toBe('EUR');
    expect(currencyForRegion(' gb ')).toBe('GBP');
    expect(currencyForRegion(null)).toBeNull();
    expect(currencyForRegion(undefined)).toBeNull();
    expect(currencyForRegion('ZZ')).toBeNull();
  });

  it('never maps a region to a currency the ledger cannot keep', () => {
    // The two tables are edited by hand, so this is the link between them: a region pointing at an
    // unsupported currency would create a Household whose every money operation throws.
    const unsupported = Object.entries(CURRENCY_BY_REGION)
      .filter(([, currency]) => !isSupportedCurrency(currency))
      .map(([region, currency]) => `${region}->${currency}`);
    expect(unsupported).toEqual([]);
    // ...and the reverse sanity check: the table is not empty and every key looks like a region.
    const keys = Object.keys(CURRENCY_BY_REGION);
    expect(keys.length).toBeGreaterThan(50);
    expect(keys.filter((key) => !/^[A-Z]{2}$/.test(key))).toEqual([]);
  });

  it('only maps currencies this build knows a minor unit for', () => {
    for (const currency of Object.values(CURRENCY_BY_REGION)) {
      expect(MINOR_UNITS_PER_MAJOR[currency], `${currency} has no minor unit`).toBeDefined();
    }
  });
});

describe('regionForLocale', () => {
  it('resolves a bare language to its likely region, which is what a browser reports', () => {
    // Chrome sends `de`, not `de-DE`. Without maximisation the pre-fill would come up empty for almost
    // everyone and every Household would fall back to the product default.
    expect(regionForLocale('de')).toBe('DE');
    expect(regionForLocale('es')).toBe('ES');
    expect(regionForLocale('fr')).toBe('FR');
    expect(regionForLocale('ja')).toBe('JP');
    expect(regionForLocale('ar')).toBe('EG');
  });

  it('respects an explicit region and script', () => {
    expect(regionForLocale('de-AT')).toBe('AT');
    expect(regionForLocale('en-GB')).toBe('GB');
    expect(regionForLocale('sr-Latn-RS')).toBe('RS');
    expect(regionForLocale('pt-BR')).toBe('BR');
  });

  it('returns null rather than throwing for anything unusable', () => {
    expect(regionForLocale('xx')).toBeNull();
    expect(regionForLocale('')).toBeNull();
    expect(regionForLocale('   ')).toBeNull();
    expect(regionForLocale(null)).toBeNull();
    expect(regionForLocale('not a tag')).toBeNull();
  });
});

describe('suggestCurrencyForLocale', () => {
  it('pre-fills the reader their own currency', () => {
    expect(suggestCurrencyForLocale('de')).toBe('EUR');
    expect(suggestCurrencyForLocale('en-GB')).toBe('GBP');
    expect(suggestCurrencyForLocale('sr')).toBe('RSD');
    expect(suggestCurrencyForLocale('pl-PL')).toBe('PLN');
  });

  it('falls back to the product default rather than guessing, and honours an explicit fallback', () => {
    // The fallback is not a recommendation — it is what the reader sees pre-selected and confirms.
    expect(suggestCurrencyForLocale('xx')).toBe('RSD');
    expect(suggestCurrencyForLocale(null)).toBe('RSD');
    expect(suggestCurrencyForLocale('xx', 'EUR')).toBe('EUR');
  });
});
