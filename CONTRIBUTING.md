# Contributing to FinMate

Thanks for taking the time to look. This project has an unusual amount of written specification for
its size, and the quickest way to have a good first contribution is to read the document that owns
the area you are touching before you write code.

## Ways to contribute

- **Bug reports** — use the issue template. A failing input plus the machine state from
  [`AGENTS.md`](AGENTS.md) is worth more than a description.
- **Feature work** — open an issue first if the change is not already in
  [`docs/09-implementation-plan.md`](docs/09-implementation-plan.md). See _Do not build without
  asking_ in [`AGENTS.md`](AGENTS.md): household-sharing UI, bank/Open Banking import, native apps,
  multi-currency ledger, investments/net worth and model fine-tuning are deliberately out of scope.
- **Documentation** — `docs/` is canonical. Fixing a doc that disagrees with the code is a real
  contribution, and a missing gotcha entry is one of the most valuable things you can add.
- **Translations** — the app ships English (primary) and Serbian (latin + cyrillic). Adding a locale
  is a catalogue plus a `TranslationKey` derivation, not a fork.

## Getting set up

[`README.md`](README.md) has the full quickstart: prerequisites, `pnpm install`, `pnpm dev:infra`,
`pnpm db:migrate`, `pnpm db:seed`, then `nx run api:serve` and `nx run web:serve`. No AI provider key
is needed — with nothing configured the classifier is rules-only, which is a supported, tested mode.

Before you open a pull request, this should be green locally:

```bash
pnpm lint
pnpm typecheck
pnpm test            # needs the dev database running
pnpm test:evals      # if you touched categorization, prompts, rules or the seed content
nx run web:build     # if you touched apps/web — typecheck does NOT check Angular templates
```

## Which document owns your change

| Touching…                              | Read first                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Anything                               | [`docs/05-architecture.md`](docs/05-architecture.md) §2 — monorepo layout and the dependency rule |
| Money, Transactions, balances          | [`docs/03-domain-model.md`](docs/03-domain-model.md) — canonical glossary, DDL, invariants        |
| A feature                              | [`docs/01-product-requirements.md`](docs/01-product-requirements.md) — the `F-xx` catalogue       |
| Categorization, rules, prompts, AI     | [`docs/04-categorization-and-ai-engine.md`](docs/04-categorization-and-ai-engine.md)              |
| An API operation                       | [`docs/06-api-specification.md`](docs/06-api-specification.md)                                    |
| Auth, consent, AI data flow            | [`docs/08-security-privacy-and-compliance.md`](docs/08-security-privacy-and-compliance.md)        |
| Tests or evals                         | [`docs/10-testing-and-quality.md`](docs/10-testing-and-quality.md)                                |
| Debugging something that "should work" | [`docs/15-implementation-gotchas.md`](docs/15-implementation-gotchas.md)                          |

**Use the canonical vocabulary from doc 03 verbatim:** Household, Member, Account, Transaction, Split,
Category, CategoryKeyword, Merchant, Counterparty, Tag, Rule, Receipt, ReceiptItem, Budget, SavingGoal,
RecurringRule, ClassificationDecision, Correction, Insight, Alert, Proposal. Never "tenant", "vendor",
"wallet" or "envelope". Reference features as `F-xx`, decisions as `ADR-xxx`, invariants as `I-x`.

## Non-negotiables

These are architecture, not preference. A change that violates one is a bug even when the tests pass.
The short list (the full list with ADR citations is in [`AGENTS.md`](AGENTS.md)):

1. **Rules before AI.** normalize → resolve → rules → keywords → **then** AI. _(ADR-002)_
2. **Money is `BIGINT` minor units + ISO-4217 code — never a float, anywhere.** No `number`, no
   `parseFloat`, no `NUMERIC` in the money path, not even transiently. _(ADR-003)_
3. **Every household-scoped query filters by `household_id` from the session, never from client
   input.** A household-scoped query without a `TenantContext` must throw. _(ADR-008)_
4. **AI egress is EEA-only or local**, and an `_EU` suffix is not enough on its own — the endpoint must
   be configured with the EEA host it means. _(ADR-007, ADR-031)_
5. **The LLM never owns state, and the assistant never invents a number.** _(ADR-001, ADR-017)_
6. **No hardcoded user-facing strings.** Every string goes through `I18nService.t()`, with English and
   Serbian present. **`fm-money` is the only thing that formats money.**
7. **A new dependency, datastore or service needs an ADR first.** _(ADR-004, ADR-013)_

## Definition of Done

A change is not done until:

- [ ] **Tests**: unit for pure logic; integration for anything touching the database
- [ ] **Money arithmetic** covered by a property-based test where applicable
- [ ] **Error, empty, loading and offline states** handled — not just the happy path
- [ ] Verified at **320 / 768 / 1280 px**, and operable by **keyboard alone**
- [ ] **No hardcoded user-facing strings** — every string goes through `I18nService.t()`
- [ ] **Telemetry** added if the feature has a success metric
- [ ] `docs/` updated if a canonical decision changed — **plus an ADR if it is architectural**

## Branches and commits

Branch off `main` and keep one logical change per branch. A name like
`fix/offline-flush-after-unlock` or `feat/receipt-item-split` is fine; there is no enforced prefix.

Commit subjects here are **descriptive sentences that say what was wrong and what changed**, not
Conventional Commit prefixes. Compare:

```
The worker could not boot: two copies of @nestjs/core, and CI could only show a native stack trace
A correct two-factor code reloaded the page, because a bare form is not a form Angular knows
```

rather than

```
fix: worker
```

Write the body when the _why_ is not obvious from the diff: what you measured, what you rejected, and
what remains. Reference the task (`4.1.6b`), the decision (`ADR-038`), the feature (`F-26`) or the
invariant (`I-6`) by their canonical ids. If a change is deliberately incomplete, say so in the commit
message and in the docs — an honest recorded gap is the house style, and a silently missing one is not.

## Documentation and ADRs

`docs/` is the specification; code comments link to it rather than restating it. If your change alters
a canonical decision, update the owning document **and** add an ADR to
[`docs/14-decisions-and-risks.md`](docs/14-decisions-and-risks.md). Never decide an architectural
question silently.

## Pull requests

1. Keep the diff focused; unrelated reformatting makes review harder.
2. Make sure the checks above are green and CI passes.
3. Fill in the pull request template — particularly **what you verified**, and how, versus what you
   assumed. "Verified live" and "covered by a test" are different claims and the template asks which.
4. Be patient, and be prepared for a review that asks for evidence rather than agreement.

## License and sign-off

FinMate is licensed under the **GNU AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)). By submitting a
contribution you agree that it may be distributed under that license, and you confirm you have the
right to submit it.

We ask contributors to certify the [Developer Certificate of Origin](https://developercertificate.org/)
by signing off each commit:

```bash
git commit -s -m "Your descriptive subject"
```

That adds a `Signed-off-by: Your Name <you@example.com>` trailer. It is requested rather than gated by
CI today, but please include it so the provenance of the project stays clean.

## Questions

Open a discussion or an issue. For anything security-related, follow [`SECURITY.md`](SECURITY.md)
instead of opening a public issue.
