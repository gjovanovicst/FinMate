import { Scalar, CustomScalar } from '@nestjs/graphql';
import { GraphQLError, Kind, type ValueNode } from 'graphql';

/**
 * A pass-through `JSON` scalar, for the two columns that are genuinely documents.
 *
 * `rules.conditions` and `rules.actions` are user-authored JSONB (docs/03 §4, docs/04 §5), and a
 * typed GraphQL mirror of a recursive condition tree would be a second definition of a shape the
 * rules engine already owns — free to disagree with `validateRule`, which is the authority.
 *
 * **Why a local scalar instead of `graphql-type-json`.** A new dependency needs an ADR (ADR-004), and
 * this is forty lines of pass-through. The trade is that the scalar validates *nothing*: anything a
 * client sends arrives in the service, so **every** write path must run `validateRule` before it
 * touches the database. That is stated here because it is the one thing a reader of this file needs
 * to know.
 *
 * Registered **without** a type function (`@Scalar('JSON')`, not `() => Object`): a custom scalar
 * used as an INPUT with a type function makes Nest treat it as an object type and every input field
 * fails with `CannotDetermineInputTypeError` (AGENTS.md).
 */
@Scalar('JSON')
export class JsonScalar implements CustomScalar<unknown, unknown> {
  description =
    'Arbitrary JSON, used for the rule condition and action documents. Unvalidated: the writer is ' +
    'responsible for checking the shape (the rules engine validates every rule on evaluation).';

  serialize(value: unknown): unknown {
    // JSONB round-trips as-is. A `bigint` cannot be represented in JSON and would be silently
    // stringified by `JSON.stringify`, so it is refused rather than quietly changed (ADR-003 is
    // about money, but the same "never silently transform a number" reasoning applies).
    if (typeof value === 'bigint') {
      throw new GraphQLError(
        'Cannot serialise a bigint as JSON. Store minor units as a decimal STRING (ADR-003).',
      );
    }
    return value ?? null;
  }

  parseValue(value: unknown): unknown {
    if (value === undefined) throw new GraphQLError('JSON input must not be undefined.');
    return value;
  }

  parseLiteral(ast: ValueNode): unknown {
    return literalToJson(ast);
  }
}

/**
 * An inline JSON literal → a plain value.
 *
 * Walks the AST rather than using `valueFromASTUntyped` so the shapes are explicit and an unexpected
 * node kind fails loudly instead of becoming `undefined`.
 */
function literalToJson(ast: ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
      // Kept as a STRING on purpose. An `amount` condition in a rule must be a decimal string or a
      // bigint (rules-engine types), and turning the literal into a JS number here would put a float
      // in the money path before the engine ever saw it (ADR-003).
      return ast.value;
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.NULL:
      return null;
    case Kind.LIST:
      return ast.values.map(literalToJson);
    case Kind.OBJECT: {
      const result: Record<string, unknown> = {};
      for (const field of ast.fields) result[field.name.value] = literalToJson(field.value);
      return result;
    }
    default:
      throw new GraphQLError(`Unsupported JSON literal: ${ast.kind}.`);
  }
}
