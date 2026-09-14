import { Kind } from 'graphql';
import { describe, expect, it } from 'vitest';

import { money } from '@finmate/domain';

import { MoneyScalar } from './money.scalar';

/**
 * The Money scalar is the boundary where ADR-003 is enforced on the wire, so these tests focus on
 * what it REFUSES as much as what it produces.
 */
describe('MoneyScalar (ADR-003 on the wire)', () => {
  const scalar = new MoneyScalar();

  describe('serialize: internal → wire', () => {
    it('emits amountMinor as a STRING, never a JSON number', () => {
      const output = scalar.serialize(money(200_000n, 'RSD'));
      expect(output).toEqual({ amountMinor: '200000', currency: 'RSD' });
      expect(typeof output.amountMinor).toBe('string');
    });

    it('preserves amounts beyond Number.MAX_SAFE_INTEGER', () => {
      // 2^53 minor units. As a JS number this would round; as a string it survives.
      const huge = 9_007_199_254_740_993n;
      const output = scalar.serialize(money(huge, 'RSD'));
      expect(output.amountMinor).toBe('9007199254740993');
      expect(BigInt(output.amountMinor)).toBe(huge);
      expect(BigInt(output.amountMinor)).not.toBe(BigInt(Number(huge)));
    });

    it('refuses to serialise a plain JS number, which would mean a float reached the money path', () => {
      expect(() => scalar.serialize({ amountMinor: 2000, currency: 'RSD' })).toThrow(/number/);
    });

    it('refuses a non-money value', () => {
      expect(() => scalar.serialize('2000 RSD')).toThrow(/Cannot serialise/);
      expect(() => scalar.serialize(null)).toThrow(/Cannot serialise/);
    });
  });

  describe('parseValue: wire → internal', () => {
    it('parses the documented wire shape into bigint minor units', () => {
      const parsed = scalar.parseValue({ amountMinor: '200000', currency: 'RSD' });
      expect(parsed.amountMinor).toBe(200_000n);
      expect(parsed.currency).toBe('RSD');
    });

    it('REJECTS a JSON number, because that is a float (ADR-003)', () => {
      expect(() => scalar.parseValue({ amountMinor: 2000, currency: 'RSD' })).toThrow(/must be a string or integer/);
    });

    it('rejects a negative amount — direction is carried by kind, not a sign', () => {
      expect(() => scalar.parseValue({ amountMinor: '-1', currency: 'RSD' })).toThrow(/non-negative/);
    });

    it('rejects a malformed currency code', () => {
      expect(() => scalar.parseValue({ amountMinor: '100', currency: 'RS' })).toThrow(/ISO-4217/);
      expect(() => scalar.parseValue({ amountMinor: '100', currency: 42 })).toThrow(/ISO-4217/);
    });

    it('rejects an unsupported currency', () => {
      expect(() => scalar.parseValue({ amountMinor: '100', currency: 'XXX' })).toThrow();
    });

    it('rejects a missing amount', () => {
      expect(() => scalar.parseValue({ currency: 'RSD' })).toThrow(/amountMinor is required/);
    });

    it('rejects a non-object', () => {
      expect(() => scalar.parseValue('2000')).toThrow(/must be an object/);
    });

    it('normalises a lowercase currency code', () => {
      expect(scalar.parseValue({ amountMinor: '100', currency: 'rsd' }).currency).toBe('RSD');
    });
  });

  describe('parseLiteral: inline literals', () => {
    it('parses an object literal with string fields', () => {
      const parsed = scalar.parseLiteral({
        kind: Kind.OBJECT,
        fields: [
          { kind: Kind.OBJECT_FIELD, name: { kind: Kind.NAME, value: 'amountMinor' }, value: { kind: Kind.STRING, value: '500' } },
          { kind: Kind.OBJECT_FIELD, name: { kind: Kind.NAME, value: 'currency' }, value: { kind: Kind.STRING, value: 'RSD' } },
        ],
      } as never);
      expect(parsed.amountMinor).toBe(500n);
    });

    it('rejects a bare numeric literal with an explanatory message', () => {
      expect(() =>
        scalar.parseLiteral({ kind: Kind.INT, value: '2000' } as never),
      ).toThrow(/bare number is rejected/);
    });
  });

  it('round-trips a value unchanged', () => {
    const original = money(123_456n, 'RSD');
    const reparsed = scalar.parseValue(scalar.serialize(original));
    expect(reparsed.amountMinor).toBe(original.amountMinor);
    expect(reparsed.currency).toBe(original.currency);
  });
});
