import { GraphQLError, Kind } from 'graphql';
import { describe, expect, it } from 'vitest';

import { balance, MoneyError } from '@finmate/domain';

import { BalanceScalar } from './balance.scalar';

/**
 * The `Balance` scalar — the **signed** counterpart of `Money`.
 *
 * It had no test of its own until the assistant's totals moved onto it, and the defect that forced
 * that move is exactly what the first case below covers: a derived figure that is negative
 * (`Income − spending`, a period-over-period change, a budget's `remaining`, an overdrawn account)
 * threw inside `MoneyScalar`, so every one of those answers was an INTERNAL error. A balance that
 * cannot serialise a negative is not a balance.
 */
describe('the Balance scalar', () => {
  const scalar = new BalanceScalar();

  it('serialises a negative amount, which is the whole reason it exists', () => {
    expect(scalar.serialize(balance(-5_000_00n, 'RSD'))).toEqual({
      amountMinor: '-500000',
      currency: 'RSD',
    });
    expect(scalar.serialize({ amountMinor: '-500000', currency: 'RSD' })).toEqual({
      amountMinor: '-500000',
      currency: 'RSD',
    });
    // Zero and positive values are the same quantity with the same rendering.
    expect(scalar.serialize(balance(0n, 'RSD')).amountMinor).toBe('0');
    expect(scalar.serialize(balance(5_000_00n, 'RSD')).amountMinor).toBe('500000');
  });

  it('refuses a JS number, because that is how a float enters the money path (ADR-003)', () => {
    expect(() => scalar.serialize({ amountMinor: 500000, currency: 'RSD' })).toThrow(MoneyError);
  });

  it('refuses to be an INPUT at all — a balance is computed by the backend, never supplied', () => {
    expect(() => scalar.parseValue({ amountMinor: '500000', currency: 'RSD' })).toThrow(GraphQLError);
    expect(() =>
      scalar.parseLiteral({
        kind: Kind.OBJECT,
        fields: [
          {
            kind: Kind.OBJECT_FIELD,
            name: { kind: Kind.NAME, value: 'amountMinor' },
            value: { kind: Kind.STRING, value: '500000' },
          },
        ],
      }),
    ).toThrow(GraphQLError);
  });
});
