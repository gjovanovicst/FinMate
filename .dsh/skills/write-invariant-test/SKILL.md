---
name: write-invariant-test
description: "Write property-based tests that prove the money and ledger invariants (I-1 to I-12) still hold."
whenToUse: "Use whenever you touch money arithmetic, the ledger, splits, receipts, budgets, or the category tree — and whenever you add a calculator."
metadata:
  owner: finmate
  area: testing
  reads: [03-domain-model.md, 10-testing-and-quality.md]
---

# Write an invariant test

Money correctness is not negotiable, and **example-based tests do not catch sign, rounding and
accumulation bugs** — those appear at boundaries you did not think to write down. Property-based
testing (fast-check) searches the input space for a counterexample instead.

The invariants are defined in `docs/03-domain-model.md` §5. That list is canonical; this skill is how
to test it. Each invariant maps to a bug class that costs user trust.

## The invariants and what each one catches

| ID | Invariant | Bug class it catches |
|---|---|---|
| **I-1** | `sum(splits.amount_minor) == amount_minor`, **or** no splits and a non-null `category_id` — never both, never neither | Split rounding drift; a transaction that belongs to no category |
| **I-2** | `occurred_local_date` agrees with `occurred_at` in the Household's timezone | Month-boundary corruption across timezones/DST |
| **I-3** | A Transaction's `category_id` has a matching `kind` | An expense landing in an income category |
| **I-4** | Balance = `opening_balance` + Σ income − Σ expense (± transfers), over non-void non-deleted rows | The one that ends the product: a balance that disagrees with reality |
| **I-5** | Budget consumption counts only `CONFIRMED`, non-deleted rows inside the subtree when `include_subcategories` | Double-counting nested categories; counting `PENDING` |
| **I-6** | Receipt items sum to `total_minor` within 1 minor unit, or `reconciliation != 'MATCHED'` | Silently "matching" a receipt that does not add up |
| **I-7** | No `PENDING` Transaction affects a budget, balance or Insight | Unconfirmed data leaking into reports |
| **I-8** | `needs_review` ⟺ `confidence < 0.60` or `category_id IS NULL` — **blocking lane only** | The advisory lane (0.60–0.89) wrongly setting the flag |
| **I-9** | Every non-`MANUAL` Transaction has ≥ 1 `ClassificationDecision` | Un-explainable categorisation |
| **I-10** | `idempotency_key` / `client_id` unique per Household; replays are idempotent | Duplicate captures, especially after an offline flush |
| **I-11** | Category tree depth ≤ 5 and acyclic | Infinite recursion in rollups |
| **I-12** | Deleting a Category with Transactions is refused | Orphaned ledger rows |

## How to write one

1. **Write the invariant as an oracle, not a re-implementation.** For I-5, compare the optimised
   subtree query against a naive walk of the tree. If you re-implement the same algorithm twice, you
   have tested nothing — you have tested that you type consistently.

2. **Generate realistic inputs, not random noise.** Constrain generators to legal states: positive
   minor units, valid enum values, categories that respect `kind`. A generator that produces illegal
   data tests nothing and wastes shrinking time.

3. **Use `bigint` for money in generators.** If a generator produces a `number`, the test itself has
   already violated ADR-003.

4. **Add a seed policy.** Log the seed on failure and allow replaying it, so a CI failure is
   reproducible locally. A property test that cannot be reproduced is worse than no test.

5. **Assert the reconstruction, not the stored value.** For I-4, do not compare against a cached
   balance — recompute from the transaction log and assert equality. That is the actual guarantee.

6. **Keep the count low and the value high.** A handful of strong properties beats fifty shallow ones.
   Every invariant in the table above should have at least one.

## Example shape

```ts
import fc from 'fast-check';

// I-4: a balance must be reconstructible from the transaction log.
it('I-4: reconstructed balance equals the stored balance', () => {
  fc.assert(
    fc.property(arbTransactionList(), (txns) => {
      const stored = computeBalanceFromLog(txns); // the production path
      const naive = txns
        .filter((t) => t.status === 'CONFIRMED' && t.deletedAt === null)
        .reduce(
          (acc, t) =>
            acc + (t.kind === 'INCOME' ? t.amountMinor : -t.amountMinor),
          0n, // bigint, never number
        );
      expect(stored).toBe(naive);
    }),
    { numRuns: 500 },
  );
});
```

## When a property fails

- **Shrink it and read the minimal counterexample** — that is the bug, and it is usually a boundary
  case (a zero amount, a single-day month, a transfer to the same account, a category at max depth).
- Fix the **production** code, not the generator, unless the generated state is genuinely illegal.
  If you weaken the generator to make a test pass, you have deleted the test.
- If the counterexample is a real product question (for example "what *should* a zero-amount
  transaction do?"), stop and ask — do not invent semantics to make CI green.

## Where these run

Unit-test layer, in `packages/domain`, with no database. They run on **every PR** and are merge-blocking
(doc 10 §2). The nightly job additionally runs them against a seeded realistic dataset.
