import {
  MINOR_UNITS_PER_MAJOR,
  MoneyError,
  money,
  type CurrencyCode,
  type Money,
} from './money';

/**
 * Parse a human-typed amount into `Money`.
 *
 * This is the rule set from docs/04 §3.1, and it is **Serbian-first** because that is where the
 * ambiguity lives. Getting it wrong is not cosmetic: reading `2.000` as `2.00` understates a
 * transaction by a factor of a thousand.
 *
 * | Input | Reading | Why |
 * |---|---|---|
 * | `2.000` | 2000 | `.` groups thousands in Serbian |
 * | `2,50` | 2.50 | `,` is the decimal separator |
 * | `2.000,50` | 2000.50 | the **last** separator is the decimal one |
 * | `1 200` | 1200 | a space also groups thousands |
 * | `2k` | 2000 | shorthand, common in chat-style entry |
 * | `2.000 din` | 2000 | currency words are stripped |
 *
 * **Ambiguity is reported, not hidden.** `1.200` could be twelve hundred or one-point-two. Rather
 * than guessing, the result carries every plausible reading with the more likely one first, and the
 * caller decides (the manual form shows a hint; the AI parser asks). This is docs/04's "never
 * silently picks" rule, and it is what makes the parser trustworthy with money.
 *
 * @module @finmate/domain
 */
export interface AmountParseResult {
  /** The most likely reading, or `null` when nothing numeric was found. */
  readonly money: Money | null;
  /** Every plausible reading, most likely first. Empty when nothing numeric was found. */
  readonly candidates: readonly Money[];
  readonly currency: CurrencyCode;
  /** True when more than one reading is defensible. */
  readonly ambiguous: boolean;
}

/** Currency words and symbols stripped before parsing. */
const CURRENCY_NOISE = /\b(din|dinara|dinara|rsd|eur|evra|evro|eura|usd|dolara)\b|€|\$|rsd/gi;

export function parseAmount(input: string, currency: CurrencyCode): AmountParseResult {
  const cleaned = input
    .toLowerCase()
    .replace(CURRENCY_NOISE, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) {
    return { money: null, candidates: [], currency, ambiguous: false };
  }

  const scale = MINOR_UNITS_PER_MAJOR[currency];
  if (scale === undefined) throw new MoneyError(`Unsupported currency: ${currency}`);

  const shorthand = applyThousandsShorthand(cleaned);

  const readings = readAmounts(shorthand, scale, currency);
  if (readings.length === 0) {
    return { money: null, candidates: [], currency, ambiguous: false };
  }

  return {
    money: readings[0]!,
    candidates: readings,
    currency,
    ambiguous: readings.length > 1,
  };
}

/** `2k` → `2000`, `1.5k` → `1500`. Only applied to a trailing `k` on an otherwise numeric string. */
function applyThousandsShorthand(input: string): string {
  const match = /^(-?[\d.,\s]+)k$/.exec(input);
  if (!match) return input;
  const base = asDecimalMajorText(match[1]!);
  if (base === null) return input;
  // Scaling by 1000 through `toMinorUnits` keeps the expansion exact and float-free. The previous
  // implementation used `Number`, which read `1.5k` as `15k` (it stripped the decimal point as if it
  // were a group separator) and lost precision on large inputs (ADR-003).
  const expanded = toMinorUnits(base, 1_000n);
  return expanded === null ? input : expanded.toString();
}

/**
 * Rewrite a loosely formatted Serbian number as an unambiguous `.`-decimal major-unit string, using
 * exactly the separator rules {@link readAmounts} applies: `.` and space group thousands, `,` is the
 * decimal separator, and with both present the last one is the decimal point.
 */
function asDecimalMajorText(input: string): string | null {
  const text = input.replace(/\s/g, '');
  if (!/\d/.test(text)) return null;

  const hasDot = text.includes('.');
  const hasComma = text.includes(',');

  if (hasDot && hasComma) {
    const decimalAt = Math.max(text.lastIndexOf('.'), text.lastIndexOf(','));
    const integerPart = text.slice(0, decimalAt).replace(/[.,]/g, '');
    const fractionPart = text.slice(decimalAt + 1).replace(/[.,]/g, '');
    return `${integerPart || '0'}.${fractionPart}`;
  }

  if (hasComma) {
    const parts = text.split(',');
    return parts.length === 2 ? `${parts[0] || '0'}.${parts[1]}` : text.replace(/,/g, '');
  }

  if (hasDot) {
    const parts = text.split('.');
    const wellFormedGroups =
      parts.length > 1 &&
      (parts[0] ?? '').length >= 1 &&
      (parts[0] ?? '').length <= 3 &&
      parts.slice(1).every((part) => part.length === 3);
    // `1.5` is a decimal point; `1.200` groups thousands and leads with that reading.
    return wellFormedGroups ? text.replace(/\./g, '') : text;
  }

  return text;
}

/**
 * Produce every defensible reading of a numeric string, most likely first.
 *
 * The ordering encodes a judgement about this market: a Serbian household typing `1.200` almost
 * always means twelve hundred, so the grouping reading leads and the decimal reading is the
 * alternative.
 */
function readAmounts(input: string, scale: bigint, currency: CurrencyCode): Money[] {
  const digitsAndSeparators = input.replace(/[^\d.,\s-]/g, '');
  if (!/\d/.test(digitsAndSeparators)) return [];

  const hasDot = digitsAndSeparators.includes('.');
  const hasComma = digitsAndSeparators.includes(',');
  const readings: Money[] = [];

  const push = (majorText: string): void => {
    const parsed = toMinorUnits(majorText, scale);
    if (parsed === null) return;
    try {
      const candidate = money(parsed, currency);
      // De-duplicate: `1,50` and `1.50` often yield the same minor units from two readings.
      if (!readings.some((existing) => existing.amountMinor === candidate.amountMinor)) {
        readings.push(candidate);
      }
    } catch {
      // Negative or otherwise invalid: not a usable amount.
    }
  };

  if (hasDot && hasComma) {
    // Both present: only one can be the decimal separator, and it is the LAST one. A string with
    // both is otherwise unambiguous — there is nothing else the other separator could be.
    const decimalAt = Math.max(digitsAndSeparators.lastIndexOf('.'), digitsAndSeparators.lastIndexOf(','));
    const integerPart = digitsAndSeparators.slice(0, decimalAt).replace(/[.,\s]/g, '');
    const fractionPart = digitsAndSeparators.slice(decimalAt + 1).replace(/[.,\s]/g, '');
    push(`${integerPart || '0'}.${fractionPart}`);
    return readings;
  }

  if (hasComma) {
    // Serbian convention (docs/04 §3.1): `,` is the DECIMAL separator, so that reading leads.
    const parts = digitsAndSeparators.split(',');
    if (parts.length === 2 && (parts[1] ?? '').length > 0 && (parts[1] ?? '').length <= 3) {
      push(`${parts[0]!.replace(/\s/g, '') || '0'}.${parts[1]}`);
      // With exactly three digits the English-style grouping reading is also defensible
      // (`1,999` → 1999), so it is offered as the alternative rather than discarded.
      if ((parts[1] ?? '').length === 3) push(digitsAndSeparators.replace(/[,\s]/g, ''));
    } else {
      push(digitsAndSeparators.replace(/[,\s]/g, ''));
    }
    return readings;
  }

  if (hasDot) {
    const parts = digitsAndSeparators.split('.');
    const wellFormedGroups =
      parts.length > 1 &&
      (parts[0] ?? '').length >= 1 &&
      (parts[0] ?? '').length <= 3 &&
      parts.slice(1).every((part) => part.length === 3);

    if (wellFormedGroups) {
      // Serbian convention: `.` groups thousands, so that reading leads.
      push(digitsAndSeparators.replace(/[.\s]/g, ''));
      // ...but `1.200` may genuinely mean one-point-two, which is the ambiguity docs/04 §3.1 calls
      // out by name. Report it rather than guessing.
      if (parts.length === 2) push(digitsAndSeparators);
    } else {
      // Not well-formed grouping (`2.5`, `0.75`), so `.` is being used as a decimal point. Reading
      // it as 25 would be surprising and wrong for anyone typing a decimal.
      push(digitsAndSeparators);
    }
    return readings;
  }

  push(digitsAndSeparators.replace(/\s/g, ''));
  return readings;
}

/**
 * Convert a major-unit decimal string (e.g. `2000.50`) to exact minor units.
 *
 * Deliberately does **not** go through `Number` for the arithmetic: `2000.50 * 100` is
 * `200050.00000000003` in binary floating point, which truncates to the wrong number of para. The
 * integer and fraction parts are handled separately as integers instead (ADR-003).
 */
function toMinorUnits(majorText: string, scale: bigint): bigint | null {
  const negative = majorText.startsWith('-');
  const unsigned = negative ? majorText.slice(1) : majorText;
  const [integerPart = '0', fractionPart = ''] = unsigned.split('.');

  const integerDigits = integerPart.replace(/\D/g, '') || '0';
  const exponent = String(scale).length - 1;

  // Pad or truncate the fraction to the currency's exponent. Truncation rather than rounding,
  // because a third decimal is below the currency's smallest unit and inventing one would be
  // creating money.
  const fractionDigits = (fractionPart.replace(/\D/g, '') + '0'.repeat(exponent)).slice(0, exponent);

  try {
    const minor = BigInt(integerDigits) * scale + (exponent === 0 ? 0n : BigInt(fractionDigits || '0'));
    return negative ? -minor : minor;
  } catch {
    return null;
  }
}

/**
 * Render `Money` as a plain major-unit decimal string, for pre-filling an input field.
 *
 * Always uses `.` as the decimal separator and no grouping, so it is unambiguous to feed back into
 * an `<input>` regardless of the display locale.
 */
export function toMajorString(value: Money): string {
  const scale = MINOR_UNITS_PER_MAJOR[value.currency];
  if (scale === undefined) throw new MoneyError(`Unsupported currency: ${value.currency}`);
  if (scale === 1n) return value.amountMinor.toString();

  const exponent = String(scale).length - 1;
  const asString = value.amountMinor.toString().padStart(exponent + 1, '0');
  const cut = asString.length - exponent;
  return `${asString.slice(0, cut)}.${asString.slice(cut)}`;
}
