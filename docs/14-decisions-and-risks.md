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

### ADR-019 — Runtime i18n catalogue, English primary, Serbian derived at runtime
**Status:** Accepted

**Context.** The product ships in Serbian (both latin and cyrillic scripts) and English
([07 §8](07-platform-strategy-mobile-desktop.md)). Serbian users switch script by preference and
sometimes mid-session, and a budget app has no SEO surface for per-locale bundles to serve — the app
is behind authentication ([ADR-006](#adr-006--angular-spa--pwa-first-no-ssr-in-v1)).

**Decision.** Ship **one runtime string catalogue** loaded at boot and switchable at runtime, with
`en`, `sr-Latn-RS` and `sr-Cyrl-RS` as first-class locales. No per-locale build outputs, no route-based
locale prefixes. `sr-Cyrl` is generated by transliteration from `sr-Latn` where safe, with a
whitelist that excludes brand names, currency codes and abbreviations.

**Amendment (Phase 0, task 0.8 follow-up) — English is the primary language.**

The original decision listed Serbian first, and the first implementation hardcoded Serbian strings
in every component. That was wrong for the product: the source of truth for the key set is now
**English**, and `TranslationKey` is derived from the English catalogue, so a missing string in any
other language is a **compile error** rather than a runtime fallback.

Three consequences worth recording:

1. **The `en` catalogue is the contract.** Every other locale is typed `Record<TranslationKey, string>`,
   and tests additionally assert key parity, no empty values, and identical `{placeholder}` sets
   across languages — the failures a type cannot catch.
2. **`sr-Cyrl` is computed at runtime**, not stored. It is derived from `sr-Latn` at module load, so
   the Cyrillic locale *cannot* be missing a key and the bundle does not carry the strings twice.
   (Verified: the built bundle contains no literal Cyrillic catalogue, only the locale label.)
3. **The server stays locale-agnostic.** The API returns a stable error `code` and a safe English
   message; the client localises by code. Adding a language is therefore a client-only data change.
   `users.locale` defaults to `en` (a forward migration), and localised *outbound email* is Phase 3
   work alongside the notification engine.

Serbian remains a first-class language, not an afterthought: the parser must still handle Serbian
input in both scripts regardless of interface language (docs/01 F-27). Design-system CSS uses
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

**Addendum (Phase 0 task 0.6) — the same constraint forced the test runner too.**

NestJS 12 ships **ESM-only** packages, so Jest could not load them at all ("Must use import to load
ES Module"). API tests therefore moved to **Vitest with `unplugin-swc`**, because Vitest handles ESM
natively and `unplugin-swc` (unlike Vitest's default esbuild transform) emits decorator metadata, so
`Test.createTestingModule` can resolve dependencies. See the updated docs/10 §2A.

**Alternatives rejected.** `tsc` + `node --watch` on the emitted output (works, but needs
`tsconfig-paths` at runtime and adds a build step to every reload); `nest start` with the default
builder (same path-rewriting problem); explicit `@Inject()` tokens on every constructor parameter
(invasive, and does not fix DTO validation, which also needs metadata).

---

### ADR-021 — Rung 5 embeddings are provider-injected, LOCAL-only by construction, and inert until a model is configured
**Status:** Accepted

**Context.** [04 §4](04-categorization-and-ai-engine.md#4-stage-3-entity-resolution) puts entity
resolution on a six-rung ladder and rung 5 is *"embedding k-NN, cosine > 0.82 over the household's own
vectors, confidence 0.60–0.85"*. It exists for a specific, documented case: the **F-09 shorthand**.
After correcting `Dejan rođa 3600`, the next input `Dejan 2000` cannot resolve on rungs 1–4 — rung 3
requires *every* folded token of the name, and trigram similarity of `dejan` against `dejan roda` is
0.545, just under rung 4's 0.55 ([04 §8.1.1](04-categorization-and-ai-engine.md#811-what-synthesis-can-and-cannot-fix-task-231)).

Four constraints meet here and none of them is a preference:

1. **The column fixes the model family.** `entity_embeddings.embedding` is `VECTOR(384)`
   ([03 §4](03-domain-model.md)) — a `CHECK` Postgres enforces. A 384-dimension model is not a
   stylistic choice; a 768-dimension one fails every `INSERT` with `expected 384 dimensions`.
2. **Entity names are personal data.** A vector built from a Household's own merchant and counterparty
   names is `PARSE`-class egress ([08 §6](08-security-privacy-and-compliance.md)). ADR-007 allows
   `LOCAL` or an explicit `_EU` endpoint and nothing else.
3. **No embedding provider is configured in this build**, and an "AI" that is not there must not be
   simulated. This is the same honesty rule as `UNCONFIGURED_AI_CLASSIFIER` (ADR-002, 04 §9).
4. **A cheap rung must not cost anything when a cheaper rung already answered.** Rung 5 is I/O; rungs
   1–4 are pure and in-process. A keystroke-debounced parse must not reach a model for a fragment a
   keyword already categorised ([04 §12](04-categorization-and-ai-engine.md)).

**Decision.**

1. Rung 5 is reached through an **interface**, `EmbeddingProvider`, injected at the API layer under
   the `EMBEDDINGS` token. Feature code never imports a provider.
2. The module provides **`UNCONFIGURED_EMBEDDINGS`** (`model: 'none'`, `dims: 0`) by default, so rung 5
   is **inert**: the ladder ends at rung 4 and every rung-5 code path is a no-op. Enabling it is a
   one-line provider swap in `ClassificationModule`.
3. **The interface has no `endpoint` and no `apiKey`.** Only an in-process model or one on the same
   host can be configured, so ADR-007's residency requirement is satisfied *by construction* rather
   than by a check somebody can skip. A remote embedding provider is not a configuration value; it is
   an amendment to this ADR plus a consent-gated exception.
4. **Residency of the vectors themselves** follows [08 §6](08-security-privacy-and-compliance.md):
   `entity_embeddings` rows are Household-scoped data, are never sent to an AI provider, and are keyed
   `(owner_type, owner_id, model)` so a model change invalidates rather than mixes vector spaces.
5. **The width is enforced, and a mismatch is "unavailable", not "broken".** A provider whose `dims`
   is not 384 reports itself unusable, which makes rung 5 inert — the same honest degradation as no
   model at all, instead of a per-row `INSERT` failure on the batch sync path.
6. **Unavailability is a value, not a throw.** A model that passes the availability check and then
   fails degrades to rung 4 and the capture still succeeds (04 §9).
7. **Rung 5 is lazy and last.** The pipeline consults it only when **both** the Merchant and the
   Counterparty lexical ladders found nothing, and only when a provider is configured. A rule, a
   keyword or an entity default never triggers an embedding call, and the tests count invocations to
   make that structural rather than incidental.
8. **A rung-5 hit is a candidate, not a decision.** `confidenceForCosine` maps the cosine into §4's
   `0.60–0.85` band, and that confidence now travels with the resolved entity into the entity-default
   stage, whose ceiling is therefore **0.85 < ADR-009's 0.90 auto-apply floor**. A semantic match can
   never silently become the user's data. This also corrected rung 4, which had been promoted to 1.00
   by the same missing wire ([04 §8.1.4](04-categorization-and-ai-engine.md#814-the-rung-that-found-an-entity-carries-its-confidence-fixed-in-234)).
9. **Indexing is explicit, never on the parse path.** `syncMissing(householdId)` writes the vectors of
   entities that have none for the current model, called where the entity set actually changes
   (onboarding's merchant selection). `parse` never writes embeddings.
10. **The model choice and its serving shape are deferred**, with the trigger recorded in
    [Part 4](#part-4--decisions-deliberately-deferred) — not decided here, and not foreclosed.

**Consequences.**
- ✅ Rung 5 cannot leak: the interface has no way to name a non-local endpoint. This is a constraint,
  so eroding it requires editing this ADR rather than flipping a config value.
- ✅ The deployed build behaves exactly as it did before 2.3.4 — the ladder ends at rung 4 — without
  anyone having to remember to disable anything.
- ✅ The cost model survives: 04 §12's "~70 % of entries cost $0.00" is asserted by counting embedding
  calls as well as AI calls.
- ✅ The audit can answer *"why this person?"*: the decision stores the cosine and the model that
  produced the hit.
- ⚠️ **Rung 5 is unexercised in this build.** The tests use a hand-built fixture vector at the
  schema's width — deliberately not a "semantic-ish" stand-in, which would clear some thresholds and
  not others and quietly become the thing under test. So the plumbing is proven and the *semantic
  quality* of any real model is **not**, and cannot be, established here.
- ⚠️ Until a model is chosen, the F-09 shorthand works only through the other two documented routes:
  an alias (what onboarding step 3 creates) or a keyword. This is unchanged from 2.3.1 and is recorded
  in [04 §8.1.1](04-categorization-and-ai-engine.md#811-what-synthesis-can-and-cannot-fix-task-231).
- ⚠️ `VECTOR(384)` narrows the choice to the 384-dimension multilingual family (MiniLM-L6, E5-small,
  LaBSE-small). Wanting a different family later is a migration, not a setting.
- ⚠️ [03 §4](03-domain-model.md) admits `owner_type = 'CATEGORY'` and nothing writes those rows:
  category matching is the keyword tier's job. The lookup therefore queries `MERCHANT` and
  `COUNTERPARTY` only, and the third arm of that `CHECK` is currently unused.
- ⚠️ Vectors are a **derived cache**, not truth. They are rebuilt from `name + aliases`, so an alias
  added after a sync is stale until `syncMissing` runs again; a stale vector can only *fail to match*,
  because the ladder's lexical rungs still run first.

**Alternatives rejected.**
- **(a) A remote embedding API** (an OpenAI/Cohere-compatible endpoint, `_EU` or otherwise):
  `PARSE`-class egress of household entity names for a rung that only ever produces a *candidate*,
  at a per-entity cost, to save an in-process model. Rejected as a default; reachable later only by
  amending this ADR with a consent-gated exception.
- **(b) A lexeme or trigram stand-in behind the same interface, so rung 5 "works" today.** It would
  produce plausible-looking hits, pass some thresholds and not others, and make the rung untestable in
  the field — the exact failure mode ADR-002's honesty rule exists to prevent. A rung that reports
  "no model" is more useful than one that pretends.
- **(c) Bundling a JS/ONNX embedding model in the API process.** A heavy new dependency with model
  weights to distribute and a cold-start cost — ADR-004 territory, and a deployment decision that
  deserves its own evaluation rather than being smuggled in with the plumbing. Deferred, not refused.
- **(d) Precomputing vectors eagerly on every entity write.** Turns a taxonomy edit into a model call
  and a batch write, and puts I/O on paths (`parse`) that must stay cheap. `syncMissing` is called
  where the set changes instead.
- **(e) A free-width or per-model column** (`VECTOR` with no dimension, or one column per model): the
  schema's fixed width is what makes `<=>` meaningful across rows, and a column per model is a
  migration per model plus a `COALESCE` in every query.
- **(f) Treating a rung-5 hit as certain** (the 1.00 the entity-default stage used to write): the
  bug this ADR's decision 8 fixes. A cosine above 0.82 is evidence about a *name*, not about a
  category, and the whole point of a confidence band is that the caller respects it.

### ADR-022 — The worker is a second process over the same services, and BullMQ owns the schedule
**Status:** Accepted

**Context.** [05 §8](05-architecture.md) has named BullMQ and a twelve-job table since Phase 0, and
`apps/worker` has been a stub ever since. That gap is now load-bearing: four features are built and
**only reachable through a mutation** — `insights.generate`, `notifications.dispatch`,
`recurring.materialise` and `recurring.detect`. Each was written so the mutation calls exactly the
method the job will, precisely so this decision would not change them. Nothing runs on a schedule, so
"the nightly insight feed" and "the subscription detector" are buttons a user has to press.

Four constraints shape the decision:

1. **One implementation per job.** Every job's logic already exists as a service method with its own
   tests and its own idempotency story (insight dedupe keys, `notifications.dedupe_key`, the
   per-occurrence `recurring:{rule}:{date}` key, detection by identity). A job must call that method,
   never a second version of it.
2. **`scope:worker` may depend on `scope:api`, and that is the only app-to-app edge.** The tag
   constraints in `eslint.config.mjs` already allow it, and Nx additionally forbids an app importing
   another app unless the target is named in the rule's `allow` list — so the API is named there, with
   a comment pointing at this ADR, and no other application is. The alternative — calling the API over
   HTTP — would make every job depend on a web process being up.
3. **A job must not read across Households, and yet something must enumerate them.** ADR-008 refuses
   any household-scoped query without a `TenantContext`, and `households` is scoped by its own primary
   key, so a worker cannot so much as list the Households it is meant to serve. This is the one place
   where that rule needs a sanctioned, auditable exception — and it must be narrow enough that it
   cannot become a general back door.
4. **Redis already exists.** ADR-013's single node runs it; the API already talks to it through
   `ioredis` for sessions and rate limits. A queue is not a new datastore.

**Decision.**

1. **The worker is a Nest application context** (`NestFactory.createApplicationContext`) that imports
   the API's feature modules and calls their services. It serves no HTTP, owns no schema, and runs no
   migrations — migrations stay a separate deploy step.
2. **BullMQ owns the schedule**, on the existing Redis: one queue per job name, repeatable jobs using
   [05 §8](05-architecture.md)'s schedule, `attempts` with exponential backoff, `removeOnComplete`/
   `removeOnFail` bounded, and a **dead-letter queue** for exhausted jobs. A failed job is logged with
   its household and its attempt count.
3. **Idempotency is the processor's obligation, not the queue's.** Every processor is safe to run
   twice; where a job posts money or a notification, the existing key is what makes that true. A new
   job may not be added without saying what makes it idempotent.
4. **`runAsSystem` is the only cross-Household read**, added to `tenant-context.ts`: it marks the
   current scope as a *job* scope, and the Prisma extension permits exactly the reads a job needs to
   enumerate work — `households.findMany` — while still refusing every household-scoped model without
   a tenant. Every per-Household unit of work then runs inside `runWithTenant`, so the job code is the
   same shape as a request.
5. **A job failure never takes the worker down**: each processor catches, logs and rethrows (BullMQ
   records the attempt), and a Household that throws is skipped for that run while the others proceed.
6. **The worker runs the same config loader as the API** (`@finmate/config`), so `REDIS_URL` and the
   database URL have one definition, and a missing required value fails the boot with a sentence
   rather than a stack trace mid-job.

**Consequences.**
- ✅ Four built features become scheduled, and the nightly evaluation runner has the process it needs.
- ✅ One implementation per job: a mutation and its job cannot drift, because they are the same method.
- ✅ Retries, backoff and a dead-letter path are configuration rather than code we maintain.
- ⚠️ **A new dependency** (`bullmq`) and its transitive tree, plus a second process to run locally, in
  CI and in the deploy (compose and `pnpm dev` both change).
- ⚠️ The worker imports the API's modules, so a service whose constructor gains a provider the worker's
  module graph does not import will fail **the worker's boot** while `api:test` stays green — the same
  class of failure as docs/15's module-resolution entry, with a new blast radius.
- ⚠️ `runAsSystem` is a deliberate hole in ADR-008. It is narrow (an enumerated read list), asserted by
  a test that it cannot do anything else, and any widening is an amendment to this ADR.
- ⚠️ Two processes can now write at once. Every processor's idempotency is what keeps that safe, which
  is why decision 3 is a rule rather than advice.

**Alternatives rejected.**
- **(a) A hand-rolled Redis scheduler** (a lock plus an interval and a `next_run_at`): no new
  dependency, but it re-implements retries, backoff, jitter, visibility timeouts and a dead-letter
  path — the parts of a queue that are easy to get subtly wrong, on the path that posts money.
- **(b) Cron inside the API process**: a web process must not own long tasks. A deploy or a restart
  kills a job mid-run, and a burst of job work competes with request latency on the same event loop.
- **(c) The worker calls the API over HTTP**: every job then depends on a web process being up, and on
  an authenticated caller that is not a user — a second auth surface for no benefit.
- **(d) Extract the services into a shared package first**: the honest long-term shape, but it is a
  large refactor of eleven modules with no behaviour change, and the boundary rule already permits the
  edge this ADR uses. If the worker ever needs to deploy independently of the API, that refactor is
  the follow-up, not a prerequisite.
- **(e) A queue table in Postgres**: `SELECT ... FOR UPDATE SKIP LOCKED` is a real pattern, but it puts
  job traffic on the primary database of a single-node deployment to avoid a dependency we already run.

---

### ADR-023 — Attachments: signed in-repo, scanned through a seam that is inert in this build
**Status:** Accepted

**Context.** [ADR-018](#adr-018--self-hosted-s3-compatible-object-storage-for-receipts) decided that
Receipt images live in S3-compatible storage reached only through short-lived presigned URLs, with
virus scanning and a lifecycle purge. Task 4.1.1 implements it (F-34, then F-14). Three questions were
left open and are not answerable from ADR-018:

1. **How is a URL signed?** The conventional answer is `@aws-sdk/client-s3` plus
   `@aws-sdk/s3-request-presigner`. ADR-004 requires an ADR before a new dependency, and this one is a
   large transitive tree for what is, in this module, four operations.
2. **What happens when no scanner is configured?** `attachments.scan_state` gates the download
   (docs/06 §9.2: *"`downloadUrl` is `null` until `CLEAN`"*), and `CLEAN` asserts a check that ran.
   With no scanner there are three options: leave every row `PENDING` (the feature cannot be used),
   write `CLEAN` (a false assertion), or write `SKIPPED` (true, and linkable).
3. **What enforces the declared size and digest?** A presigned `PUT` cannot carry a body condition —
   `content-length-range` belongs to a POST policy — so the upload itself is unconstrained.

**Decision.**

1. **SigV4 is signed in-repo** (`apps/api/src/modules/files/sigv4.ts`), dependency-free on
   `node:crypto`, as a pure module tested against AWS's published presigned-GET vector. No vendor SDK
   is added. Server-side bucket operations (`HEAD`/`PUT`/`DELETE`) use the same signer, so there is one
   canonicalisation to get right, not two.
2. **Storage and scanning are injected seams with honest inert defaults.** `OBJECT_STORAGE` resolves to
   a real signer only when all four `S3_*` settings are present; `SCANNER` has **no implementation in
   this build** and answers `SKIPPED`. `SKIPPED` means *not scanned* and is never presented as `CLEAN`;
   it is linkable, which is why the distinction is load-bearing rather than cosmetic.
3. **Verification happens at commit.** `commitAttachment` `HEAD`s the object and compares the byte
   length and the upload's `x-amz-meta-sha256` with the presign request, then runs the scan hook, and
   only then links the row. A missing, short, swapped or rejected upload becomes `FAILED`/`INFECTED`
   and is never downloadable.
4. **Retention is a job, not an intention.** `files.purge` (daily 04:00, ADR-022) deletes quarantined
   rows, uploads abandoned past a 24 h grace, unreferenced attachments, and everything past
   **24 months**; a failed blob deletion keeps its row so the next pass retries.
5. **The bucket is created out of band** (`pnpm storage:init`), never lazily on a request.

**Consequences.**
- ✅ No new dependency and no vendor coupling: MinIO today, any S3-compatible service later, by
  configuration.
- ✅ A deployment without storage still boots and fails a presign with a readable message — which is
  what lets CI, which has no MinIO, run the module's integration suite.
- ⚠️ **This build accepts attachments that have not been virus-scanned.** They are labelled `SKIPPED`,
  and a production deployment must configure a scanner before treating them as safe; docs/08 §9.4
  carries the status line by line, and AGENTS.md lists it as an open gap. Until then magic-byte
  sniffing is also absent, so a mislabelled upload is stored under its declared type.
- ⚠️ The signer is our code. It is covered by AWS's own vector and by a live MinIO round-trip, but it
  is a security-relevant implementation where a vendor SDK is the conservative choice; the seam is
  small enough (`presignS3Request`/`signS3Request`) that swapping in the SDK later is one file.
- ⚠️ `SKIPPED` is a state a client might read as "fine". The GraphQL description and the docs say
  otherwise, but the honest fix is a scanner, not better wording.

**Alternatives rejected.**
- **(a) Add `@aws-sdk/client-s3` + `s3-request-presigner`**: correct, conventional and vendor-maintained,
  but tens of megabytes and a supply-chain surface for four operations. Revisit if the signer ever needs
  SigV4 features beyond S3 path-style signing (POST policies, chunked uploads).
- **(b) Proxy the bytes through the API**: contradicts ADR-018's central property and puts a 12 MiB
  body on the request path.
- **(c) `CLEAN` when no scanner is configured**: makes the schema's promise ("promoted only after a
  clean scan") false in the data, which is worse than an inert feature.
- **(d) Leave every row `PENDING` without a scanner**: honest, but it makes F-34 unusable in
  development and in the beta, and it hides the gap behind a broken feature instead of a labelled one.
- **(e) Ship a ClamAV sidecar now**: a deployment concern, not a code seam; the interface is what makes
  it a later addition that changes no caller.

---

### ADR-024 — One service worker, first-party, app-shell-only, and enabled in production only
**Status:** Accepted

**Context.** [ADR-006](#adr-006--angular-spa--pwa-first-no-ssr-in-v1) promised "installable as a PWA, with
a service worker for app-shell caching and offline capture", and [ADR-016](#adr-016--offline-capture-via-client-generated-ids-and-an-outbox-not-a-local-first-framework)
fixed the offline **data** design (client-generated ids, an IndexedDB outbox, last-write-wins with a
`version` column). Task 4.2.1 is the first piece of that to be built, and it introduces the first runtime
component this repo has that sees every request from its own origin. Three constraints collide inside it:

- [08 §3.9](08-security-privacy-and-compliance.md) and its service-worker row: household ledger data must
  never rest in the HTTP cache — the only offline copy is the **encrypted, minimised, TTL'd** IndexedDB
  snapshot — so the worker must "never cache API responses with ledger data beyond the encrypted snapshot".
- [10 §8.3](10-testing-and-quality.md): an app-shell update must **prompt** "rather than swapping under an
  active capture", because a swap reloads the page and a half-typed fragment lives only in the DOM.
- [08 §12](08-security-privacy-and-compliance.md): "a **forced** update flow rather than an indefinitely
  stale shell" — which, read literally, forbids declining. **The two sentences disagree**, and the
  disagreement is worth resolving on purpose rather than discovering in a code review: *forced* and
  *prompted* can only both hold if force means "cannot be dismissed into staleness" rather than "cannot be
  consented to".

Rule 9 also applies: a service worker and its client library are a new dependency and a new runtime
service, so the choice is recorded before it is made.

**Decision.**

1. **Angular's first-party service worker is the implementation** — `@angular/service-worker` (the `ngsw`
   runtime) with a checked-in `apps/web/ngsw-config.json` — enabled in the **production** build
   configuration only. No third-party caching library is added.
2. **The worker caches the app shell and nothing else.** Its `assetGroups` cover the build's own static
   artifacts (the document, the hashed scripts and styles, the icons); a navigation request outside the
   cache falls back to the cached document. **No `dataGroups` entry may match `/graphql`, `/api/**`,
   `/auth/**` or `/v1/**`, and there is no runtime caching of responses at all.** A test reads this
   config and fails if such an entry appears. Offline *data* is IndexedDB under [08 §3.9](08-security-privacy-and-compliance.md),
   exactly as ADR-016 says.
3. **Registration is production-only** (`enabled: !isDevMode()`): in development the worker would serve a
   stale shell and fight the dev server's module graph. The honest cost is that `web:serve` cannot
   exercise the worker — verification is `web:build` plus a static server over `dist/browser`.
4. **The update flow is a non-dismissible prompt.** `SwUpdate.versionUpdates` → the shell renders a banner;
   `activateUpdate()` is called **only** from its button, so nothing swaps a page under an in-flight
   capture: there is no timer, no `skipWaiting`, no automatic reload. "Forced" is realised as *no
   dismissal* rather than *no consent* — the banner stays until the user reloads — which is the only
   reading under which [08 §12](08-security-privacy-and-compliance.md) and [10 §8.3](10-testing-and-quality.md)
   are both true.
5. **Activation-when-idle is accepted.** With no client running, `ngsw` may activate an installed version
   by itself, so the next launch is the current build. No client is running, so no capture can be
   interrupted, and this is the mechanism that keeps the fleet from staying stale behind a prompt nobody
   clicks.

**Consequences.**
- ✅ The app opens with no network and shows its own shell instead of the browser's error page, which is
  the precondition for 4.2.2's outbox and 4.2.3's pending tray.
- ✅ The privacy constraint is **structural**: with no `dataGroups`, there is nothing to forget, and the
  assertion is a test rather than a review habit. An HTTP cache of a household's ledger cannot be created
  by accident.
- ✅ No hand-rolled cache versioning. `ngsw.json`'s hash table is generated from the build, and
  `ngsw-worker.js`/`ngsw.json` are served unhashed and revalidated, so a stale asset cannot be paired with
  a fresh document once a version is activated.
- ✅ 4.2.5's push has a worker to deliver to; without this task it had none.
- ⚠️ **`ngsw` fails quietly.** A resource listed in `assetGroups` that the build does not emit makes the
  whole install fail **at runtime** (the classic instance is `/favicon.ico` from the `@angular/pwa`
  default config) and a glob that matches nothing caches nothing — neither is a build error. The
  mitigation is this task's verification: every `hashTable` entry is resolved against the built output.
- ⚠️ **A cached shell can outlive a deploy and talk to a newer API.** The prompt is the only defence, so a
  tab left open for days keeps the old bundle until it is clicked. API changes must therefore stay
  additive within a release, which [06](06-api-specification.md) already requires.
- ⚠️ **Production serving is now part of the contract and is not built.** The worker needs HTTPS (or
  `localhost`), origin scope, and `ngsw-worker.js`/`ngsw.json` served unhashed and revalidated rather than
  cached for a year. The deploy path ([11 §5](11-devops-and-observability.md)) does not exist yet — the
  hosting decision is Q-7 — so this is a written requirement for whoever builds it, not a tested one.
- ⚠️ **Still not installable.** No web app manifest and no icons ship in this task: installability is
  4.3.2, and a manifest carries the product **name**, which ADR-014 leaves undecided. Until then the
  worker improves reloads and gives an offline shell, but the browser will not offer to install the app.
- ⚠️ **The offline experience is still mostly error states.** GraphQL calls fail offline and each screen
  shows its own failure; queueing a capture is 4.2.2–4.2.3 and `as of <time>` labelling (with the header's
  offline chip) is 4.2.4. Nothing in this task writes offline.
- ⚠️ **The Playwright offline suite [10 §8.3](10-testing-and-quality.md) promises does not exist** — the
  repo has no Playwright — so the real cache strategy is verified by inspecting and serving the built
  manifest, not by throttling a browser to offline. A stubbed `SwUpdate` proves the banner's logic and
  nothing about `ngsw` itself.
- ⚠️ Reversal is cheap in code (delete the config and the registration) but not in the field: an installed
  worker must be unregistered before the feature is removed, or existing clients keep serving a cached
  shell.

**Alternatives rejected.**
- **(a) A hand-written service worker on the Cache API.** Full control over the fallback and the update,
  but we would own cache versioning by hand, and the failure it produces — a shell pinned to an old build,
  silently — is exactly what our verification recipe cannot see. Nothing in F-26's offline scope needs
  request rewriting, which is the only thing `ngsw` cannot do.
- **(b) Workbox directly.** The same primitives with a build integration of its own and a third-party
  dependency, while we rebuild Angular's `SwUpdate` integration on top.
- **(c) A `dataGroups` runtime cache for `GET` API traffic.** Rejected outright: it puts household ledger
  responses in an unencrypted HTTP cache, contradicts 08 §3.9's minimisation and TTL, and duplicates a
  cache we already own in IndexedDB. 3.9's snapshot is deliberately *less* than the API returns.
- **(d) Cache-then-network for the GraphQL POST.** A POST is not cacheable by a generic strategy without
  inventing a key, and the key would be the query plus its variables — a per-household data cache, see (c).
- **(e) `skipWaiting` plus an automatic reload.** Simplest, and it never leaves anyone stale, but it
  reloads a page the user is typing into; [10 §8.3](10-testing-and-quality.md) forbids exactly that.
- **(f) Defer the worker to Phase 5.** 4.2.2's outbox can be *stored* without a worker, but 4.2.3's
  pending tray is only honest if the shell opens offline, and 4.2.5's push is impossible without one —
  deferring moves two tasks and blocks a third.

### ADR-025 — The offline store is one encrypted IndexedDB, and without an app lock nothing confidential is persisted
**Status:** Accepted

**Context.** [ADR-016](#adr-016--offline-capture-via-client-generated-ids-and-an-outbox-not-a-local-first-framework)
fixed the offline **semantics** (client-generated ids, an `idempotencyKey` on every write, an IndexedDB
outbox flushed in order, last-write-wins with a `version`, a diff for money fields) and [05 §7](05-architecture.md)
names "a thin repository over `idb`". [08 §3.9](08-security-privacy-and-compliance.md) fixes the
**client-side posture**: an app lock, AES-GCM records under a non-extractable **in-memory** `CryptoKey`
unwrapped by that lock, a minimised snapshot with a 24 h TTL, pending captures that expire after 30 days,
and wipes on logout, revocation and household deletion. T-03 is the threat — L4 × I4, *"lost phone:
IndexedDB holds pending captures, ledger snapshot, taxonomy cache"* — and that combination is its
mitigation.

Three things those documents leave open, which task 4.2.2 is where they become real:

1. **The wrapping secret.** A key that lives only in memory decrypts nothing after a reload, so the data
   key has to be stored **wrapped** — by a WebAuthn secret or a PIN — and unwrapped again after the
   app-lock check. **No task in [09](09-implementation-plan.md) builds that app lock**: Sprint 4.2 is
   worker → store → tray → labelling → push, and 4.3 is mobile polish. Sprint 4.2's own exit criterion
   (*"full capture flow works in airplane mode and syncs without duplication on reconnect"*) therefore
   depends on a control nobody was scheduled to build.
2. **What happens before it exists.** The tempting shortcut — generate the key, store it beside the
   ciphertext — makes §3.9's claim (*"a filesystem dump of the browser profile yields ciphertext"*)
   **false**, and silently removes a mitigation T-03 is scored against. That is the one thing a security
   decision may not do: an ADR with no downside is marketing, and a mitigation that is not there is worse.
3. One library choice and one KDF deviation, below.

**Decision.**

1. **`idb` is the storage library.** One runtime dependency for a typed, promise-based wrapper over
   IndexedDB, as [05 §7](05-architecture.md) already names; `fake-indexeddb` is a **dev** dependency so the
   store and the outbox are exercised against a real IndexedDB implementation in Node. No local-first
   framework (ADR-016).
2. **Every offline record is one AES-GCM-256 message** under a single per-install data key: `{ iv,
   ciphertext }`, plus the cleartext keys a lookup needs (a household UUID, a `clientRowId`), which is
   metadata we accept because we cannot index ciphertext. The data key is generated with
   `crypto.getRandomValues` and used as a **non-extractable** `CryptoKey`; nothing writes it in the clear.
   The one record that is **not** encrypted under the data key is the data key itself: the `keys` store
   holds it *wrapped* by the app-lock secret, which is its ciphertext already, and encrypting it under
   the key it contains would be circular. It is stored raw, has no expiry, and is the first thing
   `purge()` removes.
3. **The data key is persisted only wrapped by an app-lock secret** — and the app lock is a **new task**
   (4.2.6, plus risk R-23), WebAuthn's platform authenticator preferred with a 6-digit PIN as the fallback.
   Until it ships the store runs on an **in-memory** key: the outbox works for the life of the page (a
   failed commit is recoverable without retyping), and the snapshot and taxonomy caches are **not written
   to disk at all**. A reload discards pending work, and the UI has to say so rather than imply
   otherwise — 4.2.3 owns that copy.
4. **The PIN is stretched with PBKDF2-SHA-256 (WebCrypto), not Argon2-wasm** — a deliberate deviation from
   §3.9's wording. Argon2 is the better KDF, but it arrives as a wasm build to audit and ship, for a secret
   with roughly 20 bits of entropy: a 6-digit PIN is brute-forceable offline in hours either way. WebAuthn
   is the control and the PIN is a speed bump; §3.9 now says that instead of implying otherwise. If a
   PIN-only mode ever needs to be strong, the fix is a longer secret, not a different KDF.
5. **What is stored, exactly** — §3.9's list made concrete: outbox entries (one `captureCommit` input per
   Confirm press, carrying its rows' `clientRowId`/`idempotencyKey`); the ledger snapshot (only
   `amountMinor`, `kind`, `occurredLocalDate`, `description`, and a category's id and name — never `note`,
   `rawInput`, counterparty notes, or unbounded history: the current period plus **45 days**); and the
   taxonomy cache (the categories and accounts the composer needs). **No receipt images** — their blob URLs
   are short-lived and revoked ([08 §3.9](08-security-privacy-and-compliance.md)).
6. **TTLs and purges are the store's own job.** The snapshot expires after **24 h**, a pending capture
   after **30 days**, and `purge()` runs on logout, on a `401` (the remote-revoke path), on household
   deletion, and from a manual control. Every read filters by expiry and a sweep runs on open, not on a
   timer — a background timer in a PWA is a promise iOS does not keep.
7. **The queue is ordered and idempotent.** Each entry takes a monotonic sequence at enqueue time; the
   flush sends **whole entries in sequence order** and **stops at the first retryable failure** so order is
   preserved; a `4xx` refusal is marked `rejected` (it needs the user, not a retry); and a replay is safe
   because the keys were minted when the row was created, so the server collapses it (I-10,
   `replayed: true`).

**Consequences.**
- ✅ Offline capture stops being a promise and becomes a queue with an order, a retry rule and a purge
  rule — all of it testable in Node, without a browser.
- ✅ **The encryption claim stays true as written**: with no app lock there is no key on disk, so a
  filesystem dump of the profile yields nothing confidential and T-03's mitigation survives intact.
- ✅ The key provider is a seam, so the app lock turns persistence on with no data migration.
- ⚠️ **Until 4.2.6 ships, F-26's offline capture survives only as long as the page does.** [07 §6](07-platform-strategy-mobile-desktop.md)'s
  ✅ for capture is *in-session* only, and the honest mobile story is degraded; R-23 carries it with a
  checkpoint rather than assuming it away.
- ⚠️ No snapshot cache before the app lock means 4.2.4's `as of <time>` labelling has nothing to label in
  this build. Its producer arrives with the lock, not with the labelling task.
- ⚠️ `idb` is a supply-chain addition ([08 §9.6](08-security-privacy-and-compliance.md), T-15) for about a
  kilobyte of wrapper. The alternative — hand-rolled IndexedDB plumbing — is exactly where transaction and
  connection-lifetime bugs live.
- ⚠️ A profile dump still reveals **keys** (household and client ids) and the *existence* of pending work
  even when the ciphertext is unreadable. Minimised, not eliminated.
- ⚠️ TTLs are enforced on read and on open, so a profile left closed for months keeps ciphertext until it
  is opened once. The encryption is what makes that acceptable, and it is another reason not to weaken it.

**Implementation notes (task 4.2.2b).** Three limits the code has and the decision text does not:
- **The snapshot mapper exists; the window does not.** `toSnapshotRow` enforces the field whitelist, but
  nothing yet selects "the current period plus 45 days" from the ledger — that belongs to whichever task
  first *fills* the snapshot (4.2.4's labelling needs something to label), and the store must never be
  handed an unbounded list. Recorded rather than implied.
- **`seq` is monotonic within a tab, not across tabs.** It is allocated synchronously from a counter
  seeded with the durable maximum, so two Confirm presses in the same millisecond keep their order and a
  reload cannot reuse a number — but two tabs sharing the database could allocate the same one. Capture
  from one tab is the supported configuration (ADR-016 is deliberately not collaborative-grade), and
  ADR-008 defers sharing; an atomic append is a migration, not an oversight.
- **A record that fails to authenticate is a loud failure, not a miss.** `decryptValue` throws
  `OfflineDecryptError` rather than returning `null`, so a caller cannot read a wrong figure out of a
  tampered record; `get`/`list` therefore surface it. The alternative — skip and carry on — would hide
  exactly the event the encryption exists to detect.

**Alternatives rejected.**
- **(a) Store the data key unwrapped, or derive it from a device constant.** Makes "encrypted at rest"
  false while looking true. It would invalidate T-03's mitigation and it is the worst kind of change: one
  that quietly removes a safety net.
- **(b) Build the app lock inside this task.** WebAuthn + PIN + idle lock + re-auth is a feature with its
  own UX ([02 §4.18](02-ux-flows-and-screens.md)), its own tests and its own failure modes. Folding it into
  the storage task is how a store ships without the lock it depends on; it becomes task 4.2.6 instead.
- **(c) Require an app lock to use the app at all.** Contradicts F-28's "everything except AI works" and
  gates the whole product on a browser capability whose iOS behaviour differs.
- **(d) A local-first framework (Replicache/Zero).** Rejected in ADR-016, unchanged here: a large
  dependency whose semantics we would have to learn for a requirement we do not have.
- **(e) `localStorage` or the Cache API instead of IndexedDB.** The service-worker cache is app-shell-only
  by ADR-024 and must stay that way; `localStorage` is synchronous, stringly-typed and size-capped.
- **(f) Argon2-wasm for the PIN, as §3.9 words it.** See decision 4 — a new wasm dependency does not fix
  20 bits of entropy, and PBKDF2 is in the platform.

### ADR-026 — The pending tray: a route reached from the header, whole capture batches, and a diff the server explains
**Status:** Accepted

**Context.** ADR-016 fixed the outbox semantics, ADR-025 the store and the key, and task 4.2.2b built the
layer. Task 4.2.3 is the **UX** on top of it, and four things it needs are not decided by any document:

1. **Where the tray lives and how it is reached.** [07 §6](07-platform-strategy-mobile-desktop.md) asks
   for "a badge count on the nav at every size class (never a hidden queue)", while
   [02 §2.3](02-ux-flows-and-screens.md) says the review slot is **the only badged destination** — and
   [02 §2.1](02-ux-flows-and-screens.md)'s route map has no pending route at all. The two documents
   disagree, and the nav has five slots precisely so that badges stay meaningful.
2. **What the queue may carry.** [02 §4.3](02-ux-flows-and-screens.md)'s offline sequence ends with
   *"409 + version on an edited row → money-field diff"*, but nothing queues an edit: 4.2.2b queues
   whole `captureCommit` batches, which are append-only and idempotent, so no version conflict can arise
   from them.
3. **What the user is told while it waits, and what a retry costs.** [07 §6](07-platform-strategy-mobile-desktop.md)
   names the flush triggers, an attempt count and a capped backoff; [02 §4.3](02-ux-flows-and-screens.md)
   names a *"Pregledaj razlike (n)"* diff with a *Zašto* line for the server's decision.
4. **Which tab flushes.** [07 §6](07-platform-strategy-mobile-desktop.md) says "leader tab only", which is
   a multi-tab concern.

**Decision.**

1. **`/pending` is a route reached from the header, not a nav destination** — the same shape as
   `/notifications`, which is header-only by [02 §2.2](02-ux-flows-and-screens.md). A **sync chip** in the
   header renders `Čeka slanje (n)` only while something is queued and links to the tray, so the count is
   visible at every size class without a second badged nav slot. **docs/07 §6 is corrected**: its "badge
   count on the nav" is satisfied by the header chip, because [02 §2.3](02-ux-flows-and-screens.md)
   deliberately keeps one badged destination and two badges on a five-slot bar is how a count stops
   meaning anything.
2. **The queue carries whole `captureCommit` batches, plus a client-only `meta`.** The outbox already
   stores `document` + `variables`; it gains an optional `meta` that is stored and never sent, which is
   where the local preview lives so the diff in decision 5 can be built. Queuing **edits** (and with them
   the money-field conflict diff) is **task 4.2.7**, deferred with a reason rather than half-built: nothing
   queues an edit yet, the online version-conflict path already exists in the Transaction sheet, and
   deciding *which* mutations may be queued offline is a product decision about what "offline" means
   (docs/07 §6's matrix draws the line at capture and review).
3. **An entry records its attempts and its last error**, and the retry delay is a pure, capped
   exponential — so the tray can say "3 attempts, last: no connection" and the flush cannot hammer a
   server that is down. Auto-flush runs on app start, on `online`, on `visibility → visible`, and after
   each write ([07 §6](07-platform-strategy-mobile-desktop.md)); a **retryable** failure leaves the queue
   intact and stops the flush, a **refusal** parks that entry as *ne može se poslati* and never drops it.
4. **Flush leadership is deferred to the persistent store.** In this build the store runs on a
   session-only key (ADR-025 decision 3), so two tabs cannot even see each other's queue and there is
   nothing to elect a leader for. Leader election (Web Locks or a `BroadcastChannel` claim) becomes a real
   requirement only when 4.2.6 turns persistence on, and it is recorded there rather than guessed here.
5. **The diff is built client-side from the queued preview and the server's own answer**, and it shows
   *before → after* per row plus the server's **`Zašto`** line, so a changed category is explainable
   rather than merely applied ([02 §4.3](02-ux-flows-and-screens.md) point 3). It is offered as
   *Pregledaj razlike (n)* and never applied silently; a row the server did **not** change shows no diff.

**Consequences.**
- ✅ The queue is visible at every size class without diluting the nav badge, and the tray is one tap from
  the chip that announces it.
- ✅ A server-side re-classification of an offline capture is **explainable**: the queued preview and the
  committed row are both on hand, so the diff is a comparison, not a reconstruction.
- ✅ Attempt counts and capped backoff make "it is not sending" a state the user can read instead of a
  spinner that never resolves; the escape hatch (*Izvezi kao tekst*) means no queue is ever a dead end.
- ⚠️ **The money-field conflict diff the plan names is not built** (task 4.2.7). Nothing queues an edit, so
  it would be a flow with no producer — the pattern this repo declines. Recorded in docs/09 and AGENTS.md.
- ⚠️ **docs/07 §6's review-queue half of the diff is not built either**: it says a re-classified row
  "surfaces as a reviewable diff in the review queue", which needs a `ReviewReason` arm and a producer on
  the API (`ReviewItemKind.RECEIPT_ITEM` has no producer today either). The tray's diff is where the user
  sees it in this build; the review-queue route is the API change's own task.
- ⚠️ Auto-flush on `visibility → visible` and `online` means a queue drains while the user is looking at
  any screen, so the tray can change under them. That is the honest behaviour — the alternative is a queue
  that only drains when someone opens a particular screen — but it is why the tray re-reads the queue
  rather than holding a snapshot.
- ⚠️ **A queued entry is immutable, and that is a server property rather than a UI preference.** Verified
  live in 4.2.3: an identical replay collapses to one Transaction (`wasReplayed: true`), but a resend
  under the **same** `idempotencyKey` with a *different* amount also returns the original row — the first
  payload wins, with no refusal. The tray therefore offers retry and discard and **never** "edit and
  resend": editing a queued payload would show a success while the server kept the old figure, and a
  changed row needs a new key. docs/15 carries the measurement.
- ⚠️ `meta` makes the outbox slightly more than a queue: it is now a place a caller can stash client-only
  state. Kept to one optional field with no semantics inside the outbox, and the tray is its only reader.

**Alternatives rejected.**
- **(a) A badged nav slot for pending sync** (what docs/07 §6 literally asks): two badged destinations in a
  five-slot bar, against docs/02 §2.3, for a queue that is usually empty.
- **(b) A section on `/capture` only**: invisible from anywhere else, and the user who queued a capture is
  usually not on it when the network returns.
- **(c) Queue edits now, so the money-field conflict diff has a producer**: it would decide offline-editing
  semantics inside a capture-UX task, and a version conflict has no UI to resolve it offline yet.
- **(d) Apply the diff silently** (last-write-wins with no surfacing): docs/05 §7 and docs/02 §4.3 both
  forbid it — a changed category the user never saw is exactly the surprise the offline design exists to
  avoid.
- **(e) Leader-tab election now**: there is nothing shared to lead until the store persists (ADR-025).

### ADR-027 — A stale figure is labelled, sourced from a per-read-model snapshot, and never fabricated
**Status:** Accepted

**Context.** [05 §7](05-architecture.md) requires the read-model cache to carry a `syncedAt` and says an
unlabelled stale "safe to spend" is a trust bug. [07 §6](07-platform-strategy-mobile-desktop.md)'s matrix
is more specific than that: safe-to-spend and the projection are 📖 *"shown from the snapshot with `as
of`; **never recomputed client-side**"*, analytics and the assistant are 📖 *"cached views only … we will
not fabricate an answer from a stale snapshot"*, and the ledger snapshot is 📖. [08 §3.9](08-security-privacy-and-compliance.md)
minimises what may be cached — but its field list is about **transaction** rows, and says nothing about a
*computed* figure. [10 §8.3](10-testing-and-quality.md) turns all of it into a test: *"every figure
carries `as of <timestamp>`; the test fails if any offline figure lacks it"*.

ADR-025 built the store, the whitelist mapper and the TTLs, and recorded that **nothing writes a
snapshot** — which made this task the one that has to decide what a snapshot *is*.

**Decision.**

1. **The snapshot is a per-read-model record, not one ledger blob.** A successful dashboard read writes
   `{ syncedAt, figures }`, where `figures` is the `Dashboard` payload verbatim: every member is a
   numeral, a currency amount or a boolean, so there is no free text to whitelist and no row to minimise.
   That is not an evasion of §3.9 — it is what makes ADR-001 hold: the matrix forbids recomputing
   safe-to-spend client-side, so the only honest offline figure is *the server's own number, cached*,
   never a value re-derived from a row cache.
2. **A figure is stale when it came from the snapshot, not when it is merely old.** Age is not
   observable to the client — a fresh read of a quiet month also describes yesterday — so the **source**
   decides the label: a live read renders unlabelled, a snapshot-served read labels *every* figure it
   renders `podaci od <syncedAt>` (docs/02 §4.2, with the label in the hero's disclosure).
3. **Never fabricate.** If the snapshot is missing or past its 24 h TTL (ADR-025 decision 6), the screen
   keeps its existing honest error state. It does not show a zero that looks like advice, does not
   extrapolate a projection, and does not override the server's own `paceIsReliable` refusal to forecast.
4. **The label belongs to the serving mode, not to each tile.** The dashboard renders one
   `podaci od <time>` line whenever it is serving snapshot data, so a figure cannot appear without its
   provenance — a per-tile label would be five ways to forget one. The spec asserts both halves: the
   label is present in snapshot mode, and no money figure renders while the mode is unlabelled.
5. **The header chip carries both states in one element**: `podaci od <time>` when figures are stale and
   `Čeka slanje (n)` when something is queued (docs/02 §2.2's offline chip, whose `syncedAt` and
   `pendingCount` inputs are exactly this). The pending half shipped in 4.2.3; this task adds the stale
   half and the combination.
6. **The snapshot is written after a successful read, never on a timer**, for the dashboard only in this
   build, and it is cleared by the same `purge()` triggers as everything else offline (logout, a `401`,
   Household deletion, the manual control).

**Consequences.**
- ✅ The dashboard is honest offline: it shows the figures the server last computed, says when, and
  refuses to invent the rest.
- ✅ The trust rule is structural rather than editorial: provenance is a property of where a figure came
  from, so "a stale figure without a label" is not a rendering the code can produce.
- ✅ 4.2.6 makes the snapshot survive a reload by swapping the key provider — no change to this design.
- ⚠️ **In this build the snapshot lives in memory**, so `podaci od <time>` survives navigation but not a
  reload: reopen the tab and the dashboard is back to its error state offline. That is ADR-025 decision 3
  working as intended (no app lock, no key, nothing on disk), and it is the visible half of R-23.
- ⚠️ **Only the dashboard serves from a snapshot.** The ledger-rows cache the matrix's *Ledger snapshot*
  row (📖) wants is a separate record and is **not built**; `/transactions`, analytics' cached period and
  the assistant stay online-only, with their own error states. Recorded in docs/07 §6 rather than
  implied, because "every offline figure is labelled" is only true while the set of offline figures is
  this small.
- ⚠️ A cached dashboard has no per-figure provenance: if one input changed and another did not, the whole
  screen is labelled stale. Coarser than a per-tile timestamp and deliberately so — the alternative is
  five labels that can disagree about the same moment.
- ⚠️ The snapshot is written on **read**, so a user who only ever captures (never opens the dashboard)
  gets no offline figures at all. The alternative — a background prefetch — is a timer, which this repo
  does not trust in a PWA (ADR-025 decision 6).
- ⚠️ **`purge()` and the stale signal are not yet joined.** The store's `purge()` empties the snapshot,
  but nothing resets `SnapshotService.staleAt` — no caller purges in this build (logout, a `401` and
  Household deletion are not wired to it yet). Whoever wires them must clear the signal too, or the chip
  can read `podaci od <time>` for a moment after a purge. Recorded here because the reset belongs to the
  purge path, and there is no purge path to put it in yet.

**Alternatives rejected.**
- **(a) Cache the ledger rows and recompute the dashboard offline.** Forbidden by 07 §6's matrix and by
  ADR-001: two implementations of safe-to-spend is how the app and the server start disagreeing about
  money, and the offline one would be the one nobody tested.
- **(b) Label every tile individually.** More labels, and no way to keep them consistent about a single
  snapshot time.
- **(c) Label by age** ("older than an hour is stale"). A fresh read of a quiet month is also old, so the
  label would cry wolf until users ignore it — the failure mode labelling exists to prevent.
- **(d) Serve a zero or a blank instead of an error when there is no snapshot.** A zero that looks like
  advice is worse than an honest failure (docs/02 §4.2's own rule about an unset budget).
- **(e) Prefetch on a timer so the snapshot is always fresh.** A background timer in a PWA is a promise
  iOS does not keep (ADR-025), and it inverts the cost model: the app would read on a schedule nobody
  asked for.
- **(f) Snapshot the analytics and assistant answers too.** 07 §6 says cached views only, and the
  assistant must never answer from a stale snapshot; both need their own design, not this record.

#### ADR-027 — amendment 4.2.8b: the ledger-rows record gets its screen

**Status:** Accepted (2026-09-16), amending decision 6 and the ⚠️ that said only the dashboard serves
from a snapshot.

**Context.** Decision 6 wrote the snapshot "for the dashboard only in this build", and its consequences
recorded that *"`/transactions`, analytics' cached period and the assistant stay online-only, with their
own error states"* — while docs/09's 4.2.8b row says *"analytics' cached period follows the same rule"*
and this ADR's rejected option (f) says analytics and the assistant *"need their own design, not this
record"*. Three documents, two answers for analytics. `/transactions` was not in doubt: it is the screen
the ledger-rows record exists for.

**Decision.**

1. **`/transactions` serves the ledger-rows record.** A successful **unfiltered** first page writes it;
   a failed first page serves it with one `podaci od <time>` line, read-only. The label is the serving
   mode, per decision 4 — one line for the whole list, not one per row or per day.
2. **A filtered read is never cached and never served.** A search, a date range or a `needsReview`
   filter returns a *subset*; caching it would later present four rows as the Household's ledger, and
   serving it after a failed search would answer a question the user did not ask. With a filter active
   and the read failed, the honest error state stands. This is the same rule decision 3 applies to a
   fabricated figure, one step earlier.
3. **The record carries the ledger currency.** `LedgerSnapshot.currency`, not a field on each row: the
   currency is a property of the Household's ledger (ADR-011) and not part of the row whitelist
   docs/08 §3.9 minimises. Without it `fm-money` cannot render a cached amount at all, because `Money`
   carries its currency (ADR-003) — the gap only appeared when a screen first tried to serve these rows.
4. **The cached list claims nothing the whitelist does not hold.** No id, so no row is a button and
   nothing drills in; no `status` and no `needsReview`, so no flag is rendered; and a `null` category
   renders as *nothing*, because it means "uncategorised" **or** "divided" — a split Transaction has no
   Category of its own and the whitelist holds one. Adding any of them is a data-minimisation decision
   (docs/08 §3.9), not a rendering convenience, and is not taken here.
5. **Analytics is left where the documents agree, not where one of them gestured.** Its offline view is
   an **open decision**: this matrix says cached views only, rejected option (f) says it needs its own
   design, and serving the ledger rows in its place would show a table where the user expects category
   spend. `/analytics` therefore keeps its error state, and the contradiction is recorded in docs/07 §6
   rather than resolved by picking a side silently.
6. **The assistant still reads nothing.** Rejected option (f) is unchanged: it must never answer from a
   stale snapshot.

**Consequences.**
- ✅ `podaci od <time>` is now true of a second screen, and the two records stay separate: the header
  chip's stale half is still the **dashboard's** provenance, so a cached transaction list cannot make
  the dashboard's figures look fresher than they are.
- ✅ The rule "a stale figure is labelled" is enforced structurally rather than editorially: the screen
  derives the label from the cache service's own provenance signal, which `readRows` sets and
  `writeRows`/`reset` clear — so the label cannot outlive the rows it describes.
- ⚠️ **The cached list is a summary, not the ledger screen.** No drill-in, no review flags, no split
  breakdown, and the window is the cache's (current period + 45 days, capped at 200 rows), so a busy
  month can be cut. The mode says so in one sentence rather than leaving the user to infer it.
- ⚠️ **The write happens on a read**, so a user who never opens `/transactions` has no cached list —
  the same consequence decision 6 records for the dashboard, for the same reason (no timer).
- ⚠️ **Requires the app lock to survive a reload** (ADR-025 decision 3): with no lock the store is
  in-memory and the label survives navigation but not a reload.
- ⚠️ **Analytics' offline view is still owed**, and it is now the only 📖 row in docs/07 §6 with no
  record behind it.

**Alternatives rejected.**
- **(a) Serve the cached rows on `/analytics` as its "cached period".** A table of raw rows where the
  screen promises category spend is a different kind of fabrication, not a smaller one. If analytics is
  to work offline it needs its own record (the server's aggregates), which is rejected option (f)'s
  "own design".
- **(b) Cache filtered reads too.** Four rows cached under a search would be served later as the
  ledger, and nothing in the record would say they were a subset.
- **(c) Cache every page as the user scrolls.** It would grow the record past its cap and, worse, make
  the cached window depend on how far somebody happened to scroll — a ledger view whose completeness
  varies by accident.
- **(d) Add an id to the whitelist so cached rows can be opened.** An id is the first step back to a
  full ledger copy on the device, which docs/08 §3.9 exists to bound; and the row a user taps offline
  could not be edited anyway (an edit needs a connection and a version).
- **(e) Label each cached row with its own time.** Decision 4's argument, unchanged: one snapshot
  moment, one label.

### ADR-028 — Web push: the protocol's own library, a sender that is inert without keys, and a payload the lock screen can show
**Status:** Accepted

**Context.** `WEB_PUSH` and `PUSH` rows have been written since 3.1.2 and **never delivered**:
`NotificationsService.dispatch` skips them and reports `skipped`, with the comment that "there is no push
dependency to send with". docs/09 §6 schedules 4.2.5 as *"web push subscription + permission flow"* — the
**client** half — which cannot work without a sender, a subscription store and a key pair that no task
builds. So this is the third plan gap of the same shape as ADR-025's app lock: the planned task assumes a
counterpart that was never scheduled.

Three constraints shape the decision:

- **T-09** ([08 §2.3](08-security-privacy-and-compliance.md)): a notification payload must be
  lock-screen-safe — **no amounts, no Merchant or Counterparty names**. A push payload is rendered by the
  operating system on a locked device, which is the least private surface the product has.
- **push is a third party by construction.** The payload is end-to-end encrypted (RFC 8291), but the
  **endpoint, the timing and the count** pass through Apple's, Google's or Mozilla's push service — a
  sub-processor class this product did not previously have, in a design that self-hosts object storage
  (ADR-018) and keeps AI in-region (ADR-007) precisely to avoid one.
- **iOS gives push only to an installed PWA** ([07 §4.8](07-platform-strategy-mobile-desktop.md)):
  `PushManager` does not exist in a Safari tab, so the flow must not promise what the platform withholds,
  and email stays the fallback (docs/07 §6).

**Decision.**

1. **The sender is `web-push`, the protocol's own library** — RFC 8291 (`aes128gcm`) payload encryption and
   VAPID — added to `apps/api`. It is a protocol implementation, not a vendor platform: no account, no
   dashboard, no second copy of our data. Rule 9 is satisfied by this ADR.
2. **The sender is a seam that is inert without keys**, exactly like `SCANNER` (ADR-023), `OCR` and
   `OBJECT_STORAGE`: `WEB_PUSH` resolves to an unconfigured implementation when `VAPID_PUBLIC_KEY` /
   `VAPID_PRIVATE_KEY` are absent, rows stay `QUEUED`, and `dispatch` reports them `skipped` **with a
   reason** rather than a bare count. A deployment that has not configured VAPID must be able to see that
   nothing was delivered and why.
3. **`push_subscriptions` is a new household-scoped table**: one row per `endpoint` (unique), with
   `user_id`, `household_id`, `p256dh`, `auth`, `user_agent`, `created_at`, `last_seen_at` and a soft
   delete. A `404`/`410` from the push service **deletes** the row — a dead endpoint is not a delivery
   failure to retry — and a re-subscription of the same endpoint updates it rather than duplicating.
4. **The payload is minimal by construction.** It carries `{ notificationId, kind, deepLink }` and **no
   sentence, no amount and no name**: `kind` selects a **generic** sentence the client already has
   translated (`"Novo obaveštenje"` / `"You have a new alert"`), and the detail is read in the app. That
   keeps T-09 enforced in one place, keeps copy in the i18n catalogue, and means a compromised or curious
   push service learns nothing but "this device was told something at 08:12".
5. **Push is opt-in, and it is one channel among three.** The preference already exists
   (`households.settings.notifications`); `IN_APP` is the row itself and `EMAIL` is the fallback, so a
   Household that does not want a third party in the path simply does not enable push. The permission
   prompt is asked **after** an explanation, never on load (4.2.5's client half), and a denied permission
   is a state the UI shows rather than a broken control.
6. **`SENT` means "accepted by the push service"**, not "seen". Push has no receipt, so the notification
   row remains the record and the copy never claims delivery to a person.

**Amendment — task 4.2.5, when the client half was built (decision 4 corrected).** Decision 4 assumed the
*client* could turn `kind` into the generic sentence the lock screen shows. It cannot. `@angular/service-worker`'s
`ngsw-worker.js` handles a `push` event in `Driver.handlePush` by broadcasting the payload to any open
client and then —

```js
if (!data.notification || !data.notification.title) return;
await this.scope.registration.showNotification(data.notification.title, options);
```

— so a payload of `{ notificationId, kind, deepLink }` shows **no notification when the app is closed**,
which is the only moment push exists for; and the title it would show has to come from the payload,
because the SPA — and therefore the i18n catalogue decision 4 relied on — is not running. Amended, the
payload is:

```json
{
  "notificationId": "…", "kind": "BUDGET_PACE", "deepLink": "/budgets",
  "notification": {
    "title": "<APP_NAME>",
    "data": { "onActionClick": { "default": { "operation": "navigateLastFocusedOrOpen", "url": "/budgets" } } }
  }
}
```

The only text that reaches a lock screen is the **brand**, `APP_NAME` from configuration (ADR-014) — not a
sentence, so it needs no translation and does not put unreviewed copy on a lock screen, which was rejected
alternative (c)'s actual objection. T-09 stays structural: the title is a constant chosen by the sender, the
row's own `title`/`body` are still never read, and `web-push-payload.spec.ts` now asserts that **every
string in the serialised payload** is one of the values this file itself decided. `data.onActionClick` is how
`ngsw`'s own `Driver.handleClick` opens the deep link, and it is what makes a tap land on the screen that
caused the notification. Nothing else about decisions 1–3 and 5–6 changes.

**Consequences.**
- ✅ F-22's push finally has a path: subscription → sender → delivered, with the seams this repo already
  uses for every unconfigured integration, so a CI without VAPID keys still tests the whole dispatch flow.
- ✅ The lock-screen rule is structural rather than editorial: there is no field in the payload that could
  carry an amount, so no future copy change can leak one.
- ✅ A dead endpoint prunes itself, and a re-subscribe updates, so the table cannot grow stale duplicates.
- ⚠️ **A new sub-processor class enters the register**: Apple/Google/Mozilla push services see the
  endpoint, the timing and the count of our notifications. `push_subscriptions.endpoint` is also personal
  data (a device identifier), so it belongs in [08 §3.9's data-flow table](08-security-privacy-and-compliance.md)
  and in the erasure path (`gdpr.purge`), and the privacy policy must name push services before beta.
- ⚠️ **A new dependency on the API** (`web-push`), with a supply-chain surface ([08 §9.6](08-security-privacy-and-compliance.md), T-15).
- ⚠️ **VAPID keys are secrets**: they live in configuration, never in the repository, and rotating them
  invalidates every existing subscription — so a rotation is a re-subscribe campaign, not a redeploy.
- ⚠️ **Delivery is best-effort and unobservable.** A `SENT` row may never have reached a device, so the
  in-app centre must remain the canonical list and no screen may say "sent to your phone".
- ⚠️ **The payload shape is coupled to `ngsw`'s handler, which is not a public contract.** `handlePush`
  and `onActionClick` are implementation, not documentation; an `@angular/service-worker` upgrade that
  renames either would make push *silently* show nothing (R-24). Anything that changes the payload must be
  re-checked against the installed `ngsw-worker.js`, and the unit test's "every string is one of ours"
  assertion is what catches an accidental copy leak in the meantime.
- ⚠️ **iOS delivers push only to an installed PWA** and **the PWA is not installable yet** (no manifest —
  4.3.2, blocked on the product name). Until then web push is effectively Android/desktop only, which is a
  capability gap to state in the UI rather than discover.
- ⚠️ The worker's `notifications.dispatch` job is the sender's caller, so push delivery inherits the job's
  idempotency rules (ADR-022): a re-dispatch of an already-`SENT` row must not send twice, which is what the
  row's status is for.

**Alternatives rejected.**
- **(a) A push platform (OneSignal, Firebase Cloud Messaging).** A sub-processor holding our payloads by
  default, a vendor lock, and a dashboard to operate — for a protocol `web-push` implements in a few
  hundred lines we can read.
- **(b) Put the amount or the Merchant in the payload** so the lock screen is more useful. T-09 forbids it,
  and a lock screen is precisely where a household's spending should not appear.
- **(c) Server-rendered copy in the payload.** It would move i18n into the API (already a recorded breach
  for email, docs/06 §5.14) and put a sentence on a lock screen that no reviewer sees in the catalogue.
- **(d) The service worker polling for notifications instead of push.** A timer in a background worker,
  which this repo does not trust in a PWA (ADR-025) and which iOS throttles heavily anyway.
- **(e) Email only, no push.** docs/07 §6 wants push as the primary channel with email as the iOS fallback;
  dropping push would leave the alert design worse for the majority platform to avoid a third party that
  the user opts into.
- **(f) Ship the client half first (4.2.5 as planned) and subscribe to nothing.** A permission prompt that
  leads to a `403` from an unimplemented endpoint is worse than not asking.

---

### ADR-029 — The app lock's WebAuthn secret is the PRF extension, and its policy is five idle minutes
**Status:** Accepted

**Context.** ADR-025 decision 3 named the app lock as task 4.2.6 and said what it is *for* — the data key is
persisted **only** wrapped by an app-lock secret — while docs/08 §3.9 fixed the policy (*"Re-auth on cold
start and after 5 minutes idle. Preferred: WebAuthn platform authenticator. Fallback: 6-digit app PIN"*).
Two things neither document says, and both are load-bearing:

1. **What a WebAuthn credential contributes.** A credential id, an authenticator's public key and a
   signature are all public; none of them can wrap a key. A platform authenticator can produce a *secret*
   through exactly one mechanism — the **PRF extension**, which evaluates a pseudo-random function over a
   per-install salt and returns 32 stable bytes that only that authenticator can reproduce. Without PRF the
   WebAuthn path cannot be a key source at all, only a gate over a secret stored somewhere else — which is
   ADR-025's rejected alternative (a) wearing a costume.
2. **The cost of getting the state machine wrong.** A lock that cannot reproduce its key is a one-way door
   on the user's queue; a lock that reports itself armed after an interrupted write gates the user behind a
   secret nothing can unwrap; and a lock that stays unlocked past its idle window is a lost phone away from
   T-03 (L4 × I4). None of these are visible in a screen that looks fine.

**Decision.**

1. **The WebAuthn path is the PRF extension, probed rather than assumed.** Registration calls
   `credentials.create()` with an **empty** `prf` input and treats `prf.enabled !== true` as *this
   authenticator cannot do PRF*; only then is the salt evaluated through `credentials.get()`, and the
   output is run through HKDF-SHA-256 with a domain-separation `info` string to become the AES-GCM-256
   key-wrapping key. The two steps are separate because a `create()` that asked for an evaluation an
   authenticator ignores returns no output and would look like a bug instead of a capability answer.
2. **When PRF is unavailable the caller must fall back to the PIN, never to an unwrapped key.** The
   capability check returns `null` and the service reports `WEBAUTHN_UNAVAILABLE`; nothing is written. The
   PIN is stretched with PBKDF2-SHA-256 at 600 000 iterations exactly as ADR-025 decision 4 fixed it.
3. **The install's metadata is the one plaintext record.** The lock's method, its salt and its credential
   id live in the `keys` store beside the wrapped key, because without them the wrapped key can never be
   unwrapped again. A salt is not a secret and a credential id is public by construction, so this does not
   weaken the posture — but it is written down, because "the database is all ciphertext" would otherwise be
   a claim the code does not keep.
4. **A half-written lock is not a lock.** Metadata and wrapped key are written together, and the state is
   derived from **both**: either one missing is `OFF`, never `LOCKED`. An interrupted registration therefore
   degrades to "no lock" rather than to a screen nobody can get past.
5. **The lock is opt-in, and enabling it is what turns persistence on.** `OFF` means the session provider
   and an in-memory store; `UNLOCKED` means the wrapped provider and IndexedDB; `LOCKED` means the
   in-memory store again, because a page with no key in memory may not read what is on disk. The offline
   store's backing is rebuilt when that changes, which is what keeps ADR-025 decision 3's sentence true in
   both directions.
6. **Arming is refused while the queue is not empty.** The entries in the in-memory store are encrypted
   under the session key; re-keying them into a durable store is a migration whose failure mode is a lost
   confirmed capture. Draining first is a step the user can see.
7. **Policy: locked on cold start and after five idle minutes**, both from docs/08 §3.9. Idle is measured
   from the last activity and `null` activity is *not* idleness — a lock that has just been opened must not
   immediately re-lock. The rule is a pure function (`shouldLockOnIdle`) so it is testable without a timer;
   polling it is the lock screen's job (4.2.6b).
8. **One flush at a time across tabs.** ADR-026 decision 4 deferred this here because persistence is what
   makes it real: with one IndexedDB behind every tab, two tabs can see the same queue. The flush runs
   under a Web Locks mutex (`finmate:offline-flush`, `mode: 'exclusive'`, `ifAvailable: true`), and a tab
   that cannot take it **skips** rather than waiting to send the same entries a moment later. Without Web
   Locks it runs: a lock that cannot be taken must not mean a queue that never drains, and ADR-025's
   implementation notes already record that capture from one tab is the supported configuration.
9. **`purge()` is one operation with two names' worth of callers** — turning the lock off, sign-out, a
   `401`/remote revoke, household deletion. It removes the lock configuration with the data, because
   ADR-025 decision 2 makes the wrapped key the first thing a purge removes; a wipe that left a lock behind
   would leave a door with no key.

**Consequences.**
- ✅ T-03's mitigation is real rather than intended: a filesystem dump yields a wrapped key and no secret,
  and the wrap is an authenticator's PRF output on the path most devices will take.
- ✅ The lock is a seam: the store, the outbox and the snapshot needed no data migration to gain
  persistence, and `OFF` is still a fully usable app (ADR-025's rejected alternative (c)).
- ✅ The failure modes that matter are asserted, not assumed: the cold-start-reload test is a second
  service instance over the same database, the round trip is proved by decrypting across it, and the wipe
  is read from the **raw** database rather than through the service's own accessor.
- ⚠️ **PRF support is uneven.** Chrome/Edge on desktop and Android, and recent Safari, expose it on
  platform authenticators; Firefox does not. On those devices the PIN is the only path, which is why the
  PIN is a first-class fallback rather than an error case — and why the UI must offer it (4.2.6b) rather
  than showing a disabled button.
- ⚠️ **No browser has driven the real prompt in this build.** The WebAuthn path is tested against a fake
  authenticator with a deterministic PRF; a real device, a real Face ID prompt and a real cancellation are
  unverified. A manual pass on a phone is required before beta, and it is named in docs/10's device matrix.
- ⚠️ **5 idle minutes is a delay, not a lock against a determined attacker with the unlocked device and
  the PIN** — docs/08 §3.9's honest limit stands unchanged, and the native shell (v2, ADR-012) is the fix.
- ✅ **The device panel and the re-auth screen shipped in 4.2.6b** (`/settings` → `Bezbednost`, and the
  gate the shell renders while locked), so a user can arm the lock and F-26's offline capture survives a
  reload. R-23 is closed: the capability exists, and an install that leaves the lock off still persists
  nothing — which is a decision, not a gap.
- ⚠️ `purge()` deletes the lock configuration, so a sign-out on a phone means re-arming (and re-consenting
  to the biometric prompt) at the next sign-in. That is ADR-025 decision 2's order, and it is the safer
  reading of docs/08 §3.9's "wipes on logout".

**Alternatives rejected.**
- **(a) Use WebAuthn as a gate over a key stored unwrapped.** The most common shape in the wild, and the
  one that makes "encrypted at rest" false while looking true — ADR-025's alternative (a), rejected there
  and again here.
- **(b) Derive the wrapping key from the credential id or a signature.** Both are public; this is (a) with
  extra steps.
- **(c) A PIN-only lock, with WebAuthn as an unlock convenience over the same PIN-derived key.** It would
  work everywhere, and it would make the six-digit PIN the only real secret on every device — lowering the
  weakest device's posture to the lowest common denominator instead of using the authenticator where it
  exists.
- **(d) Keep the lock in memory only and never persist the wrapped key.** That is the current state, and it
  cannot satisfy Sprint 4.2's own exit criterion (offline capture that survives a reload) — the gap R-23
  records.
- **(e) Migrate the in-memory queue into the durable store when the lock is armed.** Re-encrypting a
  user's confirmed captures from one key to another is exactly where a bug loses data, for a case the UI
  can avoid by asking the user to let the queue drain first.
- **(f) Elect a leader tab with a `BroadcastChannel` claim.** A claim needs a timeout, a heartbeat and a
  re-election rule to survive a closed tab — a distributed-systems problem for a mutex the platform
  already provides.

### ADR-030 — Queued edits: what the queue may carry, and a conflict diff that quotes no decision
**Status:** Accepted

**Context.** ADR-026 decision 2 queued whole `captureCommit` batches and deferred **edits** here, with the
reason written down: *"deciding which mutations may be queued offline is a product decision about what
'offline' means (docs/07 §6's matrix draws the line at capture and review)"*, and docs/02 §4.3's offline
sequence ends with *"409 + version on an edited row → money-field diff"* — a diff no task built, because
nothing queued an edit. Four things needed deciding, and each is wrong **silently** when it is wrong:

1. **Which writes the queue may carry.** A queue that accepts any mutation is a second, weaker API: no
   screen asked for it, and a queued delete of a row somebody else has since edited is worse than an
   error.
2. **What a stale edit means.** `updateTransaction` takes the `version` the client read and answers
   `CONFLICT` when it no longer matches. A queue that re-read the row and bumped the version before
   sending would turn optimistic concurrency into a **silent overwrite** — the exact defect the field
   exists to catch.
3. **What the user is shown.** ADR-026's re-classification diff has a `why` because the server *decided*
   something about a row it accepted. A conflict is a write the server **rejected**, and the API gives no
   decision to quote. Inventing a reason there would be a screen explaining something that never happened.
4. **What the diff compares.** Money is `BIGINT` minor units (ADR-003); a diff that parsed it to decide
   whether something changed would be arithmetic in the money path.

**Decision.**

1. **The queue carries two documents and no more**: `captureCommit` (4.2.3, batched atomically) and
   `updateTransaction` (this task). An entry records its **kind** (`OutboxKind`), because the two need
   different outcomes, and the document is what dispatches them — there is no kind on the wire, and
   matching the document string is the one honest signal available. An entry written before the field
   existed reads as a capture, which is all 4.2.3 could queue.
2. **An edit is queued only when the failure was retryable.** A refusal that needs a person stays an
   error on the screen where the person is (ADR-026 decision 3); nothing about editing changes that.
3. **`version` is mandatory and is never refreshed.** A queued edit carries the version the user read. If
   the row moved, the server refuses it; the queue does not "helpfully" re-read and retry, because that
   is a silent overwrite. This is the constraint most likely to be eroded by a future convenience.
4. **A `CONFLICT` parks the entry and does not stop the flush.** The API already answers
   `retryable: false`, so the outbox's own classifier marks the entry *ne može se poslati* and carries on
   — one stale row must not block a queue of unrelated captures behind it.
5. **The conflict's detail is recorded separately from a re-classification diff.** `SyncConflict` is its
   own list with its own type: one says "the server accepted this row and changed the category, here is
   what decided it", the other says "the server refused this write". Merging them would let one screen
   imply the other's outcome.
6. **The diff quotes no decision — it shows the two versions.** `editedVersion` and `serverVersion` are
   the entire explanation the API supports, and rendering them is what keeps the screen from inventing a
   `why`. The re-classification arm's `Zašto` line stays where it belongs.
7. **The diff compares only the fields the edit carried, as strings.** A field the user never touched
   cannot be "what they changed", and comparing the row's other values would report untouched fields as
   differences the moment the `before` snapshot was incomplete — which is exactly what the first version
   of this code did, caught by its own spec. Money is compared as the rendition each side gave
   (`'2000'` vs `'2000.00'` are not equal), never parsed.
8. **An empty change list is still a conflict.** The version moved because somebody changed a field this
   edit did not; that is worth showing, because the user's press did fail. The screen says so in words
   rather than rendering an empty table.
9. **The UI is 4.2.7b** — the sheet queueing an edit when it is offline, and the tray's conflict panel.
   This record covers the queue and the diff it produces, which is what the UI needs to exist first.

**Consequences.**
- ✅ docs/02 §4.3's *"409 + version on an edited row → money-field diff"* finally has a producer, and the
  diff is a comparison of two real observations rather than a reconstruction of either.
- ✅ Optimistic concurrency survives the queue: a stale edit is refused and explained rather than applied.
- ✅ The queue's meaning stays small enough to reason about — two documents, one of which is append-only
  and idempotent, the other explicitly version-checked.
- ⚠️ **`captureCommit` is idempotent and an edit is not.** A replay of a capture collapses (I-10); a
  replay of an edit succeeds once and then conflicts, because the first attempt bumped the version. The
  outbox removes an entry only after a successful send, so this is only reachable if a response was lost
  after the write landed — in which case the entry keeps its old version and parks as a conflict, which is
  honest and recoverable by hand. A queued edit is therefore **at-most-once, not idempotent**, and the
  difference is recorded here rather than discovered later.
- ⚠️ **The `before` snapshot is the caller's responsibility.** An incomplete one yields a diff with
  spurious rows; the service limits the comparison to the fields the edit carried to shrink that window,
  but a caller that flattens `amount` wrongly still produces a wrong "before". `enqueueEdit`'s contract
  says so, and the spec pins the shape.
- ⚠️ **A conflict is a dead end that needs a person**: the entry can be retried (same stale version, same
  conflict) or discarded. 4.2.7b offers exactly those two, which is what the tray already does for a
  refusal.
- ⚠️ **`correctTransaction` is not queued.** A category change that should teach a rule still needs the
  network — the learning signal is recorded against the version the user read, and a queue would have to
  decide what a delayed correction teaches. Recorded, not silently omitted.

**Alternatives rejected.**
- **(a) Queue any mutation the client can call.** A second API with weaker semantics, and the queue's
  ordering/retry rules were designed for one append-only document.
- **(b) Re-read the row before flushing and send the new version.** Turns a conflict into a silent
  overwrite of somebody else's change, which is the one thing `version` exists to prevent.
- **(c) Merge field-by-field automatically and apply the union.** A conflict-resolution policy for money
  is a product decision, the user cannot see what was merged, and "both changed the amount" has no
  safe union.
- **(d) Report the conflict through the existing `SyncDiff` shape.** The two mean different things
  (accepted-and-reclassified vs refused), and one shape would force the tray to guess from a field.
- **(e) Treat a conflict as retryable.** It is not: the same stale version produces the same conflict
  forever, and the retry loop would burn the backoff and the user's patience.
- **(f) Queue `deleteTransaction`.** A queued delete of a row that changed while offline destroys work
  with no diff to show for it; it needs its own decision, not an extra arm here.

### ADR-031 — An `_EU` suffix must name an EEA host, and `DEEPSEEK_GLOBAL` is what is not EEA
**Status:** Accepted

**Context.** A DeepSeek API key was supplied on 2026-09-16 to give the app AI support — the first real
credential this project has had. Checking what it would take turned up three things, none of which the
key could fix:

1. **There is no composition root.** `AI_CLASSIFIER` is bound as `useValue: UNCONFIGURED_AI_CLASSIFIER`
   (`classification.module.ts`), `NARRATOR`/`OCR`/`EMBEDDINGS` are the same shape, and **nothing in
   `apps/` calls the provider factories or reads the routing table**: `AI_PARSE_PRIMARY` and its
   siblings are validated at boot and then never read. The pipeline degrades to rules-only correctly and
   always will, with or without a key.
2. **Every `_EU` label was false.** `DEEPSEEK_EU` resolved to `https://api.deepseek.com` and
   `OPENAI_EU` to `https://api.openai.com` — neither host is in the EEA — while `ANTHROPIC_EU` and
   `GEMINI_EU` were in `UNIMPLEMENTED_ENDPOINTS` *and* `AI_NARRATE_PRIMARY` defaulted to
   `ANTHROPIC_EU`. The residency guard is a suffix predicate, so `AI_CLASSIFY_PRIMARY=DEEPSEEK_EU`
   passed it while sending household free text — merchant and person names — to a non-adequacy
   jurisdiction. That is precisely the Chapter V transfer [04 §9](04-categorization-and-ai-engine.md)
   records as *removed as a default*, reinstated by one environment variable, with the boot check
   reporting the configuration valid.
3. **Consent does not exist.** ADR-007 permits a non-EEA endpoint only as a "consent-gated exception",
   and there is no consent column, no check and no UI: `aiConsentGiven` appears in docs and the GraphQL
   sketch and nowhere else.

The third of those is why this is an ADR and not a patch. A guarantee that a configuration value can
satisfy while the traffic goes elsewhere is worse than no guarantee, because it is *relied upon*.

**Decision.**

1. **An `*_EU` endpoint must be configured with the EEA host it means** — `DEEPSEEK_EU_BASE_URL`,
   `OPENAI_EU_BASE_URL`, `ANTHROPIC_EU_BASE_URL`, `GEMINI_EU_BASE_URL`. There is **no default**, and
   the boot guard refuses a task primary that names one without it. The provider factories take the
   base URL as an input rather than reading a constant, so the old behaviour is not merely checked
   against — it is unwriteable.
2. **`DEEPSEEK_GLOBAL` is the truthful name** for DeepSeek's own platform. It is listed in
   `NON_EEA_ENDPOINTS`, `isEeaOrLocal` rejects it, and admission is `isAdmissible(endpoint,
   consentRecorded)` — a predicate that takes consent as an *argument*, so a caller cannot reach a
   non-EEA endpoint without having decided what it is doing.
3. **`DEFAULT_ROUTING` is `LOCAL` for every task, with `null` fallbacks.** A fallback that cannot be
   honoured is not a fallback; a deployment with a real EEA host configures one. The degradation ladder
   already covers "no endpoint", so nothing else changes.
4. **`AI_NARRATE_PRIMARY` defaults to `LOCAL`.** Its previous default named an unimplemented endpoint,
   so every narration silently fell through to the template — the honest default is the one the
   behaviour already had.
5. **The key lives in `.env` only** (`.gitignore` line 30) and never in `.env.example`, which carries
   placeholders for the new base URLs. A credential in a tracked file is a leak; a credential in a
   *transcript* is a rotation.
6. **What is still to build, recorded rather than implied:** the composition root (config → routing →
   provider instances → the tokens) and the per-Household consent store plus its enforcement. Until
   both exist, `DEEPSEEK_GLOBAL` is admissible and unreachable: **no traffic leaves the EEA today, and
   none can**, because there is no wiring to leave through.

**Consequences.**
- ✅ The residency rule is now a fact about hosts rather than a claim about names: the suffix cannot be
  satisfied by a spelling, and the one non-EEA endpoint this build knows says so in its name.
- ✅ The defect is visible in the tests that used to pin it: `endpoints.spec.ts` asserted
  `DEFAULT_ROUTING` was "docs/04 §9 verbatim", including the two-hop chain that made the claim false.
  Those assertions are now the record of what changed.
- ⚠️ **A deployment that had `AI_CLASSIFY_PRIMARY=DEEPSEEK_EU` (or any `_EU` primary) and no base URL
  now fails to boot.** That breakage is the point — it is the difference between a silent Chapter V
  transfer and a configuration error — but it is a breaking configuration change, and `.env.example`
  now shows what to set.
- ⚠️ **This commit does not give the app AI.** It removes a false compliance claim, names the non-EEA
  endpoint honestly, and makes the consent question unskippable. `Lidl 2000` still resolves by rules and
  keywords — which is the designed behaviour with no provider wired, not a regression.
- ⚠️ **Consent is still unimplemented**, so `DEEPSEEK_GLOBAL` is admissible-by-config and unusable in
  fact. The gate must land before the routing does, or the exception ADR-007 allows would be an
  exception nobody granted.
- ⚠️ **`LOCAL` remains an aspiration on this machine**: nothing is listening on
  `LOCAL_AI_DEFAULT_BASE_URL`, so routing `LOCAL` means rules-only. ADR-021's inert embeddings and this
  are the same honesty rule seen from two sides.
- ⚠️ A key supplied in a chat transcript should be treated as exposed and rotated once a deployment
  path exists; the repository is the part this ADR can protect.

**Alternatives rejected.**
- **(a) Use the key as supplied — `AI_CLASSIFY_PRIMARY=DEEPSEEK_EU`.** The one-word version of the
  request. It would have made the code report EEA compliance for traffic leaving the EEA, which is the
  failure mode this ADR exists to prevent.
- **(b) Leave the labels, document the discrepancy.** A note beside a false claim is still a false
  claim; the guard's whole value is that it can be trusted without reading the note.
- **(c) Rename only DeepSeek's endpoint.** `OPENAI_EU` had the same defect and `ANTHROPIC_EU` was the
  *default*, so the systemic fix — no default host for an `_EU` endpoint — is the one that holds.
- **(d) Enforce residency by an allow-list of known-good hosts.** It cannot work: jurisdiction is not a
  property of a hostname string, so the list would need the same human judgement it was meant to
  replace, one DNS entry at a time.
- **(e) Build the composition root first and decide this later.** It would wire the same false labels
  into a path that actually sends data, turning a documented defect into an incident.

### ADR-032 — Consent is a per-Household record, and the router asks it on every call
**Status:** Accepted

**Context.** ADR-031 removed a false residency guarantee and recorded that two things must exist before
anything could leave the EEA: a composition root (config → routing → adapters → the injected seams) and
a per-Household consent store with enforcement. It also said the gate had to land *before* the routing,
"or the exception ADR-007 allows would be an exception nobody granted". Building both turned up four
things worth deciding rather than discovering:

1. **A `consents` table already exists and does not say what docs/08 §6.6 says.** docs/03 §4 owns the
   DDL — `kind TEXT CHECK (kind IN ('AI_DATA_PROCESSING','EVAL_DATASET','MARKETING_EMAIL','CLOUD_OCR'))`,
   `granted BOOLEAN`, `policy_version`, `recorded_at`, `withdrawn_at`, `evidence JSONB` — and it is
   applied. docs/08 §6.6 sketches a different table: `purpose` with four values
   (`AI_TEXT_EGRESS`, `AI_RECEIPT_OCR`, `AI_NARRATION`, `EVAL_DATASET`), a `state` enum and
   `decided_at`. docs/06 §4 sketches a **third** answer: a single `aiConsentGiven: Boolean!` on
   `HouseholdSettings`, and on `SignUpInput` "cannot be omitted".
2. **`AiRouter` had no way to ask.** `isAdmissible(endpoint, consentRecorded)` existed from 2.2.1 and
   nothing passed `true`, so `validateRouting` refused every non-EEA endpoint and the consent question
   was unreachable rather than answered.
3. **The capture path already had a `allowAi` flag** (docs/06 §5.1) defaulting to `true`. Treating that
   as the consent record was the tempting shortcut, and it is wrong: a per-request flag set by a client
   is not a recorded decision by the data subject, and "absent means yes" is the opposite of docs/08
   §6.6's rule.
4. **The first live provider found two defects** that no test could see, because both live in the seam
   between two packages rather than in either one (§ "What the live call found").

**Decision.**

1. **The record is the shipped table, and the purposes map onto it.** `consents` stays as docs/03 §4
   defines it; docs/08 §6.6's four purposes are the *product* vocabulary and map onto two stored kinds —
   `AI_TEXT_EGRESS` + `AI_NARRATION` → `AI_DATA_PROCESSING`, `AI_RECEIPT_OCR` → `CLOUD_OCR`,
   `EVAL_DATASET` → `EVAL_DATASET`. The mapping lives in one place
   (`apps/api/src/modules/consent/consent.ts`) and travels to the client on every row, so no screen
   invents it. Reshaping the table to four purposes is **deferred**, not refused: it is a migration with
   no data and no consumer yet, and the coarser record loses no meaning, only granularity between two
   text purposes that share an endpoint.
2. **The gate is a callback on the router, asked once per non-EEA endpoint per call.**
   `RouterOptions.consent?: ConsentGate` with `permits(task): boolean | Promise<boolean>`. The
   constructor **refuses a table that names a non-EEA endpoint when no gate is installed**, so such a
   route cannot exist in a process that has no way to say no to it. Asking on every call is what makes
   withdrawal immediate (docs/08 §6.6); a memoised grant would outlive it. A gate that throws is a
   refusal, and the refusal is a value — `CONSENT_DECLINED`, a rung of the ladder, never an exception.
3. **`apps/api/src/modules/ai` is the composition root and the only place a model's host or key is
   read.** It assembles the routing table and one adapter per usable endpoint from validated config,
   installs `ConsentsService` as the gate, and provides `AI_CLASSIFIER`, `NARRATOR`, `OCR` and
   `EMBEDDINGS`. `LOCAL` is usable **only** when `LOCAL_AI_BASE_URL` is set, because setting it is a
   claim that a model is listening and the old default claimed it on a port nothing listened on.
   `EMBEDDINGS` stays the unconfigured twin: rung 5 needs a model and a *width*
   (`entity_embeddings.embedding` is `vector(384)`), not a host (ADR-021).
4. **The consent surface is `aiConsents` + `recordAiConsent`, OWNER-only** (docs/08 §6.6, Q-11), and the
   record is append-only with `WITHDRAWN` stored as `granted = false` plus `withdrawn_at`, which is how
   docs/03 §4's columns express docs/08 §6.6's state machine without a migration. docs/06 §4's
   `SignUpInput.aiConsentGiven` / `HouseholdSettings.aiConsentGiven` booleans are **not implemented**:
   a boolean cannot answer "may the Receipt image go?" separately from "may the free text go?", so it
   contradicts docs/08 §6.6's granularity requirement in the same document set. Recorded as a doc
   defect rather than reconciled silently.
5. **`allowAi` stays, and is not consent.** It is a per-request opt-out (default `true`) meaning "not
   this request"; consent is a per-Household record (default absent ⇒ refused) meaning "this Household
   may". Both must pass before a non-EEA endpoint is called. Conflating them would either make the
   default an unlawful assumption or make every capture a consent decision.
6. **What the live call found is part of the decision that the root exists to be verifiable.** With
   `AI_CLASSIFY_PRIMARY=DEEPSEEK_GLOBAL` and a recorded grant, every answer came back `categoryId:
   null`. Two independent defects, both fixed here: the category list was rendered **twice** — by the
   caller with real UUIDs and by the adapter with its placeholders — so the model answered in a
   vocabulary the redaction map could not resolve; and `json_object` mode, which constrains syntax and
   not keys, was **never told the field names**, so DeepSeek invented them
   (`{"category_id": …, "reason": …}`). The split is now explicit: **the caller renders the
   instructions, the adapter renders the payload**, and the `json_object` prompt carries the same schema
   constant the `json_schema` path transmits. Both have regression tests at the composed seam, which is
   where they belong — neither package's own suite could have caught either.

**Consequences.**
- ✅ **The residency rule is now enforced against a record, not a configuration.** A deployment may name
  `DEEPSEEK_GLOBAL`; a Household with no `GRANTED` row still gets rules and keywords, instantly, with no
  socket opened. Verified live: `usedAi: false` / `RUNG: RULES_KEYWORDS_ONLY` before the grant,
  `decidedBy: AI` with provider `DEEPSEEK`, model `deepseek-flash`, latency and `cost_micros` in
  `classification_decisions` after it, and refused again the moment it was withdrawn.
- ✅ **`Lidl 2000` still resolves by keyword** (`decidedBy: KEYWORD`, 0.923) with a provider configured.
  ADR-002 is untouched — the AI is the exception path, and the first live run is the evidence.
- ✅ **The two prompt defects are the strongest argument for this ADR's existence.** Neither was visible
  to typecheck, lint, `web:build`, the 2 400-test suite or the eval gates; both were found within a
  minute of the first real call, because the root made the composed path *runnable*.
- ⚠️ **The consent sheet is unbuilt.** A Household can record consent only through the mutation, so on
  any deployment without a client for it, every Household is `NOT_ASKED` and gets rules-only. That is
  the safe direction and it is a real product gap: the sheet is docs/02 §4.18's *AI podešavanja*, part of
  the settings work. Recorded as R-25.
- ⚠️ **`AI_CLASSIFY_PRIMARY` is set to `DEEPSEEK_GLOBAL` in the dev `.env` only.** `.env.example` keeps
  `LOCAL`, because a deployment should not default to a non-EEA provider; the file now documents why
  naming it is safe rather than forbidden.
- ⚠️ **The `json_object` steering costs tokens on every call to such an endpoint** (~400 for the
  classify schema). `json_schema` providers pay nothing. This is a documented cost, not a regression.
- ⚠️ **`LOCAL_AI_BASE_URL` has no default any more, and `.env.example` leaves it blank.** A deployment
  that had relied on the old `http://localhost:11434` default must now set it — which is the point: the
  default was a claim about a model that was not running.
- ⚠️ **Rung 5 is still inert** (ADR-021) and **`EVAL_DATASET` consent is recordable but read by
  nothing** (docs/08 §8.7 is unbuilt). Both are named, not implied.
- ⚠️ Consent is **not** audited into `audit_log` yet, and `gdpr.purge` does not exist, so a
  `consents` row currently has no erasure path other than the Household cascade. Named in the task list.

**Alternatives rejected.**
- **(a) One `aiConsentGiven` boolean, as docs/06 sketches.** It cannot distinguish text from image, and
  it moves the decision to signup, which docs/08 §6.6 explicitly rejects ("requested at first use, not
  buried in onboarding").
- **(b) Reshape `consents` to docs/08 §6.6's four purposes now.** A migration against an empty table,
  changing the canonical DDL for a granularity nothing consumes. Deferred with the mapping recorded
  instead — the reverse of a silent reconciliation.
- **(c) Enforce consent in the boot guard.** It cannot be done: consent is per Household and revocable
  at runtime, so a validated-once value is either a false guarantee or a full restart per withdrawal.
- **(d) Have `packages/ai` read the consent record.** The package has no database by construction, and
  giving it one would put tenancy and residency in a library. The callback keeps the decision in
  `apps/api` and the mechanism in the package.
- **(e) Treat `allowAi: true` as consent.** A client-set request flag is not evidence of a lawful basis,
  and its default would be the assumption docs/08 §6.6 forbids.
- **(f) Make the adapter tolerant of the model's own key names** (`category_id`, `reason`,
  `alternatives` as strings). It would have made the first live call "work" by guessing at a schema —
  and guessing is how a plausible wrong field becomes a persisted decision. Describing the shape is
  the fix; leniency is a second bug wearing the first one's coat.
- **(g) Send `response_format: json_schema` to DeepSeek.** Its platform does not offer the mode (the
  factory says so), so the request would either be rejected or silently ignored — a configuration that
  looks enforced and is not.

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
| **R-21** | **Rung 5 (embeddings) is inert until a local model is chosen** (ADR-021), so the semantic entity match 04 §4 promises is unexercised in the shipped build and the F-09 shorthand depends on an alias | 4 | 2 | 8 | The alias route works today and is what onboarding step 3 creates; the rung is provider-injected, so enabling it is a one-line swap once a model is chosen; the plumbing is integration-tested at the schema's width | Before the first deployment that claims semantic matching; revisit with the Part 4 model decision |

| **R-22** | **A stale app shell outlives a deploy** — the service worker serves a cached document whose bundle predates an API or contract change, so the fix never reaches the user (ADR-024) | 3 | 3 | 9 | Non-dismissible update prompt that activates only on the user's click; `ngsw.json`'s generated hash table makes a mixed old/new bundle impossible; activation-when-idle catches closed tabs; API changes stay additive within a release; the per-feature offline matrix in [07 §6](07-platform-strategy-mobile-desktop.md) states what a stale shell may still do | Phase 4.2 + every release |

| **R-23** | ~~**The offline cache depends on an app lock that no task builds** (ADR-025), so F-26's offline capture is session-only and Sprint 4.2's exit criterion cannot be met as written~~ **CLOSED in 4.2.6b** | 4 | 3 | ~~12~~ **0** | The lock's core shipped in 4.2.6a (ADR-029) and the **device panel and re-auth screen that arm it** in 4.2.6b, so a user can turn persistence on and offline capture survives a reload. An install that leaves the lock off still persists nothing — deliberately (ADR-025's rejected alternative (c)), and the tray's copy now says so instead of claiming *"Nothing here is lost."* | Closed; the residual "the user has not armed it" case is Phase 4.3's onboarding copy, not a risk |
| **R-24** | **The push payload is coupled to `ngsw-worker.js`'s undocumented `handlePush`/`onActionClick`** (ADR-028's 4.2.5 amendment), so an `@angular/service-worker` upgrade could make every push silently display nothing — `dispatch` still reports `SENT`, so nothing looks broken server-side | 3 | 3 | 9 | The dependency is pinned and the coupling is written down in the payload module and here; `web-push-payload.spec.ts` pins the exact block the worker reads; the in-app centre is the source of truth and is complete without push (docs/07 §4.8), so a silent failure costs nagging, not data; re-check `ngsw-worker.js` on every Angular major | Every Angular upgrade + Phase 5 beta gate |

| **R-25** | **The consent gate ships without a consent sheet** — a Household can record AI consent only through the `recordAiConsent` mutation, so on any deployment with no client for it every Household stays `NOT_ASKED` and the AI path is rules-only (ADR-032) | 4 | 2 | 8 | The safe direction is the default: absence of a record is refused, and the record, the enforcement and the audit row are built and verified live; the sheet is docs/02 §4.18's *AI podešavanja* and belongs to the settings work whose first section shipped in 4.2.6b | Phase 4.3/5 — before any deployment that claims AI categorisation |

### Top five by exposure
1. **R-01 onboarding cold-start (20)** — the single biggest threat, and the one the plan spends the most disproportionate effort on.
2. **R-12 retention (16)** — a working product that people stop using is still a failed product.
3. **R-03 / R-04 / R-05 / R-06 / R-07 / R-08 / R-14 / R-15 / R-16 / R-23 (12 each)** — a cluster of medium-high risks, all addressed by decisions already taken above (R-23 by an ADR that names the missing task rather than assuming it).
4. **R-02 / R-09 / R-10 / R-20 (10 each)** — low-likelihood, catastrophic-impact; these justify the reconciliation job, backup rehearsal and tenancy tests even though they are unlikely.
5. **R-11 / R-13 / R-17 / R-19 / R-22 / R-25 (8–9)** — monitor, do not over-invest.

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
| **The local embedding model and its serving shape** (in-process ONNX vs. a same-host sidecar; which 384-dimension multilingual model) | ADR-021 fixes the *seam*, the width and the residency rule, but not the model — that needs weights to be chosen, distributed and measured, and rung 5 produces a candidate rather than a decision. The alias route covers F-09 meanwhile | When a deployment enables rung 5, or before beta if the shorthand without an alias proves necessary |
| Public API / integrations | No validated demand | v2, on request |
| Open-sourcing any component | Unclear benefit; the moat is the memory model and the data, not the code | Not planned |
