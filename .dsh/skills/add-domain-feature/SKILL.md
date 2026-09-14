---
name: add-domain-feature
description: "Add or extend a domain capability as a vertical slice: migration, domain logic, tenancy-safe repository, GraphQL operation, UI, and tests."
whenToUse: "Use when adding a new entity, a new field, or a new end-to-end capability that touches schema, API and UI."
metadata:
  owner: finmate
  area: engineering
  reads: [03-domain-model.md, 05-architecture.md, 06-api-specification.md, 01-product-requirements.md]
---

# Add a domain feature (vertical slice)

Work **bottom-up through the layers**, in this order. Never start at the UI — it hides missing
invariants until the end, when they are expensive.

## 0. Before writing anything

1. Identify the **`F-xx`** requirement this serves in `docs/01-product-requirements.md`. If nothing
   matches, stop and ask — do not invent scope (doc 01 §8 lists what is deliberately excluded).
2. Read `docs/03-domain-model.md` for the canonical name of every entity and field. **Use those names
   exactly.** If you need a new entity, it goes in doc 03 first, then in code.
3. Check `docs/14-decisions-and-risks.md` Part 4 for a deferral. If the feature is on that list, stop.

## 1. Schema (`docs/03-domain-model.md` is the owner)

- Update the DDL **in doc 03** and the migration together; doc 03 is canonical, so code that disagrees
  with it is a bug. Use the `add-migration` skill for the mechanics.
- Every household-scoped table needs `household_id UUID NOT NULL` and an index **leading** with it.
- Money columns are `BIGINT ..._minor` + `CHAR(3) currency`. No exceptions (ADR-003).
- Add timestamps (`created_at`, `updated_at`) and a soft-delete `deleted_at` if the row is
  user-visible financial data.
- If the row is written from natural-language or offline input, it needs `idempotency_key` and/or
  `client_id` with a partial unique index.

## 2. Domain logic (`packages/domain`)

- Put the **pure** rules here: value objects, calculators, tree traversal. This package imports
  **nothing** — no Prisma, no Nest, no HTTP. It must be testable in isolation.
- Any money arithmetic added here needs a property-based test. Use the `write-invariant-test` skill.
- If the feature computes a derived value (balance, budget remainder, safe-to-spend, projection),
  it belongs here and **must not** be computed anywhere else, and **never by an LLM** (ADR-001).

## 3. Repository / service (the owning module)

- Put it in the module that owns the table per `docs/05-architecture.md` §3. Cross-module reads go
  through the owning service — **never** query another module's table directly.
- The tenancy rule: `household_id` comes from `TenantContext` (the session), **never** from input.
  Clients never send a `householdId`. A household-scoped query without a tenant context must throw
  (ADR-008).
- Emit an `audit_log` row for anything that changes financial state.
- If the feature is user-triggered AI cost, record it (`classification_decisions.cost_micros`).

## 4. GraphQL (`docs/06-api-specification.md` is the owner)

- Add the operation to the doc's schema **and** the code together.
- `Money` is a scalar serialised as `{ amountMinor: "200000", currency: "RSD" }` — `amountMinor` is a
  **string**, never a JSON number. Do not accept a float anywhere in an input type.
- Use cursor pagination for lists, the existing error-code enum for failures, and
  `version` + a typed `CONFLICT` for optimistic concurrency on updates.
- Add the operation to the **role matrix** in doc 06 §11 for `OWNER`/`ADMIN`/`MEMBER`/`VIEWER`.
  AI consent and provider config are `OWNER`-only.

## 5. UI (`docs/02-ux-flows-and-screens.md` is the owner)

- Check whether the screen spec already exists. If the feature adds a screen, spec it there first,
  with **both** a ~390 px and a ~1440 px layout.
- Render every amount through `<ui-money>`. Never format currency inline (ADR-003).
- Implement **all** states, not just the happy path: loading, empty, error, **offline**, and
  permission-denied. Offline figures must be labelled `as of <time>`.
- No hardcoded user-facing strings; both latin and cyrillic Serbian.

## 6. Tests

- Unit tests for the pure logic; integration tests (Testcontainers Postgres) for anything touching the
  database — including a **cross-tenant test** proving another Household cannot read or write the row.
- Property-based test if money is involved.
- Add the end-to-end journey to the Playwright suite if this is one of the ten MVP journeys.

## 7. Finish

- Tick the `AGENTS.md` Definition of Done — every box, including the 320/768/1280 px and keyboard pass.
- If the change altered a canonical decision, update the doc **and add an ADR** (`write-adr` skill).
- Say in the PR description which docs you changed and why. If code and docs disagreed, say which you
  fixed.
