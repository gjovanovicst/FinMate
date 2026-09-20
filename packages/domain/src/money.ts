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
 * Minor units per major unit, for every currency a Household's ledger may be kept in (ADR-045).
 *
 * This is deliberately a lookup rather than the constant `100`: JPY has no minor unit and KWD has
 * three, so a hardcoded hundred is wrong the day a second currency exists.
 *
 * **Why this is a static table and not derived from `Intl` at load.** `Intl` knows both the list of
 * currencies and their minor-unit counts, which is exactly the right source of truth — and building
 * the table from it costs **61 ms** (measured, 162 currencies × `Intl.NumberFormat`), which is startup
 * cost on the client's first-paint path. A money path also wants an answer that does not depend on the
 * runtime's CLDR build. So the data is static and the *correctness* is pinned by `money.spec.ts`, which
 * asserts every entry below against `Intl`'s own `maximumFractionDigits` — hand-written data that a
 * test checks against the authority, rather than data a test trusts.
 *
 * The set covers the markets the product targets plus the majors; a currency outside it is refused at
 * signup rather than accepted and then thrown on by `money()` at the first transaction.
 */
export const MINOR_UNITS_PER_MAJOR: Readonly<Record<string, bigint>> = Object.freeze({
  // Balkans and wider Europe
  RSD: 100n,
  EUR: 100n,
  GBP: 100n,
  CHF: 100n,
  SEK: 100n,
  NOK: 100n,
  DKK: 100n,
  PLN: 100n,
  CZK: 100n,
  HUF: 1n,
  RON: 100n,
  BGN: 100n,
  ISK: 1n,
  MKD: 100n,
  ALL: 1n,
  BAM: 100n,
  MDL: 100n,
  UAH: 100n,
  TRY: 100n,
  // Americas
  USD: 100n,
  CAD: 100n,
  MXN: 100n,
  BRL: 100n,
  ARS: 100n,
  CLP: 1n,
  COP: 1n,
  PEN: 100n,
  // Asia-Pacific
  JPY: 1n,
  CNY: 100n,
  KRW: 1n,
  INR: 100n,
  IDR: 1n,
  MYR: 100n,
  SGD: 100n,
  HKD: 100n,
  TWD: 100n,
  THB: 100n,
  PHP: 100n,
  VND: 1n,
  AUD: 100n,
  NZD: 100n,
  PKR: 1n,
  BDT: 100n,
  // Middle East, Africa
  AED: 100n,
  SAR: 100n,
  QAR: 100n,
  KWD: 1000n,
  BHD: 1000n,
  OMR: 1000n,
  JOD: 1000n,
  ILS: 100n,
  EGP: 100n,
  ZAR: 100n,
  NGN: 100n,
  KES: 100n,
  MAD: 100n,
  TND: 1000n,
  GHS: 100n,
  TZS: 100n,
  UGX: 1n,
});

/**
 * The default ledger currency for a new Household.
 *
 * It stays `RSD` because that is what existing Households hold and what a client that sends no currency
 * gets. It is a **fallback, not a policy**: signup takes the currency the client derived from the
 * reader's own locale (ADR-045), so a German Household is born in EUR rather than being corrected later.
 */
export const DEFAULT_LEDGER_CURRENCY: CurrencyCode = 'RSD';

/** The currency's minor-unit exponent, or throws when this build does not support it. */
export function minorUnitsPerMajor(currency: CurrencyCode): bigint {
  const exponent = MINOR_UNITS_PER_MAJOR[currency];
  if (exponent === undefined) throw new MoneyError(`Unsupported currency: ${currency}`);
  return exponent;
}

/**
 * Decimal places a currency is written with.
 *
 * Derived from the exponent rather than assumed: `100n` → 2, `1n` → 0, `1000n` → 3. The formatters below
 * used to hardcode `scale === 1 ? 0 : 2`, which silently rendered a Kuwaiti dinar to two places.
 */
export function fractionDigitsOf(currency: CurrencyCode): number {
  return minorUnitsPerMajor(currency).toString().length - 1;
}

/** True when a ledger can be kept in `currency`. Signup validates against this before creating one. */
export function isSupportedCurrency(currency: string): boolean {
  return currency in MINOR_UNITS_PER_MAJOR;
}

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
  if (!isSupportedCurrency(currency)) {
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
 *
 * `locale` is **required, with no default** (ADR-044). It used to default to `'sr-Latn-RS'`, which was
 * right when the product was Serbian-first and is a defect now: a default locale silently formats an
 * amount in a language and region nobody chose, and it does so *invisibly* — the number still looks
 * like a number. Requiring it makes every call site answer "whose number is this?" at compile time,
 * and the client's answer is always the active locale (`fm-money` → `I18nService.tag`).
 */
export function formatMoney(m: Money, locale: string): string {
  const exponent = minorUnitsPerMajor(m.currency);
  const scale = Number(exponent);
  const major = Number(m.amountMinor) / scale;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    // The currency's own digit count, not `scale === 1 ? 0 : 2` — that rendered KWD to two places.
    minimumFractionDigits: fractionDigitsOf(m.currency),
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
  if (!isSupportedCurrency(currency)) {
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

/**
 * Format a Balance for display, including a leading minus where the value is negative.
 *
 * `locale` is required for the same reason as {@link formatMoney}: see ADR-044.
 */
export function formatBalance(value: Balance, locale: string): string {
  const exponent = minorUnitsPerMajor(value.currency);
  const scale = Number(exponent);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: fractionDigitsOf(value.currency),
  }).format(Number(value.amountMinor) / scale);
}

/**
 * Split an amount into parts that **sum exactly to the original**.
 *
 * This is the algorithm that makes invariant I-1 hold: `sum(splits) == amount`. It is not
 * incidental — naive proportional splitting loses para to rounding, and a ledger where the splits do
 * not add up to the payment is a ledger nobody can trust.
 *
 * Largest-remainder (Hamilton) apportionment:
 *   1. give every part its floor share of the total;
 *   2. hand the remaining minor units out one at a time, largest fractional remainder first;
 *   3. break ties by index, so the result is deterministic and reproducible.
 *
 * Ratios are scaled to integers before any arithmetic, so **no float ever touches the money** even
 * though the ratios themselves are fractional (ADR-003).
 *
 * @param total  the amount to divide
 * @param ratios relative weights, e.g. `[1, 1, 2]`. Must be positive and not all zero.
 */
export function allocate(total: Money, ratios: readonly number[]): Money[] {
  if (ratios.length === 0) {
    throw new MoneyError('allocate requires at least one ratio.');
  }
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio < 0)) {
    throw new MoneyError('allocate ratios must be finite and non-negative.');
  }

  const SCALE = 1_000_000;
  const scaled = ratios.map((ratio) => BigInt(Math.round(ratio * SCALE)));
  const ratioTotal = scaled.reduce((sum, value) => sum + value, 0n);

  if (ratioTotal === 0n) {
    throw new MoneyError('allocate ratios sum to zero, so there is nothing to divide by.');
  }

  const shares: bigint[] = [];
  const remainders: { index: number; remainder: bigint }[] = [];
  let assigned = 0n;

  scaled.forEach((ratio, index) => {
    const numerator = total.amountMinor * ratio;
    const share = numerator / ratioTotal;
    shares.push(share);
    remainders.push({ index, remainder: numerator % ratioTotal });
    assigned += share;
  });

  // Distribute what rounding left behind. Never more than `ratios.length - 1` units, by construction.
  let leftover = total.amountMinor - assigned;
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );

  for (const { index } of remainders) {
    if (leftover <= 0n) break;
    shares[index] = shares[index]! + 1n;
    leftover -= 1n;
  }

  // A negative total cannot occur (Money is non-negative), but assert the invariant we promise
  // rather than assuming it.
  const sum = shares.reduce((acc, value) => acc + value, 0n);
  if (sum !== total.amountMinor) {
    throw new MoneyError(
      `allocate produced ${sum} minor units from ${total.amountMinor}; the parts must sum exactly.`,
    );
  }

  return shares.map((share) => money(share, total.currency));
}

/** Split into `parts` equal shares, distributing the remainder to the earliest parts. */
export function allocateEqually(total: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new MoneyError(`allocateEqually needs a positive whole number of parts, received ${parts}.`);
  }
  return allocate(total, Array.from({ length: parts }, () => 1));
}
