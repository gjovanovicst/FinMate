import { toMajorString as domainMajorString, type Money } from '@finmate/domain';

import type { MoneyWire } from './ui/money/money.component';

/**
 * Rendering helpers for figures that appear *inside a sentence* ("of {budget}", "over by {amount}").
 *
 * These exist as plain functions, outside the component, for one reason: the sign handling below is
 * where a real bug lived, and a bug about money must be pinned by a test a component that fails to
 * mount cannot skip. `money-text.spec.ts` covers it directly.
 *
 * Note what these do NOT do: format money. Actual formatting is `@finmate/domain`'s, reached through
 * the wire adapter below, because it is currency-aware (JPY has no minor unit) and a hand-rolled
 * `slice(-2)` is wrong the moment a second currency exists.
 */

/**
 * The wire representation of Money (docs/06 §1) as a domain `Money` value.
 *
 * `amountMinor` crosses the wire as a STRING so a large value cannot be rounded by `JSON.parse`;
 * converting to `bigint` here is what keeps every later sum exact (ADR-003).
 */
export function moneyFromWire(value: MoneyWire): Money {
  return { amountMinor: BigInt(value.amountMinor), currency: value.currency };
}

/** `"300000.00"` — minor units to major units, no currency and no grouping. */
export function toMajorString(minor: bigint, currency = 'RSD'): string {
  return domainMajorString({ amountMinor: minor, currency });
}

/** A Money value as `"300000.00 RSD"`, or `''` when absent. Never a sign — see `overrunText`. */
export function moneyText(value: MoneyWire | null | undefined): string {
  return value ? `${domainMajorString(moneyFromWire(value))} ${value.currency}` : '';
}

/**
 * The overspend as `"2000.00 RSD"`, or **null when there is no overspend**.
 *
 * `available` and `projectedOverrun` are **signed Balances** (doc 03 §3.4): a negative projection
 * means the month is *under* budget, which is the ordinary case, not a warning. Returning a string
 * for any non-null value printed "over budget" on a month comfortably inside its budget — so the
 * gate is the sign, and callers use `@if (…; as over)` to render nothing when it is null.
 */
export function overrunText(value: MoneyWire | null | undefined): string | null {
  if (!value) return null;
  const minor = BigInt(value.amountMinor);
  if (minor <= 0n) return null;
  return `${domainMajorString(moneyFromWire(value))} ${value.currency}`;
}

/**
 * The overspend as text, from a figure that is **negative when over budget**: `available`.
 *
 * The two signs are opposite and that is not a detail — `projectedOverrun` is positive when the month
 * will overshoot, while `budget.safeToSpend`'s `available` is negative when it already has. Calling
 * {@link overrunText} on `available` therefore returns `null` for exactly the case it is meant to
 * report, which is how the dashboard shipped a hero whose "over budget" line never rendered: the value
 * is negative, the helper's gate rejects it, and nothing appears. Found by the ADR-039 visual pass,
 * which rendered a month 9,4 M RSD over its available budget with no warning on screen.
 *
 * The returned text is the **magnitude**, because "over budget by −9.461.129,00 RSD" is not a sentence.
 */
export function overspendText(value: MoneyWire | null | undefined): string | null {
  if (!value) return null;
  const minor = BigInt(value.amountMinor);
  if (minor >= 0n) return null;
  return `${domainMajorString({ amountMinor: -minor, currency: value.currency })} ${value.currency}`;
}
