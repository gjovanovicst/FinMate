# AGENTS.md — FinMate

> **The name is not decided.** `FinMate` is a working title and **is already taken** by existing
> finance products (ADR-014, `docs/13-brand-and-naming.md`). Never hardcode a brand string — read
> `APP_NAME` from config. `Ostava` is the current recommendation, pending screening.

AI-first household budgeting app for **mobile and desktop**. The product promise, in one line:

> Type **`Lidl 2000`** and get a correctly categorised, budget-aware transaction in under five seconds.

**Machine state:** Node 24.20.0, pnpm 11.7.0, Go 1.27.0, **Docker 29.7.2 + Compose v5.5.0 (Linux
containers)** on Ubuntu 20.04 LTS / WSL2.

**Build state — Phase 0 COMPLETE. Phase 1 (manual core) complete apart from the visual pass. Phase 2 (AI input) STARTED: **Sprint 2.1 COMPLETE** (2.1.1 `packages/nlp`, 2.1.2 golden dataset, 2.1.3 `packages/rules-engine`, 2.1.4 entity resolution) and **Sprint 2.2 COMPLETE: 2.2.1–2.2.5 done** (2.2.1–2.2.2 `packages/ai`, 2.2.3 `classification` module — pipeline orchestration, audit, confidence gate; 2.2.4 `captureCommit` — the atomic write half — plus the `/capture` screen with the in-browser preview, confidence badges and one-action confirm; 2.2.5 duplicate-suspect detection plus the undo). **Sprint 2.2 COMPLETE. Sprint 2.3 STARTED: 2.3.1 COMPLETE (2.3.1a the corrections + rule-synthesis backend, 2.3.1b the "Zapamti za ubuduće" affordance and the `/rules` screen); **2.3.2 COMPLETE (2.3.2a the review queue's API, 2.3.2b the `/review` screen, the nav badge and the nav move). 2.3.3 (the F-13 onboarding seed) is next.**

| Phase 1 slice | State |
|---|---|
| Domain: dates (incl. `instantForLocalNoon`), money allocation, Serbian amount parsing, tree, budget calculators | **Done** — 97 tests, calculators asserted against hand-computed figures |
| Categories tree CRUD + keywords (I-1, I-11, I-12) | **Done** — verified live, including cycle refusal and reassignment |
| Transactions CRUD + splits (I-1, I-3, I-7, I-10, optimistic concurrency) | **Done** — verified live |
| Transaction list: filters, search, day grouping, cursor paging (1.2.5) | **Done** — UI only; the API already had every filter |
| Transaction detail/edit sheet (1.2.6) | **Done** — edit + delete, optimistic concurrency; **splits are create-only** (`updateTransaction` accepts no splits) |
| Budgets CRUD (1.3.1) | **Done** — `upsertBudget` / `deleteBudget` / `budgets` with period consumption and pace |
| CSV export (1.3.4, F-25) | **Done** — `GET /export/transactions.csv`, filtered, oldest-first. **CSV import is not started** |
| Merchants (1.2.1, F-10) | **Done** — queries + create/update/delete/setMerchantAliases/mergeMerchants, copy-on-write seeds, merge-as-deletion, and the `/merchants` screen with a merge preview |
| Counterparties/tags (1.2.2–1.2.3) | **Done** — `counterparties`/`counterparty` + create/update/setCounterpartyAliases/mergeCounterparties/deleteCounterparty (merge-as-deletion, no copy-on-write: the table is plain household-scoped); `tags`/`tag` + createTag/updateTag/deleteTag (delete **cascades its assignments**, deliberately unlike a Merchant); `tagIds` on `createTransaction`/`updateTransaction` and `tags` on `TransactionModel`; `/counterparties` and `/tags` screens |
| **Phase 1 UI** | **Done** — transaction entry, filtered/paginated list, edit sheet, budgets, dashboard tiles; Accounts from Phase 0 |
| Category tree editor + keyword editor (1.2.4, F-02/F-03) | **Done** — rename, reparent, reorder, delete-with-reassign, include/exclude keywords. **Drag-and-drop not implemented**; the Parent select and Alt+arrows cover reparenting |
| Responsive pass (1.3.5) | **Partially done** — no fixed pixel widths and every multi-column grid is behind a `min-width` query; five known 320 px hazards fixed (nav overflow, hero amount, split-editor row, budget card, keyword chips). 2.3.2b removed a sixth by moving Budgets/Accounts behind More (four primary links plus More, docs/02 §2.2), and `/review` is written to the same rules (wrapping flex, `min-inline-size: 0`, `max-inline-size: 100%` on the category select) — but **`/review` has not been looked at by a human at any width**, and the rest still needs the same pass. **Still needs a human at 320/768/1280 px** |

| What | State |
|---|---|
| Monorepo | 9 Nx projects: `apps/{api,worker,web}`, `packages/{domain,contracts,nlp,rules-engine,ai,config}` |
| Dependency boundaries | Enforced by `@nx/enforce-module-boundaries`; both forbidden edges verified to fail lint |
| Dev stack | `pnpm dev:infra` → Postgres 16 + pgvector (port **5433**), Redis, MinIO (quay.io), Mailhog |
| Schema | 36 tables + 44 CHECK constraints + 18 partial indexes applied; `_prisma_migrations` current |
| Prisma | Client generated to `apps/api/src/generated/prisma` (gitignored) |
| API | Boots, `/health` + `/health/ready` green, structured JSON logs, typed error filter |
| Tenancy | `TenantContext` (AsyncLocalStorage) + Prisma guard; **five-way** model classification, incl. global-readable models (`merchants`) |
| Auth (0.6) | REST `/auth/*`: signup, login, refresh **with rotation + theft detection**, logout, verify, reset; argon2id; login throttling; `TenantContext` now resolved from a real session |
| Seed | `pnpm db:seed` — 38 categories, 134 keywords, 38 merchants; idempotent |
| GraphQL (0.7) | Code-first; `Money` / `UUID` / `LocalDate` scalars; keyset pagination on the UUIDv7 key; `apps/api/schema.gql` generated as a reviewable artifact. First vertical slice: Accounts, with a backend-computed balance |
| CI (0.9) | `.github/workflows/ci.yml`: install → extensions → generate → migrate → lint → typecheck → test → schema-drift check. Deploy to staging is NOT wired (needs the hosting decision, docs/14 Q-7) |
| Web (0.8) | Angular 22, **zoneless** + signals, ADR-006. Responsive shell (bottom nav → sidebar at 1024px), design tokens (`apps/web/src/styles.css`), `fm-money` as the only Money renderer, auth pages, Accounts consuming GraphQL |
| i18n | `core/i18n/`: **English primary**, Serbian latin + cyrillic. Runtime catalogue (no rebuild), `TranslationKey` derived from `en`, `sr-Cyrl` generated at runtime. Language switcher in the shell |
| Tests | **1303 pass** — 439 API + 114 domain + 235 web + 149 nlp + 108 rules-engine + 258 ai (+contracts) |
| Not yet built | worker jobs; production build for apps/api (its own decision); PWA service worker (Phase 4) |
| Known gap → task 2.3.3 | **F-13's seed is short and mislocated, and the shortfall is worse than a count.** **Verified live in 2.3.2b: a Household that has not run onboarding step 4 resolves NO merchants at all.** `loadContext` loads `merchants` with `where: { household_id }`, which excludes the 38 `household_id IS NULL` global seed rows (they are readable through the API — `merchants` is `HOUSEHOLD_SCOPED_WITH_GLOBAL_READS` — but they are a *template catalogue*, not the Household's own entities). docs/01 F-13 step 4 is what turns the shipped list into Household-owned merchants with aliases, so until 2.3.3 lands the headline promise (`Lidl 2000`) cannot categorise for a fresh signup: `captureParse('Lidl 2000')` returns `merchantId: null` and no category. A Household-owned Merchant *does* resolve — the ladder is fine — so this is purely the missing onboarding step, not an entity-resolution defect. Original note: **F-13's seed is short and mislocated.** docs/01 F-13 and docs/11 §2.3 specify a shipped list of **~60** local merchants; `apps/api/prisma/seed.ts` defines **38** (the DB holds 38), and docs/11 §2.3 says the content lives in `packages/domain/seed/` — that directory does not exist. Categories (38 ≈ "~40") and keywords (134) do match. Owned by 2.3.3; do not "fix" docs/11 to say 38, which would enshrine the shortfall as the spec |
| Known gap → Phase 2 | **The fold is internally inconsistent for `đ`/`ђ` (verified).** Latin `đ` folds to `d` (hand-patched in 2.1.1 to fix the NFD gap) but Cyrillic `ђ` folds to `dj` (docs/04 §3.1's table). So `rođa` folds to `roda` while `рођа` folds to `rodja`, and the orthography-correct Cyrillic spelling of the canonical F-11 case resolves on the **trigram rung at 0.61 instead of normalized at 0.98** — a verify-lane match where an exact one was available. The other seven script pairs (`č/č`, `ć/ћ`, `š/ш`, `ž/ж`, `lj/љ`, `nj/њ`, `dž/џ`) are consistent; `đ/ђ` is the only broken one. Fix is one rule in `foldForMatching` (fold the digraph `dj`→`d` after transliteration, which does NOT change §3.1's transliteration table — `ђ`→`dj` stays correct for reading). It needs a re-fold of stored keywords/aliases, so do it before beta when there is no real data |
| Known gap → the rest of Sprint 2.3 | **2.3.1 and 2.3.2 are complete.** Next: **2.3.3 the F-13 seed** (see the row above), then **2.3.4 embeddings** (which is also what makes F-09's shorthand work). Also unbuilt and documented: **the review queue's Lane B** — `/review` ships the blocking lane only, because `reviewQueue` filters `needs_review: true` and `resolveReviewItem` no-ops on a row where the flag is false, so the advisory band (docs/04 §7) is neither listable nor resolvable; making it so is a lane-aware predicate, not a parameter (docs/06 §4.2.1). The queue's `reason`/`confidenceBelow` filters are served but unused, because they are applied to the enriched item **after** paging, so a filtered page can be short while matches sit on the next page (docs/06 §4.2.1). Also: the badge has **no subscription** — the shell asks the scoped COUNT on auth and on each navigation, and a resolution applies the count the server returns, which is why there is no optimistic decrement to reconcile; "confirm the suggestion and remember it" cannot be persisted (a `Correction` means *changed*, so the checkbox is hidden rather than ignored); `bulkResolveReviewItems` (`applyToSimilar` covers the affordance); `ReviewItemKind.RECEIPT_ITEM` and three of five `ReviewReason` arms (no producer); the `CONFIDENCE`/`AMOUNT` queue sorts (a keyset page on a non-unique key repeats or skips rows — it needs a composite cursor); the rule **backfill** (which is also the count-bearing *"Primeni i na N sličnih?"* offer with a diff preview); global keyboard navigation (`g` then `d`/`t`/`r`/…, `⌘K`, `n`, `/` — docs/02 §8); the `acceptProposal: false` refusal is not persisted; the `/rules` screen cannot edit a rule's conditions; no **Restore** for an undone capture; the undo's `audit_log` entry (Phase 5); `DashboardDelta`. No AI provider is configured, so `AI_CLASSIFIER` is the honest always-unavailable classifier (rules-only, `degraded: true`), and `classification_decisions.prompt_template_id` is `null` while `prompt_version` **is** recorded. The per-household threshold override is read from `households.settings.aiConfidenceThresholds`, but the mutation that writes it plus its `audit_log` row is not built |
| Known gap → F-09 vs rung 3 (**found by 2.3.1's exit-criterion test**) | **docs/01 F-09's own scenario cannot pass end to end today.** It corrects `Dejan rođa 3600` and expects the *next* input — `Dejan 2000` — to resolve via the rules engine with no AI call. The rule is synthesised correctly, but it cannot fire: **`Dejan` alone does not resolve `Dejan rođa`.** docs/04 §4's rung 3 deliberately requires *every* folded token of the name to occur among the input's tokens, so that an abbreviation cannot auto-apply at 0.90 — the ladder is right and weakening it would trade a missing match for a wrong one. The shorthand starts working via (1) an **alias** on the counterparty, which is what F-13's onboarding step 3 is for and which works today, (2) **rung 5 embeddings** (task 2.3.4), which §4 says exists for exactly this case, or (3) a keyword, which the `DISTINCTIVE_TOKEN` trigger already adds when no entity resolves. Recorded in docs/04 §8.1.1 and asserted in `corrections.integration.spec.ts` so it stays a known state rather than a surprise |
| Known gap → unscheduled | **The documented pre-commit layer does not exist.** docs/10 §1 layer 0 lists `lint-staged` + prettier + `gitleaks`; there is no `.husky`, no `lint-staged` config and no hook, and `format:check` fails on 119 files repo-wide (including `pnpm-lock.yaml`). It is not in CI, so nothing is gated on formatting |
| Phase 2 progress | **2.1.1 `packages/nlp` done** — transliteration + `foldForMatching`, segmentation, `TransactionFragment` extraction via domain's parser. **2.1.2 golden dataset v1 done** — 300 cases under `packages/nlp/test/golden/` (amount-format 150, merchant 110, bulk 40), spec-derived expectations, run by `nlp:test` in CI; asserts parsing, not the §11.2 accuracy gates. **2.1.3 `packages/rules-engine` done** — §5.3 conflict resolution, §5.4 keyword scoring, no I/O. **2.1.4 entity resolution done** — the pure ladder (exact 1.00 → normalized 0.98 → prefix 0.90 → trigram 0.55–0.85) in `packages/nlp/src/resolve.ts`, with trigram similarity injected. Sprint 2.1 COMPLETE. **2.2.1 `packages/ai` done** — §9 `AiProvider`, OpenAI-compatible adapters shared by OpenAI/DeepSeek/local, declarative routing with a FAIL-CLOSED residency check, per-endpoint circuit breaker, one retry on transient only, redaction, cost/latency telemetry. **No vendor SDK, no dependency added.** **2.2.2 structured-output validation + calibration done** — §6.2 `validateClassifyProposal` audit (closed list, `extracted` incl. `counterpartyType`, `needsUserInput`, `rationale ≤ 140`) plus an alternatives cap of 3 by confidence, and §6.4 `packages/ai/src/calibration.ts`: isotonic PAVA per `(task, model, prompt_version)`, `MIN_CALIBRATION_SAMPLES = 200`, `raw × 0.85` shrink below it, serialisable map, and a gate that accepts only a branded `CalibratedConfidence`. **2.2.3 `classification` module done** — `apps/api/src/modules/classification/`: the docs/04 §2 pipeline (`normalize → resolve → rules → keywords → entity default → AI`, with the AI reached **only** when every deterministic stage was inconclusive), the `classification_decisions` audit row per fragment (raw + calibrated confidence, losing candidates, provider/model/prompt/latency/cost), and the §7/I-8 gate (≥0.90 auto · 0.60–0.89 advisory · <0.60 blocking · **null category blocking at any confidence**). Unit + integration coverage includes a **zero-AI-call** assertion for rule and keyword decisions, the bulk one-low-row case, an always-failing provider, money round-trips and Household isolation. No dependency added, no migration. **2.2.4 `captureCommit` + the capture screen done** — `apps/api/src/modules/ledger/`: the write half of docs/06 §5.2 (whole-batch validate → class/override/proposal resolution → §5.2.1 gate → one interactive transaction → `classification_decisions.transaction_id` linked **in the same transaction**), plus the union result, I-10 replay, ADR-011 currency check, I-3 category/kind check and per-row rejection diagnostics returned in the caller's row order. `apps/web/src/app/features/capture/`: the in-browser `@finmate/nlp` preview per keystroke, a 250 ms superseded server parse, the four-state confidence badge (🟢/🟡/🔴/⚪, icon **and** text **and** percent), provenance, a kind-filtered category picker, ambiguity chips that block the commit until chosen, row removal → `discardProposalIds`, and one-action confirm. 33 new API integration tests + 26 web tests. No dependency added, no migration. **2.2.5 duplicate-suspect detection + undo done** — `apps/api/src/modules/ledger/duplicate-detection.ts` implements docs/06 §5.2.2's rules as a **pure** function (13 unit tests: every boundary on both sides), and `captureCommit` runs it in **one** extra query for the whole batch; the payload joins each suspect to the row the user typed and the row it resembles, and a `undoCapture(transactionIds:)` mutation soft-deletes the batch in one call. The capture screen renders the amber chip and the undo toast. Three doc contradictions were resolved and recorded in docs/06 §5.2.2: the comparison is against non-`VOID` rather than `CONFIRMED` rows (a `CONFIRMED`-only rule is unreachable for the cold-start household where every row is `PENDING`), the submission window is 5 minutes (the two windows in the docs answer different questions), and two identical rows in one batch are reported from both sides. Sprint 2.2 COMPLETE. **2.3.1a corrections + rule synthesis backend done** — `apps/api/src/modules/classification/rule-synthesis.ts` is **pure** (16 unit tests: every trigger, the narrowest-first order, the token heuristics, the witness); `rules.service.ts` owns `rules` and implements docs/04 §8.2's guardrail by running the **real engine** on a witness the proposal matches, with a redundancy arm so an identical rule already in place is a shadow too; `corrections.service.ts` owns `corrections` and turns one into a `LEARNED` rule (ADR-010) whose `source_correction_id` links back. `correctTransaction` lives on the ledger (it writes a Transaction; the module edge stays one-directional) and always returns the proposal so the UI can offer it, creating a rule only when the user ticked `rememberForFuture` **and** the trigger is a resolved entity **and** nothing shadows it. `captureCommit` now counts `hit_count`/`last_hit_at` — on the **commit** path, never the 250 ms parse debounce, so docs/04 §8.2's "stale after 90 days" means something. A local `JSON` scalar avoids a `graphql-type-json` dependency (ADR-004) at the cost of the service validating every document with the engine's `validateRule`. 18 new integration tests, including **docs/09 §4's exit criterion**: correct + remember → the next input resolves via the rules engine with **zero AI calls, counted**. That test also found a real dependency — see the F-09 gap below. **2.3.1b the UI done** — the Transaction detail sheet now routes a **category** change through `correctTransaction` (everything else still goes through `updateTransaction`), offers the "Zapamti za ubuduće" checkbox, and renders the proposal with the conflicting rule named; `createRuleFromCorrection`'s rejection arm is treated as an answer rather than an error. `apps/web/src/app/features/rules/`: a `/rules` screen that groups rules by what needs attention (shadowed or stale), renders a rule as a sentence with names resolved from the Household's own categories/merchants/counterparties, and **falls back to the raw document** for a nested tree rather than flattening it into something false. `planEdit` in `transactions.view.ts` is the pure, tested decision that routes a save to the correction path or the plain-edit path — getting it wrong is silent in both directions. 31 new web tests. Sprint 2.3.1 COMPLETE. **2.3.2a the review queue's API done** — `ReviewService` (classification) owns the **read**: it joins each Transaction to the `classification_decisions` row behind it and reports I-8's `reason`, the suggestion and the losing alternatives; `TransactionsService.resolveReviewItem` (ledger, next to `correctTransaction`) owns the **write**, where `SET_CATEGORY` goes through the correction path so the queue is a learning surface rather than a dismiss button, and `applyToSimilar` sweeps the peers that share the resolved entity **and** the suggestion — excluding the other `kind` (I-3), rows with splits (I-1) and `VOID`. `TransactionsService.list` gained four **id-aligned** sorts (a UUIDv7 is the creation order, so the cursor and the sort key are the same column and the keyset is exact). 17 new integration tests. The task also **found and fixed a real defect**: `PipelineOutcome.entityId` (the entity a *decision* came from) was written to `merchant_id` unconditionally, so a Counterparty default put a Counterparty id into a column whose foreign key points at `merchants` (an FK failure), and a Counterparty that resolved without deciding anything was recorded nowhere — which made a counterparty rule unlearnable from a capture. The outcome now carries the *resolved* pair separately, and the capture client echoes it on the commit row. Recorded in docs/04 §8.1.2 and docs/06 §5.5.1. **2.3.2b the `/review` screen done** — `apps/web/src/app/features/review/`: the blocking lane as a queue, keyboard-driven (`j`/`k` move a cursor that is **not** DOM focus, `1`–`3` pick an alternative, `Enter` resolves, `c` focuses the category picker), with the badge, the reason, the resolved entity, the numbered alternatives and a kind-filtered category picker per row. `review.view.ts` is **pure** and holds the decisions that are silent when wrong: `resolvePlan` returns `null` for a row with nothing chosen (this is docs/02 §4.6's "the queue never auto-resolves anything" — an uncategorised row has no suggestion to accept, and writing a `null` category would clear the flag while leaving the question unanswered), `rememberAvailable` gates the *Zapamti za ubuduće* checkbox to the correction path the server actually reads, `canApplyToSimilar` gates the sweep to rows with a resolved entity, and `commandFor` re-checks the "never inside a form control" rule itself rather than trusting its caller. 32 pure + 15 mounted + 10 navigation + 8 shell tests. The **nav badge** is `ReviewQueueStore` + `core/navigation.ts`: the scoped COUNT is asked on auth and on each navigation (no subscription exists), a resolution applies the count the server returned (exact even when `applyToSimilar` swept peers, which is why there is no optimistic decrement to reconcile), and the drawn badge is hidden at 0 / literal to 9 / `9+` above while the accessible name carries the **real** number. The **nav move** puts docs/02 §2.2's four primary destinations plus **More** in the compact bar and moves Budgets and Accounts behind More — a fifth link was the sixth flex item in a 320 px bar. That task also **found and fixed a second entity defect**: `captureCommit` classified a row server-side to get its category and then discarded that same classification's resolved entity, so a client that commits without previewing stored `merchant_id = null` (verified live: `captureParse` resolved a Merchant, `captureCommit` on the same text did not), which kept `applyToSimilar` and a counterparty rule unlearnable. The row's pair still wins, an **absent** field is filled from the decision, and an explicit `null` is respected — which needed the absent-vs-`null` distinction to survive the resolver, where `?? null` had erased it, so the mapping moved into a pure `toCommitRow` with its own spec. Two smaller defects found while reading: `/rules` rendered a Category `path` (`[String!]!`) as a comma-joined array because the response type called it a `string`, and `en.ts` carried two `nav.rules` keys. Recorded in docs/02 §2.3/§4.6, docs/06 §4.2.1/§5.5 and docs/04 §8.1.2 |
| Web screens | `/` dashboard, **`/capture`** (F-05/F-06 — the signature interaction), `/transactions` (filter + edit + **correction with "Zapamti za ubuduće"** + CSV export), **`/review`** (F-08 — the blocking lane, keyboard-driven), `/budgets`, `/categories`, `/merchants`, `/counterparties`, `/tags`, **`/rules`** (F-09 — grouped by what needs attention), `/accounts`, sign-in/up |
| Navigation | docs/02 §2.2's five slots: **dashboard · transactions · capture · review** plus **More** (≥1024 px the sidebar lists all 11 in one list, so it is never a reduced view). The review slot is the only badged one (`nav.review`), and Budgets/Accounts moved behind More in 2.3.2b — a fifth link plus More was six flex items in a 320 px bar. Destinations and that split live in `core/navigation.ts` with their own spec, not in the component |

```bash
pnpm dev:infra            # start Postgres/Redis/MinIO/Mailhog
pnpm db:migrate           # apply migrations
pnpm db:seed              # seed global merchants (add SEED_HOUSEHOLD_ID for a full household)
nx run api:serve          # API on :3001 (pinned; see the port note below)
nx run web:serve          # SPA on :4200, proxying /api and /graphql to the API
pnpm lint / typecheck / test
nx run web:build          # production bundle
```

**The browser talks to `/api/*`; the dev proxy strips the prefix** before forwarding, because the
API serves `/auth/*` and `/graphql` without one (docs/06). Changing the prefix on one side only
produces a 404 that looks like an auth failure.
Verified working: lint 9/9, typecheck 9/9, 1303 tests, `web:build`, GraphQL over HTTP through the
browser origin, the full signup → cookie → `/auth/me` → GraphQL flow, and `prisma migrate diff`
reporting no drift.

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

```bash
pnpm dev            # start infra, then apps in parallel
pnpm dev:infra      # Postgres + Redis + MinIO + Mailhog only
pnpm test           # unit + integration (Vitest everywhere; API needs unplugin-swc)
pnpm lint           # includes the dependency-boundary rule
pnpm typecheck
pnpm db:migrate     # forward-only, expand/contract
pnpm db:pull        # re-derive schema.prisma after a migration
pnpm db:seed        # starter categories, keywords and merchants
nx run api:serve    # API on :3001 — pinned to match the web dev proxy
nx run web:serve    # SPA on :4200
nx run web:build    # production bundle
```

Not yet implemented: `pnpm test:evals` (Phase 2) and a production `build` for **apps/api** —
deferred past Phase 0, because bundling source-consumed workspace packages is its own decision.
`web:build` does work. Do not reference build scripts the repo does not have.

---

## Definition of Done

A change is not done until (doc 09 §8):

- [ ] **Tests**: unit for pure logic; integration for anything touching the database
- [ ] **Money arithmetic** covered by a property-based test where applicable
- [ ] **Error, empty, loading and offline states** handled — not just the happy path
- [ ] Verified at **320 / 768 / 1280 px**, and operable by **keyboard alone**
- [ ] **No hardcoded user-facing strings** — every string goes through `I18nService.t()`, with
      English (primary) and Serbian (latin + cyrillic) present
- [ ] **Telemetry** added if the feature has a success metric
- [ ] `docs/` updated if a canonical decision changed — **plus an ADR if it is architectural**

---

## Gotchas specific to this project

- **`packages/domain/src/parse.ts` had a shorthand bug, fixed in Phase 2** — `applyThousandsShorthand`
  stripped *every* `.`, so `1.5k` read as `15k` (`15000`, a tenfold overstatement) while docs/04 §3.1
  says `1500`. It now rewrites the base to a `.`-decimal string using `readAmounts`' own separator
  rules and scales through `toMinorUnits`, so the expansion is exact bigint with no `Number` on the
  money path. `1.200k` stays 1 200 thousand (a 3-digit group) and `1.5k` is 1.5 thousand. **There is
  now a `packages/domain/src/parse.spec.ts`** — the parser previously had no focused spec, so its
  coverage came indirectly through `allocation.spec.ts` and a money-path change could only be checked
  by a test about splitting. Put money-parser tests there, and assert in **minor units as `bigint`**.
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
- **`infra/docker/initdb/*.sql` must stay mode 644.** The Postgres entrypoint runs `psql` as uid 999
  and cannot read a 0600 file, so the container comes up **healthy with the extensions missing** —
  the failure is silent until a query needs `citext`/`vector`. Fix with
  `chmod 644 infra/docker/initdb/*.sql` then `down -v && up -d`.
- **MinIO is pulled from `quay.io`, not Docker Hub.** `minio/minio` no longer exists there.
- **pnpm needs a workspace-local store** (`store-dir=.pnpm-store`) because the file sandbox denies
  writes outside the project; the store is gitignored and must never be committed.
- **Prisma is pinned to 7.10.0 deliberately:** `prisma@latest` resolves to an 8.x **release
  candidate**. Never let a `^` range pull it in.
- **The API dev runtime is SWC, not tsx.** esbuild (and therefore `tsx`) **cannot emit decorator
  metadata**, which is what NestJS uses for constructor injection — running the API under `tsx` fails
  with "Parameter decorators only work when experimental decorators are enabled", and even with
  decorators enabled, DI would silently break. Use `node -r @swc-node/register` with
  `apps/api/.swcrc` (`legacyDecorator` + `decoratorMetadata`). `tsx` is fine for plain scripts
  (the seed) — just not for NestJS.
- **Prisma 7 moved things.** The connection URL is no longer in `schema.prisma`; it lives in
  `prisma.config.ts` for the CLI and is passed to `PrismaClient` through `@prisma/adapter-pg`. The
  generator is `prisma-client` with a mandatory `output`, not `prisma-client-js`. Never run
  `prisma migrate dev` — it would generate SQL that drops the CHECK constraints, partial indexes and
  expression indexes doc 03 depends on.
- **GraphQL errors need an explicit conversion.** NestJS does **not** populate `originalError` for
  GraphQL contexts, so an `ApiError`'s `code` is dropped and everything surfaces as
  `INTERNAL_SERVER_ERROR`. `AllExceptionsFilter` converts `ApiError` into a `GraphQLError` with
  `extensions.code` when `host.getType() === 'graphql'`; `formatError` then surfaces it. Do not
  "simplify" that branch away — clients branch on `UNAUTHENTICATED` to refresh a token.
- **A custom scalar used as INPUT must be registered without a type function.** `@Scalar('Money')`,
  not `@Scalar('Money', () => Object)` — the latter makes Nest treat it as an object type and every
  input field fails with `CannotDetermineInputTypeError`.
- **The dev API runs on 3001 because the web proxy targets 3001, and `.env` says 3000 — so `api:serve`
  PINS the port.** `apps/web/proxy.conf.json` forwards `/api` and `/graphql` to `localhost:3001`, while
  `.env`/`.env.example` set `API_PORT=3000` (the port for a direct `node src/main.ts`, a container or CI).
  `nx run api:serve --configuration=production` and plain `node` still honour `.env`; only the dev
  `options.command` overrides it. **This cost real debugging time**: with the API on 3000 and the proxy
  pointed at 3001, every request through the SPA fails as a proxy error and the sign-in page reports
  "something went wrong" — which reads like an auth or CORS bug and is neither. If you change one
  port, change both. (`/proc` is restricted and `lsof`/`fuser` are absent here, so use `ss -ltn` or
  `/tmp/run-api.sh <port>`, which frees the port and waits for the readiness line rather than sleeping.)
  A historical note said port 3000 was held by an unattributable process; the API binds 3000 fine now, so
  that was a stale server, not a rule. Keep the pin anyway: it makes the documented dev pair independent
  of whatever else is on 3000.
- **TypeScript is pinned to 6.0.3, and `baseUrl` must stay.** Angular 22's compiler-cli requires
  `>=6.0 <6.1`; TS 6 deprecates `baseUrl` and node10 resolution, with `ignoreDeprecations: "6.0"`
  acknowledging it. Do NOT remove `baseUrl`: tsc stays happy without it, but
  `@swc-node/register` resolves the workspace aliases through it, so the API fails at boot with
  `Cannot find module '../../../packages/domain/src'` — a failure typecheck cannot catch. Migrating
  to node16/bundler must move `tsconfig.base.json` and `apps/api/.swcrc` together and be verified by
  booting the API.
- **Apps must not set `outDir`.** With it, tsc infers a `rootDir` and then rejects the workspace
  packages it pulls in as source (TS6059). Apps set `declaration: false` and no `outDir`; typecheck
  is `tsc --noEmit` and SWC does the transpiling.
- **No hardcoded user-facing copy.** Every string goes through `I18nService.t('key')`. English is
  primary and is the source of the key set: add the string to `translations/en.ts` first, then to
  `sr-latn.ts` (typed, so a miss is a compile error). `sr-Cyrl` is generated — never edit it. A
  component that calls `t('key')` in its template re-renders on a language change because `t` reads
  the locale signal; do NOT introduce an impure pipe for this.
- **`fm-money` takes its locale from the active language**, so an amount is never formatted in one
  language while the page is in another.
- **`**/.angular/**` must stay in the eslint ignores.** The Angular build cache contains bundled
  dependency output, so linting it reports hundreds of errors in `@angular/forms`' own bundle.
- **Angular targets run with `cwd: {projectRoot}` and project-relative binaries.** Mixing a
  workspace-relative binary path with `cwd: {projectRoot}` yields `ng: not found`.
- **`nx run web:typecheck` does NOT check templates; `nx run web:build` does.** `tsc --noEmit` skips
  Angular's template type-checker, so a dynamic `i18n.t('x.' + value)` (not assignable to
  `TranslationKey`) or a required `input()` read in a constructor (NG8118) pass `typecheck` and fail
  `build`. Run `web:build` before believing a UI change is green.
- **Never put a backtick inside a `template:` or `styles:` literal — including inside a comment.**
  Both are JS template literals, so a backtick *terminates the string* and the remainder is parsed as
  code. The error names neither the file nor the real problem: `Failed to resolve styles at position
  N to a string` / `Failed to resolve template at position N`, usually surfacing as
  `Angular compilation initialization failed`. It has cost real time **four** times — twice from a
  backtick in a CSS comment documenting a property, and again in 2.3.2b from *two* HTML comments and a
  CSS comment written in the same sitting (the author knew the rule and still did it, because a comment
  that names a property — `aria-label`, `1`–`9` — reaches for backticks by reflex). Write CSS/HTML
  comment prose without them, or use quotes. **The failure looks like a syntax error, not a template
  error** when it happens in TS: `tsc` reports `TS1005: ',' expected` at the first markup line after the
  comment, and `const X = /* GraphQL */ \`` lines further down show as stray backticks — so a
  plain-backtick scan of the whole file is the reliable check, not a scan of the `template:` region.
- **A date-only write must send `occurredLocalDate`, never an invented instant.** The server derives
  `occurred_local_date` from the instant in the *Household's* timezone, so `T12:00:00Z` is the 15th
  for a Household in `Pacific/Auckland` (UTC+13) — and the wrong *month* at a boundary, silently
  corrupting every budget total for that period. `occurredLocalDate` wins when both are sent (I-2).
- **Category keywords are normalised, so what is stored differs from what was typed.** `addKeyword`
  lower-cases and strips accents (`septička` → `septicka`), matching how the pipeline normalises
  transaction text — which is correct, but means the chip shown back is not the input. The editor
  says so next to the field. Do not "fix" the chip to echo the input; that would break matching.
- **Every Transaction filter goes through one builder (`buildWhere`).** The page and its `totalCount`
  used to be assembled separately and the count silently ignored the date range, so a date-filtered
  list read "8 transactions" above seven rows. The CSV export uses the same builder, so the file
  always matches the screen. Never add a predicate to only one caller.
- **`GET /export/transactions.csv` is REST on purpose** (docs/06 §9.7): a download is a navigation,
  not a fetch. It is a *browser* URL under `/api/...`; the client fetches it through `HttpClient` so a
  failure lands in the error banner instead of downloading a file full of JSON. Distinct from the
  async whole-household `exportData` (docs/06 §5.11), which needs the worker and is not built.
- **Merchants are copy-on-write, and that includes a merge target.** A global row is read-only, so
  `updateMerchant`, `setMerchantAliases` and a `mergeMerchants` whose *target* is global all create a
  Household-owned copy and move this Household's references onto it. Merging into a seed is a write
  to it (the alias union must be stored), so without the copy it fails as an opaque `P2025`. Never
  "simplify" this by relaxing the write predicate.
- **Merging is the deletion path for a Merchant in use.** `deleteMerchant` refuses with `CONFLICT`
  while Transactions, Receipts or RecurringRules reference the row; `mergeMerchants` moves them. A
  shipped Merchant is never deletable at all. The `merchants` table has **no `version` column**, so
  Merchant writes are last-write-wins — acceptable because the row holds no money.
- **The fold lives once, in `packages/nlp` (`foldForMatching`), and both sides import it.** The web
  client imports `@finmate/nlp` directly so the duplicate-name warning on Merchants, Counterparties
  and Tags agrees with the server's `CONFLICT`, and `apps/api/src/common/text/normalise.ts` keeps its
  exported name but delegates there. When you fold anything for comparison, go through that function —
  a local copy will drift and a keyword will silently stop matching. `shared/aliases.ts` still holds
  the merge preview's alias union for the same "one definition" reason.
- **Normalise keywords and aliases through `common/text/normalise`, never a local copy.** All three
  fold to the same form the classifier will compare against, because they all delegate to
  `@finmate/nlp`'s `foldForMatching` (transliterate Cyrillic → Latin, lower-case, strip diacritics,
  collapse whitespace). `Đ/đ` needed an explicit rule: it has no canonical decomposition, so the
  combining-mark strip that handles `č/ć/š/ž` left it intact and `Đorđe` never matched `Djordje`.
  `packages/nlp` now owns the whole fold, including Cyrillic transliteration (docs/04 §3).
- **`packages/rules-engine` may not import `@finmate/nlp`, so the text fold is INJECTED.** The eslint
  boundary forbids the edge ("nlp / rules-engine / ai must NOT depend on each other") and rule
  conditions match text, which needs the fold. The engine takes a required
  `RuleEngineOptions.folder` (`fold` + `tokens`) supplied by the caller from `@finmate/nlp`. Do not
  "fix" this by editing the boundary config, and do not add a local fold — a second fold is how a
  keyword silently stops matching. The option is required so a caller cannot forget it; passing an
  identity folder silently loses Cyrillic and diacritic matching.
- **The rules-engine sort key is `priority ASC, specificity DESC, created_at DESC, id ASC`.**
  docs/04 §5.3 now records why the specificity score sits before `created_at`: keywords are compiled
  into the same sort as an implicit tier at priority 1000, so ordering on `created_at` ahead of
  specificity would let insertion time decide whether §5.3.4's "explicit rules outrank keywords"
  holds. Priority is always compared first, so specificity can never override it.
- **`packages/domain` sets `testTimeout: 30_000`, and that is load-bearing.** Its test style is
  deliberately exhaustive over ranges rather than example-based — that is what 100 % branch coverage on
  money math requires. Two tests are therefore multi-second: the I-1 allocation loop (5001 totals × 6
  ratio sets) and the `instantForLocalNoon` round-trip (every day of 2026 × 5 zones). Under `pnpm test`
  with seven projects in parallel they measured **4886–5881 ms against Vitest's 5000 ms default**, so
  both failed intermittently, on the money path, for reasons unrelated to money. The budget is
  package-level because the *next* exhaustive test would otherwise reintroduce the same flake. Do not
  lower it; 30 s is only reached by a test that is genuinely hung, which still fails the run.
- **`runWithTenant` aside, never use the outer client inside an interactive `$transaction`.** Each
  inner query then waits for a second connection from the same pool and stalls until the transaction
  times out — surfacing only as an opaque INTERNAL. Always use the `tx` the callback receives.
- **`transactions.source` has a database DEFAULT but not in the derived Prisma schema.** A direct
  `transactions.create` must pass `source`; the service does. `prisma db pull` cannot carry a
  PostgreSQL enum default through.
- **`merchants` and `ai_provider_configs` are `HOUSEHOLD_SCOPED_WITH_GLOBAL_READS`, not plain
  household-scoped.** Their `household_id` is nullable, and docs/08 §"Layer 2" puts those rows on the
  global allow-list. Reads get `AND: [{ OR: [{ household_id: ctx }, { household_id: null }] }]`;
  **writes keep the strict predicate**, or any Household could rename or delete the seeded platform
  catalogue. `is_global` is forced false on create and on an upsert's create branch. Adding a model to
  this group requires a nullable `household_id` — a spec asserts it. The `AND` wrapper is deliberate:
  Prisma's `where` holds one `OR`, so setting ours there would discard a caller's own.
- **`runWithTenant(ctx, () => prisma.x.findMany())` works now, but used to lose the context.** A
  Prisma query object is *lazy* and does not run until awaited, so `storage.run` exited before the
  query executed and it threw `TenantContextMissingError` from a distance. `runWithTenant` chains a
  returned thenable inside the context. Service methods were never affected because they `await`
  internally; one-line test helpers are where it bites.
- **Category deletion is a refusal, not a cascade.** `deleteCategory` throws `CONFLICT` while
  Transactions, Splits or subcategories still reference the row (I-12); the UI turns that into a
  reassign-target picker. Passing `reassignToId` moves children, Transactions **and** Splits. The
  CONFLICT counts are the API's, so a split-only reference reports "0 transactions, 3 splits".
- **`updateTransaction` cannot change `kind` or `splits`.** Direction is not a flippable property,
  and the parts of a divided Transaction must be edited as parts. `update()` refuses an amount change
  on a split Transaction with `VALIDATION_FAILED` rather than deleting the splits to satisfy I-1.
- **A nested relation write needs `update`/`create`, never `updateMany`/`createMany`.** Prisma raises
  `Unknown argument` for a relation field inside `updateMany`'s `data`, and an XOR CreateInput means
  an unchecked scalar (`updated_at`) alongside a relation field is also rejected. This is why
  `TransactionsService.update` runs an interactive `$transaction` — `updateMany` for the versioned
  field edit (which is also the row lock), then `update` for the `transaction_tags` replacement — and
  why `TagsService.remove` loops `transactions.update` over the scoped holders rather than one
  `updateMany`. Both pass a *scoped* `where`; do not "simplify" either into raw SQL to get one round
  trip, or the tenant predicate becomes something a human has to remember.
- **Count a parent-scoped join by joining through the parent, not by `groupBy`.** Prisma's `groupBy`
  `by` accepts only scalar fields (`Expected TransactionsScalarFieldEnum`), so `transaction_tags`
  cannot be grouped — and the guard refuses the model directly anyway. `TagsService.transactionCounts`
  is one parameterised `$queryRaw` joining `transactions` on `household_id` and `deleted_at IS NULL`;
  the join *is* the tenancy predicate. One grouped statement for the page, never a count per row.
- **Never trust a `RETURNING` capture from `psql`** without a CTE. `psql -tAc "INSERT ... RETURNING id"`
  also prints the `INSERT 0 1` command tag, which silently corrupts a captured id. Wrap it:
  `WITH ins AS (INSERT ... RETURNING id) SELECT id FROM ins;`.
- **A spec file's decorators need that file to be inside its tsconfig's `include`.** Vite resolves a
  file's tsconfig *by path*, and a file the tsconfig excludes is transformed without
  `experimentalDecorators` — so an `@Component` in an excluded spec fails with a bare
  `SyntaxError: Invalid or unexpected token` that names neither the file nor the decorator. This is
  why `apps/web/tsconfig.json` includes specs (and why `web:typecheck` now checks them, which it never
  did before) while `tsconfig.app.json` excludes them again so the production program stays clean.
  Two consequences worth knowing: `paths` in a child tsconfig **replaces** the parent's map, so the
  `@finmate/*` aliases are repeated there; and a mounted-component spec needs
  `// @vitest-environment jsdom` plus `initAngularTesting()` from `@web-test/angular-testing` imported
  **first**, before any other Angular import — `@angular/router` is partially compiled and its module
  body needs `@angular/compiler` already loaded, or it fails with "The injectable 'PlatformLocation'
  needs to be compiled using the JIT compiler".
- **Angular's JIT does not discover `input()` signal inputs, so a mounted test cannot render
  `fm-money`.** `MoneyComponent.amount` is `input.required`, and under JIT (which is what Vitest runs,
  unlike the AOT production build) the binding is dropped and it throws NG0950. `web:build` accepts
  the same binding, so it is a JIT limitation and not a template bug.
  `capture.component.spec.ts` therefore swaps `fm-money` for a **custom element**
  (`remove: { imports: [MoneyComponent] }, add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] }`) and asserts
  amounts on the component's own state. Do not "fix" that by weakening the component.
- **A capture row's `clientRowId` and `idempotencyKey` are generated once and never regenerated.**
  They are what survives a re-parse as the user keeps typing, and I-10's retry safety *is* the stable
  key: minting one at submit time would produce a duplicate on the first retry after a network
  failure. `parseLocally`'s carry-over is also why an edit, a removal and a category choice do not
  slide onto the row below. And the preview sends `categoryId` **only when it differs from the
  proposal's**, because the server reads a present `categoryId` as "the user overrode this" and marks
  the proposal rejected — echoing the proposal back would label every acceptance a correction and
  poison docs/04 §6.4's re-fit.
- **`captureCommit` rejects the whole request when any row is structurally invalid, and it collects
  every offending row first.** Validation runs in phases (fields → existence → previews), so the
  rejections are re-sorted into the caller's row order before the single throw; a `reject()` helper
  also de-duplicates so a row with two problems is named once. Do not reintroduce an intermediate
  `throw` between phases: the caller would fix one row, resubmit, and be told about the next.
  A **low-confidence row is not a validation failure** — it is written `PENDING` and the rest of the
  batch still commits (docs/06 §5.2.1, F-06).
- **A custom scalar must be listed in a module's `providers` or Nest cannot use it as an INPUT.** `@Scalar('JSON')` +
  `@Field(() => JsonScalar)` is not enough: without the provider, boot fails with
  `CannotDetermineInputTypeError ... for the "conditions"`, which names the *class* and reads like a decorator
  problem. `accounts.module.ts` is the precedent (`MoneyScalar`, `BalanceScalar`, `UuidScalar`, `LocalDateScalar`);
  `classification.module.ts` now provides `JsonScalar` the same way.
- **The rule conflict check must give the proposal `createdAt = now`, and must treat "already decided the same way"
  as a shadow.** docs/04 §5.3.1 breaks a specificity tie on `created_at DESC`, so an epoch timestamp made every
  proposal lose every tie — including to an identical rule — and `checkShadowing` reported the wrong answer for
  same-priority rules. And without the redundancy arm, ticking "remember" twice on the same correction context
  quietly piles up duplicate rules that all do the same thing, which is the rot §8.2 is about. Do not "simplify"
  the check into a structural condition-overlap comparison: it runs the **real** `evaluateRules` on a witness the
  proposal matches, which is why it cannot disagree with the pipeline.
- **`CorrectionsService` is not self-contained: the caller composes the synthesis subject.** It owns `corrections`
  and `rules` only; the subject needs the Transaction (ledger) and the entity names (taxonomy), so
  `TransactionsService.correctionSubject(...)` builds it and the resolver passes it in. The alternative — reading
  `transactions` from the classification module — would invert the module edge, and recomputing it later from the
  correction alone needs the same read. `corrections.integration.spec.ts` has a `subjectFor` helper for the same
  reason.
- **Resolution and decision are two different entities, and the ledger records the *resolved* one.**
  `PipelineOutcome` carries `resolvedMerchantId`/`resolvedCounterpartyId` (what the row stores, and what
  synthesis reads) **separately** from `entityId`/`decidedBy` (what the audit trail explains). Mapping the
  decision entity to `merchant_id` put a Counterparty id into a column whose foreign key points at
  `merchants` — an FK failure, and only when a Counterparty had a default category — and dropped a
  Counterparty that resolved without deciding, which made F-09's counterparty rule unlearnable from a
  capture. The preview returns the resolved pair and the **client echoes it on the commit row**: the ledger
  writes the row it is given and does not re-run resolution, so a client that drops the echo leaves the
  entity resolved for the preview and absent from the row. See docs/04 §8.1.2.
- **A keyset page needs the sort key to be the cursor.** `TransactionsService.list`'s four sorts are
  `OCCURRED_*` (date, then id as a stable tiebreak) and `RECORDED_*` (the id alone — a UUIDv7 *is* the
  creation order). The cursor comparison flips with the direction, and the review queue deliberately has no
  CONFIDENCE/AMOUNT sort: a page boundary on a non-unique key silently repeats or skips rows, which needs a
  composite cursor rather than an approximate one.
- **`hit_count` is bumped on the COMMIT path, never on parse.** `captureParse` fires on a 250 ms keystroke
  debounce, so counting there inflated `hit_count` by an order of magnitude and made docs/04 §8.2's "stale after 90
  days" meaningless. A hit is a Transaction a rule actually decided.
- **Duplicate-suspect detection compares against non-`VOID` rows, not `CONFIRMED` ones, and that is a
  correction to docs/06 §5.2.2.** The spec said `CONFIRMED`, which taken literally makes the mechanism
  unreachable for the household that needs it most: with no keywords, rules or AI provider — every
  fresh signup, and F-13's cold start — *every* captured row is `PENDING`, so no candidate would ever
  exist and `Lidl 2000` could be typed twice with no warning. Status is not what makes a row a
  duplicate; the user's two submissions are. `VOID` and `deleted_at` stay excluded. Two things follow:
  the mechanism is **advisory only** (it can never refuse a row, which is what makes the generous
  windows safe), and it is **symmetric** — two identical rows in one batch are reported from both
  sides, so `suspectTransactionIds` de-duplicates before an undo acts on them. The three windows the
  docs state in three places are resolved in `duplicate-detection.ts` as named constants (5-minute
  submission window, ±2 days on `occurred_local_date`, 0.85 trigram similarity) with the reasoning in
  the module header. `prisma.client.transactions.findMany` for the candidate pool is **one** query for
  the whole batch; do not turn it into a per-row lookup.

- **An absent optional GraphQL input field and an explicit `null` are different instructions, and a `?? null`
  in the resolver destroys the difference.** `CaptureCommitRowInput.merchantId` is nullable, so a client that
  omits it and one that sends `null` reach Nest differently (`undefined` vs `null`) — and for the commit row
  that is meaningful: absent means "this client did not preview, fill in what the classification resolved",
  `null` means "there is no entity here, do not overrule me". Normalising with `?? null` (which the resolver
  did) collapses them, so a service-level test of the distinction passes while production behaves as if the
  distinction did not exist — which is exactly how a Merchant the server had resolved went missing from a
  committed row. The mapping now lives in a pure `toCommitRow` in `capture-commit.model.ts` with its own spec,
  so the contract is testable and the resolver cannot quietly re-coalesce it. Coalesce the fields where the two
  really are the same thing (`categoryId`, `note`, `clientId`) and spread the ones where they are not.
- **`CategoryModel.path` is `[String!]!` on the wire, not a `string`.** A hand-written response interface is a
  claim, not a check, and `/rules` had `path: string` — so a rule's category rendered as a comma-joined array
  (`Hrana,Supermarket`) rather than the ` › ` breadcrumb every other screen builds. Ask what the type actually
  is before typing the response: `apps/api/schema.gql` is generated and is the answer.
- **`fm-money`'s `accessibleLabel` hardcodes the Serbian words `prihod`/`trošak`.** Found while reading the
  component in 2.3.2b; **not fixed**, because it is a shipped component on the money path and the fix (two
  `confidence`-style catalogue keys plus `i18n.t`) deserves its own change and its own test run. It violates
  the DoD's "no hardcoded user-facing strings" rule, and it is the only known instance.

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
