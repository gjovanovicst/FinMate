# 09 — Implementation Plan

**Assumption:** 1–2 full-stack engineers, working with AI coding assistance. Estimates are in
**person-days (pd)** and assume the stack in [05](05-architecture.md). With two engineers
front/back-split, the calendar compresses by roughly 35 % (not 50 % — integration and review do not
parallelise perfectly).

**Governing sequencing rule:** *ship a correct manual app before shipping any AI.* If the AI layer
slips, the product is still usable. This inverts the usual AI-first failure mode.

---

## 1. Phase overview

| Phase | Weeks | Theme | Exit criterion |
|---|---|---|---|
| **0** | 1–2 | Foundations | A logged-in user sees an empty but real dashboard in CI-deployed staging |
| **1** | 3–5 | Manual core | A user can record and categorise a month of spending **without any AI** |
| **2** | 6–8 | AI input | `Lidl 2000` works end-to-end, with rules, confidence and the learning loop |
| **3** | 9–11 | Intelligence | Safe-to-spend, predictions, alerts, goals, and the assistant are live |
| **4** | 12–14 | Receipts & mobile | Receipt itemisation and offline mobile capture work |
| **5** | 15–16 | Hardening & beta | Security review passed, performance targets met, **public beta launched** |
| **6** | 17–20 | Post-beta stabilisation | Retention and unit economics confirmed → **GA** |
| **v2** | 21+ | Family, native apps, bank import, multi-currency | — |
| **v3+** | — | Growth: investments/net worth, coach, regional expansion | — |

Total to public beta: **≈ 16 weeks / ~150 person-days**. To GA: **≈ 20 weeks**.

Sections 2–7 specify **Phases 0–5 in detail**. Phases 6, v2 and v3+ are **forecasts, not plans** —
see **[§13](#13-roadmap-to-the-final-product)**, which consolidates the whole arc from zero to the
final product and is explicit about which parts are specified and which are not.

---

## 2. Phase 0 — Foundations (weeks 1–2, ~14 pd)

**Goal:** remove every reason to make an architectural decision later under pressure.

| # | Task | pd | Notes |
|---|---|---|---|
| 0.1 | Nx monorepo, pnpm workspaces, TS strict, eslint boundaries, prettier | 1.5 | Enforce the dependency rule from [05 §2](05-architecture.md#2-monorepo-layout) from the first commit |
| 0.2 | Docker Compose: Postgres 16 (+`pg_trgm`, `pgvector`), Redis, MinIO, Mailhog | 1 | Local dev in one command |
| 0.3 | Prisma/Drizzle setup + migration workflow + seed script | 1 | |
| 0.4 | Full schema from [03](03-domain-model.md) migrated; not all tables used yet | 1.5 | Doing the schema early prevents painful retrofits of `household_id` |
| 0.5 | NestJS skeleton: config, health, logging, error filter, `TenantContext`, tenancy guard + Prisma extension | 2.5 | The tenancy enforcement is built **before** any feature |
| 0.6 | Auth: signup, login, refresh rotation, verify email, reset password, argon2id | 3 | |
| 0.7 | GraphQL wiring, Money/Date/UUID scalars, auth guard, pagination convention | 1.5 | |
| 0.8 | Angular app: routing, layout shell (nav + content), design tokens, `ui-money`, base components | 2.5 | |
| 0.9 | CI: lint, typecheck, unit tests, build, migrate, deploy to staging | 1.5 | Green pipeline is a gate for every later phase |
| 0.10 | Error tracking, structured logging, uptime check | 0.5 | |

**Exit criteria**
- `pnpm dev` boots the whole stack locally with one command.
- CI is green and deploys to staging automatically on merge to `main`.
- A new user can sign up, verify, log in, and see an authenticated empty shell on desktop and mobile
  widths.
- A test asserts that a query without a tenant context **throws**.

**Deliberate omission:** no CI/CD to production, no Kubernetes, no IaC. Staging on a single node is
enough until there is a product.

---

## 3. Phase 1 — Manual core (weeks 3–5, ~32 pd)

**Goal:** the product is genuinely usable — boring, correct, no AI. This is the insurance policy.

### Sprint 1.1 (week 3) — Money core, ~11 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 1.1.1 | `packages/domain`: Money value object, minor-unit math, currency, date/local-date helpers | 2 | — |
| 1.1.2 | Accounts CRUD + computed balances (invariant I-4) with tests | 2.5 | F-01 |
| 1.1.3 | Categories tree CRUD (depth cap, cycle guard, delete-reassign rule I-12) | 3 | F-02 |
| 1.1.4 | Ledger module: transaction CRUD, validation, optimistic concurrency (`version`) | 3.5 | F-04 |

### Sprint 1.2 (week 4) — Taxonomy & entry UX, ~11 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 1.2.1 | Merchants + aliases CRUD, merge flow | 2 | F-10 |
| 1.2.2 | Counterparties + aliases CRUD | 1.5 | F-11 |
| 1.2.3 | Tags CRUD and assignment | 1 | F-12 |
| 1.2.4 | Category keywords (include/exclude) management UI + validation | 2 | F-03 |
| 1.2.5 | Transaction list: virtual scroll, filters, search, grouping by day | 2.5 | F-24 |
| 1.2.6 | Transaction detail/edit sheet with all fields; split editor | 2 | F-04, F-15 |

### Sprint 1.3 (week 5) — Budgets & dashboard, ~10 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 1.3.1 | Budgets: CRUD, period resolution, subtree consumption (invariant I-5) | 3 | F-17 |
| 1.3.2 | Safe-to-spend + month-end projection calculators (**pure functions, fully unit-tested**) | 2 | F-19, F-21 |
| 1.3.3 | Dashboard tiles: spend this month, budget remaining, safe-to-spend, projection, recent activity | 3 | F-19 |
| 1.3.4 | CSV export (and import scaffolding) | 1.5 | F-25 |
| 1.3.5 | Responsive pass: verify every Phase-1 screen at 320 / 768 / 1280 / 1920 | 0.5 | F-26 |

**Exit criteria**
- A user can record a full month of transactions manually, with budgets, and the arithmetic is
  provably correct (property tests + a seed script that reproduces a known month).
- Safe-to-spend and projection match hand-computed fixtures exactly.
- Every screen is usable at 320 px width with touch only, and at 1920 px with keyboard only.

> **This is the checkpoint that de-risks the project.** If the AI work in Phase 2 collapses, shipping
> Phase 1 + polish is still a viable product.

---

## 4. Phase 2 — AI input (weeks 6–8, ~34 pd)

**Goal:** the wedge. Cheap-first pipeline with visible confidence and a real learning loop.

### Sprint 2.1 (week 6) — Parser & rules, ~12 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 2.1.1 | `packages/nlp`: segmentation, Serbian normalization, transliteration, amount/date/direction extraction | 4 | F-05, F-06 |
| 2.1.2 | Golden dataset v1 (**300 cases** from the merchant / amount-format / bulk slices) + Jest harness; run in CI. Grows to the full 1 300-case composition from [04 §11.1](04-categorization-and-ai-engine.md) before the Phase 5 launch gate | 2 | — |
| 2.1.3 | `packages/rules-engine`: condition evaluation, priority, conflict resolution, keyword scoring | 3.5 | F-07 |
| 2.1.4 | Entity resolution: exact → normalized → prefix → trigram (embeddings deferred to 2.3) | 2.5 | F-07 |

### Sprint 2.2 (week 7) — AI, capture UX, learning loop, ~12 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 2.2.1 | `packages/ai`: `AiProvider` interface, OpenAI + DeepSeek adapters, routing, timeouts, circuit breaker | 3 | F-07 |
| 2.2.2 | Structured-output classify with JSON-schema validation and closed category list | 2 | F-07 |
| 2.2.3 | `classification` module: pipeline orchestration, `classification_decisions` audit, confidence gate | 2.5 | F-07, F-31 |
| 2.2.4 | Capture UI: single + bulk input, parse preview, per-row confidence badge, one-action confirm | 3 | F-05, F-06 |
| 2.2.5 | Idempotency + duplicate detection | 1.5 | F-06 |

### Sprint 2.3 (week 8) — Corrections, review queue, seeding, ~10 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 2.3.1 | Correction capture + "Zapamti za ubuduće" rule synthesis with conflict guardrails | 3 | F-09 |
| 2.3.2 | Review queue UI: badge, filtered list, bulk resolve, keyboard-driven | 2.5 | F-08 |
| 2.3.3 | Onboarding wizard (F-13) incl. seeded Serbian category tree + ~60 merchants | 3 | F-13 |
| 2.3.4 | Embedding-based entity resolution (local model, `pgvector`) | 1.5 | F-07 |
| 2.3.5 | Phase 2 evaluation harness (v1 golden set through the real pipeline; rule-hit ratio + the §11.2 gates in CI) | 2 | — |

**Exit criteria**
- `Lidl 2000, gorivo 3500, plata 150000` parses to 3 correct transactions, one confirm, ≤ 4 s median.
- Rule-hit ratio ≥ 50 % on the golden dataset (rising with real usage toward the 70–85 % target).
- Correcting a category and ticking "remember" makes the next identical input resolve with **zero**
  AI calls — asserted by an integration test.
- Overconfident-wrong rate on the golden set ≤ 1.5 %; CI blocks otherwise.
- With the AI provider mocked to always fail, capture still succeeds and rows are marked for review.

**Where Phase 2 stands (measured, task 2.3.5).** `pnpm test:evals` runs all 300 v1 golden cases through
the real pipeline in CI ([10 §5.9](10-testing-and-quality.md#59-what-the-phase-2-harness-actually-is-task-235)):
rule-hit ratio **73.8 %** (criterion ≥ 50 %, inside the 70–85 % steady-state target), overconfident-wrong
**0.28 %** (≤ 1.5 %, and CI now blocks on it), top-1 in the ≥0.90 bucket **100 %**, should-ask recall
**98.8 %**, extraction **100 %**, p95 **39 ms**. The zero-AI-after-correction criterion and the
provider-down criterion are both asserted by integration tests. Two gates remain unenforceable in this
build and say so in every report: the narration pair (NARRATE is Phase 3) and top-3/cost (no provider is
configured). The first run of the harness found and fixed two real defects — see
[04 §8.1.5](04-categorization-and-ai-engine.md#815-the-evaluation-harness-found-two-defects-on-its-first-run-task-235).

---

## 5. Phase 3 — Intelligence (weeks 9–11, ~30 pd)

### Sprint 3.1 (week 9) — Insights & alerts, ~10 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 3.1.1 | Deterministic insight generators: budget pace, category spike, unusual spend, **positive trend** | 3 | F-20, F-22 |
| 3.1.2 | Alert rules engine + `dedupe_key` + quiet hours + rate limiting | 2.5 | F-22 |
| 3.1.3 | Notification dispatch: in-app first, then web push and email | 3 | F-22 |
| 3.1.4 | In-app notification centre + preferences UI | 1.5 | F-22 |

### Sprint 3.2 (week 10) — Assistant, ~11 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 3.2.1 | Query planner: ~25 intent templates, slot extraction, no-SQL guarantee | 3 | F-23 |
| 3.2.2 | Fact assembly + provenance payloads per template | 2 | F-23 |
| 3.2.3 | Narration via `NARRATE` provider + **numeric validator** + template fallback | 2.5 | F-23 |
| 3.2.4 | Assistant UI: chat surface, expandable "based on N transactions" + drill-through links | 2.5 | F-23 |
| 3.2.5 | Savings-proposal path ("kako da uštedim 20.000?") computed by backend | 1 | F-30 |

### Sprint 3.3 (week 11) — Analytics & goals, ~9 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 3.3.1 | Analytics: category trends, month-over-month, top merchants, chart components | 3.5 | F-20 |
| 3.3.2 | Saving goals + contributions + required-monthly calculator | 2.5 | F-18 |
| 3.3.3 | Recurring rules: CRUD, RRULE expansion, materialisation job | 2 | F-16 |
| 3.3.4 | Subscription detection (propose, never auto-create) | 1 | F-16 |

**Exit criteria**
- Safe-to-spend, projection and insight figures come exclusively from backend calculators — a test
  asserts the assistant never introduces a numeral absent from its facts payload.
- Notifications never fire twice for the same condition (dedupe test).
- A user can ask five canonical questions in Serbian and get correct, cited answers.

---

## 6. Phase 4 — Receipts & mobile (weeks 12–14, ~28 pd)

### Sprint 4.1 (week 12) — Receipts, ~11 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 4.1.1 | `files` module: presigned upload, virus scan hook, retention | 2 | F-34 |
| 4.1.2 | Camera capture (PWA `getUserMedia` + file input fallback) and upload UX | 2 | F-14 |
| 4.1.3 | OCR adapter + item extraction + item-level classification | 3.5 | F-14 |
| 4.1.4 | Reconciliation against the receipt total (I-6) + mismatch resolution UI | 2 | F-14 |
| 4.1.5 | Itemised breakdown UI, per-item category override | 1.5 | F-14 |

### Sprint 4.2 (week 13) — Offline & sync, ~10 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 4.2.1 | Service worker, app shell caching, update flow | 2 | F-26 |
| 4.2.2 | IndexedDB repository + outbox pattern + idempotent flush | 3 | F-26 |
| 4.2.3 | Offline capture UX: "pending sync" tray, retry, conflict diff for money fields | 2.5 | F-26 |
| 4.2.4 | Stale-snapshot labelling (`as of <time>`) everywhere a figure is shown offline | 1 | F-26 |
| 4.2.5 | Web push subscription + permission flow | 1.5 | F-22 |
| 4.2.8 | **The ledger-rows cache and the screens that read it** — **added by [ADR-027](14-decisions-and-risks.md)**; 4.2.4 caches the dashboard read model, and the transactions list / analytics' cached period need their own minimised row cache | 1.5 | F-26, F-24 |
| 4.2.7 | **Queued edits and the money-field conflict diff** — **added by [ADR-026](14-decisions-and-risks.md)**; 4.2.3 ships the capture tray, and the `409`+`version` diff docs/02 §4.3 draws has no producer until an edit can be queued | 2 | F-26, F-04 |
| 4.2.6 | **App lock** (WebAuthn platform authenticator, 6-digit PIN fallback) — **added by [ADR-025](14-decisions-and-risks.md)**; it is what wraps the offline store's data key, so without it nothing confidential is persisted | 2 | F-26, F-28 |

### Sprint 4.3 (week 14) — Mobile UX polish, ~7 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 4.3.1 | Bottom-sheet patterns, thumb-reachable primary actions, safe-area insets | 2 | F-26 |
| 4.3.2 | Install prompt / Add-to-Home-Screen flow | 1 | F-26 |
| 4.3.3 | Mobile keyboard handling on the money field (numeric keypad, no layout jump) | 1.5 | F-05 |
| 4.3.4 | Performance: bundle budget, lazy routes, image sizing; Lighthouse ≥ 90 | 2.5 | F-26 |

**Exit criteria**
- A Lidl receipt totals correctly across ≥ 3 categories, with low-confidence items flagged.
- Full capture flow works in airplane mode and syncs without duplication on reconnect.
  **[ADR-025](14-decisions-and-risks.md) makes the second half conditional on 4.2.6**: the store persists
  nothing confidential until an app lock can wrap its key, so 4.2.2–4.2.4 are session-only until then
  (risk R-23). The criterion is met in full only with 4.2.6 done.
- Lighthouse PWA criteria pass; installable on Android and iOS Safari.
- Median time-to-log on a real mid-range Android device ≤ 5 s (device lab, not a desktop emulator —
  this is the number the whole thesis rests on).

---

## 7. Phase 5 — Hardening & beta (weeks 15–16, ~14 pd)

| # | Task | pd | Notes |
|---|---|---|---|
| 5.1 | Security review against the threat model in [08](08-security-privacy-and-compliance.md); fix findings | 3 | Including a deliberate cross-tenant access attempt |
| 5.2 | GDPR: export, hard delete, consent recording, retention jobs, privacy policy | 2.5 | Blocking for EU/RS launch |
| 5.3 | Performance: query analysis, missing indexes, N+1 sweep, API p95 ≤ 300 ms | 2 | |
| 5.4 | i18n: extract all strings, SR + EN, locale formatting, cyrillic-tolerant search | 2 | F-27 |
| 5.5 | Onboarding funnel instrumentation + product analytics | 1.5 | Needed to read the launch metrics |
| 5.6 | Load test at 10× expected beta volume; cost review vs. the model in [12](12-monetization-and-pricing.md) | 1 | |
| 5.7 | Beta ops: invite flow, feedback capture, support runbook, incident checklist | 2 | |

**Launch gates (all must pass — these are the same numbers as [10 §6](10-testing-and-quality.md))**
- AI evaluation gates green on the frozen prompt/model version, against the **full 1 300-case golden
  dataset** ([04 §11.1](04-categorization-and-ai-engine.md)).
- Zero known P0/P1 security findings; cross-tenant tests pass.
- p95 API latency ≤ 300 ms on the beta dataset size.
- Crash-free sessions ≥ 99.5 % in a 1-week closed test.
- Restore-from-backup rehearsed successfully **and timed**.
- Cost per active household ≤ 60 RSD/month at beta usage.

---

## 8. Definition of Done (applies to every story)

A story is not done until:

1. Implementation merged with tests (unit for pure logic, integration for DB-touching paths).
2. Money arithmetic covered by a property-based test where applicable.
3. Error, empty, loading and offline states designed and implemented — not just the happy path.
4. Responsive check at 320 / 768 / 1280 px, and keyboard-only operation verified.
5. Strings externalised for i18n; no hardcoded user-facing Serbian or English in components.
6. Telemetry added if the feature has a success metric.
7. Docs updated if a canonical decision changed (and an ADR added if it is architectural).
8. Deployed to staging and manually verified by someone other than the author.

---

## 9. Critical path and risk-ordered sequencing

```text
0.4 schema ─► 0.5 tenancy ─► 1.1.4 ledger ─► 1.3.1 budgets ─► 1.3.2 calculators
                                                                    │
                                        ┌───────────────────────────┘
                                        ▼
                              2.1.1 nlp parser ─► 2.1.3 rules ─► 2.2.3 pipeline ─► 2.2.4 capture UX
                                                                       │
                                                                       ▼
                                                          2.3.1 learning loop ─► 3.2.1 planner ─► 3.2.3 narration
```

Longest chain: **schema → ledger → budgets/calculators → parser → rules → pipeline → capture UX →
learning loop**. Three items on it deserve extra slack because they are the highest-uncertainty:

| Risk item | Why uncertain | Mitigation |
|---|---|---|
| `2.1.1` Serbian NL parser | Real inputs are messier than any spec | Golden dataset built *before* the parser (2.1.2 pulled one slot earlier in practice if needed) |
| `2.1.3` rules engine conflict resolution | Easy to over-engineer | Ship the simple priority model first; add specificity scoring only if observed conflicts justify it |
| `3.2.3` narration correctness | Hallucination risk | Numeric validator + template fallback, built as part of the same story, not later |

**Deliberate slack:** Phase 2 has ~20 % unallocated capacity. It *will* be consumed by parser edge
cases; planning it as fully booked would guarantee a slip.

---

## 10. Staffing shapes

| Team | Calendar to beta | Notes |
|---|---|---|
| **1 engineer** | ~18–20 weeks | Add ~15 % for context switching. Phases remain sequential; the main risk is a single point of failure on ML/parser work. |
| **2 engineers** (recommended) | ~13–14 weeks | Split: one owns `api` + `packages/*` (parser, rules, AI), the other owns `web` + design system. Both review each other's PRs; integration work is shared. |
| **2 + 1 designer (part-time)** | ~13 weeks, materially better retention outcomes | The correction UX and onboarding are the retention levers; a designer earns their cost here more than anywhere else. |
| **3+ engineers** | Not recommended for v1 | Coordination cost exceeds the gain at this scope; a modular monolith with clear module ownership is faster with 2. |

---

## 11. What is explicitly *not* in this plan (and why)

| Deferred | Reason |
|---|---|
| Household sharing UI (F-29) | Household model + `household_id` exist from day one, so this is additive UI, not a migration. Doing it in v1 multiplies permission-testing surface before the core loop is proven. |
| Bank/Open Banking import (F-33) | Not practically available for Serbian retail banking; would consume the entire budget of Phase 2 for uncertain coverage. Revisit when a provider offers real RS coverage. |
| Native iOS/Android apps | PWA covers v1. A Capacitor shell in v2 adds push + store presence without a rewrite. Reserve the decision until real PWA metrics show what is missing. |
| Multi-currency ledger | Single `ledger_currency` per household keeps every invariant simple. The column exists so multi-currency is a feature, not a migration. |
| Investments / net worth | Different domain, different users, dilutes the wedge. |
| Self-hosted/open-source model fine-tuning | The learning loop works through rules and few-shot examples; fine-tuning is not needed to reach the accuracy targets and would add an MLOps burden the team cannot carry. |

---

## 12. First 10 working days (concrete)

If work starts tomorrow, this is the order:

| Day | Deliverable |
|---|---|
| 1 | Nx monorepo scaffolded, `pnpm dev` boots Postgres + Redis + MinIO, CI running lint+typecheck |
| 2 | Full schema migrated; `packages/domain` Money + date helpers with tests |
| 3 | NestJS auth module: signup/login/refresh working, integration-tested |
| 4 | `TenantContext` + Prisma extension + the "query without tenant throws" test |
| 5 | Angular shell, routing, design tokens, `ui-money`, login wired end-to-end to staging |
| 6 | Accounts CRUD + computed balance (invariant I-4 test green) |
| 7 | Categories tree CRUD with depth/cycle guards |
| 8 | Ledger transaction CRUD with optimistic concurrency |
| 9 | Transaction list + detail/edit sheet |
| 10 | **Demo: sign up, create an account, add a category, record a transaction, see the balance** |

Day 10's demo is intentionally unglamorous. It is the point at which the project becomes real, and
every later phase builds on it rather than replacing it.

---

## 13. Roadmap to the final product

Sections 2–7 specify Phases 0–5. This section consolidates the **entire arc**, including the parts
that are deliberately *not* planned yet — and is explicit about which is which. Read
[§13.7](#137-specified-vs-forecast--read-before-treating-dates-as-commitments) before quoting any date
here as a commitment.

### 13.1 Milestones

| # | Milestone | Reached at | The test that says we got there |
|---|---|---|---|
| **M0** | Walkable skeleton | end of Phase 0 | `pnpm dev` boots the stack; a new user reaches an authenticated shell; a tenant-less query throws |
| **M1** | **Usable without AI** | end of Phase 1 | A full month of spending recorded manually, arithmetic provably correct. *The de-risking milestone.* |
| **M2** | The wedge works | end of Phase 2 | `Lidl 2000, gorivo 3500, plata 150000` → 3 correct transactions, one confirm, ≤ 4 s; overconfident-wrong ≤ 1.5 % |
| **M3** | Intelligent product | end of Phase 3 | Safe-to-spend, projections, alerts and the assistant all live and all computed by the backend |
| **M4** | Complete v1 feature set | end of Phase 4 | Receipt itemisation reconciles; offline capture syncs without duplication; ≤ 5 s to log on a mid-range Android |
| **M5** | **Public beta (1.0)** | end of Phase 5 | Every launch gate in [§7](#7-phase-5--hardening--beta-weeks-1516--14-pd) green, including the timed restore drill |
| **M6** | **GA** | end of Phase 6 | Retention and economics confirmed on real cohorts (see §13.3) |
| **M7** | v2 | §13.4 | Household sharing, and whichever native/bank triggers have fired |
| **M8** | v3+ | §13.5 | Growth surface, on validated demand |

### 13.2 To public beta — specified

The detailed plan lives in §2–§7. Summary:

| Phase | Weeks | pd | Goal | Gate |
|---|---|---|---|---|
| **0** Foundations | 1–2 | ~14 | Remove every reason to decide architecture under pressure | Tenant-less query throws; CI deploys staging |
| **1** Manual core | 3–5 | ~32 | A correct, boring, **fully usable app with no AI** | Correct arithmetic; 320 px touch + keyboard-only |
| **2** AI input | 6–8 | ~34 | The wedge: NL capture, rules, confidence, learning loop | Overconfident-wrong ≤ 1.5 %; capture survives AI outage |
| **3** Intelligence | 9–11 | ~30 | Insights, alerts, goals, assistant | No LLM-computed figure; notifications deduped |
| **4** Receipts & mobile | 12–14 | ~28 | Itemised receipts + offline mobile capture | Receipt reconciles; airplane-mode capture syncs |
| **5** Hardening & beta | 15–16 | ~14 | Ship it safely | All launch gates; timed restore rehearsal |

**≈ 16 weeks / ~150 person-days to public beta.**

### 13.3 Phase 6 — Post-beta stabilisation (weeks 17–20)

**Deliberately unspecified.** Real users find what the plan did not. Writing detailed task lists for
this phase now would be fiction — its content *is* whatever the beta teaches us.

What is known is the **shape** of the work:

| Workstream | What it is |
|---|---|
| Accuracy tuning on real corrections | The regression slice is built from failures and starts near 0 % accuracy by construction ([10 §5.3](10-testing-and-quality.md)). This is where the learning loop proves it compounds. |
| Onboarding funnel fixes | The dominant risk ([R-01](14-decisions-and-risks.md)) is measured here rather than assumed away. |
| Cost re-basing | Replace modelled unit economics with observed usage ([12 §4](12-monetization-and-pricing.md)); re-check the free-tier quotas against reality. |
| Support & triage tooling | Runbooks get exercised for real; the first genuine incident response. |
| Performance on real data | Query plans and indexes against real household shapes, not synthetic presets. |
| The rename | If the name decision (ADR-014) chose something other than the placeholder, it lands here under the Phase 5 plan. |

**GA is a metrics gate, not a calendar date.** All must hold
([00](00-executive-summary.md#success-metrics)):

- D7 ≥ 45 % and **D30 ≥ 25 %** retention
- **AI-parse acceptance ≥ 85 %** by week 4 per Household
- Categorisation correction rate **falling month over month** — the moat signal
- Median time-to-log ≤ 4 s; natural-language share of entries ≥ 60 %
- Crash-free sessions ≥ 99.5 %; p95 API ≤ 300 ms
- Cost per active Household within plan margin at *observed* usage
- No unresolved P0/P1

If retention misses, **fix retention — do not start v2.** Shipping v2 features onto a leaking bucket is
the most common way products in this category die.

### 13.4 v2 — additive, needs its own planning

Every item below is already deferred in [14 Part 4](14-decisions-and-risks.md) and
[01 §3](01-product-requirements.md#3-feature-catalogue). **None is planned in detail**, and none should
start before GA.

| Item | Why it is v2, not v1 | Effort | Trigger |
|---|---|---|---|
| **Household sharing UI** (`F-29`) | The schema, tenancy and role model already support it ([ADR-008](14-decisions-and-risks.md)) — this is additive UI plus permission-testing surface, not a migration. Deliberately kept out of v1 so the core loop is proven first. | 2–3 wk | GA reached |
| **Native apps via Capacitor** | The PWA covers v1. A shell adds store presence, native push and reliable camera — at the cost of store review latency and release process. | 3–5 wk | Any of the eight measurable triggers **T1–T8** firing ([07](07-platform-strategy-mobile-desktop.md)) |
| **Bank / Open Banking import** (`F-33`) | Not practically available for Serbian retail banking. Would consume an entire phase for uncertain coverage. | 3–6 wk | A provider offering real RS coverage |
| **Multi-currency ledger** | Forces an FX policy, historical rates and rounding rules into every balance, budget and projection ([ADR-011](14-decisions-and-risks.md)). The columns exist so it is a feature, not a migration. | 2–3 wk | Measured demand from a real cohort |
| **Public API / integrations** | No validated demand. | 2–4 wk | On request |
| **Passkeys / TOTP 2FA** | Password + refresh rotation is sufficient for v1; both add support burden. | 1–2 wk | Login friction in support data, or an enterprise ask |
| **Row-Level Security as a 4th tenancy layer** | Not needed at beta scale. | 2–3 d | Before any enterprise conversation |

### 13.5 v3+ — unspecified

Listed for completeness, not planned: investments and net worth, an AI financial coach beyond the
constrained assistant, regional expansion (BiH / Montenegro / Croatia — a localisation exercise, not a
marketing decision), possibly SOC 2 if enterprise interest materialises.

### 13.6 Decision gates by phase

These are moments where work **stops** pending a human decision. Each is an open question in
[14 Part 3](14-decisions-and-risks.md).

| Gate | Decision | Owner | Deadline |
|---|---|---|---|
| Before Phase 0 | Mobile route confirmed as PWA-first (Q-2) | Product + eng | Phase 0 |
| Phase 2.2 | Approved AI providers and regions — **EEA-only or local** (Q-4) | Eng lead | Phase 2.2 |
| Phase 2.1 | Golden-dataset sourcing and consent rules (Q-6) | Eng + legal | Phase 2.1 |
| **End of Phase 3** | **Product name** (ADR-014, Q-1) — so the rename lands in Phase 5 | Product owner | End of Phase 3 |
| Phase 5 | Hosting region / data residency (Q-7) | Eng lead | Phase 5 |
| Phase 5.6 | Free-tier quotas validated against beta usage (Q-8) | Product owner | Phase 5.6 |
| Phase 5 | Target market: Serbia only, or regional (Q-3) | Product owner | Phase 5 |

### 13.7 Specified vs forecast — read before treating dates as commitments

| Range | Status | Confidence |
|---|---|---|
| Phases 0–5 (§2–§7) | **Specified** — per-task estimates, exit criteria, DoD | High on *scope*; ±25 % on calendar |
| Phase 6 (§13.3) | **Shape only** — workstreams and a metrics gate | Low on detail, high on the gate |
| v2 (§13.4) | **Deferred list** with effort ranges and triggers | Order-of-magnitude only |
| v3+ (§13.5) | **Names only** | None |

Two systemic caveats:

1. **The 16-week figure assumes 1–2 engineers working steadily.** With one engineer, expect 18–20 weeks.
   Phase 2 additionally reserves ~20 % unallocated capacity that *will* be consumed by Serbian parser
   edge cases — planning it fully booked would guarantee a slip.
2. **Everything after Phase 5 is a forecast, and Phase 6 cannot honestly be more than a shape.** The
   defensible commitments are M1 (a correct manual app) and M5 (the launch gates). If a date and a gate
   conflict, the gate wins.

### 13.8 Timeline at a glance

```text
        wk 1-2     3-5        6-8        9-11       12-14      15-16      17-20        21+
       ┌────────┬──────────┬──────────┬──────────┬──────────┬──────────┬───────────┬──────────►
       │ Ph 0   │ Ph 1     │ Ph 2     │ Ph 3     │ Ph 4     │ Ph 5     │ Ph 6      │ v2 / v3+
       │ setup  │ manual   │ AI input │ intel    │ receipts │ beta     │ GA        │ growth
       └────────┴──────────┴──────────┴──────────┴──────────┴──────────┴───────────┴──────────►
          M0         M1          M2        M3         M4        M5         M6          M7/M8
       skeleton   usable     wedge      smart     complete   PUBLIC     GA
                  w/o AI     works      product   v1         BETA
                             ▲                                            ▲
                    the moat starts compounding              retention decides whether v2 happens
```

**Critical path** ([§9](#9-critical-path-and-risk-ordered-sequencing)):
`schema → ledger → budgets/calculators → parser → rules → pipeline → capture UX → learning loop`

The three highest-uncertainty items on it — the Serbian parser, rules-engine conflict resolution, and
narration correctness — are the reason Phase 2 carries slack and why `change-capture-pipeline` is a
skill with its own gates.
