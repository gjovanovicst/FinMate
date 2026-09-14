import { toMajorString as domainMajorString } from '@finmate/domain';

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

/** The wire representation of Money (docs/06 §1) as a domain `Money` value. */
function fromWire(value: MoneyWire) {
  return { amountMinor: BigInt(value.amountMinor), currency: value.currency };
}

/** `"300000.00"` — minor units to major units, no currency and no grouping. */
export function toMajorString(minor: bigint, currency = 'RSD'): string {
  return domainMajorString({ amountMinor: minor, currency });
}

/** A Money value as `"300000.00 RSD"`, or `''` when absent. Never a sign — see `overrunText`. */
export function moneyText(value: MoneyWire | null | undefined): string {
  return value ? `${domainMajorString(fromWire(value))} ${value.currency}` : '';
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
  return `${domainMajorString(fromWire(value))} ${value.currency}`;
}
