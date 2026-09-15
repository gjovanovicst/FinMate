import { Module } from '@nestjs/common';

import { JsonScalar } from './json.scalar';

/**
 * The custom scalars that more than one module needs.
 *
 * ## Why this module exists
 *
 * A `@Scalar()` class is a **provider**, and Nest registers each provider it can reach as a GraphQL
 * type. Providing `JsonScalar` in two feature modules therefore produced two types both named `JSON`,
 * and the schema failed to build with:
 *
 * ```text
 * Schema must contain uniquely named types but contains multiple types named "JSON".
 * ```
 *
 * That is a boot failure, not a test failure, so it is exactly the class of mistake that only shows up
 * when the whole app is assembled — `api:test` builds per-module testing modules and stayed green.
 * Declaring the scalar once and **importing** this module is the fix; a feature module that needs it
 * must never add it to its own `providers` again.
 *
 * `MoneyScalar`, `BalanceScalar` and `UuidScalar` are each used by a single module today, so they stay
 * where they are: this module is for the shared ones, not for every scalar.
 */
@Module({
  providers: [JsonScalar],
  exports: [JsonScalar],
})
export class GraphqlScalarsModule {}
