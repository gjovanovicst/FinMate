# 14 — Decisions & Risks

Two registers: **architecture decision records** (what we decided and why, so it is not relitigated
in six weeks) and a **risk register** (what could sink this, ranked by expected damage).

ADR numbers are referenced from every other document in this set. **Do not renumber.** New decisions
append with the next free number.

---

## Part 1 — Architecture Decision Records

### ADR-001 — The LLM never owns state or performs arithmetic
**Status:** Accepted · **Supersedes:** the implicit "AI does everything" framing in the source transcript

**Context.** The product is built around AI interpretation of financial input. The obvious naive
design lets the model parse, categorise, compute and write. That design is unusable for money: model
output is non-deterministic, unauditable, occasionally confidently wrong, and impossible to test.

**Decision.** All persistent state and all arithmetic live in the deterministic backend. The AI layer
returns only `Proposal` value objects with a confidence and a rationale. The classification module
validates and persists. Balances, budget consumption, safe-to-spend, projections and goal progress
are computed by pure backend functions and **never** by a model.

**Consequences.**
- ✅ The worst AI failure is a mis-categorised row the user fixes in one tap — never a wrong balance.
- ✅ The AI layer is swappable, testable and mock-able; the product degrades gracefully without it.
- ✅ Prompts cannot leak other data because the model is never the query engine (see ADR-017).
- ⚠️ More backend code than an "AI does it all" prototype: the deterministic calculators must be
  written properly, with tests. This is the correct place to spend effort.
- ⚠️ Requires discipline in review: any PR that lets a model response reach the database unvalidated
  is rejected.

**Alternatives rejected.** (a) LLM-as-orchestrator with tool calls that write directly — untestable,
unauditable, and one hallucination away from corrupting a ledger. (b) LLM computes and the backend
"double-checks" — doubles the work and still leaves a divergence path.

---

### ADR-002 — Deterministic rules run before AI (cheap-first pipeline)
**Status:** Accepted

**Context.** Most household input is repetitive. `Lidl`, `Maxi`, `Shell`, `EPS`, `plata` recur
constantly. Sending every input to a model is slow, costs money per keystroke, and is *less* accurate
than a simple lookup for the cases it handles.

**Decision.** The pipeline is ordered by cost: normalise/extract → entity resolution → rules engine →
keyword scoring → AI only if still unresolved → confidence gate. AI is the exception path, not the
default path.

**Consequences.**
- ✅ ~70–85 % of steady-state entries cost $0 and resolve in <30 ms.
- ✅ Deterministic decisions are explainable ("matched your rule") and unit-testable.
- ✅ A provider outage degrades quality, not availability.
- ⚠️ Two sources of categorisation truth means the rules engine needs real tests and a conflict model.
- ⚠️ Rule sets can rot; mitigated by hit-count telemetry and the weekly `rules.audit` job.

**Alternatives rejected.** (a) AI-first with rules as an optimisation — inverts the cost model and
makes the common case slow and expensive. (b) Rules-only — cannot handle the long tail that is the
entire product promise.

---

### ADR-003 — Money is integer minor units plus an ISO-4217 currency code
**Status:** Accepted

**Context.** Floating point cannot represent decimal money exactly (`0.1 + 0.2 !== 0.3`), and a
finance app that is off by a para is a finance app the user stops trusting.

**Decision.** Every monetary column is `BIGINT amount_minor` (always positive) plus `CHAR(3) currency`.
Direction is carried by a `kind` enum, never by a sign. `1 RSD = 100` minor units — values are
`200000` for `2.000 RSD`. No `float`, `double` or `NUMERIC` in the money path, not even transiently in
the client or the parser. The GraphQL `Money` scalar serialises `amountMinor` as a **string** so it
survives JavaScript's `Number.MAX_SAFE_INTEGER` boundary.

**Consequences.**
- ✅ Exact arithmetic; no rounding drift; sign bugs are structurally prevented.
- ✅ JSON transport cannot silently corrupt large values.
- ⚠️ Every formatter/parser must convert consciously; enforced by a single `ui-money` component and a
  single `Money` value object.
- ⚠️ Percentages (budget progress) require explicit, documented rounding rules.

**Alternatives rejected.** (a) `NUMERIC(19,4)` — correct but encourages sign conventions and is
awkward across JSON boundaries. (b) Decimal.js everywhere — a runtime dependency in the hot path for
a problem integers already solve.

---

### ADR-004 — Nx monorepo, modular monolith, NestJS + GraphQL API
**Status:** Accepted

**Context.** A team of 1–2 engineers must ship a web client, an API and background workers. Shared
domain logic (money, parsing, rules) must run in more than one place without duplication.

**Decision.** A single pnpm + Nx monorepo containing `apps/api`, `apps/web`, `apps/worker` and pure
`packages/*` (domain, nlp, rules-engine, ai, contracts). The backend is a **modular monolith** with
enforced module boundaries and no network hops between features. The API is NestJS with GraphQL
(code-first) plus a small REST surface.

**Consequences.**
- ✅ Shared, dependency-free domain packages imported by both client and server — one parser, two runtimes.
- ✅ One CI pipeline, one version, atomic cross-cutting changes.
- ✅ Boundaries are enforced by lint rules rather than by deployment topology.
- ⚠️ Nx is a learning investment; a plain pnpm workspace is the fallback if it slows the team down.
- ⚠️ A monolith requires discipline: modules must not reach into each other's tables. Enforced in review.

**Alternatives rejected.** (a) Microservices — premature for this scale; multiplies ops cost. (b) Two
repos — guarantees drift between the client parser and the server parser. (c) REST-only — the read
shapes (transaction + splits + tags + receipt items + classification decision) make over-fetching a
real mobile problem.

---

### ADR-005 — Prisma as the ORM and migration tool
**Status:** Accepted (revisit at Phase 2 if recursive queries become painful)

**Context.** The schema is large ([03](03-domain-model.md)) and evolves quickly during Phases 1–3.
Migrations must be reviewable and CI-runnable.

**Decision.** Prisma for schema definition, typed client and migrations, with raw SQL escape hatches
for the recursive category rollups, budget subtree consumption and `pg_trgm`/`pgvector` queries.

**Consequences.**
- ✅ Type-safe data access across the monolith; fast, reviewable migrations.
- ✅ The typed client makes it hard to forget `household_id` (paired with the tenant extension).
- ⚠️ Prisma's query builder is a poor fit for recursive CTEs; those live in hand-written SQL with
  their own tests.
- ⚠️ Vendor lock-in risk is modest — the schema is plain PostgreSQL and portable.

**Alternatives rejected.** TypeORM (weaker typing, migration ergonomics), Drizzle (excellent, but
slightly less mature tooling for a team optimising for speed), hand-rolled SQL (no typing, slower).

**Amendment (Phase 0, task 0.3) — Prisma 7 changes the mechanics, not the decision.**

Three breaking changes were encountered and are now baked into the repo:

1. **The connection URL left `schema.prisma`.** It lives in `prisma.config.ts` for CLI commands, and
   the runtime client receives it through a **driver adapter** (`@prisma/adapter-pg`). Consequence:
   there is exactly one place the CLI learns the URL, and the client is explicitly constructed.
2. **`prisma-client-js` is gone; the generator is `prisma-client` with a mandatory `output`.** The
   client is imported from `apps/api/src/generated/prisma`, not from `@prisma/client`.
3. **`prisma migrate dev` is forbidden in this repo.** Prisma's schema language cannot express what
   doc 03 requires, so a generated migration would silently **drop 44 CHECK constraints, 18 partial
   indexes and 3 expression indexes**. Migrations are therefore hand-authored SQL extracted from
   doc 03, and `schema.prisma` is *derived* by `prisma db pull` with `migrate diff` as the drift
   check. This is ADR-005's "raw SQL escape hatch" becoming the default path — which is the honest
   outcome, given doc 03 is the canonical DDL.

---

### ADR-006 — Angular SPA + PWA-first; no SSR in v1
**Status:** Accepted

**Context.** The app must serve desktop and mobile well, and the team is fluent in Angular. The app
sits behind authentication, so there is no SEO surface for serverside rendering to serve.

**Decision.** A single responsive Angular application, installable as a PWA, with a service worker
for app-shell caching and offline capture. No SSR/prerender in v1. Marketing pages, if needed, are
served separately by a static site.

**Consequences.**
- ✅ One codebase covers both platforms; updates ship instantly without store review.
- ✅ Client-side execution of `packages/nlp` gives an instant capture preview.
- ⚠️ iOS PWA push is limited and IndexedDB storage may be evicted under pressure — both documented
  honestly in [07](07-platform-strategy-mobile-desktop.md) with mitigations.
- ⚠️ If App Store presence becomes a requirement, Capacitor wraps the same app (ADR-012).

**Alternatives rejected.** SSR/Universal (no SEO need, real cost), React Native or Flutter (second
codebase, throws away team fluency), native (a year of work before the thesis is tested).

---

### ADR-007 — Provider-agnostic AI abstraction with per-task routing
**Status:** Accepted

**Context.** The source conversation asked for it explicitly, and the commercial logic agrees: model
prices and capabilities change every few months, and a hard dependency on one vendor is both a cost
and an availability risk.

**Decision.** One `AiProvider` interface (`parse`, `classify`, `narrate`, optional `ocr`/`embed`)
with adapters for OpenAI, Anthropic, Gemini, DeepSeek and a local model. Routing is declarative and
per-task, with timeouts, circuit breakers, cost recording and prompt versioning on every call.

**Hard constraint (added during documentation review, raised as Q-3 in [08](08-security-privacy-and-compliance.md)).**
Any task carrying the user's own free text (`PARSE`, `CLASSIFY`, `NARRATE`) or an image (`OCR`) may be
routed **only** to a `LOCAL` model or to a provider endpoint **inside an adequacy-covered region
(EEA)**. An endpoint outside the EEA is a GDPR Chapter V transfer and needs the household's explicit,
recorded consent. A provider that cannot offer an EEA endpoint cannot serve those tasks at all.

The canonical routing table therefore leads with `LOCAL` for `PARSE`, `CLASSIFY` and `OCR` and requires
an explicit `_EU` suffix on every fallback ([04 §9](04-categorization-and-ai-engine.md#9-ai-provider-abstraction)).
An earlier draft defaulted `CLASSIFY` to a non-EEA endpoint for cost; that was a compliance defect,
not a tuning choice.

**Consequences.**
- ✅ Cheap models on the high-volume path, strong models only where quality is visible to the user.
- ✅ Provider outage degrades to the next provider, then to rules-only — never to an outage.
- ✅ Cost per household becomes measurable rather than estimated.
- ✅ Residency is enforced by the routing type, so a non-EEA endpoint cannot be selected by accident.
- ⚠️ Local-first routing converts marginal API cost into fixed host cost; the break-even is a capacity
  question tracked in [11 §11](11-devops-and-observability.md). Privacy is not traded for cost.
- ⚠️ Abstraction has a cost: features unique to one vendor are harder to adopt. Accepted deliberately.
- ⚠️ Output-shape differences require per-adapter normalisation and per-provider evaluation runs.

**Alternatives rejected.** Single-provider (cost and availability risk), or per-feature ad-hoc calls
(no routing, no cost visibility, no fallback).

---

### ADR-008 — Household-scoped tenancy from day one; sharing UI deferred
**Status:** Accepted

**Context.** Family sharing is a v2 feature, but retrofitting a tenancy boundary onto an existing
schema and query layer is one of the most expensive and riskiest migrations in software.

**Decision.** Every household-scoped table carries `household_id NOT NULL` from the first migration,
every request carries a server-resolved `TenantContext`, and a Prisma client extension **throws** if a
household-scoped model is queried without one. The Family UI ships in v2.

**Consequences.**
- ✅ Family sharing becomes additive UI, not a data migration.
- ✅ Cross-tenant leakage is structurally hard rather than merely discouraged; there is a dedicated
  adversarial test suite.
- ⚠️ Every solo user has a household of one — a small modelling overhead accepted for the optionality.
- ⚠️ Optional PostgreSQL RLS is recommended before any enterprise conversation.

**Alternatives rejected.** Adding tenancy later (unacceptable migration risk), or making the user the
only tenant boundary (cannot express shared finances at all).

**Amendment (Phase 0, task 0.5) — the boundary is a four-way classification, not a boolean.**

Implementing the guard exposed two things the original decision did not anticipate:

- **Not every table in a household's world carries `household_id`.** Six child tables
  (`transaction_splits`, `transaction_tags`, `receipt_items`, `merchant_aliases`,
  `counterparty_aliases`, `goal_contributions`) do not, so there is **no tenant predicate to inject**.
  A bare `receipt_items.findMany()` would return every Household's rows. Direct access is therefore
  **refused**, and these must be reached through their scoped parent via a relation load.
- **`households` has no `household_id` either** — it is scoped by its own primary key. Without a
  special case, `households.findMany()` would list every Household on the platform. The guard injects
  `id = householdId`.

The guard accordingly classifies every model into exactly one of four groups —
`HOUSEHOLD_SCOPED_BY_COLUMN` (24), `HOUSEHOLD_SCOPED_BY_ID` (1), `PARENT_SCOPED` (6), `GLOBAL` (5) —
and a unit test asserts this classification matches the Prisma schema exactly. That test **caught a
real defect during implementation**: six models were originally mis-listed as household-scoped
despite having no `household_id` column. Adding a table without classifying it now fails CI rather
than silently leaking (risk R-10).

`findUnique` is also refused on scoped models, because Prisma's `where` there accepts only unique
fields — the scope could not be enforced in the query, and checking afterwards would push the
obligation onto every call site. `findFirst` is the required form.

---

### ADR-009 — Calibrated confidence gates (0.90 auto / 0.60 verify / below ask) with a review queue
**Status:** Accepted

**Context.** An AI that is confidently wrong about money is worse than one that admits uncertainty.
Users do not complain about a mis-categorisation as much as they quietly stop trusting the app.

**Decision.** Three states driven by **calibrated** confidence: ≥0.90 auto-apply silently; 0.60–0.89
apply with a 🟡 verify badge and a review-queue entry; <0.60 save as `PENDING` and ask. Raw model
confidence is never trusted directly — it is mapped through an isotonic regression refit weekly, with
a conservative shrink until enough samples exist. Thresholds are per-household tunable.

**Consequences.**
- ✅ The review queue stays small enough to be a convenience rather than a chore.
- ✅ The overconfident-wrong rate becomes a measurable, CI-gated number (≤1.5 %).
- ✅ Bulk entry never blocks on one ambiguous row — the decisive UX detail.
- ⚠️ Calibration requires volume; early behaviour is intentionally conservative and will ask more.
- ⚠️ A second data path (the review queue) must be designed, not just the happy path.

**Refinement (canonical, added during documentation review).** The three states map onto a review
queue with exactly **two lanes**, and conflating them was an ambiguity in the first draft of
[04 §7](04-categorization-and-ai-engine.md#7-stage-6-confidence-gates):

| Lane | Membership | Queue badge |
|---|---|---|
| **Blocking** | `needs_review = true` — i.e. `confidence < 0.60` or `category_id IS NULL` ([03 I-8](03-domain-model.md#5-invariants-enforced-in-the-service-layer--tests)) | Counted |
| **Advisory** | `category_source = 'AI'` with `confidence` in `[0.60, 0.90)` — applied and valid, worth a glance | Not counted |

The advisory lane is derived from existing columns and needs no schema change. **The nav badge counts
the blocking lane only**, because a badge that never clears is a badge users learn to ignore — and an
ignored badge means corrections stop happening, which kills the learning loop (ADR-010) and with it
the moat.

**Alternatives rejected.** A single confidence threshold (either noisy or nagging), trusting raw model
confidence (systematically overconfident), or no confidence at all (silent corruption).

---

### ADR-010 — Learning via rule synthesis and household few-shot examples, not fine-tuning
**Status:** Accepted

**Context.** The compounding moat is per-household knowledge. The question is the mechanism: retrain a
model, or accumulate rules and examples?

**Decision.** Learning happens through (a) explicit, user-confirmed rules synthesised from corrections,
and (b) household-specific few-shot examples drawn from real corrections and injected into the prompt.
**No fine-tuning.** The backend decides when a correction is unambiguous enough to propose a rule; the
user confirms; the model is never the mechanism of record.

**Consequences.**
- ✅ Day-one capability with no training pipeline, no MLOps burden, and no cold-start model.
- ✅ Learning is inspectable and editable — the user can see and delete "what the app learned".
- ✅ Improvements are instant and per-household, matching the product's actual differentiation.
- ⚠️ Rule sets can accumulate cruft; mitigated by hit-count telemetry, decay review, and a rule manager UI.
- ⚠️ Prompt size grows with examples; mitigated by retrieving only the most relevant k examples.

**Alternatives rejected.** Fine-tuning per household (absurd cost and latency), global fine-tuning (no
personalisation, needs labelled data we do not have), embedding-only k-NN (works, but is opaque and
cannot express "never categorise `ulje` as gorivo").

---

### ADR-011 — Single ledger currency per household in v1
**Status:** Accepted

**Context.** Multi-currency ledgers force every balance, budget, rollup and projection to carry an FX
policy, historical rates, and rounding rules. That is a large amount of complexity for a Serbian
household that earns and spends RSD.

**Decision.** One `ledger_currency` per household. Every transaction inherits it. The column exists on
both `households` and `transactions` so multi-currency is a feature addition, not a schema migration.

**Consequences.**
- ✅ Every invariant in [03 §5](03-domain-model.md#5-invariants-enforced-in-the-service-layer--tests)
  stays simple and testable.
- ✅ Budgets, rollups and projections never need FX.
- ⚠️ Users with EUR income are not served in v1. Accepted; it is not the target persona.
- ⚠️ A future multi-currency design will need an FX-rate table and a "reporting currency" concept.

**Alternatives rejected.** Multi-currency from day one (large complexity, unvalidated demand),
or storing everything in RSD silently (data loss and user deception).

---

### ADR-012 — Native mobile apps and Open Banking import deferred to v2
**Status:** Accepted

**Context.** Both are frequently requested and both are expensive. PWA-first covers the v1 mobile
need; Open Banking coverage for Serbian retail banking is not practically available today.

**Decision.** v1 ships as an installable PWA. A Capacitor shell, the app stores, and bank import are
v2, gated on measurable triggers (see [07](07-platform-strategy-mobile-desktop.md)) rather than on
enthusiasm.

**Consequences.**
- ✅ Phase 4 budget is spent on receipts and offline polish, which serve the core loop.
- ✅ No app-store review latency during a period of rapid iteration.
- ⚠️ No store discovery channel in v1 — growth depends on word of mouth and content.
- ⚠️ iOS push limitations must be communicated honestly to users rather than papered over.

**Alternatives rejected.** Native-first (a year before validating the thesis), or shipping a native
shell immediately (adds store compliance and release process overhead for marginal v1 gain).

---

### ADR-013 — Single-node Docker Compose deployment initially
**Status:** Accepted · **Revisit trigger defined below**

**Context.** Managed Kubernetes or a cloud PaaS would add cost, complexity and a class of failure
modes that a 1–2 person team cannot operate on top of building the product.

**Decision.** Deploy as containers on a single well-provisioned node using Docker Compose, with
Postgres, Redis and MinIO either alongside or as a managed service if the price is competitive.
Kubernetes is adopted only when an explicit threshold is crossed.

**Revisit triggers (any one of these, not a feeling):** sustained CPU > 70 % on the node, Postgres
working set exceeding available RAM, job backlog latency > 5 minutes p95, or a hard availability
requirement from a paying customer. See [11](11-devops-and-observability.md) §13.

**Consequences.**
- ✅ Lowest possible operational cost and cognitive load during the highest-uncertainty phase.
- ✅ Backups, restore and monitoring are simple enough to actually be done properly.
- ⚠️ Single point of failure. Accepted for beta; mitigated by nightly encrypted off-site backups and a
  rehearsed, timed restore.
- ⚠️ Vertically scaling one node has a ceiling; the migration path must be planned, not improvised.

**Alternatives rejected.** Kubernetes from day one (ops burden exceeds the product), serverless
(cold starts hurt the AI path; connection pooling to Postgres is awkward), bare metal manual deploys
(no reproducibility, no rollback).

---

### ADR-014 — Product name is undecided; `FinMate` is a working title only
**Status:** **Open — requires a human decision before public beta**

**Context.** The source conversation established that **FinMate, Finora, Finio and Monevo are already
used by existing finance products**, and recommended Spendora with Savora and Monexa as runners-up.
[13](13-brand-and-naming.md) re-scored all 20 source candidates against weighted criteria and **rejects
Spendora and the other runners-up**: `spend-`/`-ora` framing positions the product as an expenditure
tracker, which is exactly the category [00](00-executive-summary.md#why-this-is-a-real-opportunity)
argues we are *not* in. It further found collisions the source conversation missed — `Savora` (a
European condiment brand), `Kasa` (TP-Link Kasa), `Milo` (Nestlé), `Moneta` (MONETA Money Bank,
class 36), `Numa`/`Nomi` (funded software companies) and `Zora` (Zora Labs, `zora.co`).

**Decision.** Treat `FinMate` as an internal placeholder. Ship nothing user-visible under it. Decide
the name via the screening process in [13](13-brand-and-naming.md) and execute the rename **before
public beta, at the latest during Phase 5**.

**Candidate entering screening:** **[13 §5](13-brand-and-naming.md) recommends `Ostava`** (Serbian for
"pantry"), narrowly over `Vedro` and `Talir`, on the reasoning that it is a household word rather than
a finance word, carries no incumbent collision, and does not frame the product as spending. **This
recommendation does not close this ADR** — `Ostava` has not been domain- or trademark-screened, and
the decision remains with the product owner (Q-1).

**Consequences.**
- ✅ No premature brand investment; the technical plan is name-independent.
- ⚠️ A rename late in Phase 4 costs days (repo, package scope, app titles, PWA manifest, email sender,
  domains, docs). Cheaper now than after launch, more expensive than deciding in week 1.
- ⚠️ Marketing assets, if produced early, must use the placeholder deliberately.

**Owner:** product owner. **Deadline:** end of Phase 3, so Phase 5 hardening includes the rename.

---

### ADR-015 — Two-level categorisation: transaction level and receipt-item level, plus splits
**Status:** Accepted

**Context.** The source conversation's decisive example: a Lidl receipt is not "Hrana" — it routinely
contains food, hygiene and household cleaning in one basket. One category per merchant makes the
user's analytics worthless, and worthless analytics are why budgeting apps get abandoned.

**Decision.** Support categorisation at three granularities: (1) a single category on the transaction
for simple entries; (2) `TransactionSplit` rows when one payment spans categories; (3) `ReceiptItem`
rows with individual categories when a receipt is scanned, reconciled against the receipt total
(invariant I-6). Merchant defaults are advisory and are overridden by item-level results.

**Consequences.**
- ✅ Analytics can answer "how much did I spend on meat this month?" — the question that makes the
  product worth paying for.
- ✅ Handles the mixed-basket case that would otherwise poison the data.
- ⚠️ Every aggregation must decide whether to count transactions or splits/items; encoded as explicit
  repository methods with tests, never ad-hoc.
- ⚠️ The UI must not present three mechanisms as three confusing features; the design is in
  [02](02-ux-flows-and-screens.md).

**Alternatives rejected.** One category per merchant (poisons analytics), merchant-level category with
manual item tracking (defeats the point of AI).

---

### ADR-016 — Offline capture via client-generated IDs and an outbox, not a local-first framework
**Status:** Accepted

**Context.** Mobile capture must work without connectivity, but a full local-first sync engine
(CRDTs, or a framework like Replicache/Zero) is a large dependency whose semantics we would have to
learn and operate.

**Decision.** A narrow offline design: client-generated `client_id` (UUIDv7) with a unique index per
household, `idempotency_key` on every write, an IndexedDB outbox flushed in order, last-write-wins on
scalars with a `version` column for optimistic concurrency, and explicit diff surfacing for money
fields on conflict. Offline scope is capture + last-synced snapshot + taxonomy cache only. Every
offline figure is labelled `as of <time>`.

**Consequences.**
- ✅ The critical path (capture) works offline; nothing else has to.
- ✅ No dependency on a sync framework; the semantics are small enough to reason about and test.
- ⚠️ Not collaborative-grade. Acceptable, because household write-sharing is v2 (ADR-008) and true
  concurrent editing of the same transaction is not a v1 use case.
- ⚠️ IndexedDB eviction risk on iOS must be handled by treating the local store as a cache with an
  outbox, never as the only copy of committed data.

**Alternatives rejected.** Full local-first framework (dependency and complexity for a requirement we
do not have), online-only (unacceptable on the metro), background sync only (unreliable on iOS).

---

### ADR-017 — The assistant uses a constrained query planner with backend-computed facts
**Status:** Accepted

**Context.** "Ask your money anything" is the most attractive and most dangerous feature: it is the
surface where a hallucinated number destroys trust instantly. Text-to-SQL over a multi-tenant schema
is worse — it risks both wrong numbers and cross-tenant leakage.

**Decision.** The assistant is a **constrained intent classifier** over a fixed set of ~25 query
templates (`SPEND_BY_CATEGORY`, `TOP_MERCHANTS`, `BUDGET_STATUS`, `TREND_VS_LAST_MONTH`,
`SAFE_TO_SPEND`, `GOAL_PROGRESS`, …). The planner selects a template and slots; it never emits SQL.
Each template is a parameterised, household-scoped repository method. Facts are computed and
pre-formatted by the backend, then passed to the narrator as strings. The model reproduces numbers
verbatim and is forbidden from introducing new ones.

**Consequences.**
- ✅ Hallucinated figures are structurally impossible, not merely discouraged.
- ✅ A numeric validator (every numeral in the output must exist in the facts payload) provides a
  cheap, effective second check with a template-rendered fallback.
- ✅ Authorisation is inherited from the repository layer; the model cannot reach data the user is not
  entitled to.
- ✅ Every answer carries provenance and drills through to the underlying filtered list.
- ⚠️ Questions outside the template set are refused rather than improvised. This is a deliberate
  product limitation — and it must be messaged well ("I can't answer that yet, but I can tell you…").

**Alternatives rejected.** Text-to-SQL (wrong numbers plus tenancy risk), free-form LLM over a data
dump (unbounded cost and leakage), LLM doing arithmetic (violates ADR-001).

---

### ADR-018 — Self-hosted, S3-compatible object storage for receipts
**Status:** Accepted

**Context.** Receipt images are the most sensitive artefacts the system holds: they can contain
partial card numbers, names, addresses and the full basket.

**Decision.** Store receipts in an S3-compatible store (MinIO self-hosted, or a managed S3-compatible
service if it is cheaper), accessed only via short-lived presigned URLs, with server-side encryption,
type sniffing, size caps, virus scanning, and a lifecycle policy that purges orphans daily. Images are
never proxied through the API and never sent to an LLM provider as an image unless the user has
enabled cloud OCR for that receipt; local OCR is the default.

**Consequences.**
- ✅ The API never streams binary data, keeping the request path small and the p95 latency honest.
- ✅ Receipt retention is a policy, not an accident.
- ⚠️ Adds an infrastructure component to back up and monitor (see [11](11-devops-and-observability.md)).
- ⚠️ Local OCR quality is lower than a cloud vision model; the tradeoff is explicit and user-visible.

**Alternatives rejected.** Storing blobs in Postgres (bloats backups, poor streaming), proxying through
the API (latency and memory pressure), cloud-only OCR by default (privacy-by-default is a selling
point, not a constraint).

---

### ADR-019 — Runtime i18n catalogue with script variants, rather than build-time locale bundles
**Status:** Accepted

**Context.** The product ships in Serbian (both latin and cyrillic scripts) and English
([07 §8](07-platform-strategy-mobile-desktop.md)). Serbian users switch script by preference and
sometimes mid-session, and a budget app has no SEO surface for per-locale bundles to serve — the app
is behind authentication ([ADR-006](#adr-006--angular-spa--pwa-first-no-ssr-in-v1)).

**Decision.** Ship **one runtime string catalogue** loaded at boot and switchable at runtime, with
`sr-Latn-RS`, `sr-Cyrl-RS` and `en` as first-class locales. No per-locale build outputs, no route-based
locale prefixes. `sr-Cyrl` is generated by transliteration from `sr-Latn` where safe, with a
whitelist that excludes brand names, currency codes and abbreviations. Design-system CSS uses
**logical properties** (`margin-inline-start`, `padding-inline-end`, `inset-inline`) and user-generated
text carries `dir="auto"`, so RTL is not a rewrite if it is ever needed — but **full RTL support is
out of scope and would require its own ADR**.

**Consequences.**
- ✅ Switching latin ↔ cyrillic needs no reload, no rebuild and no duplicate UI code.
- ✅ Adding a locale is a data change, not a deployment.
- ✅ Logical properties cost nothing now and preserve the RTL option.
- ⚠️ The whole catalogue loads up front; acceptable because it is small (single-product strings) and
  far cheaper than per-locale bundles for an authenticated SPA.
- ⚠️ Transliteration is a heuristic and can produce wrong cyrillic in edge cases; hence the whitelist
  and a native-speaker review gate before each release.
- ⚠️ Serbian case and gender agreement make string concatenation produce nonsense, so all strings are
  whole sentences with ICU placeholders. Enforced by review, not by tooling.

**Alternatives rejected.** Build-time per-locale bundles (no SEO benefit, requires redeployment to
switch script), route-prefixed locales (`/sr/...`, pointless behind auth), a third-party runtime
translation service (adds egress for user-visible copy and a network dependency on first paint).

---

### ADR-020 — SWC, not tsx/esbuild, as the NestJS development runtime
**Status:** Accepted

**Context.** The monorepo consumes workspace packages as TypeScript **source** via `tsconfig` paths.
`tsx` was the obvious zero-config dev runtime — it resolved those paths correctly — but running the
API under it failed:

```text
ERROR: Parameter decorators only work when experimental decorators are enabled
```

Enabling `experimentalDecorators` is not enough. **esbuild (and therefore tsx) cannot emit decorator
metadata at all**, and NestJS resolves constructor dependencies from `design:paramtypes`. Under
esbuild the app either fails to boot or — worse, if the decorator error is worked around — starts
with dependency injection silently broken, and `ValidationPipe` unable to see DTO types. A dev
runtime that fails *quietly* on DI is worse than one that fails loudly.

**Decision.** Run the API in development with **SWC**:

```bash
node --env-file=../../.env -r @swc-node/register src/main.ts
```

configured by `apps/api/.swcrc` with `legacyDecorator: true` and `decoratorMetadata: true`, plus the
workspace `paths` so aliases resolve. `tsx` remains in use for plain scripts (the seed) where
decorators are irrelevant.

**Consequences.**
- ✅ Decorator metadata is emitted, so type-based DI and DTO validation behave as NestJS intends.
- ✅ SWC is fast, so the dev loop is still sub-second on reload.
- ✅ One `.swcrc` documents the aliases, making the alias contract visible.
- ⚠️ Two transpilers in the repo (SWC for the API, esbuild via tsx for scripts, Vitest for packages,
  ts-jest for API tests). Documented because it is genuinely confusing on first contact.
- ⚠️ `apps/api/.swcrc` duplicates the `paths` from `tsconfig.base.json`. They must be kept in step;
  a mismatch shows up as a runtime module-resolution error rather than a compile error.
- ⚠️ SWC does not typecheck. That is what `nx run api:typecheck` (`tsc --noEmit`) is for, and it is a
  gate.

**Alternatives rejected.** `tsc` + `node --watch` on the emitted output (works, but needs
`tsconfig-paths` at runtime and adds a build step to every reload); `nest start` with the default
builder (same path-rewriting problem); explicit `@Inject()` tokens on every constructor parameter
(invasive, and does not fix DTO validation, which also needs metadata).

---

## Part 2 — Risk register

Scored as **Likelihood (L)** and **Impact (I)** on 1–5; **Exposure = L × I**. Anything ≥ 12 gets an
owner and a checkpoint in [09](09-implementation-plan.md).

| ID | Risk | L | I | Exp | Mitigation | Checkpoint |
|---|---|---|---|---|---|---|
| **R-01** | **Onboarding cold-start**: the AI is unimpressive for the first ~50 entries because it knows nothing about the household, and users churn before the magic appears | 4 | 5 | **20** | F-13 knowledge seeding (starter tree, ~60 local merchants, "who do you pay regularly", guided first entry); review queue designed to be satisfying; measure first-session acceptance rate separately from steady state | Phase 2 exit criteria + launch metrics |
| **R-02** | **Trust collapse from a wrong number**: any incident where the app's arithmetic disagrees with reality is fatal and viral | 2 | 5 | **10** | ADR-001, ADR-017, nightly `ledger.reconcile` with drift alert, property-based money tests, numeric validator on narration | Phase 5 gate: zero known P0/P1 |
| **R-03** | **Category model collapses under mixed baskets** (the Lidl problem), making analytics worthless | 3 | 4 | **12** | ADR-015 two-level categorisation + splits + exclude keywords; item-level OCR; tested with a real mixed-basket fixture set | Phase 1.2.6 and Phase 4.1 |
| **R-04** | **AI cost per household exceeds the plan price** at low rules-hit ratios before memory accumulates | 3 | 4 | **12** | ADR-002 cheap-first pipeline; per-household token budgets with automatic model downgrade; cost per entry recorded on every decision; pricing margin modelled at 2× and 5× cost | Phase 5.6 cost review |
| **R-05** | **Serbian NL parsing is harder than expected** — dialect, typos, cyrillic/latin mixing, abbreviations, ambiguous amounts | 4 | 3 | **12** | Golden dataset built before/with the parser; ~20 % unallocated slack in Phase 2; closed-category-list AI fallback means the parser is not a single point of failure | Phase 2 exit criteria |
| **R-06** | **Privacy perception**: users uncomfortable with financial text going to a third-party model | 3 | 4 | **12** | Explicit consent, documented data flow, redaction before egress, local-model option, EU/RS region config, opt-out with graceful degradation, "your data" export and hard delete | Phase 5.2 (GDPR deliverables) |
| **R-07** | **Scope creep** — family sharing, bank import, investments, multi-currency each look small and are not | 4 | 3 | **12** | Explicit non-goals in [01 §8](01-product-requirements.md#8-explicit-non-goals-for-10); ADR-008/011/012 deferrals; any addition requires removing something from the same phase | Every phase planning session |
| **R-08** | **Review-queue fatigue**: confidence is miscalibrated and the queue becomes a chore, so users stop correcting and the learning loop dies | 3 | 4 | **12** | Weekly isotonic recalibration; conservative shrink early; thresholds per-household tunable; queue keyboard-driven and bulk-resolvable; measure queue length per active user | Phase 2.3 + nightly calibration job |
| **R-09** | **Single-node outage** (ADR-013) — hardware or disk failure takes the product down | 2 | 5 | **10** | Encrypted nightly off-site backups, rehearsed and timed restore before launch, uptime monitoring, documented RTO/RPO | Phase 5: timed restore rehearsal |
| **R-10** | **Cross-tenant data leak** — a missed `household_id` filter exposes another household's finances | 2 | 5 | **10** | Three-layer tenancy enforcement, Prisma extension that throws, adversarial cross-tenant test suite in CI, optional Postgres RLS | Continuous; Phase 5.1 security review |
| **R-11** | **LLM provider price or policy change** breaks the unit economics or availability | 3 | 3 | 9 | ADR-007 multi-provider abstraction with per-task routing, cost telemetry, ability to switch in a config change rather than a release | Reviewed monthly |
| **R-12** | **Retention disappoints** even though the product works — the category is defined by abandonment | 4 | 4 | **16** | Instrument D7/D30 and time-to-log from day one; AI-parse acceptance rate as a leading indicator; positive-feedback alerts; onboarding funnel analysis in Phase 5.5; be willing to cut features to fix retention | Launch metrics review at 30/60/90 days |
| **R-13** | **Prompt injection** through merchant names, receipt text or notes reaching the model | 2 | 4 | 8 | Model output treated as untrusted input; closed category list validated server-side; planner never emits SQL (ADR-017); injection fixtures in the eval suite | Phase 5.1 |
| **R-14** | **iOS PWA limitations** (push, storage eviction, install friction) make the mobile experience second-class | 4 | 3 | **12** | Honest in-app messaging; outbox treated as a queue not storage; email as a push fallback; Capacitor migration path pre-planned with explicit triggers | Phase 4.2 + post-launch metric review |
| **R-15** | **Single-engineer bus factor** — illness or departure stalls everything | 3 | 4 | **12** | Documentation set (this repository), ADRs, an automated deploy path, no undocumented manual ops steps, runbooks in [11](11-devops-and-observability.md) | Phase 5 ops readiness |
| **R-16** | **Incumbent bundles the same feature free** (a bank app or Google/Apple adding AI categorisation) | 3 | 4 | **12** | Compete on depth and local specificity (household memory, Serbian parsing, receipt itemisation, custom rules), not on the raw capability; own the retention relationship | Strategic review quarterly |
| **R-17** | **Export/eval dataset consent** — using corrections for evaluation without proper consent creates a legal problem | 2 | 4 | 8 | Explicit, revocable consent for anonymised evaluation use; anonymisation pipeline; local-only eval option; documented in [08](08-security-privacy-and-compliance.md) | Phase 5.2 |
| **R-18** | **Name decision deferred too long** (ADR-014), forcing a costly late rename | 3 | 2 | 6 | Decide by the end of Phase 3; all user-visible strings and manifests driven from one config value; no brand assets produced early | End of Phase 3 |
| **R-19** | **Accessibility debt** makes the app unusable for a meaningful share of users and is expensive to retrofit | 3 | 3 | 9 | WCAG 2.2 AA in the Definition of Done per story, axe checks in CI, keyboard-complete desktop flows, real-device screen-reader testing in Phase 4.3 | Every story + Phase 5 |
| **R-20** | **Data loss or silent corruption** in offline sync (duplicate or dropped captures) | 2 | 5 | **10** | Unique `(household_id, client_id)` index, idempotency keys on every write, outbox never discards a failed item, sync integration tests including replay and conflict | Phase 4.2 |

### Top five by exposure
1. **R-01 onboarding cold-start (20)** — the single biggest threat, and the one the plan spends the most disproportionate effort on.
2. **R-12 retention (16)** — a working product that people stop using is still a failed product.
3. **R-03 / R-04 / R-05 / R-06 / R-07 / R-08 / R-14 / R-15 / R-16 (12 each)** — a cluster of medium-high risks, all addressed by decisions already taken above.
4. **R-02 / R-09 / R-10 / R-20 (10 each)** — low-likelihood, catastrophic-impact; these justify the reconciliation job, backup rehearsal and tenancy tests even though they are unlikely.
5. **R-11 / R-13 / R-17 / R-19 (8–9)** — monitor, do not over-invest.

---

## Part 3 — Open questions requiring a human decision

These are **not** engineering questions and are **not** resolved by this documentation set. Each has a
recommendation, an owner and a deadline; leaving them open past the deadline is itself a risk.

| # | Question | Recommendation | Owner | Needed by |
|---|---|---|---|---|
| Q-1 | **What is the product called?** (ADR-014) | **Recommended: `Ostava`**, with `Vedro` and `Talir` as runners-up ([13 §5](13-brand-and-naming.md)). Run the cheap screening steps (`.com`/`.app`/`.rs`, app-store and GitHub collisions) before paying for trademark searches. Do not ship `FinMate` | Product owner | End of Phase 3 |
| Q-2 | **Is the mobile route PWA-first acceptable for the first year, given iOS push limits?** | Yes — PWA-first, with explicit Capacitor triggers defined in [07](07-platform-strategy-mobile-desktop.md) | Product owner + eng lead | Phase 0 |
| Q-3 | **Is the target market Serbia only at launch, or Serbia + regional (BiH, Montenegro, Croatia)?** | Serbia only for v1. The parser, merchant seed and pricing are tuned for it; regional expansion is a v2 localisation exercise, not a marketing decision | Product owner | Phase 5 |
| Q-4 | **Which AI providers are approved, and in which regions?** | **Constrained by [ADR-007](#adr-007--provider-agnostic-ai-abstraction-with-per-task-routing): EEA-hosted endpoints or a local model only** for `PARSE`/`CLASSIFY`/`NARRATE`/`OCR`. Default routing is `LOCAL` primary with an `_EU` fallback ([04 §9](04-categorization-and-ai-engine.md#9-ai-provider-abstraction)). Non-EEA providers are opt-in per household with recorded consent, never a default | Eng lead | Phase 2.2 |
| Q-5 | **Is a local/self-hosted model required for any user segment (privacy-driven)?** | Offer it as an option in v2 if there is demand; default to cloud with redaction and consent in v1 | Product owner | Phase 2 |
| Q-6 | **How is the golden evaluation dataset sourced and consented?** | Start with hand-authored + synthetic Serbian fixtures; add anonymised consented real corrections with explicit opt-in | Eng lead + legal | Phase 2.1 |
| Q-7 | **Where is production hosted, and does Serbian/EU data residency matter to target users?** | An EU region (close latency, adequate legal posture); revisit if enterprise or public-sector interest appears | Eng lead | Phase 5 |
| Q-8 | **Is the free tier generous enough to seed word of mouth while protecting margin?** | Validate the quotas in [12](12-monetization-and-pricing.md) against beta usage before launch, not after | Product owner | Phase 5.6 |
| Q-9 | **How much of the app must work if the user declines AI entirely?** | Everything except AI parse/classify/narrate/OCR — rules, manual entry, budgets, analytics, alerts all remain fully functional. This is a product commitment, not a fallback | Product owner | Phase 1 |
| Q-10 | **Is a designer available for the correction and onboarding UX?** | Strongly recommended. These two surfaces determine retention more than any other part of the product, and they are the least tolerant of engineering-led design | Product owner | Phase 0 |

---

## Part 4 — Decisions deliberately deferred

Recorded so they are not silently made by accident during implementation. **Sequencing and effort for
each of these is consolidated in [09 §13.4](09-implementation-plan.md#134-v2--additive-needs-its-own-planning)**,
which also records the trigger that would promote each one into a planned phase.

| Deferred | Deliberately not decided because | Earliest revisit |
|---|---|---|
| Postgres Row-Level Security as a fourth tenancy layer | Not needed for beta scale; add before any enterprise deal | Before first enterprise conversation |
| Materialised rollup tables for category spend | On-read aggregation is fast enough below ~100k transactions/household | When dashboard p95 > 300 ms |
| Read replicas | Single node has headroom | When Postgres CPU is the bottleneck |
| Kubernetes | ADR-013 revisit triggers not yet met | When a trigger fires |
| Passkeys / WebAuthn | Password + refresh tokens are sufficient for v1 | Post-launch, if login friction shows up in support |
| TOTP two-factor | Adds support burden; no enterprise requirement yet | v2 or on request |
| Multi-currency ledger | ADR-011 | v2, on measured demand |
| Bank/Open Banking import | ADR-012; RS coverage is not practical yet | When a provider offers real RS coverage |
| Native apps / Capacitor shell | ADR-012; PWA covers v1 | When a defined trigger in [07](07-platform-strategy-mobile-desktop.md) fires |
| Household write-sharing UI | ADR-008; schema ready, UI deferred | v2 |
| Fine-tuning or a self-hosted model on the hot path | ADR-010 | Only if rules + few-shot fail to reach targets |
| Public API / integrations | No validated demand | v2, on request |
| Open-sourcing any component | Unclear benefit; the moat is the memory model and the data, not the code | Not planned |
