# AGENTS.md — FinMate

> **The name is not decided.** `FinMate` is a working title and **is already taken** by existing
> finance products (ADR-014, `docs/13-brand-and-naming.md`). Never hardcode a brand string — read
> `APP_NAME` from config. `Ostava` is the current recommendation, pending screening.

AI-first household budgeting app for **mobile and desktop**. The product promise, in one line:

> Type **`Lidl 2000`** and get a correctly categorised, budget-aware transaction in under five seconds.

**Machine state:** Node 24.20.0, pnpm 11.7.0, Go 1.27.0, **Docker 29.7.2 + Compose v5.5.0 (Linux
containers)** on Ubuntu 20.04 LTS / WSL2.

**Build state — Phase 0 COMPLETE · Phase 1 (manual core) COMPLETE apart from the visual pass · Phase 2
(AI input) COMPLETE · Phase 3 (intelligence) COMPLETE · Phase 4 (receipts & mobile) IN PROGRESS: 4.1
receipts COMPLETE, 4.2 offline & sync nearly so (4.2.1–4.2.5 and 4.2.9 done, 4.2.5a is the push ADR).**

- **Phase 2's exit criteria are measured, not assumed**: rule-hit ratio 73.8 % (bar 50 %),
  overconfident-wrong 0.28 % (bar 1.5 %, blocking in CI), top-1 100 %, should-ask recall 98.8 %.
- **Phase 3**: insight generators + the alert evaluator and dispatch + `/notifications` (3.1); the
  assistant — a closed intent registry, a pure query planner, fact assembly, the numeric validator with
  a template fallback, `/assistant`, F-30's proposal (3.2); analytics on one split-aware
  `SpendReadModel` + goals (3.3); subscription detection (3.3.4); the worker, `apps/worker` booting the
  API's own services with BullMQ owning the schedule, **ADR-022** (3.4).
- **Phase 4.1 receipts**: presigned uploads with an inert scanner seam and `files.purge` (4.1.1); the
  camera/upload UX in the Transaction sheet (4.1.2); the `receipts` module — the OCR seam, item
  classification, I-6 reconciliation (4.1.3); posting a reconciled receipt as one Transaction with a
  Split per Category, plus `DETACH_TRANSACTION` (4.1.4a); the `/receipts` library and the `/receipts/:id`
  mismatch screen, plus the `/transactions/:id` drill-in docs/02 §2.1 always listed (4.1.4b/4.1.5).
- **Phase 4.2 offline & sync**: the service worker — `ngsw`, **app-shell-only with no `dataGroups`**,
  production-only, and a prompted update — **ADR-024** (4.2.1); the encrypted offline store, one store
  per app, an ordered idempotent outbox, and the app lock that turns persistence on named as a task
  because nothing had scheduled it — **ADR-025**, R-23 (4.2.2); the pending tray, the header chip's
  pending half and capture-that-queues — **ADR-026** (4.2.3); the dashboard snapshot with one
  `podaci od <time>` label per serving mode, never fabricated — **ADR-027** (4.2.4); web push decided,
  with the sender (4.2.9) named as the half docs/09 had not scheduled — **ADR-028** (4.2.5a), and then
  built: `push_subscriptions`, the inert-without-VAPID `web-push` seam, the three-operation subscription
  surface and the honest `reasons` a skipped row carries (4.2.9), and its client half — six device
  states, permission behind a button, re-register on every app start — plus the ADR-028 amendment that
  the payload needed to make a background push visible at all (4.2.5).
- **Next**: 4.2.6 (the app lock), 4.2.7 (queued edits and the money-field diff), 4.2.8 (the
  ledger-rows cache), 4.3 (mobile polish),
  Phase 5 (hardening and beta), and the human visual pass at 320/768/1280 px that **no screen has
  had** — Phase 1's own gate, still open.

**The long form is in the docs, deliberately.** Each task's decisions, its deviations from these
specifications and every defect it found live are recorded where they belong: docs/09 §6 for sequencing,
docs/02's per-screen build-state notes, docs/06 §5's implementation notes, docs/14 for the ADR log and
the risk register, and docs/15 for the gotchas. The tables below carry the per-area state; the phase
narrative above does not repeat them.

| Phase 1 slice | State |
|---|---|
| Domain: dates (incl. `instantForLocalNoon`), money allocation, Serbian amount parsing, tree, budget calculators | **Done** — 97 tests, calculators asserted against hand-computed figures |
| Categories tree CRUD + keywords (I-1, I-11, I-12) | **Done** — verified live, including cycle refusal and reassignment |
| Transactions CRUD + splits (I-1, I-3, I-7, I-10, optimistic concurrency) | **Done** — verified live |
| Transaction list: filters, search, day grouping, cursor paging (1.2.5) | **Done** — UI only; the API already had every filter |
| Transaction detail/edit sheet (1.2.6) | **Done** — edit + delete, optimistic concurrency; **splits are create-only** (`updateTransaction` accepts no splits). The **`/transactions/:id` drill-in** docs/02 §2.1 always listed shipped with 4.1.5: the same screen, the sheet opened for a row **fetched by id**, dismissed back to the list |
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
| Schema | 37 tables + 44 CHECK constraints + 20 partial indexes applied; `_prisma_migrations` current (the newest adds `push_subscriptions`, 4.2.9) |
| Prisma | Client generated to `apps/api/src/generated/prisma` (gitignored) |
| API | Boots, `/health` + `/health/ready` green, structured JSON logs, typed error filter |
| Tenancy | `TenantContext` (AsyncLocalStorage) + Prisma guard; **five-way** model classification, incl. global-readable models (`merchants`) |
| Auth (0.6) | REST `/auth/*`: signup, login, refresh **with rotation + theft detection**, logout, verify, reset; argon2id; login throttling; `TenantContext` now resolved from a real session |
| Seed | `pnpm db:seed` — **39** categories, **131** distinct keywords (after folding), **62** merchants; two idempotent layers (globals always, the demo Household with `SEED_HOUSEHOLD_ID`), content shared with onboarding from `packages/domain/src/seed/` |
| GraphQL (0.7) | Code-first; `Money` / `UUID` / `LocalDate` scalars; keyset pagination on the UUIDv7 key; `apps/api/schema.gql` generated as a reviewable artifact. First vertical slice: Accounts, with a backend-computed balance |
| CI (0.9) | `.github/workflows/ci.yml`: install → extensions → generate → migrate → lint → typecheck → test → **evals** → schema-drift check. Deploy to staging is NOT wired (needs the hosting decision, docs/14 Q-7) |
| Web (0.8) | Angular 22, **zoneless** + signals, ADR-006. Responsive shell (bottom nav → sidebar at 1024px), design tokens (`apps/web/src/styles.css`), `fm-money` as the only Money renderer, auth pages, Accounts consuming GraphQL |
| i18n | `core/i18n/`: **English primary**, Serbian latin + cyrillic. Runtime catalogue (no rebuild), `TranslationKey` derived from `en`, `sr-Cyrl` generated at runtime. Language switcher in the shell |
| Tests | **2317 pass** — 896 API + 272 domain + 628 web + 149 nlp + 108 rules-engine + 258 ai + 6 worker (+contracts) |
| Worker | `apps/worker` **boots and is scheduled** (ADR-022, task 3.4.1): five BullMQ jobs over the API's own services — `recurring.materialise`, `recurring.detect`, `insights.generate` (generate *and* evaluate since 3.4.4), `notifications.dispatch`, `files.purge` (4.1.1) — `nx run worker:serve`. The remaining jobs in docs/05 §8's table are unbuilt, and ADR-022 makes stating what makes a job idempotent a precondition for adding one |
| Receipts (F-14) | `apps/api/src/modules/receipts` **implemented in 4.1.3**: `createReceipt`, `extractReceipt`, `addReceiptItem`/`updateReceiptItem`/`removeReceiptItem`, `reconcileReceipt`, `receipts`/`receipt`. Item categories come from the **same** `ClassificationService.parse` a typed fragment uses (auditable in `classification_decisions`); I-6 lives in `@finmate/domain/src/receipts.ts` with both sides of the tolerance asserted. **No OCR provider is configured**, so extraction honestly reports `AI_UNAVAILABLE:no-provider-configured` and manual itemisation is the path, and the detail screen therefore does not offer extraction at all; the **OCR webhook (§9.5)** is not built. `commitReceipt` and `DETACH_TRANSACTION` are (4.1.4a) and both screens that call them are (4.1.4b/4.1.5, `/receipts` + `/receipts/:id`). `CreateReceiptInput.attachmentId` is **required**, so a Receipt exists only over a photo — the library's capture action is the only way in. `receipts` is a plain list with no `filter`/`totalCount`, so the library reads the first 50 and says `{count} shown, newest first` rather than claiming a total |
| Service worker (F-26) | `apps/web/ngsw-config.json` + `@angular/service-worker`, **ADR-024**. It caches the **app shell only** — `/index.html`, `/*.js`, `/*.css`, 39 built URLs in all — and declares **no `dataGroups`**, so no API response can enter the HTTP cache (the offline data cache is IndexedDB, docs/08 §3.9); `navigationUrls` explicitly excludes `/graphql`, `/api/**`, `/auth/**`, `/v1/**` and the health paths, so the shell never answers for the API. Registered in the **production build only** (`enabled: !isDevMode()`), so `web:serve` has no worker and the built `dist` is what gets verified. The update flow is a **non-dismissible banner** that activates only on the user's click. ⚠️ **Not installable yet** — no manifest and no icons (4.3.2, and a manifest carries the undecided product name), and the Playwright offline pass docs/10 §8.3 specifies does not exist, so the cache strategy is verified by inspecting and serving the build rather than by throttling a browser. ⚠️ The deploy path has to serve `ngsw-worker.js`/`ngsw.json` unhashed and revalidated over HTTPS; nothing does yet (docs/11 §5, Q-7) |
| Offline store (F-26) | `apps/web/src/app/core/offline/` — **ADR-025**. `offline-crypto` (AES-GCM-256, `OfflineDecryptError`, PBKDF2 key wrapping), `offline-key-provider` (the `OFFLINE_KEY_PROVIDER` token, **default = `SessionKeyProvider`, `persistent = false`**), `offline-store` (encrypted `idb` over `outbox`/`snapshot`/`taxonomy` + a separate in-memory backing, TTLs 24 h/24 h/30 d, `sweep` on open, `purge`, the snapshot whitelist mapper) and `outbox` (ordered, idempotent flush with a pure retry/refusal classifier). `SnapshotService` (`core/offline/snapshot.service.ts`) is the same store's other consumer, and both go through one root-provided `OfflineStoreHolder`. ⚠️ **nothing confidential reaches disk in this build** by design: without the app lock (4.2.6) there is no wrapping secret, so the store runs in memory and the outbox dies with the page. `idb` + `fake-indexeddb` are the only new dependencies |
| Attachments (F-34) | `apps/api/src/modules/files` **implemented in 4.1.1**: `POST /v1/files/presign`, `GET /v1/files/:id`, `attachment`/`commitAttachment`/`deleteAttachment`, and `files.purge`. Signing is in-repo SigV4 (**no vendor SDK**, ADR-023), storage is an injected seam that is inert without `S3_*`, and `pnpm storage:init` creates the bucket. ⚠️ **No virus scanner**: an accepted upload is `SKIPPED` (*not scanned*), never `CLEAN`; magic-byte sniffing, `Content-Disposition`/`nosniff` and re-encoding are unbuilt (docs/08 §9.4) |
| Not yet built | the remaining background jobs; production build for apps/api (its own decision); a **web app manifest and icons** — so the PWA is still not *installable* even though the worker ships (4.3.2, blocked on the undecided product name, ADR-014); the **app lock** (4.2.6) that turns persistence on; **queued edits and the money-field conflict diff** (4.2.7); the **ledger-rows cache** and the screens it would serve — `/transactions`, analytics' cached period, the assistant (4.2.8); the store's **45-day row window** (the mapper ships, the selection does not); the dashboard's **pending strip** (the query selects no pending count; the queue's own count is the header chip); and the review-queue route for a re-classified offline row (it needs its own `ReviewReason` arm) |
| Known gap → task 2.3.3 | **COMPLETE in 2.3.3a + 2.3.3b.** The content ships from `packages/domain/src/seed/` (**39** category nodes, 131 distinct keywords, **62** merchants) and `/onboarding` seeds it: six steps, resume-at-step, Skip at every one, and a redirect from the dashboard for a Household that has not finished. **What is deliberately NOT in the wizard**, each recorded in docs/02 §4.1: step 1 previews the tree rather than editing it (the shipped `/categories` editor owns that, with I-11/I-12 enforced); step 5 writes a whole-household monthly Budget instead of "monthly income + savings target", because SavingGoal is task 3.3.2 and the budget model is expense-side; step 3 has a category picker the wireframe does not show, without which it could only learn a bill and never a person. Still open and **not** part of F-13: the classifier cannot resolve a *global* seed merchant (`loadContext` filters `merchants WHERE household_id`), which docs/02 §4.1 used to promise for a skipped step 4 — fixing it needs a precedence rule for a Household's copy-on-write duplicate, so onboarding step 4 avoids the question by creating the Household's own rows |
| Known gap → **FIXED in 2.3.3, and it was the cold start itself** | **A keyword at the schema default weight can never decide a category.** docs/04 §5.4 decides from keywords only at a score of **2.0**; `category_keywords.weight` defaults to **1.0**. The shipped tree wrote all 137 keywords at the default, so a Household that completed onboarding step 1 had a full Serbian tree and **`Lidl 2000` still fell through to the AI** — or, with no provider, to the blocking lane. The demo Household hid it completely: its merchants carry `default_category_id`, and a merchant default is a different stage that always decides. Only a fresh signup exposed it. The tree now separates **`strong`** (weight 2.0, decisive alone: `lidl`, `gorivo`, `plata`, `struja`, `penzija`) from **`include`** (weight 1.0, needs corroboration: `market`, `kafa`, `voda`, `rata`) and **`exclude`** (hard-blocks on polarity). `kafa` is the case that shows why the split matters: buying coffee is `Kafa i kolači`, "kafa i mleko" is groceries. Both writers **raise** an existing keyword whose weight is wrong rather than skipping it, so an old Household repairs itself on its next onboarding visit. Asserted in `packages/domain/src/seed/seed.spec.ts` (every category with keywords has a decisive one) and `onboarding.integration.spec.ts` (the exit-criterion inputs decide with zero AI calls). docs/04 §8.1.3 |
| Known gap → Phase 2 | **The fold is internally inconsistent for `đ`/`ђ` (verified).** Latin `đ` folds to `d` (hand-patched in 2.1.1 to fix the NFD gap) but Cyrillic `ђ` folds to `dj` (docs/04 §3.1's table). So `rođa` folds to `roda` while `рођа` folds to `rodja`, and the orthography-correct Cyrillic spelling of the canonical F-11 case resolves on the **trigram rung at 0.61 instead of normalized at 0.98** — a verify-lane match where an exact one was available. The other seven script pairs (`č/č`, `ć/ћ`, `š/ш`, `ž/ж`, `lj/љ`, `nj/њ`, `dž/џ`) are consistent; `đ/ђ` is the only broken one. Fix is one rule in `foldForMatching` (fold the digraph `dj`→`d` after transliteration, which does NOT change §3.1's transliteration table — `ђ`→`dj` stays correct for reading). It needs a re-fold of stored keywords/aliases, so do it before beta when there is no real data |
| Known gap → the rest of Sprint 2.3 | **Phase 2's build is complete: 2.3.1–2.3.5** (corrections + the `/rules` screen; the review queue's API + `/review`; the seed content + the onboarding API + `/onboarding`; rung 5 embeddings, provider-injected, LOCAL-only and **inert** in this build, ADR-021; the evaluation harness). **What is deliberately unbuilt**, recorded in docs/04 §8.1.x, docs/06 §4.2.1/§5.12 and docs/15 rather than repeated here: the review queue's **Lane B** (the advisory band is neither listable nor resolvable, because `reviewQueue` filters `needs_review` and `resolveReviewItem` no-ops when it is false); the queue's `reason`/`confidenceBelow` filters (applied after paging, so a filtered page can be short); `bulkResolveReviewItems`; `ReviewItemKind.RECEIPT_ITEM` and three `ReviewReason` arms (no producer); the `CONFIDENCE`/`AMOUNT` queue sorts (a composite cursor is needed); the rule **backfill**; global keyboard navigation; the `acceptProposal: false` refusal is not persisted; `/rules` cannot edit a rule's conditions; no **Restore** for an undone capture; the undo's `audit_log` entry; `DashboardDelta`; the per-household threshold write. No AI provider is configured, so `AI_CLASSIFIER` is the honest always-unavailable classifier (rules-only, `degraded: true`), and `prompt_template_id` is `null` while `prompt_version` **is** recorded. |
| Known gap → F-09 vs rung 3 (**found by 2.3.1's exit-criterion test**) | **docs/01 F-09's own scenario cannot pass end to end today.** It corrects `Dejan rođa 3600` and expects the *next* input — `Dejan 2000` — to resolve via the rules engine with no AI call. The rule is synthesised correctly, but it cannot fire: **`Dejan` alone does not resolve `Dejan rođa`.** docs/04 §4's rung 3 deliberately requires *every* folded token of the name to occur among the input's tokens, so that an abbreviation cannot auto-apply at 0.90 — the ladder is right and weakening it would trade a missing match for a wrong one. The shorthand starts working via (1) an **alias** on the counterparty, which is what F-13's onboarding step 3 is for and which works today, (2) **rung 5 embeddings** (task 2.3.4 — now implemented and exactly the case it exists for, but **inert** in this build because no embedding model is configured, ADR-021), or (3) a keyword, which the `DISTINCTIVE_TOKEN` trigger already adds when no entity resolves. Recorded in docs/04 §8.1.1 and asserted in `corrections.integration.spec.ts` so it stays a known state rather than a surprise |
| Known gap → Phase 3 recurring | **The recurring API, the `/recurring` screen, subscription detection and both jobs ship.** `recurringRules`, `upcomingRecurring`, the CRUD mutations and `materialiseRecurring` are live (docs/06 §4/§5.8), with the RRULE subset in `@finmate/domain` and materialisation writing through `TransactionsService`. **Both jobs are scheduled since 3.4.1** (`recurring.materialise` hourly, `recurring.detect` daily) and call the same service methods the mutations do. **`committedMinor` is wired since 3.4.2 and the `RECURRING_DUE` producer since 3.4.3**: one `pendingOccurrences` read feeds both a budget's projection and the due alert, so the two cannot disagree about a bill; an unposted EXPENSE occurrence inside the next day becomes an `INFO` insight keyed on the occurrence, mapped to its own default alert rule and deep-linked to `/recurring`. Detection's evidence is the occurrence count and the amount steadiness, which the screen renders from the proposal the API stored. `RecurringRule.version` from docs/06's sketch is **omitted rather than invented** — `recurring_rules` has no version column. |
| Known gap → Phase 3 insights | **The generators are pure and tested; the facts they see are complete enough to project.** `committedMinor` is read from the Household's own recurring rules since 3.4.2 — subtree-scoped, and excluding occurrences that have already been posted (those are `spent`, and counting both would double a bill) — while the Household-level `reserved` figure still belongs to the Household scope. The trend baseline now reads the shared split-aware aggregate (`SpendReadModel.byCategory`, 3.3.1), so a category whose spend arrives as a split is no longer under-counted against it; **`UNUSUAL_SPEND` still reads direct Transaction rows on purpose**, because comparing one purchase against a split's portion would compare two different things. Insight dedupe is **writer-enforced**: the key lives inside `payload` because `insights` has no column for it, so a concurrent double `generate` could duplicate — 3.1.2's notification `dedupe_key` is where a constraint belongs. `narrative` is always `null` — the `NARRATE` seam landed in 3.2.3 but nothing calls it for an Insight yet. `insights.generate` is scheduled daily at 06:00 since 3.4.1, and since 3.4.4 it runs the whole pipeline (`NotificationsService.run`: generate **and** evaluate), so a scheduled pass turns its insights into notifications. The writer now looks a dedupe key up over the periods its own drafts use — a `RECURRING_DUE` row may be filed under next month. The `generateInsights` mutation stays as the manual entry point. |
| Known gap → Phase 3 alerts | **All four channels are wired end to end, server and client.** `dispatchNotifications` sends `IN_APP` (the row is the delivery), `EMAIL` (SMTP → Mailhog in dev, verified live with a lock-screen-safe body), and `PUSH`/`WEB_PUSH` through the `WEB_PUSH` seam (4.2.9, ADR-028): `web-push@3.6.7` + `@types/web-push` behind a token, with an **inert default** when no VAPID pair is configured — so on this deployment the rows still stay `QUEUED`, but for the honest reason the new `AlertDispatchModel.reasons` states, not silently. Payload is `{ notificationId, kind, deepLink }` **plus a `notification` block**, because `ngsw-worker.js` shows nothing without a `notification.title` — ADR-028 decision 4 assumed the client could supply the sentence and cannot, so it carries an amendment and the only text is `APP_NAME` (the brand); `title`/`body` are passed in and never read, so no amount or entity name can reach a lock screen (T-09). A `404`/`410` soft-deletes that subscription and still counts as delivered. **The client half is built too (4.2.5)**: `core/push/` holds a six-state device panel on `/notifications` (`READY`/`SUBSCRIBED`/`BLOCKED`/`IOS_INSTALL`/`SERVER_OFF`/`UNSUPPORTED`), the permission prompt behind a button and never on load, subscribe/unsubscribe, and a re-register on every app start because `pushsubscriptionchange` is unreliable (docs/07 §4.8). ⚠️ On this deployment `pushPublicKey` is null, so the panel renders `SERVER_OFF` — nothing is delivered without a VAPID pair, and the UI says so rather than offering a prompt it cannot honour. `notifications.dispatch` is scheduled every minute and `insights.generate` daily since 3.4.1, both calling the same service methods the mutations do; since 3.4.4 the daily job evaluates as well as generates, so a scheduled insight becomes a notification without a mutation. `runAlerts` stays the manual trigger for the same `run` method. `updateNotificationPreferences` is built and stores in `households.settings.notifications`, but the settings screen is 3.1.4. `AlertRule.version` is declared in the GraphQL SDL but in neither docs/03 §4 nor the table, so it is omitted rather than invented. Notification copy is English-only and server-rendered — the API has no i18n catalogue — a DoD breach recorded in docs/06 §5.14; `locale` is stored and unhonoured. The brand string now lives in **two** places (the web's `app.name` i18n key and the new API `APP_NAME`) until a shared constant lands. `notificationReceived` is not built (no pub/sub transport; the badge polls). `RECURRING_DUE` gained a producer and a default rule in 3.4.3 — an `INFO` insight one day ahead, keyed on the occurrence; `BUDGET_THRESHOLD` and `GOAL_REACHED` still have no producer. |
| Known gap → Phase 3 goals | **The goals API and the `/goals` screen ship.** `savingGoals`/`savingGoal` and the five mutations are live (docs/06 §4/§5.7), with progress, the required monthly amount, contributions and status all computed by `@finmate/domain`. **`createTransaction` on `contributeToGoal` is deliberately not built** — a contribution is not a Transaction (docs/02 §4.13) and recording the outflow needs an Account transfer, which the ledger can express (`transfer_peer_id`) and no feature builds. Also not built: `Dashboard.goals` (docs/06 §4.1's `# CP` field), the `GOAL_REACHED` insight producer (still listed as uninstrumented), and the assistant's `GOAL_PROGRESS` / `GOAL_REQUIRED_MONTHLY` templates — the planner refuses a `goalId` slot it cannot resolve, and `GoalsService` is exported for the task that wires them. `SavingGoal.version` from docs/06's sketch is **omitted rather than invented**: `saving_goals` has no version column, and optimistic concurrency for one model is a migration nobody asked for. |
| Known gap → Phase 3 UI (analytics) | **`/analytics` has not been looked at by a human at any width** — the standing gap since `/review` (docs/02 §9), now with a second screen. Recorded differences from docs/02 §4.15: the header is a heading with a subtitle rather than a toolbar; **CSV is the month's transactions** (`/api/export/transactions.csv` with the chart's own range) rather than a per-section export, because an analytics-specific format is an unmade product decision; the uncategorised row has **no drill-through** (`transactions(...)` has no "category is null" filter, so a link would open rows the figure did not come from); and `cashflow` (docs/06 §4.3) is **not fetched** — F-20 asks for category trends, month-over-month and top merchants — so the API exposes a figure no screen yet renders. |
| Known gap → Phase 3 UI (assistant) | **`/assistant` has not been looked at by a human at any width** — the standing gap for every screen since `/review` (docs/02 §9). It also differs from §4.16's wireframe in three recorded ways: **six** canonical suggestions rather than "three closest" (no similarity ranking exists), a question composer rather than the shared `CaptureField` of §3/DP-1 (that component is built nowhere, and a question is not a transaction fragment), and an F-30 proposal table that **ships without its *Primeni* button** (it labels itself *Predlog (izračunato)* and says no budget has been changed). The transcript is client-side for the visit because there is no `conversationId`, and `narrationMode`/`reason` are deliberately not rendered so a template answer does not look degraded. |
| Known gap → Phase 3 UI (notifications) | **`/notifications` has not been looked at by a human at any width** either. The alert preferences live on that screen rather than in a settings shell, because no `/settings` route exists yet; docs/02 §4.18's information architecture is the target once it does. Push channels are listed, and the device panel beneath them derives its sentence from `pushPublicKey` and the browser's own state (4.2.5) rather than a static string. The screen has no pagination control: it reads the first 50 rows, which is more than the daily cap can produce in a day. |
| Known gap → Phase 3 assistant | **The assistant answers; it just does not narrate with a model in this build, because no provider is configured at all.** `assistantAnswer` is live (docs/06 §4.4, §8.7): planner → fact assembly → `NARRATE` → numeric validator → answer, with `TEMPLATE_FALLBACK` whenever a numeral is unaccounted for or no provider is reachable, and a **refusal** (`answered: false`, no figure, the narrator never called) for anything the template set cannot answer. `NARRATOR` resolves to `UNCONFIGURED_NARRATOR` exactly as `AI_CLASSIFIER` resolves to its unconfigured twin, so every answer in this build is the deterministic template rendering and `reason` says `AI_UNAVAILABLE:no-provider-configured`; `RoutedNarrator`, `narratePrompt` and the strict retry are built and tested against a scripted narrator. **Deliberately not built**: `conversationId` (no conversation store — an accepted-but-ignored parameter is a contract the API cannot keep); narration **cost persistence** (docs/05 §3's assistant row said it "writes `classification_decisions` for cost" and **was wrong — corrected**: a narration is not a classification decision and `decided_by` has no value meaning "narration", so a row there would corrupt every accuracy metric built on that table); a drill-through for merchant- or tag-scoped answers (`transactions(...)` takes no `merchantId`/`tagId`, so a link would show rows the answer did not come from — `drillThrough: null` instead); `/transactions` **now** reads the six drill-through arguments out of the URL before its first query (3.2.4), so a link lands filtered — and the screen never writes its own filters back to the URL, so a manually filtered list is still lost on reload; the fallback copy is **English** (`narration-template.ts` + `renderRefusal` — the second instance of §5.14's no-catalogue breach: the money is in the household locale and its own names are untranslated, the connectives are not); the planner matches at most **200** Merchants/Accounts per question. `pnpm test:evals`'s two narration gates are still `skipped`, with a corrected reason (no provider, and the dataset holds classification cases rather than questions), and **narration is therefore never evaluated** — the validator's guarantee is asserted over the fallback for all 29 intents and over scripted model output, not measured on a live model. Goal and recurring slots are still unresolvable (`GOAL_*` → `UNRUNNABLE:goalId`, `RECURRING_*` → `NOT_BUILT:recurring`) and `COMPARE_PERIODS` → `NEEDS_TWO_PERIODS`. **F-30 computes but does not apply**: `SAVINGS_PROPOSAL` returns a plan (target, a reduction per Category, the shortfall) and docs/02 §4.16's *Primeni* button is not built, because a Budget is a limit and "apply" would have to decide whether it may raise a Budget the Household set lower, and whether the write is one mutation or the client's existing `upsertBudget` per line — the screen says *a suggestion only — no budget has been changed* instead of guessing (docs/06 §8.8). Its cut rule is uniform (20 % of each Category, biggest first) because nothing marks a Category as discretionary, so it will propose cutting rent; the wireframe implies a notion of essential spending the schema does not have. **No test validates a client query against `apps/api/schema.gql`** — 3.2.4 shipped `money { amountMinor }` (a selection set on a **scalar**), which failed every answer with a 400 while typecheck, lint, `web:build` and the mounted spec (which mocks `GraphqlClient`) all passed; the guard is a test that parses each feature's query strings against the generated schema. Fact assembly and the analytics queries now share one split-aware aggregate (`SpendReadModel`, 3.3.1), so the assistant, the chart and the budget tile cannot disagree; `BudgetsService.spendIn` is the remaining separate implementation and the analytics integration spec asserts the three agree on a split-containing month (the insight **trend** baseline was reconciled in 3.3.1 too — `UNUSUAL_SPEND` still reads direct rows on purpose, because a split's portion is not a purchase). One planner defect 3.2.3 found and fixed: a Household's own Merchant now wins over the global seed row of the same name (`NamedEntity.owned`) — before it, `koliko sam potrošio u lidlu` answered `0,00 RSD` from a seed row no Transaction points at. |
| Known gap → unscheduled | **The documented pre-commit layer does not exist.** docs/10 §1 layer 0 lists `lint-staged` + prettier + `gitleaks`; there is no `.husky`, no `lint-staged` config and no hook, and `format:check` fails on 119 files repo-wide (including `pnpm-lock.yaml`). It is not in CI, so nothing is gated on formatting |
| Phase 2 progress | **2.1.1–2.1.4 done** — `packages/nlp` (transliteration, `foldForMatching`, segmentation, `TransactionFragment` extraction), the 300-case golden dataset v1, `packages/rules-engine` (§5.3 conflict resolution, §5.4 keyword scoring, no I/O), and the pure entity-resolution ladder (exact 1.00 → normalized 0.98 → prefix 0.90 → trigram 0.55–0.85, trigram injected) in `packages/nlp/src/resolve.ts`. **2.2.1–2.2.5 done** — `packages/ai` (OpenAI-compatible adapters, fail-closed residency routing, circuit breaker, redaction, telemetry; **no vendor SDK**), structured-output validation + isotonic calibration, the `classification` module (pipeline, audit row, §7/I-8 gate), `captureCommit` + the `/capture` screen, duplicate-suspect detection + undo. **2.3.1–2.3.5 done** — see the row above. **2.3.5 measured**: rule-hit 73.8 % (bar 50 %), overconfident-wrong 0.28 % (bar 1.5 %), top-1 100 %, should-ask recall 98.8 %, extraction 100 %, p95 39 ms; its first run found and fixed a reversal auto-categorised as an expense (a new **direction gate**) and a seed keyword that contradicted a merchant default. Nine knowledge gaps remain and are recorded, not hidden (docs/10 §5.9, docs/04 §8.1.5). |
| Web screens | **the dashboard in offline mode** (F-19/F-21, 4.2.4 — the last successful read is served from the snapshot with one `podaci od <time>` line covering every figure, the server's own numbers verbatim, and the honest error state when there is no snapshot; nothing is recomputed client-side, ADR-027), **`/pending`** (F-26, 4.2.3 — the pending-sync tray: the queue with raw input, local time, attempts and the last error in words, retry/discard per row, retry-all, export-as-text, and the *Pregledaj razlike* diff; a header chip rather than a nav destination, ADR-026), **`/receipts`** and **`/receipts/:id`** (F-14/F-34, 4.1.4b/4.1.5 — the library with its one capture action, then the mismatch banner, the item table with its category pickers, `Uskladi ručno`, `Prihvati`, *Napravi transakciju* behind I-6 and every line's Category, `Otkači`, and a link to the created row through `/transactions/:id`; a real rendered defect was found here — a `[value]` binding on a `<select>` ran before its `@for` options existed, so every saved category showed as "no category", fixed by binding `[selected]` on the option), the **`/transactions/:id` drill-in** docs/02 §2.1 lists, **the Transaction sheet carries the Receipt photo** (F-34, 4.1.2 — camera or file, presigned upload, attach/remove; it says plainly that an upload is *not virus-scanned*, and it has not had a human pass at any width either), **`/recurring`** (F-16 — the rule list with its schedule in words, the frequency picker, activate/deactivate and auto-confirm, the next-30-days line, the raw RRULE behind a disclosure, and the detected-subscription proposals with their evidence), **`/goals`** (F-18 — the card list with progress, the monthly amount the backend derives, contributions with their history, inline target/deadline edit, archive/restore), **`/analytics`** (F-20 — the trend, the category bars with share and change, the accessible table behind every chart, the top merchants, the month-over-month comparison, `[`/`]` and a CSV of the month; one query per period), **`/assistant`** (F-23 — the composer, the transcript, the answer card with its figures, the expandable provenance line and the drill-through link; the starter chips come from `assistantSuggestions`), **`/notifications`** (F-22 — the notification centre and the alert preferences, with the unread bell in the nav), **`/onboarding`** (F-13 — the six-step wizard, nav hidden while it runs), `/` dashboard, **`/capture`** (F-05/F-06 — the signature interaction), `/transactions` (filter + edit + **correction with "Zapamti za ubuduće"** + CSV export), **`/review`** (F-08 — the blocking lane, keyboard-driven), `/budgets`, `/categories`, `/merchants`, `/counterparties`, `/tags`, **`/rules`** (F-09 — grouped by what needs attention), `/accounts`, sign-in/up |
| Shell header | **New in 3.1.4's follow-up.** docs/02 §2.2 draws a header carrying 🔔 unread, ⚙ and the account menu on both layouts; the shell had none, so the bell was first wedged above the nav list, which read as an accident. The header now holds the bell (with its unread badge), the language switcher and Sign out, and the old bottom `.session` row is gone. Below it, inside the content region, sits the **app-update line** (ADR-024): a non-dismissible *"A newer version of the app is ready."* with a *Reload* action, plus a second sentence when the worker reports an unrecoverable cache. The header also carries the **offline chip** — `podaci od <time>` (the stale half, 4.2.4) and `Čeka slanje (n)` → `/pending` (the pending half, 4.2.3) — rendered only when there is something to say, so the state is visible at every size class without a second badged nav slot (ADR-026/ADR-027). **Not built**: the ⚙ settings entry and avatar menu (there is no `/settings` route yet) — docs/02 §2 says a household switcher is *disabled with a tooltip* rather than a broken control, and the same rule applies here |
| Navigation | **Hidden entirely on `/onboarding`**, because docs/02 §4.1 draws the wizard full-screen and a list of ten destinations beside "pick your starting categories" invites the user to leave the flow that decides whether the product is useful (every step still has Skip). Otherwise docs/02 §2.2's five slots: **dashboard · transactions · capture · review** plus **More** (≥1024 px the sidebar lists all **16** in one list, so it is never a reduced view; the last is `/receipts`, which closes **Biblioteka** — Kategorije, Prodavci, Osobe, Pravila, Prijemi; `/goals` and `/recurring` follow `/budgets` in docs/02 §2.2's **Plan** group, then `/analytics` and `/assistant` in **Uvid**, in the document's own order). The review slot is the only badged one (`nav.review`), and Budgets/Accounts moved behind More in 2.3.2b — a fifth link plus More was six flex items in a 320 px bar. Destinations and that split live in `core/navigation.ts` with their own spec, not in the component |

```bash
pnpm dev:infra            # start Postgres/Redis/MinIO/Mailhog
pnpm db:migrate           # apply migrations
pnpm db:seed              # seed global merchants (add SEED_HOUSEHOLD_ID for a full household)
pnpm storage:init         # create the attachments bucket in MinIO (ADR-018, task 4.1.1)
nx run api:serve          # API on :3001 (pinned; see the port note below)
nx run web:serve          # SPA on :4200, proxying /api and /graphql to the API
pnpm lint / typecheck / test
nx run web:build          # production bundle
```

**The browser talks to `/api/*`; the dev proxy strips the prefix** before forwarding, because the
API serves `/auth/*` and `/graphql` without one (docs/06). Changing the prefix on one side only
produces a 404 that looks like an auth failure.
Verified working: lint 9/9, typecheck 9/9, 2317 tests, `pnpm test:evals` gating green, `web:build`, GraphQL over HTTP through the
browser origin, the full signup → cookie → `/auth/me` → GraphQL flow, the presign → PUT to MinIO →
`commitAttachment` → `302` download round trip (verified live, bytes compared), and `prisma migrate diff`
reporting no drift.

---

## Read the docs before you code

`docs/` is the **specification and it is canonical**. Do not restate it in code comments — link to it.
Read the document that owns your task before starting:

| If you are… | Read first |
|---|---|
| starting any task | `docs/05-architecture.md` §2 — monorepo layout + the dependency rule |
| **debugging something that should work** | **[`docs/15-implementation-gotchas.md`](docs/15-implementation-gotchas.md)** — 111 entries, each saying what the failure looks like |
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
pnpm test:evals     # the Phase 2 evaluation gates (docs/10 §5) — needs the dev database
pnpm lint           # includes the dependency-boundary rule
pnpm typecheck
pnpm db:migrate     # forward-only, expand/contract
pnpm db:pull        # re-derive schema.prisma after a migration
pnpm db:seed        # starter categories, keywords and merchants
nx run api:serve    # API on :3001 — pinned to match the web dev proxy
nx run web:serve    # SPA on :4200
nx run web:build    # production bundle
```

Not yet implemented: a production `build` for **apps/api** — deferred past Phase 0, because bundling
source-consumed workspace packages is its own decision. `web:build` does work. Do not reference build
scripts the repo does not have. Also not built: the **nightly** evaluation runner (`evals.nightly`, live
providers, the full 1 300-case set, the `evals` schema and 60-run trends, docs/10 §5.7) — `pnpm test:evals`
is the deterministic Phase 2 gate, not that.

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

## Gotchas

**The full list — 111 entries in 10 groups, each written to say what it looks like when it goes wrong —
is [`docs/15-implementation-gotchas.md`](docs/15-implementation-gotchas.md). Read it before debugging
anything that "should work".** It was split out because this file had grown past the instruction budget
and was being truncated on load. The ones below stay here because they are the ones that bite hardest,
or that are cheapest to get wrong before you have read anything else.

- **The dev API is pinned to `:3001` and the web proxy targets `:3001`, while `.env` says `3000`.** Change
  one and you must change the other, or every request through the SPA fails as a proxy error and the
  sign-in page reports "something went wrong". `nx run api:serve` pins it; plain `node` honours `.env`.
- **Never put a backtick inside a `template:` or `styles:` literal — not even in a comment — and never
  put a glob like the source-tree pattern inside a block comment**, because `*/` ends the comment. Both
  fail as a bare parse error or a template error that names the wrong problem.
- **The API dev runtime is SWC, not `tsx`.** esbuild cannot emit decorator metadata, so NestJS DI breaks
  silently under `tsx`. `tsx` is fine for plain scripts, not for the API.
- **Prisma 7 moved things:** the URL lives in `prisma.config.ts` and reaches the client through
  `@prisma/adapter-pg`; **never run `prisma migrate dev`** (it drops the CHECK constraints and partial
  indexes doc 03 depends on); `findUnique` is refused on scoped models — use `findFirst`; a direct
  `transactions.create` must pass `source`.
- **`merchants` are globally readable but strictly writable.** Reads get the guard's global `OR`, writes
  keep the strict predicate. `merchant_aliases` and `transaction_tags` have no `household_id` and can only
  be reached through their parent.
- **Merchants are copy-on-write, and that includes a merge target — and you cannot copy a global one by
  creating it.** `create`'s duplicate-name check sees global rows and refuses `Lidl`; `update` is what
  clones it and brings the aliases.
- **A keyword at the schema default weight (1.0) can never decide a category: docs/04 §5.4 decides at
  2.0.** The shipped tree wrote all 137 at the default and categorised nothing. **Test the cold start on a
  fresh signup, never on seeded data** — a merchant default always decides and hides this.
- **Never normalise a keyword or alias locally.** Go through `common/text/normalise` /
  `foldForMatching`; `packages/rules-engine` cannot import `@finmate/nlp`, so the fold is injected and a
  second copy is how a keyword silently stops matching.
- **Never use the outer Prisma client inside an interactive `$transaction`** — it stalls on the pool and
  surfaces as an opaque INTERNAL. And `runWithTenant` chains a returned thenable on purpose: a Prisma
  query is lazy, so a bare `runWithTenant(ctx, () => prisma.x.findMany())` used to lose the context.
- **`nx run web:typecheck` does NOT check templates; `nx run web:build` does.** A dynamic `t()` key or a
  required `input()` read passes typecheck and fails the build.
- **On the capture path: `clientRowId`/`idempotencyKey` are minted once and never regenerated; the preview
  sends `categoryId` only when it differs; `captureCommit` rejects the whole batch and collects every
  offending row first; and an absent GraphQL field is not the same as an explicit `null`.**
- **Postgres sorts NULLs FIRST in a `DESC` order**, so `orderBy: { nullable_column: 'desc' }` is the
  opposite of "non-null first" — use `{ sort: 'desc', nulls: 'last' }`.
- **No hardcoded user-facing copy, and `fm-money` is the only thing that formats money.** (It still
  hardcodes the Serbian words for income/expense in its accessible label — a known, unfixed DoD breach.)

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
