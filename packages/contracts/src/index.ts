/**
 * Shared DTOs, GraphQL types and schemas.
 *
 * Owner: docs/06-api-specification.md
 *
 * Rule that governs this package: the `Money` scalar serialises `amountMinor` as a **string**,
 * never a JSON number, so it survives JavaScript's `Number.MAX_SAFE_INTEGER` boundary (ADR-003).
 *
 * Populated in Phase 0 task 0.7 (GraphQL wiring), then grown per feature.
 */
export {};
