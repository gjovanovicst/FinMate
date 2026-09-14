import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'node:path';

import { CONFIG, type AppConfig } from '../config/config';

/**
 * GraphQL wiring (docs/06 §1, task 0.7).
 *
 * Code-first: the schema is generated from decorated classes, so a resolver and its type cannot
 * drift apart the way they can when the SDL is written by hand. `docs/06` remains the human-readable
 * contract; the generated schema is the machine one.
 *
 * Deliberately **not** enabled:
 *  - **`autoSchemaFile` in memory** — writing `schema.gql` to disk makes the contract reviewable in
 *    a diff, which is how a breaking change gets noticed before it ships.
 *  - **introspection in production** and **the playground** — both are disabled outside development
 *    (docs/08 §9). An internal schema is not a public API.
 *  - **Apollo Studio reporting** — it ships data about queries to a third party, which is exactly
 *    the kind of egress docs/08 §6 says must be deliberate.
 */
@Module({
  imports: [
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => ({
        // Anchored to this file, not to process.cwd(): the server is started from apps/api, so a
        // cwd-relative path produced apps/api/apps/api/schema.gql. The schema is a reviewable
        // artifact and must land in one predictable place.
        autoSchemaFile: join(__dirname, '..', '..', 'schema.gql'),
        sortSchema: true,
        // Exposes the error's `extensions.code` so clients can branch on the same typed codes the
        // REST error filter emits (docs/06 §10).
        // The typed code is put on `extensions` by `AllExceptionsFilter`, which converts an
        // `ApiError` into a `GraphQLError` at the transport boundary. That conversion is necessary
        // because NestJS does NOT populate `originalError` for GraphQL contexts, so the `code`
        // would otherwise be lost and every failure would read INTERNAL_SERVER_ERROR (docs/06 §10).
        formatError: (error) => ({
          message: error.message,
          code: typeof error.extensions?.['code'] === 'string' ? error.extensions['code'] : 'INTERNAL',
          retryable: error.extensions?.['retryable'] === true,
          path: error.path,
        }),
        introspection: config.NODE_ENV !== 'production',
        playground: config.NODE_ENV !== 'production',
        // The tenancy middleware runs before GraphQL, so `TenantContext` is already established by
        // the time a resolver executes. The global guards use it directly.
        context: ({ req }: { req: unknown }) => ({ req }),
      }),
    }),
  ],
})
export class GraphqlModule {}
