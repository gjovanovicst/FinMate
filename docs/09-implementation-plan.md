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
| 2.2.6 | **The AI composition root and the consent gate** — **added by [ADR-031](14-decisions-and-risks.md), decided by [ADR-032](14-decisions-and-risks.md)**, and landed during Sprint 4.2 because nothing had scheduled it: config → routing table → adapters → `AI_CLASSIFIER`/`NARRATOR`/`OCR`/`EMBEDDINGS`, inert when nothing is configured; the per-Household `consents` record with `aiConsents` + `recordAiConsent` (OWNER-only, append-only) and the router's per-call `ConsentGate`; plus the two prompt defects the first live call found | 2 | F-05, F-06, F-07 |
| 2.2.7 | **Reconcile a stage's category with the row's direction** — **DONE**, and the defect was wider than found: no stage compared its category's `kind` with the fragment's, so a **keyword** could put an `INCOME` row into an `EXPENSE` category too, and `captureCommit`'s I-3 check was guarded by `if (row.categoryId)` — the *override* — so the whole preview → confirm flow skipped it and a live I-3 violation was written. Fixed in one place (the pipeline's `finish()`), with the commit path's three category sources each validated and a write-loop guard as the floor. Decision: **refuse the category and ask**, keeping the suggestion as a `direction-mismatch` candidate; §8.1.5's shape. docs/04 §8.1.6 | 1 | F-05, F-07 |

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
| 4.1.6 | **A reader for the receipt, and a screen that asks it** — **added because 4.1.3 shipped an API no deployment could serve**: `AI_OCR_MODEL` + `AI_OCR_TIMEOUT_MS` ([ADR-037](14-decisions-and-risks.md)), the `assembleAi` capability gate (an adapter that lists no model for a task is a logged skip, not a route that fails on the first receipt), `CLOUD_OCR` consent on every non-`LOCAL` OCR route ([ADR-038](14-decisions-and-risks.md)), the optional local sidecar (docs/11 §2.5) and *Read the photo* on `/receipts/:id` | 2 | F-14 |

### Sprint 4.2 (week 13) — Offline & sync, ~10 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 4.2.1 | Service worker, app shell caching, update flow | 2 | F-26 |
| 4.2.2 | IndexedDB repository + outbox pattern + idempotent flush | 3 | F-26 |
| 4.2.3 | Offline capture UX: "pending sync" tray, retry, conflict diff for money fields | 2.5 | F-26 |
| 4.2.4 | Stale-snapshot labelling (`as of <time>`) everywhere a figure is shown offline | 1 | F-26 |
| 4.2.5 | Web push subscription + permission flow — the **client** half; needs 4.2.9 | 1.5 | F-22 |
| 4.2.9 | **The `WEB_PUSH` sender** — **added by [ADR-028](14-decisions-and-risks.md)**: `push_subscriptions`, the inert-without-VAPID `web-push` seam, the minimal payload and the dispatch wiring | 2 | F-22 |
| 4.2.8a | **The ledger-rows cache** — **added by [ADR-027](14-decisions-and-risks.md)**: a separate record in the same encrypted store, the current period plus 45 days capped at 200 rows, through `toSnapshotRow`'s whitelist, with its own `staleAt` | 1 | F-26 |
| 4.2.8b | **The screens that serve it** — **DONE**: `/transactions` writes the cache after a successful **unfiltered** read and serves it, labelled and read-only, when the read fails; the record carries the ledger currency, and a filtered read is neither cached nor served. **The row's own note — *analytics' cached period follows the same rule* — was wrong and is retracted**: it contradicted [07 §6](07-platform-strategy-mobile-desktop.md)'s matrix and ADR-027's rejected option (f), and the matrix won (ADR-027's 4.2.8b amendment). **Analytics needs a connection**, so no record was built for it. The assistant deliberately does **not** read the ledger cache (rejected option (f)) | 0.5 | F-26, F-24 |
| 4.2.7a | **Queued edits in the core** — **added by [ADR-026](14-decisions-and-risks.md)**, decided by [ADR-030](14-decisions-and-risks.md): the entry `kind`, `enqueueEdit`, the version-checked dispatch, and the conflict diff (`SyncConflict`) a refused stale edit produces | 1.5 | F-26, F-04 |
| 4.2.7b | **The offline edit and its conflict panel** — the sheet queues an edit when it is offline, and the tray renders before → after per money field with the two versions | 0.5 | F-26, F-04 |
| 4.2.6a | **The app lock's core** — **added by [ADR-025](14-decisions-and-risks.md)**, mechanism by [ADR-029](14-decisions-and-risks.md): the WebAuthn-PRF and PIN secrets, the wrapped-key lifecycle, the state that turns persistence on, the cross-tab flush mutex ADR-026 deferred here, and the wipe | 1.5 | F-26, F-28 |
| 4.2.6b | **The app lock's device panel and lock screen** — the control that arms it, the re-auth screen, and the `/notifications`/settings copy that stops saying "keep the app open" | 0.5 | F-26, F-28 |

### Sprint 4.3 (week 14) — Mobile UX polish, ~7 pd

| # | Task | pd | F-ID |
|---|---|---|---|
| 4.3.1a | **Layout correctness** — the 320 px shell overflow (one missing `grid-template-columns`, docs/02 §9), the header's top inset, `vh`→`dvh` in the two places docs/07 §4.3 names, and a **measured** overflow audit of all 18 authenticated routes at 320/768/1280 px. **DONE**: 50/50 route-width pairs at zero overflow | 0.5 | F-26 |
| 4.3.1b | **The sheet's dismissal contract** — **DONE**: the dirty guard (a form whose record fields differ from what it loaded turns the close button, `Esc` **and** a swipe-down into an in-sheet *Discard changes* / *Keep editing*), swipe-to-dismiss with a tested threshold, and the finding that says what a *pinned* bar would really cost. `90dvh` and `dvh` came with 4.3.1a. The inventory's `ui-sheet` stays **unbuilt on purpose**: `showModal()` is the primitive | 1 | F-26, F-05 |
| 4.3.1d | **The all-screens visual audit** — **DONE**: a browser instrument measuring horizontal overflow, text contrast and tap targets on all 20 authenticated routes at 320/768/1280 px **and in the light theme**, plus a screenshot per screen for the human pass (`.artifacts/visual-audit/contact-sheet.md`). Found and fixed a systemic contrast defect (`--color-text-subtle` at 3.31:1 across 153 element-route pairs) and three unstyled anchors rendering the UA blue at 2.02:1; measured 0 overflow and 0 contrast failures after the fixes. It also **measured the tap-target gap** rather than assuming it | 0.5 | F-26 |
| 4.3.1e | **Control sizes — DONE, and the finding it was scheduled from was wrong in both directions.** Re-measured with WCAG 2.2 SC 2.5.8's **own exceptions** implemented (inline targets, and *spacing*: a 24 px circle centred on a target must not touch another target) instead of comparing boxes: the honest count is **0 failures of 2.5.8** — most of the reported seventeen were visually-hidden native inputs whose **label** is the target, and the rest passed by spacing. The **house rule** was the real gap, and it was not where the row said either: the 44 px floor in `styles.css` has been gated on `(pointer: coarse)` **since task 0.8**, so a real phone passed while a 320 px desktop window — and every audit so far, all of which measured a fine pointer — did not. Fixed as **one token** `--control-size` (44 px on a compact layout **or** a coarse pointer, 32 px dense) applied by an element rule for `button`/`[role=button]` and a class rule for `select`, `input`, `summary`, `.btn`, `.chip`, `.link`, `.controls__csv`, `.hero__cta`, `.bar__label`, `.pager__button`, `.topbar__button`, `.skip-link` — plus four component rules where a scoped declaration outranked the token, and a `link` class on the one budgets anchor left over. **Measured after: 0 controls below the floor in 4 contexts (fine/coarse × 320/1280) × 2 households — 3,880 control-route pairs — with 0 horizontal overflow and axe still 0 critical / 0 serious.** ⚠️ Deviations recorded rather than hidden: (1) the row wanted this **with** the human pass, and it shipped first, so the **rhythm judgement is carried into that pass** (the floor grows pager arrows, the category tree's twisty, "New rule", tabs and the analytics bar labels); (2) it says a blanket `min-block-size` was deliberately not shipped, but one **has** been shipped since 0.8 under `(pointer: coarse)` — this task widened its trigger to the compact size class rather than duplicating a floor per component; (3) the audit instrument is not committed (Playwright is not a repo dependency), so the numbers above are a recorded measurement, not a CI gate | 1 | F-26, F-05 |
| 4.3.1c | **The pinned capture bar** — **found by 4.3.1b's measurement**: `position: sticky` on the confirm row computes and does nothing, because the row is the last child of its containing block and has no slack to stick into (the button sat 1431 px down on a 720 px viewport). Two designs, and the choice needs somebody looking at the screen: give the preview list its own scroll container so sticky has slack, or a fixed bar offset by the bottom nav's height. Also resolves docs/02 §4.3 vs docs/07 §4.1, which disagree about whether the confirm is inline or pinned | 0.5 | F-05 |
| 4.3.2 | Install prompt / Add-to-Home-Screen flow. **Unblocked 2026-09-17** by the name decision (`FinMate`; the screening it skipped is **R-28**). **(a) DONE — the app is installable.** `manifest.webmanifest` (name/short_name/`display: standalone`/`start_url`), four generated icons (`icon-192`, `icon-512`, a **maskable** 512 with the glyph inside Android's 80 % safe zone, and `apple-touch-icon` for iOS, which ignores the manifest's icons and applies its own mask), the three legacy `apple-mobile-web-app-*` tags Safari actually reads, and the manifest + icons in the service worker's `app` asset group so an installed app has them offline. The icons are written by `pnpm icons:generate` (`apps/web/tools/generate-icons.mjs`) — a **dependency-free** PNG encoder over `node:zlib`, because every alternative needed a new dependency or a design tool, and geometry is reviewable. **Verified by asking Chrome, not the files**: CDP `Page.getInstallabilityErrors` returns **none**, the worker is `activated` at `/`, and each icon is fetched and its PNG header decoded (192×192, 512×512 ×2) rather than trusted. **(b) DONE — the funnel itself.** `apps/web/src/app/core/install/` (`install.view.ts` — the pure decision, one assertion per row of docs/07 §4.7's table; `install-events.ts` — the sink seam; `install.service.ts` — the only code that touches the window, the stored record and the two events) plus `shared/ui/install-sheet/`, rendered by the **shell**, because `beforeinstallprompt` fires once, early, and long before anybody reaches `/capture`. **The trigger is a capture the server accepted**: a queued offline batch is a promise and a replay is the same `idempotencyKey` coming back, so neither counts. **`offeredAt`/`dismissedAt` are timestamps and not flags** — an unanswered offer is never repeated, a dismissal is a **30-day** pause and nothing more, which a boolean `shown` could not express without either suppressing for ever or re-appearing on every capture (what the first draft did). **Acceptance is measured, never asserted**: Chromium answers through `userChoice`/`appinstalled`, iOS has no API at all, so its only evidence is a later launch in `display-mode: standalone` — attributed only if a sheet was shown, and an install from the browser's own menu is marked installed while inventing no event. There is no *I installed it* button, so the event set is exactly the two §4.7 names and *shown without accepted* **is** the T3 gap. The sheet is deliberately **not modal and moves no focus** (§7.4's rules are for a sheet the user opened; §4.7 forbids blocking the app behind an install), and it reuses `core/push`'s `isIos`/`isStandalone` rather than a second copy. A browser with neither the API nor iOS gets **nothing**. **Verified live 25/25** against the served production build — both platforms, the dismissal window, the standalone gate, `/onboarding`, three widths and **Tab** to the button — with axe reporting **0 violations** on the open sheet, and the shell budget moved 137.9 → **140.6 KB** of 150. ⚠️ **Residual this task owns**: `install.prompt_shown`/`install.accepted` have **no sink** (no analytics endpoint; docs/07 §11's RUM and `sync.pending_age` are unwired too), so they are typed, emitted and written to a bounded **on-device** log that a transport can drain — **T3 is not measurable until one exists**, and `INSTALL_EVENT_SINK` is the single provider override that fixes it | 1 | F-26 |
| 4.3.3 | Mobile keyboard handling on the money field (numeric keypad, no layout jump) | 1.5 | F-05 |
| 4.3.4 | **Performance — (a) DONE, (b) next.** **(a) The bundle budget gate is built and in CI** (`pnpm bundle:budget` → `apps/web/tools/bundle-budget.mjs`, docs/07 §11): per-route **cold cost** against the documented ceilings, warning at 90 % / failure at 100 %, and a route with no budget entry fails (rule 7 — which found that §11 names 8 routes and the router has 24, so the rest are held to the documented 320 KB total through an explicit list). Two measurement traps are handled and recorded: `ng build` defaults to `development` (2–3× too large, and the tool refuses it), and a chunk's `imports` mix static and dynamic edges (following both made every route's marginal cost zero). Measured: shell 137.9 KB (92 %, warns), capture 159.9, transactions 174.9, every other route 138–178, `packages/nlp` 2.5 KB. **Lazy routes were already done** (`loadComponent` everywhere) and **no images ship** — `public/` is empty and the only `<img>` tags render a presigned receipt photo, so image sizing has nothing to size until the PWA icons exist (4.3.2). **(b) axe measured, and it found a defect**: across all 20 routes of the served production dist, **20 serious `color-contrast` violations — the active nav item on every route (3.85:1)** — which 4.3.1d's instrument had missed; fixed at the token level (`--color-primary-text`), after which axe reports **0 critical / 0 serious**, with 21 moderate landmark findings named (`<main>` nested in the shell's `<main>`, its own task). **Lighthouse did not run**: `chrome-launcher` creates its temp dir outside the file sandbox (`EACCES` on `/mnt/c/...`), so its numbers belong with the CI job — which is also why that job is deferred (a shared-runner ≥90 gate flakes for unrelated reasons). Not built and recorded: the per-PR **delta vs `main`** | 2.5 | F-26 |
| 4.3.5 | **Session continuity on a cold start — DONE.** **Added by 5.2a's live pass, recorded as R-26**: a full page load signs the user out, because the API scopes the refresh cookie to `Path=/auth` while the browser must ask the deploy proxy for `/api/auth/refresh`, and a browser matches cookie paths against the *visible* URL. It affects the service worker's own reload path and the app lock's re-auth screen (R-23's "survives a reload" is true for in-app navigation and false for a hard reload). **Decided (2026-09, on 5.2a's finding)**: **the cookie path follows the public mount prefix** — one config value, default `''` for an API mounted at the root and `/api` in dev, used by the `Set-Cookie` **and** the `clearCookie` call so a logout cannot leave an orphan, asserted by an integration test that reads the header. It keeps the narrow scope the current `Path=/auth` was written for (the refresh token still reaches only auth endpoints) and stays agnostic to the undecided hosting topology (Q-7); widening the cookie to `Path=/` and moving the client onto two prefixes were both rejected. **Built and verified 9/9 live**: the cookie now stores at `/api/auth`, a hard reload stays in the app, a second reload survives the rotation, a deep link holds, and logout actually removes it | 0.5 | F-26, F-01 |
| 4.3.6 | **The offline pass's two findings (R-27)** — **found by the pass docs/10 §8.3 specifies and nobody had run** (the harness serves the production build, because the service worker is production-only, then drives a real browser with the network cut). (a) **Diagnose and fix a dropped flush**: a queued capture drained on reconnect, the chip disappeared, the tray said *0 waiting to send, 0 refused*, and the database had **nothing**. **Diagnosis so far**: the classifier retries 5xx correctly and `GraphqlClient.query` throws for both an `errors` body and a 200 without `data`, so neither can remove an entry — and only a *resolved* send removes one; a probe shows the flush's POST returned **200**, so the client accepted something success-shaped while the server wrote nothing. **DIAGNOSIS COMPLETE (4.3.6).** The response body, recorded by wrapping fetch/XHR **in the page**, is the server refusing the batch — `VALIDATION_FAILED`, *a row with no accountId needs a defaultAccountId on the request* — and the tray **on the page that flushed** correctly shows *0 waiting to send, 1 refused* with that message, so the client's classification is right and the pass's earlier reading (*dropped as sent*) is **refuted**: the *0 refused* it saw was read after a full reload. The real defect is the **store**: `OfflineStoreHolder` has no `invalidate()` (though `app-lock.service.ts`'s doc names one), so the backing only leaves memory when a *data* consumer calls `repository()` after the unlock — measured: IndexedDB's `outbox` is **empty** after an offline capture the chip counts as queued, and a fresh dashboard mount after the unlock makes the same capture land there (`outbox: ["1"]`); and after a reload the tray reads *Nothing is waiting to be sent* while the record is on disk, because nothing re-reads the queue when the unlock changes the backing. Third defect: offline the composer's `accounts` query fails, so it sends `defaultAccountId: null`. **(a1) DONE in 4.3.6a** — the fix written up as ADR-025's amendment: `OfflineKeyProvider` exposes `durability` as a signal, `OfflineStoreHolder` watches it and invalidates on a *change* (an effect's first run must not, or an in-memory backing's only copy is discarded), `generation` is a signal, and `SyncService` reacts by dropping its cached outbox, re-reading and flushing. **Verified live 4/4** against the production build: a capture taken straight from the unlock with no data screen visited is in IndexedDB (`outbox: ["1"]`) and a reload's tray still holds it, with the server's refusal displayed. **(a2) DONE in 4.3.6b** — the composer writes and reads ADR-025 decision 5's taxonomy cache (the categories and accounts it names; the `taxonomy` store's first writer since 4.2.2), so a queued capture carries a real `accountId` and the server's refusal is gone. **The pass has been re-run for the capture path, 8/8 live**: the offline capture drains, the transaction is written (zero before), it carries the cached account, nothing is waiting or refused, the queue is empty and a reload shows one row. **(b) DONE in 4.3.6c** — [ADR-033](14-decisions-and-risks.md): an unlocked install whose session could not be restored because nothing answered gets a read-only offline shell (the queue and the cached ledger, two links and no navigation), and **nothing is sent without a session** — the flush is skipped without a token and a `401` is retryable rather than the entry's fault, which is what keeps a queued capture alive across a signed-out reconnect. **Verified live 13/13** against the production build: an offline reload + PIN lands on `/pending` with the capture listed and the offline sentence shown, the cached ledger is reachable under its `podaci od` label, the full nav is not drawn and no send control is offered, a signed-out reconnect sends and refuses nothing, and the queue drains exactly once after the session returns. **R-27 is closed in full.** **Also named**: the taxonomy TTL is the store's 24 h, the same as the snapshot's; whether a *reference list* should live longer than a figure is a decision nobody has made, and it bounds how long a device can capture offline before its account list expires. **Also owed**: the API request log (its structured log is boot-only), which is what made this diagnosis take an in-page instrument instead of a log read. (b) **An offline reload cannot reach the queued work**: the lock screen renders and unlocks, then the router lands on `/sign-in`. (b) needs an ADR — letting an unlocked lock authorise an offline session is a security decision | 1.5 | F-26 |
**Exit criteria**
- A Lidl receipt totals correctly across ≥ 3 categories, with low-confidence items flagged.
- Full capture flow works in airplane mode and syncs without duplication on reconnect.
- A hard reload of any screen keeps the session, and the app lock's re-auth screen — not `/sign-in` — is what a locked install shows. ✅ **Measured true in 4.3.5** (9/9 live: cookie at `/api/auth`, a hard reload, a second reload across the rotation, a deep link, logout). The app-lock half of the sentence is still unexercised by that pass — it needs a lock armed, which the human pass should do.
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
| 5.2 | GDPR: export, hard delete, consent recording, retention jobs, privacy policy | 2.5 | Blocking for EU/RS launch. **Consent recording is partly done early**: the record + OWNER-only API (ADR-032) and its settings surface (**R-25a**) shipped with 4.2 rather than here, because nothing else could grant consent at all |
| 5.2a | **The first-use consent sheet** — **added by [ADR-032](14-decisions-and-risks.md), the open half of R-25**: docs/08 §6.6 asks at first use (the first fragment that fails rules resolution), so the capture screen's degraded banner becomes where the question is put, with the same copy and the same OWNER-only rule as the settings section. A declined or withdrawn purpose is never asked again. **DONE** — the sheet and the `/settings` card are one component (`ui-consent-purpose`, so the disclosure cannot drift), the sheet adds the reason sentence and three verbs (Allow · Decline · *Not now*, which writes nothing), the trigger is the server's own `degraded` flag plus `askable`, and it is placed below the composer so the field never moves under the caret. Verified live at 320/768/1280 px: no record ⇒ `degraded: true, usedAi: false`; Decline ⇒ `DECLINED` and still refused; Allow ⇒ `decidedBy: AI`. 22/22 end-to-end checks | 0.5 | F-32, F-05 |
| 5.3 | Performance: query analysis, missing indexes, N+1 sweep, API p95 ≤ 300 ms | 2 | |
| 5.4 | i18n: extract all strings, SR + EN, locale formatting, cyrillic-tolerant search | 2 | F-27 |
| 5.5 | Onboarding funnel instrumentation + product analytics | 1.5 | Needed to read the launch metrics |
| 5.6 | Load test at 10× expected beta volume; cost review vs. the model in [12](12-monetization-and-pricing.md) | 1 | |
| 5.7 | Beta ops: invite flow, feedback capture, support runbook, incident checklist | 2 | |
| 4.3.7 | **AI disclosure honesty — added by the 2026-09-17 AI audit.** Two things the routing change did not
fix, both about telling the truth on screen: (a) **`/assistant` does not say when an answer is a
deterministic template** — `narrationMode`/`reason` are deliberately unrendered, which was defensible when
every deployment fell back and is now the only way to tell a narrated answer from a fallback (measured: the
model answers in the Household locale, the fallback in English, which is a *clue* rather than a statement);
(b) **`aiEgress` can name a task no code performs** — `PARSE` is routed and disclosed while only `CLASSIFY`
is ever called (`AiClassifier` has no parse; `packages/nlp` parses locally), so the consent sheet could
disclose an egress that never happens. Either drop `PARSE` from `ROUTED_TASKS` or make the disclosure name
what is called; both are small, both need a decision about what the sheet promises. **Decided and (b) closed
in 4.3.7a, together with a third defect the same audit measured: `aiEgress` returned `CLASSIFY` and `NARRATE`
both on `DEEPSEEK_GLOBAL`, and the card prints one `consent.egress` sentence per row — so the copy a person
consented to said *"It goes to DEEPSEEK, a data centre outside the European Economic Area."* twice.**
[ADR-034](14-decisions-and-risks.md): the disclosure is the intersection of routed and *callable*
(`AiSeams.calledTasks`, derived from the seams the composition root builds — `PARSE` stays routed so
`AI_PARSE_PRIMARY` is not dead config again, and a routed-but-uncalled task is logged rather than disclosed),
and the client renders one sentence per `(provider, region)` while the API keeps its per-task rows. The copy
version deliberately does **not** move: no purpose, provider or region changed. **(a) shipped in 4.3.7b**:
`/assistant` now names the path that put an answer into words — one line in the provenance panel, the reason
in words for every prefix this build knows, and **one visible sentence plus a `/settings` link only when the
fallback was the reader's own withheld consent** (the one reason with an action). docs/06 §8.5's
"make the fallback invisible" is **amended, not ignored**: the reasoning it was written under (every
deployment fell back, so the mode said nothing) no longer holds, and the part it was protecting is kept by
the wording — the template is described as what it is, never as a failure. Verified live both ways, 0 px
overflow at 320/768/1280 px, no raw machine string on the page | 0.5 | F-28, F-23 |
| 4.3.8 | **The offline app is the app — DONE, owner-requested.** [ADR-033](14-decisions-and-risks.md) shipped the offline state as **two screens and a sentence**: `/pending` plus the cached ledger, a redirect to the tray from every other route, and two links where the navigation would be. The owner's report — *"if I go offline and reload I get 'app is offline' instead of the page; isn't the point of a PWA that the app works offline and only some actions wait for a connection?"* — is right, and the ADR's own reasoning (*"every other destination is a control that cannot work"*) was written before the screens existed. The dashboard serves an ADR-027 snapshot with its `as of` label, the ledger serves its cache, the composer queues, analytics carries its own "needs a connection" sentence, and `SyncService.flushNow` already refuses without a session and drains when one arrives — so **docs/07 §6's 📖 rows were false after a reload**: safe-to-spend and the projection were reachable from no control at all. **[ADR-033's 2026-09-20 amendment](14-decisions-and-risks.md)**: the `data: { offline: true }` allow-list is gone and **every route is admitted**; the shell renders its real navigation and the header controls that need no session (theme, language, the sync chip, the bell) with **one persistent banner** inside the content region; the account block, sign-out and the global search stay hidden (the search navigates to a *filtered* read, which is deliberately never cached — docs/02 §2); and the unlock now lands on `/` rather than the tray, because the guards had run while the install was still LOCKED. The security boundary is untouched: no session is fabricated, no token is minted, `isAuthenticated()` stays false, and nothing is sent. **Verified live against the production build with the network cut**: an offline reload + PIN lands on `/` with the snapshot's `as of` label and 17 nav links, `/transactions` renders *"1 transactions saved on this device"* with its read-only sentence, an offline capture queues (`Waiting to send (1)`) and survives a second reload, and the queue drains to the server (`Kafa 25000`, `Lidl 200000`) after an online reload. The app lock remains the precondition: with it off nothing is persisted and the offline state is still `/sign-in`. **Follow-up the same day, after the owner hit the second half by hand**: the banner existed only in the offline state, so a person who reloaded offline with the lock *off* met an unexplained login form. There is now **one banner driven by the browser's `online`/`offline` events** (`core/connectivity`) that states the network is gone on **every** page — sign-in included — with copy that matches the install: *saved on this device* when the lock is armed, *kept only until you close the app* plus a *Set up offline* link when it is not, and *signing in needs a connection* when there is no session. The lock screen carries its own line, since it is where an offline reload lands. ⚠️ `navigator.onLine` chooses **copy only** — nothing that sends or persists may branch on it (ADR-025 decision 7). Verified live in all four states against the production build | 0.5 | F-26 |
| 5.8 | **The password-reset and email-verify screens — DONE.** Both routes exist and the emails' own paths were the ones built: `/reset-password` (no token ⇒ ask for the address; `?token=…` ⇒ ask for the new password) and `/verify-email?token=…`, both **unguarded** — `anonymousGuard` would bounce a signed-in visitor to `/`, and a signed-in visitor is exactly who clicks an emailed link (docs/15). The inventory's `/auth/verify`/`/auth/reset` were corrected to the shipped names: the mails have always carried `/verify-email` and `/reset-password`, and the app's convention is a flat route beside `/sign-in`, so the screens were added where the links already point rather than rewriting the mail template. The request answer is neutral for any address (the API answers `204` for all of them), a spent token becomes *Zatraži novi link*, and a `VALIDATION_FAILED` on the set form is read as the token because the client checks the same length rule the server does. Sign-in gained *Zaboravio si lozinku?*; the four auth screens now share one style block and one password-policy constant (they had two copies and a drift). **Verified live 17/17** against the production build with Mailhog as the mail source: the request form, the mail's link opening the set form **while signed in**, the new password signing in, the demo password restored through the same flow, a mismatch never reaching the API, a dead token offering a new link, signup's confirmation link confirming, a second click reporting the dead link, and an incomplete link calling nothing. Two gaps found and **not** closed, because both are decisions rather than screens: (1) `users.email_verified_at` is **read by nothing** — `login` does not require it and no feature is gated on it, so confirmation is advisory today (the failure copy says so), and what it should gate is a product and security call; (2) **no re-send operation exists** (only signup and the reset request issue tokens), so an expired confirmation link has no in-app recovery — which costs nothing *only because* of (1). Both are named in docs/06 §2, and a self-service `POST /auth/resend-verification` is the shape the fix would take | 1 | F-28 |
| 0.6.4–0.6.5 | **Profile, and email verification made real — DONE, owner-requested.** 0.6.4 adds `/profile` (docs/02 §4.18's **Profil**: display name, staged email change with its own confirmation link, password change with re-auth, active sessions with revoke, language) and the eight REST routes behind it; `GET /auth/me` also carries the profile fields, so the shell's account block names the person instead of the role. 0.6.5 closes both gaps 5.8 named: `email_verified_at` now gates when `REQUIRE_EMAIL_VERIFICATION` is on (the global `EmailVerifiedGuard`, `EMAIL_NOT_VERIFIED`, `/auth/*` exempt so an unconfirmed account can fix itself; the flag is read once per request **only** when on), `POST /auth/resend-verification` gives an expired link in-app recovery, and the schema now **refuses to boot in production without `SMTP_URL`** because `MailService` otherwise logs the message body. New `MAIL_FROM` names a provider-verified sender. The shell shows an unconfirmed-address banner **only when the deployment blocks on it** — a deployment that does not must not nag, and the demo Household's seeded user has never clicked a link | 1 | F-28 |
| 0.6.6 | **Two-factor authentication — DONE, owner-requested, and it overrides the Part 4 deferral.** Two independent opt-in factors: an authenticator app (TOTP, RFC 6238, **in-repo on `node:crypto`**, pinned to the RFC's own vectors) and an emailed six-digit code. **A correct password with a factor on mints no session and sets no cookie**: `POST /auth/login` answers a single-use challenge and `POST /auth/login/mfa` completes it, with the challenge stored as a digest plus an attempt cap. The TOTP secret is AES-256-GCM ciphertext under an optional `MFA_ENCRYPTION_KEY` — without it `totpAvailable` is false and the screen says so rather than storing a shared secret in the clear. Ten 80-bit recovery codes are minted with the first factor and shown once; every factor change re-authenticates with the password. UI: a two-step `/sign-in`, and `/profile`'s section with the QR (ADR-042), the key as text, the email toggle and the codes. ⚠️ **The second step shipped broken and was fixed after the owner hit it**: the code form bound `(ngSubmit)` with **no form directive**, so nothing emitted it and nothing cancelled the native submit — clicking *Verify* did a browser GET to `/sign-in?`, reloading the page and discarding the in-memory challenge and access token, which reads exactly as "a correct code logged me out". It is a reactive form now, with a spec that drives the real submit event (`verify()` called directly, as every existing MFA test did, cannot see this). **Live 7/7 + 4/4** — a wrong code refused in place, TOTP signing in with the session surviving a reload, a recovery code, and an emailed code requested by the button (docs/15). Risks **R-35** (lockout) and **R-36** (key loss) name what this costs | 2 | F-28 |
| 0.6.7 | **The settings shell — DONE, and it was overdue.** docs/02 §4.18 has drawn a settings *shell* since Phase 0, and the build had drifted the other way: `/settings` was four stacked cards (two of them links), `/profile` was six more cards of the same subject, and the same question was answered across two pages. `/settings?section=…` now holds every section as **URL-backed tabs** — Account, Security, AI and privacy, Notifications — with `role="tablist"`/arrow-key navigation, a strip that **wraps** at 320 px rather than scrolling, and one pane in the document at a time. `/profile` **redirects** here. Content is regrouped by *who can get in*: Account (name, email, password, language) and Security (two-step + app lock + sessions) are new components split out of the old profile screen. ⚠️ Named: the **notification preferences stay on `/notifications`**, beside the list they describe, so that one section links out instead of owning its content. **Follow-up after the owner's read of it** (docs/15): the page fills the content pane like every other screen — the root's `46rem` cap was measured at 736 px against `/budgets`' 952, and the reading measure moved to the prose (72ch) and the text inputs (26rem) — and the **second scrollbar** it showed on the Account tab was not the shell but `.fm-visually-hidden` laying out at its static position outside the content region's clip (`documentElement.scrollHeight` 903 in an 800 px viewport); fixed at the class level and swept over 20 routes × 320/768/1280 px, 0 document scroll and 0 horizontal overflow | 1 | F-28 |

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
| The rename | **Not needed**: the name decision (ADR-014, amended 2026-09-17) kept the placeholder, `FinMate`. What lands in Phase 5 instead is the **screening** the decision skipped (R-28: trademark/domain/app-store) — and, if it fails, this rename with it, which is one `APP_NAME` + `app.name` change plus the manifest because nothing hardcodes the brand. |

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
| **Passkeys / TOTP 2FA** | **Partly overridden.** TOTP shipped by owner request as **0.6.6** ([ADR-041](14-decisions-and-risks.md)), together with the emailed-code factor and recovery codes; the original reason ("password + refresh rotation is sufficient") no longer holds as a decision, only as history. **Passkeys as a login factor remain deferred** — the app lock's WebAuthn PRF is local encryption (ADR-029), a different concern. | 1–2 wk | **TOTP done (0.6.6)**; passkeys still wait for an enterprise ask |
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
| ~~**End of Phase 3**~~ | ~~**Product name** (ADR-014, Q-1)~~ — **decided 2026-09-17**: `FinMate`, screening outstanding as **R-28** | Product owner | Closed (late) |
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
