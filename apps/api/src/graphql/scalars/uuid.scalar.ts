import { Scalar, CustomScalar } from '@nestjs/graphql';
import { GraphQLError, Kind, type ValueNode } from 'graphql';

/**
 * A `UUID` scalar.
 *
 * Exists mostly to catch mistakes at the edge: a client sending `"1"` or `"abc"` as an id gets a
 * clear validation error instead of a Postgres cast failure five layers down. Validating the shape
 * (not just "is a string") also means a malformed id never reaches a query.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Scalar('UUID')
export class UuidScalar implements CustomScalar<string, string> {
  description = 'A UUID string (any version; the app generates v7 so ids sort by creation time).';

  serialize(value: unknown): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new GraphQLError(`Cannot serialise ${String(value)} as UUID.`);
    }
    return value;
  }

  parseValue(value: unknown): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new GraphQLError('UUID must be a well-formed UUID string.');
    }
    return value;
  }

  parseLiteral(ast: ValueNode): string {
    if (ast.kind !== Kind.STRING) throw new GraphQLError('UUID must be a string literal.');
    return this.parseValue(ast.value);
  }
}

/**
 * A `LocalDate` scalar for calendar days (`YYYY-MM-DD`).
 *
 * Distinct from `DateTime` on purpose: `occurred_local_date` answers "which day was this, for this
 * Household" and must not be timezone-shifted by a client. docs/03 §3.2 requires both an instant
 * and a local calendar day; conflating them is what breaks month boundaries.
 */
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

@Scalar('LocalDate')
export class LocalDateScalar implements CustomScalar<string, string> {
  description = 'A calendar day in the Household timezone, formatted YYYY-MM-DD (docs/03 §3.2).';

  serialize(value: unknown): string {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'string' && LOCAL_DATE_PATTERN.test(value)) return value;
    throw new GraphQLError(`Cannot serialise ${String(value)} as LocalDate.`);
  }

  parseValue(value: unknown): string {
    if (typeof value !== 'string' || !LOCAL_DATE_PATTERN.test(value)) {
      throw new GraphQLError('LocalDate must be a string formatted YYYY-MM-DD.');
    }
    return value;
  }

  parseLiteral(ast: ValueNode): string {
    if (ast.kind !== Kind.STRING) throw new GraphQLError('LocalDate must be a string literal.');
    return this.parseValue(ast.value);
  }
}
