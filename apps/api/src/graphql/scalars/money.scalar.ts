import { Scalar, CustomScalar } from '@nestjs/graphql';
import { Kind, type ValueNode } from 'graphql';

import { money, MoneyError, type Money } from '@finmate/domain';

/**
 * The `Money` scalar.
 *
 * **Wire format** (docs/06 §1):
 * ```json
 * { "amountMinor": "200000", "currency": "RSD" }
 * ```
 *
 * Two decisions matter here, and both exist to protect ADR-003:
 *
 *  1. **`amountMinor` is a STRING, not a JSON number.** `2.000 RSD` is `200000` minor units, but a
 *     large balance in a zero-decimal currency can exceed JavaScript's `Number.MAX_SAFE_INTEGER`
 *     (2^53−1). `JSON.parse` would silently round it — a wrong number in a money app, delivered
 *     without an error. A string cannot be rounded in transit.
 *  2. **A bare JSON number is rejected as INPUT.** Accepting `2000` would mean accepting a float,
 *     and floats in the money path are exactly what ADR-003 forbids. Making the client send a string
 *     forces the conversion to be explicit and keeps `bigint` on the inside.
 *
 * Amounts are non-negative; direction is carried by `kind`, never by a sign.
 */
@Scalar('Money')
export class MoneyScalar implements CustomScalar<MoneyOutput, Money> {
  description =
    'Money as integer minor units plus an ISO-4217 currency. amountMinor is a string to avoid ' +
    'losing precision beyond Number.MAX_SAFE_INTEGER (ADR-003). Always non-negative.';

  /** Internal `Money` → wire. */
  serialize(value: unknown): MoneyOutput {
    const parsed = toMoney(value);
    return { amountMinor: parsed.amountMinor.toString(), currency: parsed.currency };
  }

  /** Wire → internal. Rejects numbers, negatives, and unsupported currencies. */
  parseValue(value: unknown): Money {
    return parseMoneyInput(value);
  }

  /** Inline literals: an object literal `{ amountMinor: "2000", currency: "RSD" }`. */
  parseLiteral(ast: ValueNode): Money {
    if (ast.kind !== Kind.OBJECT) {
      throw new MoneyError(
        'Money must be given as an object literal { amountMinor: "…", currency: "…" }; ' +
          'a bare number is rejected because it would be a float (ADR-003).',
      );
    }

    const fields: Record<string, unknown> = {};
    for (const field of ast.fields) {
      const key = field.name.value;
      // `Kind.INT` is rejected, and this is the whole point: an IntValueNode exposes its digits as
      // a STRING (`ast.value === '2000'`), so treating INT as acceptable made a numeric literal
      // indistinguishable from a string literal and let a float into the money path. Verified by
      // an end-to-end test that previously created an Account from `amountMinor: 2000`.
      if (field.value.kind !== Kind.STRING) {
        throw new MoneyError(
          `Money.${key} must be a STRING literal (e.g. amountMinor: "2000"), not a number. ` +
            `A numeric literal is a float and is rejected by ADR-003.`,
        );
      }
      fields[key] = field.value.value;
    }
    return parseMoneyInput(fields);
  }
}

export interface MoneyOutput {
  readonly amountMinor: string;
  readonly currency: string;
}

/** Accept the internal representation, or the wire shape, and normalise to `Money`. */
function toMoney(value: unknown): Money {
  if (value && typeof value === 'object' && 'amountMinor' in value && 'currency' in value) {
    const candidate = value as { amountMinor: unknown; currency: unknown };
    const amount = candidate.amountMinor;
    if (typeof amount === 'bigint') return money(amount, String(candidate.currency));
    if (typeof amount === 'string') return money(BigInt(amount), String(candidate.currency));
    if (typeof amount === 'number') {
      throw new MoneyError(
        'A Money value reached the response as a JS number, which means a float entered the money ' +
          'path (ADR-003). Use `money(bigint, currency)`.',
      );
    }
  }
  throw new MoneyError(`Cannot serialise ${JSON.stringify(value)} as Money.`);
}

/** Parse client input. Deliberately strict. */
function parseMoneyInput(value: unknown): Money {
  if (typeof value === 'number') {
    throw new MoneyError(
      'amountMinor must be a string (or integer literal), not a number — a JSON number is a ' +
        'float and would be silently rounded (ADR-003).',
    );
  }
  if (!value || typeof value !== 'object') {
    throw new MoneyError('Money must be an object { amountMinor, currency }.');
  }

  const { amountMinor, currency } = value as { amountMinor?: unknown; currency?: unknown };

  if (typeof currency !== 'string' || currency.length !== 3) {
    throw new MoneyError('Money.currency must be a 3-letter ISO-4217 code.');
  }
  if (amountMinor === undefined || amountMinor === null) {
    throw new MoneyError('Money.amountMinor is required.');
  }

  // Check the FIELD, not the enclosing object. An earlier version only tested `typeof value` on the
  // object, so `{ amountMinor: 2000 }` slipped through and was silently coerced by BigInt(String(…))
  // — a float entering the money path, which is exactly what ADR-003 forbids. Whole numbers would
  // have been accepted while `2000.5` threw, which is worse than either behaviour alone.
  if (typeof amountMinor !== 'string' && typeof amountMinor !== 'bigint') {
    throw new MoneyError(
      `Money.amountMinor must be a string or integer, received ${typeof amountMinor}. ` +
        `A JSON number is a float and would be silently rounded (ADR-003).`,
    );
  }
  if (typeof amountMinor === 'string' && !/^\d+$/.test(amountMinor)) {
    throw new MoneyError('Money.amountMinor must be a non-negative integer string.');
  }

  const raw = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor);
  return money(raw, currency.toUpperCase());
}
