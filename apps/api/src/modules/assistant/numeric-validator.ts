/**
 * The numeric validator — docs/06 §8.5, docs/04 §10, ADR-017.
 *
 * > **Guarantee:** an `AssistantAnswer` returned with `narrationMode = "LLM"` contains **no numeral
 * > that is not present in its own `facts` payload.**
 *
 * ## A numeral is compared with its **sign**
 *
 * Since the totals became signed Balances (a month that spent less than the last one, a budget past
 * its limit, an overdrawn account), comparing digits alone was no longer enough: `5.000,00` and
 * `-5.000,00` tokenise identically, so a sign-blind check would accept an answer that states the
 * **opposite direction**. Each numeral therefore carries the sign it was written with and must match
 * a fact that was written the same way — see {@link isNegated} for what counts as a sign, and why an
 * en dash and an ISO date's hyphens do not.
 *
 * ## What this file is, and what it is not
 *
 * It is the *check*, not the enforcement. The enforcement — regenerate once with a stricter
 * instruction, then fall back to a wholly deterministic rendering — lives in
 * `assistant.service.ts`, because a fallback needs the template renderer and the caller's intent.
 * Keeping the check pure means it can be run over any string, including a template answer, and that
 * the tool that guards the model is itself unit-tested rather than trusted.
 *
 * ## Why a numeral is compared as a **value**, not as a string
 *
 * The narrator is told to reproduce the formatted strings verbatim, and the factories mostly obey.
 * But `27.450,00 RSD` and `27.450 RSD` are the same figure, and `0,00 RSD` versus `0 RSD` is a
 * formatting difference rather than a lie. So each numeral is canonicalised to a decimal value with
 * the locale's own separators (read from `Intl`, never hardcoded) and compared against the
 * canonicalised values of the payload. What the validator *does* refuse is a different magnitude —
 * which is exactly the hallucination class docs/04 §10 calls "the majority of plausible-sounding
 * finance hallucinations".
 *
 * ## What is deliberately allowed
 *
 * The payload's `formatted` strings, the **locale-formatted** form of every machine value (never the
 * bare minor-unit digits — `2745000` for `27.450,00` is wrong by 100×, and allowing it would let a
 * factor-of-100 error through), the transaction count, and the date components of the period. A date
 * component is a single digit — `1` and `30` of a monthly range — so this guard is not absolute for
 * single-digit numerals; §8.5 says so by listing `periodStart`/`periodEnd` as allowed sources.
 *
 * @module apps/api/src/modules/assistant
 */

import { balance, formatBalance, type CurrencyCode } from '@finmate/domain';

/**
 * The part of an assembled answer the validator may cite.
 *
 * Structural rather than an import of `AssemblyResult`, so this module stays pure and so a test can
 * hand it a payload without building a database row.
 */
export interface NumericPayload {
  readonly formatted: Readonly<Record<string, string>>;
  readonly rows: readonly { readonly label?: string; readonly value: string; readonly formatted: string }[];
  readonly totals: readonly {
    readonly label?: string;
    readonly money: { readonly amountMinor: string; readonly currency: string };
    readonly formatted: string;
  }[];
  readonly transactionCount: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly ledgerCurrency: string;
}

/** One numeral found in a piece of text. */
export interface Numeral {
  /** Exactly as written, e.g. `27.450,00`. */
  readonly raw: string;
  /** The canonical decimal value, e.g. `27450` — or `-27450` when the text wrote it as a negative. */
  readonly value: string;
}

export interface NumericValidation {
  readonly ok: boolean;
  /** The numerals that could not be accounted for, as written and deduplicated. */
  readonly unaccounted: readonly string[];
  /** How many numerals were examined — the denominator the fabricated-numeral rate divides by. */
  readonly checked: number;
}

/**
 * A numeral token: a digit run that may contain group separators and one decimal part.
 *
 * It must **start and end with a digit**, so a trailing sentence period is not swallowed, and the
 * separator class is explicit rather than `\D`, so the en dash in `1–31` splits the range into two
 * numerals instead of producing one unparseable token.
 */
const NUMERAL = /(?:\p{Nd}[\p{Nd}\s.,'\u00a0\u202f\u2009]*\p{Nd}|\p{Nd})/gu;

interface Separators {
  readonly group: string;
  readonly decimal: string;
}

/** The locale's own separators, read from `Intl` so a new locale needs no code change. */
export function separatorsFor(locale: string, sample = 12_345.6): Separators {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(sample);
    const group = parts.find((part) => part.type === 'group')?.value ?? ',';
    const decimal = parts.find((part) => part.type === 'decimal')?.value ?? '.';
    return { group, decimal };
  } catch {
    // An unparseable locale tag is not worth throwing over: docs/06 §4.4 makes `locale` a client
    // string, and the caller validates it. Falling back keeps the validator total.
    return { group: ',', decimal: '.' };
  }
}

/**
 * Canonicalise one numeral token to a comparable decimal value, or `null` when it cannot be read.
 *
 * `null` means **unaccounted**: a numeral nobody can interpret is not a numeral the payload
 * authorised, and treating it as "probably fine" is how a validator becomes decoration.
 */
export function canonicaliseNumeral(token: string, locale: string): string | null {
  const { group, decimal } = separatorsFor(locale);

  // A space is never part of a numeral's value: `1 234,00` and `1.234,00` are the same figure.
  let text = token.replace(/\s/g, '');
  if (group.length > 0 && group !== decimal) text = text.split(group).join('');
  if (decimal !== '.') {
    // Exactly one decimal marker, or the token is ambiguous (`1,234,567` under a comma-decimal
    // locale could be two different numbers) and is refused rather than guessed at.
    const first = text.indexOf(decimal);
    if (first !== -1 && text.indexOf(decimal, first + 1) !== -1) return null;
    text = text.replace(decimal, '.');
  }
  // `\p{Nd}` rather than `\d`: a locale that writes Arabic-Indic digits must be able to validate its
  // own payload, and the two sides then compare as the same string. A numeral in a *different* digit
  // set from the payload's is therefore still unaccounted — which is what we want.
  if (!/^\p{Nd}+(?:\.\p{Nd}+)?$/u.test(text)) return null;

  const [whole = '', fraction = ''] = text.split('.');
  // Leading zeros are **kept**: `09` is a month in a date, and folding it to `9` would make the
  // payload's own date components unmatched. Trailing fraction zeros go, so `27.450,00` and
  // `27.450` are the one figure they are.
  const trimmedFraction = fraction.replace(/0+$/, '');
  return trimmedFraction.length === 0 ? whole : `${whole}.${trimmedFraction}`;
}

/**
 * The numeral tokens in a piece of text, with where they start.
 *
 * Exported because "what counts as a numeral" is one definition with two readers: this validator, and
 * the planner's extraction of a **savings target** from a question (F-30). A second regex there is how
 * `20.000` ends up meaning two different things in the same answer.
 */
export function findNumeralTokens(text: string): readonly { readonly raw: string; readonly index: number }[] {
  return [...text.matchAll(NUMERAL)].map((match) => ({ raw: match[0], index: match.index ?? 0 }));
}

/**
 * Whether the numeral starting at `index` is written as a **negative**.
 *
 * This is the half of the guarantee that a sign-blind comparison cannot give: a total may be negative
 * (`Income − spending`, a period-over-period change, an overspend, an overdraft), and without this the
 * model could answer "you spent 5.000,00 RSD more than last month" while the fact said
 * `-5.000,00 RSD`. Both tokenise to the same digits, so the old check passed and **the answer was
 * wrong by direction** — the failure class ADR-017 exists to prevent, and one that gets *worse* the
 * moment a negative figure becomes renderable at all.
 *
 * Two deliberate restrictions:
 *
 *   - **Only `-` and `−` (U+2212) count.** The en dash `–` is this codebase's *range* separator
 *     (`1–31`, `2026-09-01 – 2026-09-30`), and reading it as a sign would make every period range a
 *     pair of negative numbers.
 *   - **A hyphen with a digit before it is a separator, not a sign.** That is what keeps an ISO date
 *     (`2026-09-01`, tokenised as `2026`, `09`, `01`) and a bare range (`1-31`) from becoming
 *     `2026`, `-9`, `-1` — which would have dropped the payload's own date components out of the
 *     allowed set and sent every trend answer to the template fallback.
 */
function isNegated(text: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(text[cursor] as string)) cursor -= 1;
  if (cursor < 0) return false;
  const character = text[cursor] as string;
  if (character !== '-' && character !== '\u2212') return false;
  const before = cursor > 0 ? (text[cursor - 1] as string) : '';
  return !/\p{Nd}/u.test(before);
}

/** Every numeral in a piece of text, in order, with its canonical value (`null` when unreadable). */
export function extractNumerals(text: string, locale: string): readonly { raw: string; value: string | null }[] {
  return findNumeralTokens(text).map((token) => {
    const unsigned = canonicaliseNumeral(token.raw, locale);
    if (unsigned === null) return { raw: token.raw, value: null };
    // `-0` is `0`: a facts payload never writes one, and an answer that does is not a different value.
    const negative = unsigned !== '0' && isNegated(text, token.index);
    return { raw: token.raw, value: negative ? `-${unsigned}` : unsigned };
  });
}

/** `formatBalance` for a machine value that arrived as minor units, or `null` when it cannot be one. */
function formattedMinor(minor: string, currency: string, locale: string): string | null {
  try {
    // The **signed** formatter: a total is a derived Balance and may be negative (see
    // `fact-assembly.service.ts`). `formatMoney` would throw on one, so the machine value of a signed
    // total would have been silently dropped from the allowed set — leaving only its formatted string,
    // which is how a correctly signed answer could have been rejected and an unsigned one accepted.
    return formatBalance(balance(BigInt(minor), currency as CurrencyCode), locale);
  } catch {
    return null;
  }
}

/**
 * The numerals a payload authorises.
 *
 * The two entries that are easy to get wrong: a machine value is allowed **after locale formatting**
 * (not as its bare digits — see the module docstring), and the date components are allowed both as
 * they are written in ISO form (`2026`, `09`, `01`) and as the *day endpoints* a person writes
 * (`1`, `30`), because "1–30 September" is a true statement about the range and refusing it would
 * send every trend answer to the template fallback for no gain in safety.
 */
export function allowedNumerals(payload: NumericPayload, locale: string): ReadonlySet<string> {
  const allowed = new Set<string>();
  const add = (text: string | null | undefined): void => {
    if (text === null || text === undefined) return;
    for (const numeral of extractNumerals(text, locale)) {
      if (numeral.value !== null) allowed.add(numeral.value);
    }
  };

  for (const value of Object.values(payload.formatted)) add(value);
  for (const row of payload.rows) {
    add(row.formatted);
    // A label is part of the facts payload, and a Household may well have named a Category `Stan 2`.
    add(row.label);
    add(formattedMinor(row.value, payload.ledgerCurrency, locale));
  }
  for (const total of payload.totals) {
    add(total.label);
    add(total.formatted);
    add(formattedMinor(total.money.amountMinor, total.money.currency, locale));
  }

  add(String(payload.transactionCount));
  add(new Intl.NumberFormat(locale).format(payload.transactionCount));

  for (const day of [payload.periodStart, payload.periodEnd]) {
    add(day);
    const dayOfMonth = day.slice(8, 10);
    if (/^\d{2}$/.test(dayOfMonth)) add(String(Number(dayOfMonth)));
  }
  add(payload.ledgerCurrency);

  return allowed;
}

/**
 * Check a narration against the payload it was given.
 *
 * @returns every numeral it used that the payload does not authorise — empty means the narration
 *          invented nothing.
 */
export function validateNarration(
  text: string,
  payload: NumericPayload,
  locale: string,
): NumericValidation {
  const allowed = allowedNumerals(payload, locale);
  const unaccounted: string[] = [];
  const seen = new Set<string>();

  const numerals = extractNumerals(text, locale);
  for (const numeral of numerals) {
    if (numeral.value !== null && allowed.has(numeral.value)) continue;
    if (seen.has(numeral.raw)) continue;
    seen.add(numeral.raw);
    unaccounted.push(numeral.raw);
  }

  return { ok: unaccounted.length === 0, unaccounted, checked: numerals.length };
}
