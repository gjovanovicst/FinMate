---
name: add-migration
description: "Add a PostgreSQL schema migration safely: expand/contract, forward-only, invariant test, and batched backfill."
whenToUse: "Use for any change to the database schema, including adding a column, table, index, or constraint, or backfilling data."
metadata:
  owner: finmate
  area: database
  reads: [03-domain-model.md, 11-devops-and-observability.md, 10-testing-and-quality.md]
---

# Add a migration

**Doc 03 is the canonical DDL.** A migration that leaves doc 03 stale is incomplete — update both in
the same change. Mechanics are in `docs/11-devops-and-observability.md` §6.

## Hard rules

1. **Forward-only.** No `down` migrations in production. To undo, write a new forward migration.
2. **Expand/contract for anything destructive or renaming.** Destructive changes need **two releases**:
   - *Release N (expand)*: add the new column/table, dual-write, backfill, keep the old one.
   - *Release N+1 (contract)*: stop reading/writing the old one, then drop it.
   Never drop or rename in the same release that code stops using the old shape.
3. **Never run migrations on application boot in production.** They run as a separate deploy step, so
   a failing migration does not leave a half-started app fleet.
4. **Never backfill in the migration transaction** for tables that can grow large. Emit a batched,
   resumable job instead (see below).

## Procedure

### 1. Update the canonical DDL first
Edit `docs/03-domain-model.md` §4. Choose names from its §1 glossary — never invent a synonym.

### 2. Write the migration
- Additive column: give it a default or make it nullable, **then** backfill, **then** add `NOT NULL`
  in a later step. A `NOT NULL` column with a volatile default locks the table on older Postgres.
- Create indexes `CONCURRENTLY` outside a transaction on large tables. Note that
  `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block — check the migration tool's
  transaction handling and disable it for that migration.
- Foreign keys: choose `ON DELETE` deliberately. Financial rows are soft-deleted, so `RESTRICT` or
  `SET NULL` is usually right; `CASCADE` on a ledger row is almost always wrong.
- Add `CHECK` constraints that encode invariants where the database can enforce them (for example
  `amount_minor > 0`, `currency` length).

### 3. Backfill as a job, not a statement
For anything beyond a few thousand rows:
- Batch by primary key (keyset pagination), not `OFFSET`.
- Make it **resumable and idempotent** — record progress, so a restart does not redo work.
- Throttle it; a backfill that saturates I/O takes the API down with it.
- Verify with a count query before and after, and log both.

### 4. Prove the invariants still hold
Run the money/invariant property tests (`write-invariant-test` skill). Specifically:
- `I-1` splits sum to the transaction amount — **still true** if you changed `transaction_splits`.
- `I-4` account balance is reconstructible from the transaction log — **still true** if you touched
  `transactions`, `kind`, or `amount_minor`.
- `I-5` budget consumption counts the right subtree — **still true** if you changed `categories`.
- `I-6` receipt items reconcile to the receipt total.
- `I-10` idempotency/client-id uniqueness survived.
- `I-11` category tree is still acyclic and depth ≤ 5.

### 5. Cross-tenant check
If you added a household-scoped table, confirm the tenant extension covers it and that a query
without a `TenantContext` **throws**. Add it to the cross-tenant test suite (doc 10 §7.1).

### 6. Verify on a realistic dataset
Test against the 10k / 100k / 1M presets in `docs/10-testing-and-quality.md` §10.2 — a migration that
is instant on an empty database can lock for minutes on a real one. Record the measured duration in
the PR, because that number determines the deployment window.

## Anti-patterns to refuse

- A migration that drops a column the running application still reads.
- `ALTER TABLE ... ADD COLUMN ... NOT NULL DEFAULT now()` on a large table in one step.
- Data transformation inside the schema migration with no way to resume.
- Editing a migration that has already been applied anywhere. Add a new one.
- Making doc 03 and the migration disagree. One of them is wrong; fix it before merging.
