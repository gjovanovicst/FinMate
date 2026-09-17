# AGENTS.md — FinMate

> **The name is `FinMate` — decided by the product owner on 2026-09-17** (ADR-014's amendment), which
> unblocked 4.3.2. Docs/13 recommended `Ostava` and rejects this name; **no
> trademark/domain/app-store check was run**, and that gap is **R-28** — close it before launch, not
> after. **Never hardcode a brand string**: read `APP_NAME` from config, so a rename stays one commit
> plus a manifest.

AI-first household budgeting app for **mobile and desktop**. The product promise, in one line:

> Type **`Lidl 2000`** and get a correctly categorised, budget-aware transaction in under five seconds.

**Machine state:** Node 24.20.0, pnpm 11.7.0, Go 1.27.0, **Docker 29.7.2 + Compose v5.5.0 (Linux
containers)** on Ubuntu 20.04 LTS / WSL2.

**Build state — Phase 0 COMPLETE · Phase 1 (manual core) COMPLETE apart from the visual pass · Phase 2
(AI input) COMPLETE · Phase 3 (intelligence) COMPLETE · Phase 4 (receipts & mobile) IN PROGRESS: 4.1
receipts COMPLETE, **4.2 offline & sync COMPLETE** (4.2.1–4.2.9).**

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
  the payload needed to make a background push visible at all (4.2.5); and the app lock's core — the
  WebAuthn-PRF and PIN secrets, the wrapped-key lifecycle, the state that turns persistence on, the
  cross-tab flush mutex ADR-026 deferred here, and the wipe — **ADR-029** (4.2.6a); and the control that
  arms it — `/settings`' one section, the re-auth screen the shell renders while locked, and the idle
  gate — which is what turns offline persistence on for F-26 (4.2.6b). ⚠️ **R-23 was closed on a claim 4.3.6 measured false**: arming the lock did not make the queue durable,
  and both halves are fixed in 4.3.6a (ADR-025's amendment). An **offline** reload separately cannot
  restore the session, so the re-auth screen unlocks into `/sign-in` and queued work is unreachable —
  **R-27(b)**, closed by 4.3.6c ([ADR-033](docs/14-decisions-and-risks.md));
  and queued **edits**, version-checked and dispatched by entry kind, with a conflict diff that shows
  the two versions instead of inventing a reason — **ADR-030** (4.2.7a/4.2.7b); and the **ledger-rows**
  record plus **the screens that serve it** (4.2.8a/4.2.8b) — the current period plus 45 days, capped at
  200 rows, cached after a successful **unfiltered** read and served labelled and read-only when the read
  fails, claiming nothing the whitelist does not hold — **ADR-027's 4.2.8b amendment**; and **ADR-031**, which repaired AI residency: an `*_EU` endpoint must
  be configured with the EEA host it means (there is no default — the default *was* a non-EEA host),
  DeepSeek's own platform is named `DEEPSEEK_GLOBAL` and reaches a Household only with recorded
  consent, and `DEFAULT_ROUTING` is `LOCAL`-only. **And then ADR-032 built both halves**: the AI
  composition root (`apps/api/src/modules/ai`) turns validated config into one adapter per usable
  endpoint and provides `AI_CLASSIFIER`/`NARRATOR`/`OCR`/`EMBEDDINGS`, staying inert when nothing is
  configured; consent is a per-Household record in the shipped `consents` table, exposed as
  `aiConsents` + `recordAiConsent` (OWNER-only, append-only), and the router **asks it on every call**
  through an injected gate that a non-EEA route cannot be constructed without. Verified live with the
  stored DeepSeek key: rules-only before the grant, `decidedBy: AI` (provider `DEEPSEEK`, model
  `deepseek-flash`, latency and `cost_micros` in `classification_decisions`) after it, refused again the
  moment it was withdrawn — and `Lidl 2000` still resolves by keyword. Wiring the first real provider
  also found **two prompt defects no test could see** (a twice-rendered category list, and a
  `json_object` prompt that never named the fields); both are fixed with regression tests at the
  composed seam.
- **And then 5.2a closed R-25**: the **first-use consent sheet**, opened by `/capture` when a preview comes
  back `degraded` — the moment docs/08 §6.6 asks for. The sheet and `/settings`' card are **one component**
  (`ui-consent-purpose`), so the provider/region/never-sent/trade disclosure cannot drift between the two
  screens; the sheet adds only the reason and three verbs (Allow, a first-class Decline, and *Not now*,
  which defers without writing because `NOT_ASKED` is the *absence* of a row). The pass found **R-26** and
  the 48 px shell overflow, both **fixed in 4.3.1a**.
- **And 4.3.5 closed R-26**: a cookie path is what the *browser* checks. The refresh cookie was scoped to
  `/auth` while the browser asks for `/api/auth/refresh`, so **every hard reload signed the user out**; it
  now follows `PUBLIC_API_PREFIX`. **Live 9/9.**
- **4.3.1d measured every screen instead of assuming, and it paid twice.** A browser instrument walked all
  20 routes at 320/768/1280 px **and in the light theme**, capturing a contact sheet for the human pass
  (`.artifacts/visual-audit/`); it found a systemic contrast defect (`--color-text-subtle` at
  **3.31:1** over **153 element-route pairs**, plus three uncoloured anchors at **2.02:1**), fixed at the
  class level. **0 contrast failures and 0 overflow** remain (two inactive controls are **exempt**, WCAG
  1.4.3), and it measured the tap-target gap — **corrected and closed by 4.3.1e below**, which found 0
  failures of SC 2.5.8 and a floor mistakenly gated on the pointer (docs/15).
- **4.3.6's offline pass found F-26's exit criterion failing; R-27 is now closed in full.** Against the
  **production build** with the network cut, **(a1)** the store backing could not follow the lock
  (`OfflineStoreHolder` had no `invalidate()`) — fixed with a `durability` signal the holder watches and a
  `generation` signal `SyncService` reacts to, ADR-025's amendment; **(a2)** offline the composer sent
  `defaultAccountId: null` because its `accounts` query failed, so the server refused the batch — it now
  reads ADR-025 decision 5's taxonomy cache. **Live 8/8.** **(b, [ADR-033](docs/14-decisions-and-risks.md))** an unlocked install whose
  session could not be restored because *nothing answered* renders a **read-only offline shell** — one
  sentence, two links (`/pending`, `/transactions`' cached ledger), no navigation, and **nothing sent
  without a session** — **live 13/13**. It also **refuted its own first reading**: the flush *is* refused.
- **And 4.3.7 closed the AI-disclosure audit** ([ADR-034](docs/14-decisions-and-risks.md)): the consent
  sheet names what a *caller* can reach, one sentence per destination; `/assistant` says how each answer was
  worded, linking `/settings` only when withheld consent caused the fallback — docs/06 §8.5's *"make the
  fallback invisible"* is amended, not ignored. **Both live.**
- **4.3.4 put the bundle budgets in CI and measured accessibility with axe.** **4.3.4a**: `pnpm
  bundle:budget` measures each route's **cold cost** against docs/07 §11 — warn 90 %, fail 100 %, and a
  route with no entry fails (so the 18 routes §11 does not name are held to 320 KB). **4.3.4b**: axe over all 20 routes found **20 serious contrast violations — the active
  nav item, 3.85:1**, which 4.3.1d's instrument missed; fixed with `--color-primary-text` (**0 critical /
  0 serious**), with 21 moderate nested-`<main>` findings named as their own task.
  **Lighthouse could not run** (a sandboxed launcher temp dir) → deferred CI job.
- **4.3.2 made the app installable and built the funnel that offers it.** **(a)** A manifest, four generated
  icons (`pnpm icons:generate`, a dependency-free PNG encoder; maskable in Android's safe zone,
  `apple-touch-icon` for iOS) and both in the worker's asset group — **asked Chrome**:
  `Page.getInstallabilityErrors` returns **none**, and each icon's PNG header was decoded. **(b, docs/07
  §4.7)** `core/install/` + `ui-install-sheet`: the sheet opens on the **2nd** capture that actually landed
  (never in onboarding, never standalone, once, and again only after a dismissal's 30 days), Chromium gets
  a real button that calls `beforeinstallprompt`, iOS gets the Share steps and **no**
  button it could not honour, and the two events §4.7 asks for are recorded on-device — **their sink does
  not exist** (docs/05 §10's web hooks are unwired), recorded as this task's residual. It reuses
  `core/push`'s `isIos`/`isStandalone`. **Live 25/25**, axe 0 on the sheet. ⚠️ The brand now lives in
  static assets too, so a rename is a search over five places.
- **4.3.1e met the house touch-target rule, and corrected the finding it came from.** With SC 2.5.8's own
  exceptions implemented (inline, spacing), "17 controls under 24 px" is **0 failures** — most were hidden
  native inputs whose **label** is the target. The real gap was the floor: it had been gated on
  `(pointer: coarse)` since 0.8, so a phone passed and a 320 px desktop window did not, and every audit had
  measured a *fine* pointer (docs/15). One token (`--control-size`) plus three rules and four
  scoped overrides. **After: 0 below the floor** in 4 contexts × 2 households (3,880 pairs), 0 overflow,
  axe 0/0. The rhythm call goes to the human pass.
- **5.8 closed the last broken user flow: the emailed links land on screens.** `/reset-password` (no token
  ⇒ ask for the address; `?token=…` ⇒ ask for the new one) and `/verify-email?token=…`, at the paths the
  mails already carried and **unguarded** — the reverse guard would bounce the signed-in person who clicks
  an email. The four auth screens now share one style block and one password constant. **Live 17/17**
  with Mailhog, including the link working while signed in and the demo password restored.
  ⚠️ Named, not closed: `email_verified_at` is **read by nothing**, and there is **no re-send** (docs/09).
- **Next**: the **human visual pass** (the new control rhythm, 4.3.1c's pinned capture bar, the nested-`<main>`
  landmarks, and whether the install sheet should be a bottom sheet rather than a panel), then 4.3.3 and
  4.3.4b's Lighthouse job.

**The long form is in the docs.** Each task's decisions, deviations and live defects are recorded where
they belong: docs/09 §6 (sequencing), docs/02's per-screen notes, docs/06 §5, docs/14 (ADRs and risks) and
docs/15 (gotchas).

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
| Responsive pass (1.3.5) | **Measured clean, not yet looked at.** 4.3.1a audited **all 18 authenticated routes at 320/768/1280 px: zero horizontal overflow** (50/50 pairs). It had been **48 px on every one of them at 320 px**, from a single missing declaration — the shell's grid had no `grid-template-columns`, so its implicit `auto` track took the bottom nav's 368 px min-content (`min-inline-size: 0` removes a flex item's automatic minimum, not its min-content *contribution*); `minmax(0, 1fr)` plus `flex-wrap` on the header's action row fixed it, and the header gained the top safe-area inset while two `100vh` became `dvh` (docs/02 §9, docs/07 §4.3). **What remains is the judgement a measurement cannot make**: whether a screen *looks* right. **Still needs a human at 320/768/1280 px** |

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
| CI (0.9) | `.github/workflows/ci.yml`: install → extensions → generate → migrate → **seed** → lint → typecheck → test → **bundle budgets** → **evals** → schema-drift check. Deploy to staging is NOT wired (needs the hosting decision, docs/14 Q-7) |
| Web (0.8) | Angular 22, **zoneless** + signals, ADR-006. Responsive shell (bottom nav → sidebar at 1024px), design tokens (`apps/web/src/styles.css`), `fm-money` as the only Money renderer, auth pages, Accounts consuming GraphQL |
| i18n | `core/i18n/`: **English primary**, Serbian latin + cyrillic. Runtime catalogue (no rebuild), `TranslationKey` derived from `en`, `sr-Cyrl` generated at runtime. Language switcher in the shell |
| Tests | **2635 pass** — 955 API + 275 ai + 272 domain + **870** web + 149 nlp + 108 rules-engine + 6 worker (plus `contracts`, which ships no specs and passes with none) |
| Worker | `apps/worker` **boots and is scheduled** (ADR-022, task 3.4.1): five BullMQ jobs over the API's own services — `recurring.materialise`, `recurring.detect`, `insights.generate` (generate *and* evaluate since 3.4.4), `notifications.dispatch`, `files.purge` (4.1.1) — `nx run worker:serve`. The remaining jobs in docs/05 §8's table are unbuilt, and ADR-022 makes stating what makes a job idempotent a precondition for adding one |
| Receipts (F-14) | `apps/api/src/modules/receipts` **implemented in 4.1.3**: `createReceipt`, `extractReceipt`, `addReceiptItem`/`updateReceiptItem`/`removeReceiptItem`, `reconcileReceipt`, `receipts`/`receipt`. Item categories come from the **same** `ClassificationService.parse` a typed fragment uses (auditable in `classification_decisions`); I-6 lives in `@finmate/domain/src/receipts.ts` with both sides of the tolerance asserted. **No `OCR` endpoint is routed** (ADR-032 decision 3 leaves `EMBEDDINGS` inert and routes only the endpoints the config names), so extraction honestly reports `AI_UNAVAILABLE:no-provider-configured` and manual itemisation is the path, and the detail screen therefore does not offer extraction at all; the **OCR webhook (§9.5)** is not built. `commitReceipt` and `DETACH_TRANSACTION` are (4.1.4a) and both screens that call them are (4.1.4b/4.1.5, `/receipts` + `/receipts/:id`). `CreateReceiptInput.attachmentId` is **required**, so a Receipt exists only over a photo — the library's capture action is the only way in. `receipts` is a plain list with no `filter`/`totalCount`, so the library reads the first 50 and says `{count} shown, newest first` rather than claiming a total |
| Service worker (F-26) | `apps/web/ngsw-config.json` + `@angular/service-worker`, **ADR-024**. It caches the **app shell only** — `/index.html`, `/*.js`, `/*.css`, 39 built URLs in all — and declares **no `dataGroups`**, so no API response can enter the HTTP cache (the offline data cache is IndexedDB, docs/08 §3.9); `navigationUrls` explicitly excludes `/graphql`, `/api/**`, `/auth/**`, `/v1/**` and the health paths, so the shell never answers for the API. Registered in the **production build only** (`enabled: !isDevMode()`), so `web:serve` has no worker and the built `dist` is what gets verified. The update flow is a **non-dismissible banner** that activates only on the user's click. **Installable, with the docs/07 §4.7 funnel, since 4.3.2** (manifest, icons, sheet — Chrome-verified); the Playwright pass docs/10 §8.3 specifies does not exist, so the cache strategy is verified by serving the build. ⚠️ The deploy path must serve `ngsw-worker.js`/`ngsw.json` unhashed and revalidated (docs/11 §5, Q-7) |
| Offline store (F-26) | `apps/web/src/app/core/offline/` — **ADR-025**. `offline-crypto` (AES-GCM-256, `OfflineDecryptError`, PBKDF2 key wrapping), `offline-key-provider` (the `OFFLINE_KEY_PROVIDER` token now resolves to the **app lock**, which reports `persistent = true` only while it is unlocked and delegates to `SessionKeyProvider` when no lock is configured), `offline-store` (encrypted `idb` over `outbox`/`snapshot`/`taxonomy` + a separate in-memory backing, TTLs 24 h/24 h/30 d, `sweep` on open, `purge`, the snapshot whitelist mapper) and `outbox` (ordered, idempotent flush with a pure retry/refusal classifier). `SnapshotService` (`core/offline/snapshot.service.ts`) is the same store's other consumer, and both go through one root-provided `OfflineStoreHolder`. ⚠️ **nothing confidential reaches disk until the app lock is armed** (ADR-025 decision 3): with no wrapping secret the store runs in memory and the outbox dies with the page. Arming it — `/settings` → `Bezbednost`, WebAuthn PRF or a PIN (ADR-029) — is *meant* to switch the backing to IndexedDB and make F-26's offline capture survive a reload (4.2.6b); and since 4.3.6a it really does — the provider announces a change and the holder and the queue react (ADR-025's amendment, R-27(a)). `idb` + `fake-indexeddb` are the only new dependencies. Since 4.3.6b the composer writes and reads the `taxonomy` record (categories + accounts), so an offline capture carries an account instead of being refused |
| Attachments (F-34) | `apps/api/src/modules/files` **implemented in 4.1.1**: `POST /v1/files/presign`, `GET /v1/files/:id`, `attachment`/`commitAttachment`/`deleteAttachment`, and `files.purge`. Signing is in-repo SigV4 (**no vendor SDK**, ADR-023), storage is an injected seam that is inert without `S3_*`, and `pnpm storage:init` creates the bucket. ⚠️ **No virus scanner**: an accepted upload is `SKIPPED` (*not scanned*), never `CLEAN`; magic-byte sniffing, `Content-Disposition`/`nosniff` and re-encoding are unbuilt (docs/08 §9.4) |
| Not yet built | the remaining background jobs; production build for apps/api (its own decision); the dashboard's **pending strip** (the query selects no pending count; the queue's own count is the header chip); and the review-queue route for a re-classified offline row (it needs its own `ReviewReason` arm) |
| Known gap → task 2.3.3 | **COMPLETE in 2.3.3a + 2.3.3b.** The content ships from `packages/domain/src/seed/` (**39** category nodes, 131 distinct keywords, **62** merchants) and `/onboarding` seeds it: six steps, resume-at-step, Skip at every one, and a redirect from the dashboard for a Household that has not finished. **What is deliberately NOT in the wizard**, each recorded in docs/02 §4.1: step 1 previews the tree rather than editing it (the shipped `/categories` editor owns that, with I-11/I-12 enforced); step 5 writes a whole-household monthly Budget instead of "monthly income + savings target", because SavingGoal is task 3.3.2 and the budget model is expense-side; step 3 has a category picker the wireframe does not show, without which it could only learn a bill and never a person. Still open and **not** part of F-13: the classifier cannot resolve a *global* seed merchant (`loadContext` filters `merchants WHERE household_id`), which docs/02 §4.1 used to promise for a skipped step 4 — fixing it needs a precedence rule for a Household's copy-on-write duplicate, so onboarding step 4 avoids the question by creating the Household's own rows |
| Known gap → **FIXED in 2.3.3, and it was the cold start itself** | **A keyword at the schema default weight can never decide a category.** docs/04 §5.4 decides from keywords only at a score of **2.0**; `category_keywords.weight` defaults to **1.0**. The shipped tree wrote all 137 keywords at the default, so a Household that completed onboarding step 1 had a full Serbian tree and **`Lidl 2000` still fell through to the AI** — or, with no provider, to the blocking lane. The demo Household hid it completely: its merchants carry `default_category_id`, and a merchant default is a different stage that always decides. Only a fresh signup exposed it. The tree now separates **`strong`** (weight 2.0, decisive alone: `lidl`, `gorivo`, `plata`, `struja`, `penzija`) from **`include`** (weight 1.0, needs corroboration: `market`, `kafa`, `voda`, `rata`) and **`exclude`** (hard-blocks on polarity). `kafa` is the case that shows why the split matters: buying coffee is `Kafa i kolači`, "kafa i mleko" is groceries. Both writers **raise** an existing keyword whose weight is wrong rather than skipping it, so an old Household repairs itself on its next onboarding visit. Asserted in `packages/domain/src/seed/seed.spec.ts` (every category with keywords has a decisive one) and `onboarding.integration.spec.ts` (the exit-criterion inputs decide with zero AI calls). docs/04 §8.1.3 |
| Known gap → Phase 2 | **The fold is internally inconsistent for `đ`/`ђ` (verified).** Latin `đ` folds to `d` (hand-patched in 2.1.1 to fix the NFD gap) but Cyrillic `ђ` folds to `dj` (docs/04 §3.1's table). So `rođa` folds to `roda` while `рођа` folds to `rodja`, and the orthography-correct Cyrillic spelling of the canonical F-11 case resolves on the **trigram rung at 0.61 instead of normalized at 0.98** — a verify-lane match where an exact one was available. The other seven script pairs (`č/č`, `ć/ћ`, `š/ш`, `ž/ж`, `lj/љ`, `nj/њ`, `dž/џ`) are consistent; `đ/ђ` is the only broken one. Fix is one rule in `foldForMatching` (fold the digraph `dj`→`d` after transliteration, which does NOT change §3.1's transliteration table — `ђ`→`dj` stays correct for reading). It needs a re-fold of stored keywords/aliases, so do it before beta when there is no real data |
| Known gap → the rest of Sprint 2.3 | **Phase 2's build is complete: 2.3.1–2.3.5** (corrections + the `/rules` screen; the review queue's API + `/review`; the seed content + the onboarding API + `/onboarding`; rung 5 embeddings, provider-injected, LOCAL-only and **inert** in this build, ADR-021; the evaluation harness). **What is deliberately unbuilt**, recorded in docs/04 §8.1.x, docs/06 §4.2.1/§5.12 and docs/15 rather than repeated here: the review queue's **Lane B** (the advisory band is neither listable nor resolvable, because `reviewQueue` filters `needs_review` and `resolveReviewItem` no-ops when it is false); the queue's `reason`/`confidenceBelow` filters (applied after paging, so a filtered page can be short); `bulkResolveReviewItems`; `ReviewItemKind.RECEIPT_ITEM` and three `ReviewReason` arms (no producer); the `CONFIDENCE`/`AMOUNT` queue sorts (a composite cursor is needed); the rule **backfill**; global keyboard navigation; the `acceptProposal: false` refusal is not persisted; `/rules` cannot edit a rule's conditions; no **Restore** for an undone capture; the undo's `audit_log` entry; `DashboardDelta`; the per-household threshold write. `AI_CLASSIFIER` now comes from the composition root (ADR-032): with no usable endpoint it is the honest always-unavailable classifier (rules-only, `degraded: true`), and with one it routes through the consent gate. `prompt_template_id` is `null` while `prompt_version` **is** recorded. |
| Known gap → **FIXED in 2.2.7, and it was wider than the finding** | **No stage reconciled its category with the row's direction.** Found by 2.2.6's live verification as the model suggesting the INCOME category `Plata` for `salary 150000` on an `EXPENSE` row at 0.765 (the verify lane, so nothing asked). Fixing it found two more of the same defect: a **keyword** putting an `INCOME` row described `Lidl mesec` into the `EXPENSE` category `Supermarket` — which the commit path had been *writing* since 2.2.x — and `captureCommit`'s I-3 check being guarded by `if (row.categoryId)`, the *override*, so the entire preview → confirm flow skipped it and a live I-3 violation was written. The reconciliation now lives in the pipeline's `finish()` — the one function all five stage arms return through — and **refuses the category and asks**, keeping the suggestion as a `direction-mismatch` candidate and the AI's cost/latency in the audit. The commit path validates all three category sources and a write-loop guard is the invariant's floor. docs/04 §8.1.6 |
| Known gap → F-09 vs rung 3 (**found by 2.3.1's exit-criterion test**) | **docs/01 F-09's own scenario cannot pass end to end today.** It corrects `Dejan rođa 3600` and expects the *next* input — `Dejan 2000` — to resolve via the rules engine with no AI call. The rule is synthesised correctly, but it cannot fire: **`Dejan` alone does not resolve `Dejan rođa`.** docs/04 §4's rung 3 deliberately requires *every* folded token of the name to occur among the input's tokens, so that an abbreviation cannot auto-apply at 0.90 — the ladder is right and weakening it would trade a missing match for a wrong one. The shorthand starts working via (1) an **alias** on the counterparty, which is what F-13's onboarding step 3 is for and which works today, (2) **rung 5 embeddings** (task 2.3.4 — now implemented and exactly the case it exists for, but **inert** in this build because no embedding model is configured, ADR-021), or (3) a keyword, which the `DISTINCTIVE_TOKEN` trigger already adds when no entity resolves. Recorded in docs/04 §8.1.1 and asserted in `corrections.integration.spec.ts` so it stays a known state rather than a surprise |
| Known gap → Phase 3 recurring | **The recurring API, the `/recurring` screen, subscription detection and both jobs ship.** `recurringRules`, `upcomingRecurring`, the CRUD mutations and `materialiseRecurring` are live (docs/06 §4/§5.8), with the RRULE subset in `@finmate/domain` and materialisation writing through `TransactionsService`. **Both jobs are scheduled since 3.4.1** (`recurring.materialise` hourly, `recurring.detect` daily) and call the same service methods the mutations do. **`committedMinor` is wired since 3.4.2 and the `RECURRING_DUE` producer since 3.4.3**: one `pendingOccurrences` read feeds both a budget's projection and the due alert, so the two cannot disagree about a bill; an unposted EXPENSE occurrence inside the next day becomes an `INFO` insight keyed on the occurrence, mapped to its own default alert rule and deep-linked to `/recurring`. Detection's evidence is the occurrence count and the amount steadiness, which the screen renders from the proposal the API stored. `RecurringRule.version` from docs/06's sketch is **omitted rather than invented** — `recurring_rules` has no version column. |
| Known gap → Phase 3 insights | **The generators are pure and tested; the facts they see are complete enough to project.** `committedMinor` is read from the Household's own recurring rules since 3.4.2 — subtree-scoped, and excluding occurrences that have already been posted (those are `spent`, and counting both would double a bill) — while the Household-level `reserved` figure still belongs to the Household scope. The trend baseline now reads the shared split-aware aggregate (`SpendReadModel.byCategory`, 3.3.1), so a category whose spend arrives as a split is no longer under-counted against it; **`UNUSUAL_SPEND` still reads direct Transaction rows on purpose**, because comparing one purchase against a split's portion would compare two different things. Insight dedupe is **writer-enforced**: the key lives inside `payload` because `insights` has no column for it, so a concurrent double `generate` could duplicate — 3.1.2's notification `dedupe_key` is where a constraint belongs. `narrative` is always `null` — the `NARRATE` seam landed in 3.2.3 but nothing calls it for an Insight yet. `insights.generate` is scheduled daily at 06:00 since 3.4.1, and since 3.4.4 it runs the whole pipeline (`NotificationsService.run`: generate **and** evaluate), so a scheduled pass turns its insights into notifications. The writer now looks a dedupe key up over the periods its own drafts use — a `RECURRING_DUE` row may be filed under next month. The `generateInsights` mutation stays as the manual entry point. |
| Known gap → Phase 3 alerts | **All four channels are wired end to end, server and client.** `dispatchNotifications` sends `IN_APP` (the row is the delivery), `EMAIL` (SMTP → Mailhog in dev, verified live with a lock-screen-safe body), and `PUSH`/`WEB_PUSH` through the `WEB_PUSH` seam (4.2.9, ADR-028): `web-push@3.6.7` + `@types/web-push` behind a token, with an **inert default** when no VAPID pair is configured — so on this deployment the rows still stay `QUEUED`, but for the honest reason the new `AlertDispatchModel.reasons` states, not silently. Payload is `{ notificationId, kind, deepLink }` **plus a `notification` block**, because `ngsw-worker.js` shows nothing without a `notification.title` — ADR-028 decision 4 assumed the client could supply the sentence and cannot, so it carries an amendment and the only text is `APP_NAME` (the brand); `title`/`body` are passed in and never read, so no amount or entity name can reach a lock screen (T-09). A `404`/`410` soft-deletes that subscription and still counts as delivered. **The client half is built too (4.2.5)**: `core/push/` holds a six-state device panel on `/notifications` (`READY`/`SUBSCRIBED`/`BLOCKED`/`IOS_INSTALL`/`SERVER_OFF`/`UNSUPPORTED`), the permission prompt behind a button and never on load, subscribe/unsubscribe, and a re-register on every app start because `pushsubscriptionchange` is unreliable (docs/07 §4.8). ⚠️ On this deployment `pushPublicKey` is null, so the panel renders `SERVER_OFF` — nothing is delivered without a VAPID pair, and the UI says so rather than offering a prompt it cannot honour. `notifications.dispatch` is scheduled every minute and `insights.generate` daily since 3.4.1, both calling the same service methods the mutations do; since 3.4.4 the daily job evaluates as well as generates, so a scheduled insight becomes a notification without a mutation. `runAlerts` stays the manual trigger for the same `run` method. `updateNotificationPreferences` is built and stores in `households.settings.notifications`, but the settings screen is 3.1.4. `AlertRule.version` is declared in the GraphQL SDL but in neither docs/03 §4 nor the table, so it is omitted rather than invented. Notification copy is English-only and server-rendered — the API has no i18n catalogue — a DoD breach recorded in docs/06 §5.14; `locale` is stored and unhonoured. The brand string now lives in **two** places (the web's `app.name` i18n key and the new API `APP_NAME`) until a shared constant lands. `notificationReceived` is not built (no pub/sub transport; the badge polls). `RECURRING_DUE` gained a producer and a default rule in 3.4.3 — an `INFO` insight one day ahead, keyed on the occurrence; `BUDGET_THRESHOLD` and `GOAL_REACHED` still have no producer. |
| Known gap → Phase 3 goals | **The goals API and the `/goals` screen ship.** `savingGoals`/`savingGoal` and the five mutations are live (docs/06 §4/§5.7), with progress, the required monthly amount, contributions and status all computed by `@finmate/domain`. **`createTransaction` on `contributeToGoal` is deliberately not built** — a contribution is not a Transaction (docs/02 §4.13) and recording the outflow needs an Account transfer, which the ledger can express (`transfer_peer_id`) and no feature builds. Also not built: `Dashboard.goals` (docs/06 §4.1's `# CP` field), the `GOAL_REACHED` insight producer (still listed as uninstrumented), and the assistant's `GOAL_PROGRESS` / `GOAL_REQUIRED_MONTHLY` templates — the planner refuses a `goalId` slot it cannot resolve, and `GoalsService` is exported for the task that wires them. `SavingGoal.version` from docs/06's sketch is **omitted rather than invented**: `saving_goals` has no version column, and optimistic concurrency for one model is a migration nobody asked for. |
| Known gap → Phase 3 UI (analytics) | **`/analytics` has not been looked at by a human at any width** — the standing gap since `/review` (docs/02 §9), now with a second screen. Recorded differences from docs/02 §4.15: the header is a heading with a subtitle rather than a toolbar; **CSV is the month's transactions** (`/api/export/transactions.csv` with the chart's own range) rather than a per-section export, because an analytics-specific format is an unmade product decision; the uncategorised row has **no drill-through** (`transactions(...)` has no "category is null" filter, so a link would open rows the figure did not come from); and `cashflow` (docs/06 §4.3) is **not fetched** — F-20 asks for category trends, month-over-month and top merchants — so the API exposes a figure no screen yet renders. |
| Known gap → Phase 3 UI (assistant) | **`/assistant` has not been looked at by a human at any width** — the standing gap for every screen since `/review` (docs/02 §9). It also differs from §4.16's wireframe in three recorded ways: **six** canonical suggestions rather than "three closest" (no similarity ranking exists), a question composer rather than the shared `CaptureField` of §3/DP-1 (that component is built nowhere, and a question is not a transaction fragment), and an F-30 proposal table that **ships without its *Primeni* button** (it labels itself *Predlog (izračunato)* and says no budget has been changed). The transcript is client-side for the visit because there is no `conversationId`; since 4.3.7b `narrationMode`/`reason` **are** rendered in the provenance panel (docs/06 §8.5 amended). |
| Known gap → Phase 3 UI (notifications) | **`/notifications` has not been looked at by a human at any width** either. The alert preferences live on that screen rather than in a settings shell, because no `/settings` route exists yet; docs/02 §4.18's information architecture is the target once it does. Push channels are listed, and the device panel beneath them derives its sentence from `pushPublicKey` and the browser's own state (4.2.5) rather than a static string. The screen has no pagination control: it reads the first 50 rows, which is more than the daily cap can produce in a day. |
| Known gap → Phase 3 assistant | **The assistant answers; a model narrates only where the config names a `NARRATE` endpoint** (`LOCAL_AI_BASE_URL` is blank and no EEA narration host is configured, so the shipped default templates; ADR-032 decision 3). `assistantAnswer` is live (docs/06 §4.4, §8.7): planner → fact assembly → `NARRATE` → numeric validator → answer, with `TEMPLATE_FALLBACK` whenever a numeral is unaccounted for or no provider is reachable, and a **refusal** (`answered: false`, no figure, the narrator never called) for anything the template set cannot answer. `NARRATOR` resolves to `UNCONFIGURED_NARRATOR` when no `NARRATE` endpoint is routed (the composition root decides this, ADR-032), and **the dev `.env` now routes it to `DEEPSEEK_GLOBAL`** — verified live: `narrationMode: LLM`, a Serbian answer, ~1.2 s, 117 micros, and withdrawing `AI_DATA_PROCESSING` drops the same question to `TEMPLATE_FALLBACK` with `CONSENT_DECLINED` before a socket opens. ⚠️ **Both cloud factories omitted `NARRATE` from their model map until 2026-09-17**, so an EEA-hosted or consented narration route answered `TASK_NOT_SUPPORTED` and silently templated — see docs/15; the shipped default stays `LOCAL`. **Deliberately not built**: `conversationId` (no conversation store — an accepted-but-ignored parameter is a contract the API cannot keep); narration **cost persistence** (docs/05 §3's assistant row claimed it "writes `classification_decisions` for cost" and **was wrong**: a narration is not a classification decision, and a row there would corrupt every accuracy metric built on that table); a drill-through for merchant- or tag-scoped answers (`transactions(...)` takes no `merchantId`/`tagId`, so a link would show rows the answer did not come from — `drillThrough: null` instead); `/transactions` **now** reads the six drill-through arguments out of the URL before its first query (3.2.4), so a link lands filtered — and the screen never writes its own filters back to the URL, so a manually filtered list is still lost on reload; the fallback copy is **English** (`narration-template.ts` + `renderRefusal` — the second instance of §5.14's no-catalogue breach: the money is in the household locale and its own names are untranslated, the connectives are not); the planner matches at most **200** Merchants/Accounts per question. `pnpm test:evals`'s two narration gates are still `skipped` (no provider, and the dataset holds classification cases), so **narration is never evaluated** — the validator's guarantee is asserted over the fallback and over scripted model output, not measured live. Goal and recurring slots are still unresolvable (`GOAL_*` → `UNRUNNABLE:goalId`, `RECURRING_*` → `NOT_BUILT:recurring`) and `COMPARE_PERIODS` → `NEEDS_TWO_PERIODS`. **F-30 computes but does not apply**: `SAVINGS_PROPOSAL` returns a plan (target, a reduction per Category, the shortfall) and docs/02 §4.16's *Primeni* button is not built, because a Budget is a limit and "apply" would have to decide whether it may raise a Budget the Household set lower, and whether the write is one mutation or the client's existing `upsertBudget` per line — the screen says *a suggestion only — no budget has been changed* instead of guessing (docs/06 §8.8). Its cut rule is uniform (20 % of each Category, biggest first) because nothing marks a Category as discretionary, so it will propose cutting rent; the wireframe implies a notion of essential spending the schema does not have. **No test validates a client query against `apps/api/schema.gql`** — 3.2.4 shipped `money { amountMinor }`, a selection set on a **scalar**, and every mock accepted it (docs/15). Fact assembly and the analytics queries now share one split-aware aggregate (`SpendReadModel`, 3.3.1), so the assistant, the chart and the budget tile cannot disagree; `BudgetsService.spendIn` is the remaining separate implementation and the analytics integration spec asserts the three agree on a split-containing month (the insight **trend** baseline was reconciled in 3.3.1 too — `UNUSUAL_SPEND` still reads direct rows on purpose, because a split's portion is not a purchase). One planner defect 3.2.3 found and fixed: a Household's own Merchant now wins over the global seed row of the same name (`NamedEntity.owned`) — before it, `koliko sam potrošio u lidlu` answered `0,00 RSD` from a seed row no Transaction points at. |
| Known gap → **settled by 4.2.8b** | **Analytics needs a connection, and three documents disagreed about it.** docs/09's 4.2.8b row said *"analytics' cached period follows the same rule"* as the ledger cache; docs/07 §6's matrix said analytics was 📖 *"cached views only"* with no record behind it; ADR-027's rejected option (f) said analytics and the assistant *"need their own design, not this record"*. 4.2.8b served `/transactions` (the screen the ledger-rows record exists for), left `/analytics` with its honest error state, and then **resolved the contradiction in the matrix's favour**: a spending analysis has no honest offline form — its content is the server's aggregates, recomputing them from a row cache is forbidden (ADR-001), and a cached analysis would be staler than safe-to-spend while driving no decision. docs/07 §6 now says 🌐, the plan's note is **retracted**, and ADR-027's 4.2.8b amendment records the reasoning. The assistant is excluded for its own reason: it must never answer from a stale snapshot |
| Known gap → unscheduled | **The documented pre-commit layer does not exist.** docs/10 §1 layer 0 lists `lint-staged` + prettier + `gitleaks`; there is no `.husky`, no `lint-staged` config and no hook, and `format:check` fails on 119 files repo-wide (including `pnpm-lock.yaml`). It is not in CI, so nothing is gated on formatting |
| Phase 2 progress | **2.1.1–2.1.4 done** — `packages/nlp` (transliteration, `foldForMatching`, segmentation, `TransactionFragment` extraction), the 300-case golden dataset v1, `packages/rules-engine` (§5.3 conflict resolution, §5.4 keyword scoring, no I/O), and the pure entity-resolution ladder (exact 1.00 → normalized 0.98 → prefix 0.90 → trigram 0.55–0.85, trigram injected) in `packages/nlp/src/resolve.ts`. **2.2.1–2.2.6 done** — `packages/ai` (OpenAI-compatible adapters, fail-closed residency routing, circuit breaker, redaction, telemetry; **no vendor SDK**), structured-output validation + isotonic calibration, the `classification` module (pipeline, audit row, §7/I-8 gate), `captureCommit` + the `/capture` screen, duplicate-suspect detection + undo, **2.2.6** the composition root + consent gate (ADR-032), and **2.2.7** the direction reconciliation (docs/04 §8.1.6). **2.3.1–2.3.5 done** — see the row above. **2.3.5 measured**: rule-hit 73.8 % (bar 50 %), overconfident-wrong 0.28 % (bar 1.5 %), top-1 100 %, should-ask recall 98.8 %, extraction 100 %, p95 39 ms; its first run found and fixed a reversal auto-categorised as an expense (a new **direction gate**) and a seed keyword that contradicted a merchant default. Nine knowledge gaps remain and are recorded, not hidden (docs/10 §5.9, docs/04 §8.1.5). |
| Web screens | **the dashboard in offline mode** (F-19/F-21, 4.2.4 — the last successful read is served from the snapshot with one `podaci od <time>` line covering every figure, the server's own numbers verbatim, and the honest error state when there is no snapshot; nothing is recomputed client-side, ADR-027), **`/pending`** (F-26, 4.2.3 — the pending-sync tray: the queue with raw input, local time, attempts and the last error in words, retry/discard per row, retry-all, export-as-text, and the *Pregledaj razlike* diff; a header chip rather than a nav destination, ADR-026), **`/receipts`** and **`/receipts/:id`** (F-14/F-34, 4.1.4b/4.1.5 — the library with its one capture action, then the mismatch banner, the item table with its category pickers, `Uskladi ručno`, `Prihvati`, *Napravi transakciju* behind I-6 and every line's Category, `Otkači`, and a link to the created row through `/transactions/:id`; a real rendered defect was found here — a `[value]` binding on a `<select>` ran before its `@for` options existed, so every saved category showed as "no category", fixed by binding `[selected]` on the option), the **`/transactions/:id` drill-in** docs/02 §2.1 lists, **the Transaction sheet carries the Receipt photo** (F-34, 4.1.2 — camera or file, presigned upload, attach/remove; it says plainly that an upload is *not virus-scanned*, and it has not had a human pass at any width either), **`/recurring`** (F-16 — the rule list with its schedule in words, the frequency picker, activate/deactivate and auto-confirm, the next-30-days line, the raw RRULE behind a disclosure, and the detected-subscription proposals with their evidence), **`/goals`** (F-18 — the card list with progress, the monthly amount the backend derives, contributions with their history, inline target/deadline edit, archive/restore), **`/analytics`** (F-20 — the trend, the category bars with share and change, the accessible table behind every chart, the top merchants, the month-over-month comparison, `[`/`]` and a CSV of the month; one query per period), **`/assistant`** (F-23 — the composer, the transcript, the answer card with its figures, the expandable provenance line and the drill-through link; the starter chips come from `assistantSuggestions`), **`/notifications`** (F-22 — the notification centre and the alert preferences, with the unread bell in the nav), **`/onboarding`** (F-13 — the six-step wizard, nav hidden while it runs), `/` dashboard, **`/capture`** (F-05/F-06 — the signature interaction, and since 5.2a the screen that asks the first-use consent question when a preview comes back degraded), `/transactions` (filter + edit + **correction with "Zapamti za ubuduće"** + CSV export, and since 4.2.8b the **ledger cache**: an unfiltered successful read is cached and a failed one is served read-only under one `podaci od <time>` line), **`/review`** (F-08 — the blocking lane, keyboard-driven), `/budgets`, `/categories`, `/merchants`, `/counterparties`, `/tags`, **`/rules`** (F-09 — grouped by what needs attention), `/accounts`, sign-in/up |
| Shell header | **New in 3.1.4's follow-up.** docs/02 §2.2 draws a header carrying 🔔 unread, ⚙ and the account menu on both layouts; the shell had none, so the bell was first wedged above the nav list, which read as an accident. The header now holds the bell (with its unread badge), the language switcher and Sign out, and the old bottom `.session` row is gone. Below it, inside the content region, sits the **app-update line** (ADR-024): a non-dismissible *"A newer version of the app is ready."* with a *Reload* action, plus a second sentence when the worker reports an unrecoverable cache. The header also carries the **offline chip** — `podaci od <time>` (the stale half, 4.2.4) and `Čeka slanje (n)` → `/pending` (the pending half, 4.2.3) — rendered only when there is something to say, so the state is visible at every size class without a second badged nav slot (ADR-026/ADR-027). The ⚙ settings entry is **built** (4.2.6b) and opens `/settings`, whose sections are the app lock, **AI consent** (R-25a: every purpose's state, an Allow/Decline pair while the question is open, a withdrawal, and the provider-and-region disclosure rendered from the server's own routing table — the half the first-use sheet deliberately shares) and a link to `/notifications`; the **first-use sheet** itself (5.2a) opens from `/capture` and reuses that same card, so the disclosure cannot drift between the two screens. **Not built**: the rest of docs/02 §4.18's sections (Profil, Domaćinstvo, Prikaz, Jezik, Podaci) and the avatar menu — docs/02 §2 says a control that cannot work is *disabled with a tooltip* rather than shown broken, and the same rule applies here |
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
produces a 404 that looks like an auth failure — and the same fact, in the other direction, is why
`PUBLIC_API_PREFIX` exists: anything the browser path-scopes (the refresh cookie) must name the
*browser's* path, because the API never sees the prefix.
Verified working: lint 9/9, typecheck 9/9, 2635 tests, `pnpm test:evals` gating green, `web:build`, GraphQL over HTTP through the
browser origin, the full signup → cookie → `/auth/me` → GraphQL flow, the presign → PUT to MinIO →
`commitAttachment` → `302` download round trip (verified live, bytes compared), and `prisma migrate diff`
reporting no drift. **CI seeds the globals (`pnpm db:seed`) before the suite**: three API integration specs
assert the shipped merchant catalogue and cannot create it (ADR-008), so a fresh database fails them by
name — see docs/10 §4.1. The service container also takes the dev cluster's `--locale=C`, because a text
`ORDER BY` is a deployment property and CI's `en_US.utf8` default ordered one tag list differently.

---

## Read the docs before you code

`docs/` is the **specification and it is canonical**. Do not restate it in code comments — link to it.
Read the document that owns your task before starting:

| If you are… | Read first |
|---|---|
| starting any task | `docs/05-architecture.md` §2 — monorepo layout + the dependency rule |
| **debugging something that should work** | **[`docs/15-implementation-gotchas.md`](docs/15-implementation-gotchas.md)** — 165 entries, each saying what the failure looks like |
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
   *(ADR-007)* **An `_EU` suffix is not enough on its own**: the endpoint must be configured with the
   EEA host it means, because a suffix is a claim and a hostname is not jurisdiction *(ADR-031)* —
   DeepSeek's own platform is `DEEPSEEK_GLOBAL`, and it needs recorded consent.
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

**The full list — 165 entries in 10 groups, each written to say what it looks like when it goes wrong —
is [`docs/15-implementation-gotchas.md`](docs/15-implementation-gotchas.md). Read it before debugging
anything that "should work".** It was split out because this file had grown past the instruction budget
and was being truncated on load. The ones below stay here because they are the ones that bite hardest,
or that are cheapest to get wrong before you have read anything else.

- **The dev API is pinned to `:3001` and the web proxy targets `:3001`, while `.env` says `3000`.** Change
  one and you must change the other, or every request through the SPA fails as a proxy error and the
  sign-in page reports "something went wrong". `nx run api:serve` pins it; plain `node` honours `.env`.
  **A stopped API gives the human the same message** (the proxy answers 502 with no upstream), so check
  `:3001/health` before handing work back — especially after running the suite, which is when the API
  gets stopped. Since 4.2.6a's follow-up the client says "the server is not reachable" for
  `status 0`/`502`/`503`/`504`, which is a better message and still not a running server.
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
- **`KEY=` in `.env` is not "unset" — it is a present variable holding `''`, and every seam tests
  `=== undefined`.** `cp .env.example .env` therefore did not mean "leave these blank": an empty
  `VAPID_PUBLIC_KEY` built a real push sender with empty keys instead of the inert one, and an empty
  `*_EU_BASE_URL` failed boot as "Invalid url". `config.ts` now normalises a blank value to `undefined`
  once (`blankIsAbsent`). When a seam decides by `=== undefined`, make the schema make blank mean
  undefined.
- **An AI seam's prompt is composed from two packages, so assert the bytes that ship.** `apps/api` renders
  the instructions and `packages/ai` renders the redacted payload (with the category ids substituted), and
  the first live provider found two defects in that seam that no test, lint, `web:build` or eval gate could
  see: the category list was rendered **twice** — once with real ids, once with placeholders — so the model
  answered in a vocabulary the redaction map could not resolve, and `json_object` mode, which constrains
  syntax and not keys, was never told the field names, so the model invented them. See docs/15 and
  `ai-classifier.spec.ts`.
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
