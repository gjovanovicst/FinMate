import { Scalar, CustomScalar } from '@nestjs/graphql';
import { GraphQLError, type ValueNode } from 'graphql';

import { balance, MoneyError, type Balance } from '@finmate/domain';

/**
 * The `Balance` scalar — a **signed** money value, for derived figures only.
 *
 * **Why this is not the `Money` scalar.** ADR-003 makes `Money` non-negative because a Transaction
 * amount carries its direction in `kind`, not in a sign. A *balance* is a different quantity: it is
 * the sum of many movements and may legitimately be negative (an overdraft, a credit card, or an
 * account whose opening balance was recorded lower than what was already spent).
 *
 * Using `Money` for balances was a real defect: `subtractMoney` threw on the first overdrawn
 * account, and because the Accounts screen resolves every balance in one query, that single account
 * took the whole screen down with an INTERNAL error. Verified end to end before this fix.
 *
 * **Write-only on the wire.** `parseValue` and `parseLiteral` always throw: a balance is computed
 * by the backend and must never be accepted from a client. If a future field genuinely needs a
 * signed monetary *input*, that is a different scalar and a deliberate decision.
 */
@Scalar('Balance')
export class BalanceScalar implements CustomScalar<BalanceOutput, never> {
  description =
    'A derived, SIGNED money value: { amountMinor, currency }, where amountMinor may be negative. ' +
    'Read-only — balances are computed by the backend and never accepted as input (ADR-003).';

  serialize(value: unknown): BalanceOutput {
    const parsed = toBalanceValue(value);
    return { amountMinor: parsed.amountMinor.toString(), currency: parsed.currency };
  }

  parseValue(value: unknown): never {
    throw new GraphQLError(
      `A Balance is computed by the server and cannot be supplied as input (received ${typeof value}).`,
    );
  }

  parseLiteral(ast: ValueNode): never {
    // Named explicitly so the error reads sensibly for an inline literal.
    throw new GraphQLError(
      `A Balance is computed by the server and cannot be supplied as an inline ${ast.kind} literal.`,
    );
  }
}

export interface BalanceOutput {
  /** A signed integer string. Negative values are expected, not exceptional. */
  readonly amountMinor: string;
  readonly currency: string;
}

function toBalanceValue(value: unknown): Balance {
  if (value && typeof value === 'object' && 'amountMinor' in value && 'currency' in value) {
    const candidate = value as { amountMinor: unknown; currency: unknown };
    const amount = candidate.amountMinor;
    if (typeof amount === 'bigint') return balance(amount, String(candidate.currency));
    if (typeof amount === 'string') return balance(BigInt(amount), String(candidate.currency));
    if (typeof amount === 'number') {
      throw new MoneyError(
        'A Balance reached the response as a JS number, which means a float entered the money path ' +
          '(ADR-003). Use `balance(bigint, currency)`.',
      );
    }
  }
  throw new MoneyError(`Cannot serialise ${JSON.stringify(value)} as a Balance.`);
}
