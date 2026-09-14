# Golden dataset v1 — `packages/nlp/test/golden/`

The deterministic parsing gate from docs/09 §4 task 2.1.2, at the location docs/10 §1 mandates.
It is part of `pnpm nx run nlp:test`, which is part of `pnpm test` in CI — not an opt-in script.

**300 cases**, drawn from the three slices task 2.1.2 names, per the staged-delivery note in
docs/04 §11.1:

| Slice | Cases | Purpose (docs/04 §11.1) |
|---|---|---|
| `AMOUNT_FORMAT` | 150 | `.` / `,` / space / `k` / currency suffix |
| `MERCHANT` | 110 | Serbian merchant and biller inputs, the common path |
| `BULK` | 40 | Segmentation of multi-transaction lines |

The fixed slices grow to the full 1 300-case composition (adding `CYRILLIC`, `COUNTERPARTY`,
`RECEIPT_ITEM`, `SHOULD_ASK` and the growing `REGRESSION` slice) before the Phase 5 launch gate.
`EXPECTED_V1_CASES` in `harness.ts` is asserted, so a fixture file that stops being collected fails
the suite instead of passing quietly over a shrunken dataset. Bump it when the composition grows.

## The rule this dataset lives by

**Every expectation is derived from docs/04 §3 or from hand-computed Serbian reasoning — never from
what `extractFragments` happens to return.** The generator (`generate-fixtures.mjs`) does not import
`@finmate/nlp` and never runs the parser. If it did, the harness would assert that the code does what
the code does: it would pass forever and catch nothing.

The loop that produced these cases, and the loop any new case must follow:

1. write the expected values from the specification by hand;
2. run the harness;
3. **if it fails, decide which side is wrong** — parser bug or wrong expectation — and record which;
4. report every disagreement.

A dataset that finds nothing on its first run is usually a snapshot of the implementation. This one's
first run found a parser bug (see `git log`/the task report): the tokenizer read `A1 199` — the shipped
`A1` Merchant and a 199 RSD top-up — as the single thousands group `1 199`, overstating the amount
six-fold. `AMOUNT_TOKEN` now refuses to *begin* a group inside an alphanumeric token.

## Fixture format

One JSON array per slice in `fixtures/`, each element a `GoldenCase` (see `types.ts`):

```json
{
  "id": "merchant-0001",
  "slice": "MERCHANT",
  "input": "Lidl 199",
  "today": "2026-09-14",
  "ledgerCurrency": "RSD",
  "expected": {
    "amountMinor": "19900",
    "currency": null,
    "kind": "EXPENSE",
    "occurredOn": null,
    "description": "Lidl",
    "tokens": ["lidl"],
    "candidates": 1
  },
  "note": "common path: merchant name plus amount",
  "provenance": "hand-labelled",
  "addedIn": "2026-09-14"
}
```

* **`amountMinor` is a string.** `bigint` does not survive JSON, and a JSON number would round past
  `Number.MAX_SAFE_INTEGER` and reintroduce the float ADR-003 excludes. The harness compares
  `BigInt` to `BigInt`.
* **`today` and `ledgerCurrency` are required on every case.** `extractFragments` takes both as
  options; a case that read the clock would not be reproducible. `juče` is only meaningful in the
  Household's timezone (docs/03 §3.2).
* **A present key in `expected` is asserted; an absent key is not.** Cases where docs/04 §3 leaves the
  answer open deliberately omit the field (see *Known gaps*) rather than pinning the implementation's
  current choice.
* `BULK` cases use an array of expectations, one per fragment — the count is the segmentation
  assertion. Other slices use a single object.
* `provenance` is `synthetic` for the cross-product rows of the amount-format slice (machine-composed
  from hand-written axes) and `hand-labelled` elsewhere. It records how the row was produced, not
  where its expectation came from, which is always the spec.
* A case id may not contain a UUID and the input may not contain one either (docs/10 §5.2).

### How the amount-format slice was generated

The interesting space is the *interaction* of the grouping separator, the decimal separator, the `k`
shorthand and the currency suffix, which is combinatorial. `generate-fixtures.mjs` therefore composes
130 rows as **26 numeric forms × 5 currency suffixes**, plus **20 hand-written rows** for the forms the
axes cannot express honestly (currency words, the `kg` lookahead, exact bigint past 2^53, currency
inheritance, an injected JPY ledger currency). Each axis entry carries its own hand-computed minor
units and candidate count (`AMOUNT_FORMS`), so composition never invents an expectation. All three
currencies on the suffix axis are scale-100, which is what lets the suffix change `currency` without
changing `minor` — a JPY row would break that assumption, so none is generated.

## How to add a case

1. Add a row to the relevant table in `generate-fixtures.mjs`, with the expectation derived from
   docs/04 §3 and a `note` saying why. For `AMOUNT_FORMAT`, prefer a new axis entry over a new special.
2. `node packages/nlp/test/golden/generate-fixtures.mjs` (it refuses a composition that is not
   150/110/40 for v1).
3. `pnpm nx run nlp:test`.
4. If it fails, decide which side is wrong. Parser bug → fix `packages/nlp` **and add a focused test
   in `src/extract.spec.ts`** so the bug has a named regression test outside the dataset. Wrong
   expectation → fix the expectation and record why. Spec ambiguous → leave the field unpinned and add
   a line to *Known gaps* below.

Do not regenerate a fixture from parser output. If that ever seems easier, the case is being written
for the wrong reason.

## What the harness asserts

Per fragment: `amountMinor` (as bigint), `currency`, `kind`, `occurredOn`, `description`, `tokens`,
`candidates` count, `needsDirectionConfirmation` — whichever the case pins — and, for `BULK`, the
number of fragments segmentation produced. That is the **parsing half** of the grader in docs/10
§5.4: *segmentation* (fragment count) and *extraction* (`amountMinor` and `kind` exact).

Failures are aggregated: every case in a slice runs, and the slice then fails once with a report
naming each case id, input, field, expected and actual. The per-slice composition is printed on every
run.

The harness is mutation-verified: perturbing an `amountMinor`, a `tokens` array, a `description` or a
fragment count in the fixtures fails the suite and prints the diff.

## What it does NOT assert, and which docs/04 §11.2 gates are still unattached

This is a **level-1 deterministic** suite (docs/10 §1.3, §2). It asserts parsing. It does **not**
assert categorisation accuracy, and nothing here should be read as covering the §11.2 accuracy or
confidence gates.

| docs/04 §11.2 gate | Needed before it can be asserted |
|---|---|
| Category accuracy top-1 ≥ 96 % (calibrated ≥ 0.90 bucket) | CLASSIFY + calibration — Sprint 2.2/3.x |
| Category accuracy top-3 ≥ 99 % | CLASSIFY + candidates |
| Overconfident-wrong rate ≤ 1.5 % | calibrated confidence (ADR-009) |
| Should-ask recall ≥ 90 % | confidence plus the 100-case adversarial slice, not yet populated |
| Semantic-preservation 100 %, fabricated-numeral 0 | NARRATE (F-23, Phase 3) |
| p95 latency ≤ 1.5 s — cost ≤ $0.002 | the live pipeline and recorded provider usage; docs/10 §1.4 forbids latency assertions in the unit suite |

Category ground truth is not in this dataset on purpose. docs/10 §5.1 carries `categoryPath`,
`fixtureTree`, `splitCount`, `maxConfidence` and `receiptItems`; none is assertable here because
classification does not exist, and `fixtureTree` would need a synthetic tree that does not exist yet
(docs/11 §2.3 places the seed tree under `packages/domain/seed/`, but it is inlined in
`apps/api/prisma/seed.ts`, and `packages/nlp` may not depend on `apps/api`). Those fields belong with
the classification slices in Sprint 2.2. `splitCount` is covered implicitly by the `BULK` array
length; the rest is not.

## Known gaps

Cases whose expectation could not be established from the specification. Each is either left out or
has the undecidable field deliberately unpinned.

1. **`kind` of a refund/negation fragment.** docs/04 §3.1 says `vraćeno` / `storno` / `refund` "flag
   for user confirmation rather than guessing a sign", but §3.2's interface has only
   `EXPENSE | INCOME | UNKNOWN` and no flag field. `packages/nlp` documents an extra
   `needsDirectionConfirmation` field and leaves `kind` at the expense default. The refund cases pin
   the amount, description, tokens and the flag — **not `kind`**.
2. **More than one numeric token in one fragment** (`kupio 2 mleka 350`, `Lidl 2000 3500`).
   docs/04 §3.1 defines no precedence. The implementation's rule (a currency-suffixed token wins,
   otherwise the last token) is not in the spec, so no case asserts which number is the amount.
3. **A number glued to a description** (`Lidl2000`). The spec's shape is `description amount` with
   whitespace. The dedicated unit test records the implementation's choice; the golden set does not
   assert it.
4. **Malformed decimals** (`1.2000`, `2.000,`, `1.2.3`, `31.02.2026` used as an amount). The spec
   defines `.`/space grouping and `,` decimals for well-formed input and is silent on the rest,
   including the truncation of a third decimal.
5. **Uppercase `2K`.** The spec names `2k`; case-insensitivity is an implementation nicety.
6. **A bare merchant name ending in a digit** (`A1` with no amount) still yields a 1 RSD amount from
   the digit inside the name. The §3 fix stops a *group* from starting mid-name; the plain-digit
   reading is a separate question the spec does not answer, and fixing it would break `Lidl2000`,
   which is not obviously wrong either. Flagged as a follow-up, not asserted.
7. **Cyrillic currency words and Cyrillic merchant names** (`2000 динара`, `Лидл 2000`) belong to the
   `CYRILLIC` slice from docs/04 §11.1, which is not part of v1. `BULK` contains two Cyrillic rows
   only because Cyrillic conjunctions (`и`, `па`) are segmentation, which is this slice's subject.
   `packages/nlp`'s existing `transliterate.spec.ts` and `extract.spec.ts` cover the fold.
