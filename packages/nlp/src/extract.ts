/**
 * Stage 1–2 extraction: turn one fragment into the `TransactionFragment` docs/04 §3.2 defines.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §3.
 *
 * Two rules shape everything here:
 *
 * 1. **Money is never a float, and this module does not parse it.** It locates the numeric token and
 *    delegates to `@finmate/domain`'s `parseAmount`, so there is exactly one Serbian amount parser in
 *    the product (ADR-003). The ambiguity `parseAmount` reports is propagated, never re-decided.
 * 2. **`today` is injected.** "juče" is only meaningful in the Household's timezone (docs/03 §3.2),
 *    and a parser that reads the clock is untestable.
 *
 * @module @finmate/nlp
 */

import {
  compareLocalDates,
  localDate,
  parseAmount,
  type CurrencyCode,
  type LocalDate,
} from '@finmate/domain';

import { foldForMatching } from './transliterate';
import { foldTokens, normalizeFragment } from './normalize';
import { segmentFragments } from './segment';

/** Inputs the parser cannot invent: the Household ledger currency and the current local day. */
export interface ExtractOptions {
  /** The Household ledger currency, used when the text names none. */
  readonly currency: CurrencyCode;
  /** The current day in the Household timezone, e.g. `'2026-09-14'`. */
  readonly today: LocalDate;
}

/**
 * One transaction fragment, per docs/04 §3.2.
 *
 * `currency === null` means "inherit the Household ledger currency" — a fragment that names no
 * currency must not be assumed to be in one.
 */
export interface TransactionFragment {
  rawText: string;
  amountMinor: bigint | null;
  currency: string | null;
  kind: 'EXPENSE' | 'INCOME' | 'UNKNOWN';
  occurredOn: string | null;
  description: string;
  tokens: string[];
  candidates: { amountMinor: bigint; reason: string }[];
  /**
   * Extra field beyond docs/04 §3.2, documented here so the interface cannot drift silently.
   *
   * §3.1 says a negation/refund word (`vraćeno`, `storno`, `refund`) must **flag for user
   * confirmation rather than guessing a sign**, but `kind` has no arm for "direction unknown". Rather
   * than overload `UNKNOWN` — which means "no direction signal at all" — the flag carries the
   * uncertainty and `kind` keeps its own meaning. A caller that ignores the flag is making a
   * direction choice the docs asked it not to make.
   */
  needsDirectionConfirmation: boolean;
}

/**
 * Words that bias direction to INCOME (docs/04 §3.1), stored folded. `primljen*` is included because
 * §3.1 names the phrase `rata kredita primljena`, not the lemma.
 */
export const INCOME_MARKERS: readonly string[] = Object.freeze([
  'plata',
  'penzija',
  'uplata',
  'primio',
  'primila',
  'primljen',
  'primljena',
  'primljeno',
  'refundacija',
  'povracaj',
  'povrat',
  'honorar',
]);

/** Words that make the sign uncertain (docs/04 §3.1), stored folded. */
export const NEGATION_MARKERS: readonly string[] = Object.freeze(['vraceno', 'storno', 'refund']);

/** Relative day words, folded, mapped to an offset from `today`. */
const RELATIVE_DAY_OFFSETS: Readonly<Record<string, number>> = Object.freeze({
  danas: 0,
  juce: -1,
  prekjuce: -2,
});

/** Weekday names, folded, indexed from Monday = 0 (the ISO week). */
const WEEKDAY_INDEX: Readonly<Record<string, number>> = Object.freeze({
  ponedeljak: 0,
  utorak: 1,
  sreda: 2,
  cetvrtak: 3,
  petak: 4,
  subota: 5,
  nedelja: 6,
});

const RSD_WORDS = new Set(['din', 'dinar', 'dinara', 'dindzi', 'rsd']);
const EUR_WORDS = new Set(['eur', 'euro', 'eura', 'evro', 'evra']);
const USD_WORDS = new Set(['usd', 'dolar', 'dolara']);

/** A currency written immediately after the amount: `2000din`, `2.000 rsd`, `1500 dindži`, `20€`. */
const CURRENCY_SUFFIX =
  /^\s*(€|\$|din(?:ar(?:a)?)?|dind[zž]i|rsd|eur(?:o|a)?|evr(?:o|a)?|usd|dolar(?:a)?)(?![\p{L}])/iu;

/**
 * A numeric token.
 *
 * - the first alternative covers grouped forms: `2.000`, `1 200`, `1.250,50`;
 * - the second covers plain and decimal forms: `2000`, `2,50`, `1.5`;
 * - a trailing `k` is the thousands shorthand, but only when it is not the start of a unit — without
 *   the lookahead, `2000kg` would expand to two million (docs/04 §3.1: reject when ambiguous).
 */
const AMOUNT_TOKEN =
  /(?:\d{1,3}(?:[.\u00a0 ]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)*)(?:k(?![\p{L}\d]))?/giu;

const DOT_DATE_WITH_YEAR = /\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})\.?/;
const DOT_DATE_NO_YEAR = /\b(\d{1,2})\.(\d{1,2})\./;
const SLASH_DATE = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?/;

interface DateMatch {
  readonly start: number;
  readonly end: number;
  readonly date: LocalDate;
}

interface AmountHit {
  readonly start: number;
  readonly end: number;
  /** End of the currency suffix when one was recognised, otherwise `end`. */
  readonly suffixEnd: number;
  readonly numericText: string;
  readonly currency: CurrencyCode | null;
}

interface WordSpan {
  readonly start: number;
  readonly end: number;
  readonly folded: readonly string[];
}

interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * Extract every fragment from a capture input, in order.
 *
 * The exit-criterion line `Lidl 2000, gorivo 3500, plata 150000` yields exactly three fragments.
 */
export function extractFragments(
  input: string,
  options: ExtractOptions,
): readonly TransactionFragment[] {
  return segmentFragments(input).map((fragment) => extractFragment(fragment, options));
}

/** Extract one already-segmented fragment. */
export function extractFragment(rawText: string, options: ExtractOptions): TransactionFragment {
  const normalized = normalizeFragment(rawText);
  const raw = normalized.rawText;

  // The date is located first and blanked out, so a date like `1.9.` can never be read as an amount.
  const dateMatch = findDate(raw, options.today);
  const amountHit = chooseAmountHit(findAmountHits(dateMatch ? maskSpan(raw, dateMatch) : raw));

  const effectiveCurrency = amountHit?.currency ?? options.currency;
  const parsed = amountHit ? parseAmount(amountHit.numericText, effectiveCurrency) : null;
  const amountMinor = parsed?.money?.amountMinor ?? null;

  const description = buildDescription(raw, [
    amountHit ? { start: amountHit.start, end: amountHit.suffixEnd } : null,
    dateMatch ? { start: dateMatch.start, end: dateMatch.end } : null,
  ]);

  const income = normalized.tokens.some((token) => INCOME_MARKERS.includes(token));
  const needsDirectionConfirmation = normalized.tokens.some((token) =>
    NEGATION_MARKERS.includes(token),
  );

  return {
    rawText: raw,
    amountMinor,
    currency: amountHit?.currency ?? null,
    // The line between the expense default and UNKNOWN: a fragment is EXPENSE-default only when it
    // actually carries money movement. Without an amount and without an income marker there is no
    // direction signal at all, and guessing EXPENSE would put a number-free line in the ledger.
    kind: income ? 'INCOME' : amountMinor !== null ? 'EXPENSE' : 'UNKNOWN',
    occurredOn: dateMatch?.date ?? null,
    description,
    tokens: [...foldTokens(description)],
    candidates: (parsed?.candidates ?? []).map((candidate, index) => ({
      amountMinor: candidate.amountMinor,
      reason: describeCandidate(amountHit?.numericText ?? '', parsed?.candidates.length ?? 0, index),
    })),
    needsDirectionConfirmation,
  };
}

/** Find the earliest date expression in a fragment. */
function findDate(text: string, today: LocalDate): DateMatch | null {
  const numeric = findNumericDate(text, today);
  const relative = findRelativeDate(text, today);
  if (numeric === null) return relative;
  if (relative === null) return numeric;
  return numeric.start <= relative.start ? numeric : relative;
}

function findNumericDate(text: string, today: LocalDate): DateMatch | null {
  const matches: DateMatch[] = [];

  const withYear = DOT_DATE_WITH_YEAR.exec(text);
  if (withYear) {
    const date = explicitDate(withYear[1]!, withYear[2]!, withYear[3]!);
    if (date !== null) {
      matches.push({ start: withYear.index, end: withYear.index + withYear[0].length, date });
    }
  }

  // Only consulted when the year form did not already claim this position; `01.09.` is a valid date
  // and `01.09.2026` must keep its year in the span.
  const noYear = DOT_DATE_NO_YEAR.exec(text);
  if (noYear) {
    const date = mostRecentDate(noYear[1]!, noYear[2]!, today);
    if (date !== null) {
      matches.push({ start: noYear.index, end: noYear.index + noYear[0].length, date });
    }
  }

  const slash = SLASH_DATE.exec(text);
  if (slash) {
    const date =
      slash[3] !== undefined
        ? explicitDate(slash[1]!, slash[2]!, slash[3])
        : mostRecentDate(slash[1]!, slash[2]!, today);
    if (date !== null) {
      matches.push({ start: slash.index, end: slash.index + slash[0].length, date });
    }
  }

  if (matches.length === 0) return null;
  return matches.reduce((best, candidate) => (candidate.start < best.start ? candidate : best));
}

function findRelativeDate(text: string, today: LocalDate): DateMatch | null {
  const spans = wordSpans(text);
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!;
    const token = span.folded.length === 1 ? span.folded[0]! : null;
    if (token === null) continue;

    const offset = RELATIVE_DAY_OFFSETS[token];
    if (offset !== undefined) {
      return { start: span.start, end: span.end, date: shiftDays(today, offset) };
    }

    if (token === 'prosli' && index + 1 < spans.length) {
      const next = spans[index + 1]!;
      const weekdayToken = next.folded.length === 1 ? next.folded[0]! : null;
      const weekday = weekdayToken === null ? undefined : WEEKDAY_INDEX[weekdayToken];
      if (weekday !== undefined) {
        return { start: span.start, end: next.end, date: previousWeekWeekday(today, weekday) };
      }
    }
  }
  return null;
}

/**
 * Split into whitespace-delimited words, each folded.
 *
 * Used only for the relative-date words, where the raw span has to be removed from the display text
 * — which is why the raw offsets are kept rather than working on the folded string (transliteration
 * changes length).
 */
function wordSpans(text: string): WordSpan[] {
  const spans: WordSpan[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      folded: foldTokens(match[0]),
    });
  }
  return spans;
}

/** A date with an explicit year, `01.09.2026` or `1/9/26`. A 2-digit year means the 2000s. */
function explicitDate(dayText: string, monthText: string, yearText: string): LocalDate | null {
  const year = Number(yearText) + (yearText.length <= 2 ? 2000 : 0);
  return makeDate(year, Number(monthText), Number(dayText));
}

/**
 * A date with no year: the most recent occurrence **not in the future**.
 *
 * The rule matters at a boundary. In January 2027, `1.9.` means last September (2026), because a
 * future transaction is not what someone recording a purchase is describing. The alternative
 * "this calendar year" would file 2027-09-01 — eight months in the future — and silently corrupt the
 * month it lands in. Walking back up to 8 years also covers 29 February.
 */
function mostRecentDate(dayText: string, monthText: string, today: LocalDate): LocalDate | null {
  const day = Number(dayText);
  const month = Number(monthText);
  const currentYear = Number(today.slice(0, 4));
  for (let back = 0; back <= 8; back += 1) {
    const candidate = makeDate(currentYear - back, month, day);
    if (candidate !== null && compareLocalDates(candidate, today) <= 0) return candidate;
  }
  return null;
}

function makeDate(year: number, month: number, day: number): LocalDate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  try {
    return localDate(text);
  } catch {
    // `localDate` rejects impossible days such as 2026-02-31; a non-date is not a parse failure.
    return null;
  }
}

/**
 * The Friday of the **previous week**, not merely the last Friday.
 *
 * ISO weeks start on Monday. If today is Sunday, "last Friday" is two days ago, while `prošli petak`
 * is the Friday of the week before — the week that has just ended. Computing from the Monday of
 * today's week and stepping back one week encodes that distinction directly.
 */
function previousWeekWeekday(today: LocalDate, weekday: number): LocalDate {
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const weeksSinceMonday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  const monday = shiftDays(today, -weeksSinceMonday);
  return shiftDays(monday, -7 + weekday);
}

/**
 * Shift a calendar day by whole days.
 *
 * `@finmate/domain` exposes no day arithmetic, and this is deliberately **calendar** arithmetic on a
 * `LocalDate`, not instant/timezone arithmetic: `Date.UTC` is used only as a day counter so month
 * lengths and leap years are handled, and no timezone is involved (docs/03 §3.2).
 */
function shiftDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86_400_000);
  return localDate(
    `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`,
  );
}

/** Replace a span with spaces so amount scanning cannot see inside a date, keeping offsets stable. */
function maskSpan(text: string, span: Span): string {
  return `${text.slice(0, span.start)}${' '.repeat(span.end - span.start)}${text.slice(span.end)}`;
}

function findAmountHits(text: string): AmountHit[] {
  const hits: AmountHit[] = [];
  for (const match of text.matchAll(AMOUNT_TOKEN)) {
    const start = match.index;
    const end = start + match[0].length;
    const suffix = CURRENCY_SUFFIX.exec(text.slice(end));
    const currency = suffix ? currencyFor(suffix[1]!) : null;
    hits.push({
      start,
      end,
      suffixEnd: currency === null || suffix === null ? end : end + suffix[0].length,
      numericText: match[0],
      currency,
    });
  }
  return hits;
}

/**
 * Pick the amount from the numeric tokens in a fragment.
 *
 * A token carrying a currency suffix is the strongest signal of which number is the amount, so the
 * first such token wins. With no suffix the **last** numeric token wins, because the common shape is
 * `description quantity price` (`kupio 2 mleka 350`). The rule is deterministic and documented; when
 * the token itself is ambiguous, `candidates` carries every reading.
 */
function chooseAmountHit(hits: readonly AmountHit[]): AmountHit | null {
  if (hits.length === 0) return null;
  return hits.find((hit) => hit.currency !== null) ?? hits[hits.length - 1]!;
}

function currencyFor(suffixText: string): CurrencyCode | null {
  if (suffixText === '€') return 'EUR';
  if (suffixText === '$') return 'USD';
  const folded = foldForMatching(suffixText);
  if (RSD_WORDS.has(folded)) return 'RSD';
  if (EUR_WORDS.has(folded)) return 'EUR';
  if (USD_WORDS.has(folded)) return 'USD';
  return null;
}

/** Remove the given spans from the raw text, preserving every remaining character and its case. */
function buildDescription(raw: string, spans: readonly (Span | null)[]): string {
  const ordered = spans
    .filter((span): span is Span => span !== null)
    .sort((left, right) => left.start - right.start);

  let result = '';
  let cursor = 0;
  for (const span of ordered) {
    if (span.start < cursor) continue;
    result += raw.slice(cursor, span.start);
    cursor = span.end;
  }
  result += raw.slice(cursor);
  return result.replace(/\s+/g, ' ').trim();
}

/** Label one parseAmount reading so the UI can explain the ambiguity without knowing domain internals. */
function describeCandidate(numericText: string, count: number, index: number): string {
  const hasDot = numericText.includes('.');
  const hasComma = numericText.includes(',');
  if (index > 0) {
    if (hasDot && hasComma) return 'alternative-reading';
    if (hasComma) return 'thousands-grouping (English convention)';
    if (hasDot) return 'decimal-point';
    return 'alternative-reading';
  }
  if (/k$/i.test(numericText)) return 'thousands-shorthand';
  if (count <= 1) return 'unambiguous';
  if (hasDot && hasComma) return 'last separator is the decimal point';
  if (hasComma) return 'comma is the decimal separator (Serbian)';
  if (hasDot) return 'dot groups thousands (Serbian)';
  return 'unambiguous';
}
