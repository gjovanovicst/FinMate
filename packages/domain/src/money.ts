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

function assertSameCurrency(a: { currency: CurrencyCode }, b: { currency: CurrencyCode }): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `Currency mismatch: ${a.currency} vs ${b.currency}. ` +
        `v1 has one ledger currency per Household (ADR-011).`,
    );
  }
}

/**
 * A **Balance**: a signed monetary value.
 *
 * Why this is separate from {@link Money}, and why the separation matters:
 *
 * ADR-003 says `amount_minor` is always non-negative and direction is carried by `kind`. That rule
 * is about **Transaction amounts** — recording `-500 RSD` as an expense would be a sign bug, and
 * `subtractMoney` refuses it.
 *
 * A **Balance is a different quantity**: it is the derived sum of many movements, and it can
 * legitimately be negative. An account can be overdrawn, a credit card starts at zero and goes
 * negative, and a user who records an opening balance lower than what they have already spent will
 * produce a negative figure.
 *
 * Conflating the two produced a real defect: computing a balance with `subtractMoney` threw, and
 * because the Accounts screen computes every balance in one query, a single overdrawn account took
 * down the whole screen with an INTERNAL error. Verified end to end before this fix.
 *
 * Rule of thumb: if a human typed the number, it is `Money`. If the system derived it, it may be a
 * `Balance`.
 */
export interface Balance {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

/** Construct a `Balance`. Negative values are allowed; that is the whole point. */
export function balance(amountMinor: bigint, currency: CurrencyCode): Balance {
  if (typeof amountMinor !== 'bigint') {
    throw new MoneyError(
      `Balance amountMinor must be a bigint (minor units), received ${typeof amountMinor}. See ADR-003.`,
    );
  }
  if (!(currency in MINOR_UNITS_PER_MAJOR)) {
    throw new MoneyError(`Unsupported currency: ${currency}`);
  }
  return Object.freeze({ amountMinor, currency });
}

/** A zero Balance in the given currency. The identity for balance arithmetic. */
export function zeroBalance(currency: CurrencyCode): Balance {
  return balance(0n, currency);
}

/** Promote a non-negative `Money` amount into a `Balance`. */
export function toBalance(amount: Money): Balance {
  return balance(amount.amountMinor, amount.currency);
}

/** Signed addition. Two balances of the same currency. */
export function addBalance(a: Balance, b: Balance): Balance {
  assertSameCurrency(a, b);
  return balance(a.amountMinor + b.amountMinor, a.currency);
}

/** Signed subtraction. The result MAY be negative — unlike `subtractMoney`. */
export function subtractBalance(a: Balance, b: Balance): Balance {
  assertSameCurrency(a, b);
  return balance(a.amountMinor - b.amountMinor, a.currency);
}

/**
 * Apply signed movements to a balance.
 *
 * `income` adds and `expense` subtracts, which is the shape every ledger rollup needs. Direction is
 * applied here, once, so no call site has to remember the sign convention.
 */
export function applyMovement(current: Balance, kind: 'INCOME' | 'EXPENSE', amount: Money): Balance {
  assertSameCurrency(current, amount);
  return kind === 'INCOME'
    ? balance(current.amountMinor + amount.amountMinor, current.currency)
    : balance(current.amountMinor - amount.amountMinor, current.currency);
}

/** Format a Balance for display, including a leading minus where the value is negative. */
export function formatBalance(value: Balance, locale = 'sr-Latn-RS'): string {
  const exponent = MINOR_UNITS_PER_MAJOR[value.currency];
  if (exponent === undefined) throw new MoneyError(`Unsupported currency: ${value.currency}`);
  const scale = Number(exponent);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: scale === 1 ? 0 : 2,
  }).format(Number(value.amountMinor) / scale);
}
