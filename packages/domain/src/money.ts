/**
 * Money — the foundation of the ledger.
 *
 * **ADR-003 is non-negotiable:** money is an integer count of minor units plus an ISO-4217
 * currency code. Never a float, never a `number`, not even transiently. `2.000 RSD` is
 * `200000n`, because `1 RSD = 100 para`.
 *
 * Two invariants this module exists to protect:
 *   - `amountMinor` is always **non-negative**. Direction is carried by `kind`
 *     (`EXPENSE` / `INCOME`), never by a sign. This kills an entire class of sign bugs.
 *   - Arithmetic across two different currencies is a programming error, not a
 *     conversion opportunity (ADR-011: one ledger currency per Household in v1).
 *
 * SCOPE NOTE: this is the *seed* of the value object, added with the Phase 0 skeleton so the
 * toolchain (strict TS + vitest + boundary lint) is proven end to end. Task 1.1.1 completes it
 * with parsing, allocation/rounding for splits (I-1), and locale formatting.
 *
 * @module @finmate/domain
 */

/** An ISO-4217 currency code, e.g. `'RSD'`. */
export type CurrencyCode = string;

/** An integer count of minor units (para for RSD). Always non-negative. */
export type MinorUnits = bigint;

/**
 * Minor units per major unit for the currencies v1 supports.
 *
 * This is deliberately a lookup rather than a constant: JPY has 0 decimals and KWD has 3, so a
 * hardcoded 100 would be wrong the moment multi-currency lands. v1 is RSD-only (ADR-011).
 */
export const MINOR_UNITS_PER_MAJOR: Readonly<Record<string, bigint>> = Object.freeze({
  RSD: 100n,
  EUR: 100n,
  USD: 100n,
  JPY: 1n,
});

/** The default ledger currency for a new Household. */
export const DEFAULT_LEDGER_CURRENCY: CurrencyCode = 'RSD';

/** Thrown when money is combined across currencies, or given an invalid amount. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export interface Money {
  readonly amountMinor: MinorUnits;
  readonly currency: CurrencyCode;
}

/** Construct `Money`, rejecting floats, negatives and unknown currencies. */
export function money(amountMinor: bigint, currency: CurrencyCode): Money {
  if (typeof amountMinor !== 'bigint') {
    // A `number` here means a float leaked into the money path. Fail loudly.
    throw new MoneyError(
      `amountMinor must be a bigint (minor units), received ${typeof amountMinor}. See ADR-003.`,
    );
  }
  if (amountMinor < 0n) {
    throw new MoneyError(
      `amountMinor must be non-negative; direction is carried by kind, not a sign (ADR-003).`,
    );
  }
  if (!(currency in MINOR_UNITS_PER_MAJOR)) {
    throw new MoneyError(`Unsupported currency: ${currency}`);
  }
  return Object.freeze({ amountMinor, currency });
}

/** Sum two amounts of the **same** currency. */
export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

/** Subtract `b` from `a`, refusing to go negative — that would be a sign bug, not a result. */
export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  if (b.amountMinor > a.amountMinor) {
    throw new MoneyError(
      `subtractMoney would produce a negative amount (${a.amountMinor} - ${b.amountMinor}). ` +
        `Model the reverse direction as its own Transaction instead (ADR-003).`,
    );
  }
  return money(a.amountMinor - b.amountMinor, a.currency);
}

/** Structural equality on both amount and currency. */
export function equalsMoney(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

/**
 * Format for display. Grouping uses the locale's separator; Serbian uses `.` for thousands
 * and `,` for decimals (see docs/04 §3.1 on the parsing side).
 */
export function formatMoney(m: Money, locale = 'sr-Latn-RS'): string {
  const exponent = MINOR_UNITS_PER_MAJOR[m.currency];
  if (exponent === undefined) throw new MoneyError(`Unsupported currency: ${m.currency}`);
  const scale = Number(exponent);
  const major = Number(m.amountMinor) / scale;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: scale === 1 ? 0 : 2,
  }).format(major);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `Currency mismatch: ${a.currency} vs ${b.currency}. ` +
        `v1 has one ledger currency per Household (ADR-011).`,
    );
  }
}
