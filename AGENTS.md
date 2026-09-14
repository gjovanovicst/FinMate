# AGENTS.md — FinMate

> **The name is not decided.** `FinMate` is a working title and **is already taken** by existing
> finance products (ADR-014, `docs/13-brand-and-naming.md`). Never hardcode a brand string — read
> `APP_NAME` from config. `Ostava` is the current recommendation, pending screening.

AI-first household budgeting app for **mobile and desktop**. The product promise, in one line:

> Type **`Lidl 2000`** and get a correctly categorised, budget-aware transaction in under five seconds.

**Machine state:** Node 24.20.0, pnpm 11.7.0, Go 1.27.0. **Docker is NOT available in this WSL distro**
(Docker Desktop integration is off) — this blocks Phase 0 tasks 0.2/0.3/0.9 and the "`pnpm dev` boots
the whole stack" exit criterion. See `docs/11-devops-and-observability.md` §2.0.

---

## Read the docs before you code

`docs/` is the **specification and it is canonical**. Do not restate it in code comments — link to it.
Read the document that owns your task before starting:

| If you are… | Read first |
|---|---|
| starting any task | `docs/05-architecture.md` §2 — monorepo layout + the dependency rule |
| touching money, Transactions, balances | `docs/03-domain-model.md` — **canonical glossary, DDL, invariants** |
| adding or changing a feature | `docs/01-product-requirements.md` — the `F-xx` catalogue |
| touching categorization, rules, prompts, AI | `docs/04-categorization-and-ai-engine.md` |
| adding an API operation | `docs/06-api-specification.md` |
| touching auth, consent, or AI data flow | `docs/08-security-privacy-and-compliance.md` |
| adding or changing tests/evals | `docs/10-testing-and-quality.md` |
| planning or sequencing work | `docs/09-implementation-plan.md` |
| making an architectural decision | `docs/14-decisions-and-risks.md` — **add an ADR, never decide silently** |

`docs/README.md` is the index.

**Use the canonical vocabulary from doc 03 verbatim:** Household, Member, Account, Transaction, Split,
Category, CategoryKeyword, Merchant, Counterparty, Tag, Rule, Receipt, ReceiptItem, Budget, SavingGoal,
RecurringRule, ClassificationDecision, Correction, Insight, Alert, **Proposal**. Never "tenant",
"vendor", "wallet" or "envelope". Reference features as `F-xx`, decisions as `ADR-xxx`, invariants as
`I-x`.

---

## Non-negotiable rules

These are architecture, not preference. Violating one is a bug even when tests pass.

1. **The LLM never owns state or computes money.** AI returns `Proposal` DTOs with a confidence; only
   the backend validates and persists. The model is never the source of truth. *(ADR-001)*
2. **Rules before AI.** normalize → resolve → rules → keywords → **then** AI. AI is the exception path,
   not the default. *(ADR-002)*
3. **Money is `BIGINT` minor units + ISO-4217 code — never a float, anywhere.** `2.000 RSD` is
   `200000n`. No `number`, no `parseFloat`, no `NUMERIC` in the money path, not even transiently.
   `amount_minor` is **always positive**; direction comes from `kind` (`EXPENSE`/`INCOME`). *(ADR-003)*
4. **Every household-scoped query filters by `household_id` resolved from the session — never from
   client input.** Clients never send a `householdId`. A household-scoped query without a
   `TenantContext` must **throw**. *(ADR-008)*
5. **AI egress is EEA-only or local.** `PARSE`/`CLASSIFY`/`NARRATE`/`OCR` may only reach a `LOCAL` model
   or a provider endpoint with an explicit `_EU` suffix. Anything else is a consent-gated exception.
   *(ADR-007)*
6. **The assistant never invents a number.** A constrained query planner computes facts server-side;
   the LLM only narrates them, and every numeral in its output must exist in the facts payload.
   *(ADR-017)*
7. **Corrections become rules — the model is never retrained.** Rule synthesis is proposed by the
   backend and confirmed by the user. *(ADR-010)*
8. **Confidence gates: ≥0.90 auto-apply · 0.60–0.89 verify · <0.60 ask.** `needs_review` is the
   *blocking* lane only; the nav badge counts the blocking lane only. *(ADR-009)*
9. **A new dependency, datastore, or service needs an ADR first.** We run Postgres + Redis and a modular
   monolith on a single node, deliberately. *(ADR-004, ADR-013)*
10. **The LLM provider is swappable.** Never call a vendor SDK from a feature module — go through
    `packages/ai`. *(ADR-007)*

---

## Commands

Phase 0 scaffolds these (doc 09). Write to this interface so the scripts land as specified:

```bash
pnpm dev            # boots the whole stack: Postgres, Redis, MinIO, api, web, worker
pnpm test           # unit + integration
pnpm test:evals     # golden-dataset AI evaluation — a CI gate (doc 10 §5.5)
pnpm lint           # includes the dependency-boundary rules
pnpm typecheck
pnpm db:migrate     # forward-only, expand/contract (doc 11 §6)
```

Until Phase 0 lands, there is nothing to run — do not invent scripts that the repo does not have.

---

## Definition of Done

A change is not done until (doc 09 §8):

- [ ] **Tests**: unit for pure logic; integration for anything touching the database
- [ ] **Money arithmetic** covered by a property-based test where applicable
- [ ] **Error, empty, loading and offline states** handled — not just the happy path
- [ ] Verified at **320 / 768 / 1280 px**, and operable by **keyboard alone**
- [ ] **No hardcoded user-facing strings** (i18n; both latin and cyrillic Serbian)
- [ ] **Telemetry** added if the feature has a success metric
- [ ] `docs/` updated if a canonical decision changed — **plus an ADR if it is architectural**

---

## Gotchas specific to this project

- **Serbian input is the hard part.** Latin *and* cyrillic, `.` as thousands separator and `,` as
  decimal, `2k` shorthand, `plata`/`penzija`/`uplata` mean **income**. Normalisation lives in
  `packages/nlp` and runs on **both client and server** — never write a second parser.
- **Two levels of categorisation**: transaction-level *and* receipt-item-level, plus `Split`s. A Lidl
  basket is not one category. Every aggregation must be explicit about which level it counts. *(ADR-015)*
- **`occurred_at` (instant) and `occurred_local_date` (calendar day) are both required.** Month
  boundaries are a local-calendar question; conflating them breaks reports across timezones.
- **`račun` is ambiguous in Serbian** — it means both *Account* and *receipt/bill*. Never use bare
  `račun` in UI copy for a Receipt.
- **Confidence is calibrated, not raw.** Never gate on the model's self-reported number. *(ADR-009)*
- **Offline capture is idempotent** via client-generated `client_id` + `idempotency_key`. Never
  "check then insert" — rely on the unique index. *(ADR-016)*
- **If code and docs disagree, that is a bug in one of them.** Fix the right one and say which.

---

## Do not build without asking

Household sharing UI (`F-29`) · bank/Open Banking import (`F-33`) · native apps · multi-currency
ledger · investments/net worth · model fine-tuning. See `docs/01-product-requirements.md` §8 and
`docs/14-decisions-and-risks.md` Part 4.

---

## Skills

Procedures for repeated work live in `.dsh/skills/`. Load one with the `skill` tool when the task
matches: `add-domain-feature`, `add-migration`, `change-capture-pipeline`, `write-invariant-test`,
`pre-release-check`, `write-adr`.
