# AGENTS.md — FinMate

> **The name is not decided.** `FinMate` is a working title and **is already taken** by existing
> finance products (ADR-014, `docs/13-brand-and-naming.md`). Never hardcode a brand string — read
> `APP_NAME` from config. `Ostava` is the current recommendation, pending screening.

AI-first household budgeting app for **mobile and desktop**. The product promise, in one line:

> Type **`Lidl 2000`** and get a correctly categorised, budget-aware transaction in under five seconds.

**Machine state:** Node 24.20.0, pnpm 11.7.0, Go 1.27.0, **Docker 29.7.2 + Compose v5.5.0 (Linux
containers)** on Ubuntu 20.04 LTS / WSL2.

**Build state — Phase 0 COMPLETE. Phase 1 (manual core): all screens are working; the remaining gaps are listed below.**

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
| Counterparties/tags (1.2.2–1.2.3) | **Backend done, verified independently** — `counterparties`/`counterparty` + create/update/setCounterpartyAliases/mergeCounterparties/deleteCounterparty (merge-as-deletion, no copy-on-write: the table is plain household-scoped); `tags`/`tag` + createTag/updateTag/deleteTag (delete **cascades its assignments**, deliberately unlike a Merchant); `tagIds` on `createTransaction`/`updateTransaction` and `tags` on `TransactionModel`. **No UI** |
| **Phase 1 UI** | **Done** — transaction entry, filtered/paginated list, edit sheet, budgets, dashboard tiles; Accounts from Phase 0 |
| Category tree editor + keyword editor (1.2.4, F-02/F-03) | **Done** — rename, reparent, reorder, delete-with-reassign, include/exclude keywords. **Drag-and-drop not implemented**; the Parent select and Alt+arrows cover reparenting |
| Responsive pass (1.3.5) | **Partially done** — no fixed pixel widths and every multi-column grid is behind a `min-width` query; five known 320 px hazards fixed (nav overflow, hero amount, split-editor row, budget card, keyword chips). **Still needs a human at 320/768/1280 px** |

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
| Tests | **453 pass** — 263 API + 97 domain + 93 web |
| Not yet built | worker jobs; production build for apps/api (its own decision); PWA service worker (Phase 4) |
| Web screens | `/` dashboard, `/transactions` (filter + edit + CSV export), `/budgets`, `/categories`, `/merchants`, `/accounts`, sign-in/up |
| Navigation | 4 primary destinations in the bottom bar plus **More** (≥1024 px the sidebar lists all 6); `nav.more` is the overflow control |

```bash
pnpm dev:infra            # start Postgres/Redis/MinIO/Mailhog
pnpm db:migrate           # apply migrations
pnpm db:seed              # seed global merchants (add SEED_HOUSEHOLD_ID for a full household)
nx run api:serve          # API on :3001   (see the port note below)
nx run web:serve          # SPA on :4200, proxying /api and /graphql to the API
pnpm lint / typecheck / test
nx run web:build          # production bundle
```

**The browser talks to `/api/*`; the dev proxy strips the prefix** before forwarding, because the
API serves `/auth/*` and `/graphql` without one (docs/06). Changing the prefix on one side only
produces a 404 that looks like an auth failure.
Verified working: lint 9/9, typecheck 9/9, 453 tests, `web:build`, GraphQL over HTTP through the
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
nx run api:serve    # API on :3001 (host port 3000 is taken in this environment)
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
- **Host port 3000 is held by an unattributable process in this environment.** `/proc` is restricted
  and `lsof`/`fuser` are absent, so the dev API is verified on 3001+. Use `/tmp/run-api.sh <port>`,
  which frees the port and waits for the readiness line rather than a fixed sleep.
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
  `Angular compilation initialization failed`. It has cost real time three times, twice from a
  backtick in a CSS comment documenting a property. Write CSS/HTML comment prose without them. A scan
  that finds them is two lines of Python: locate `styles: [\`` / `template: \``, then the next
  closing delimiter, and look for an interior backtick.
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
- **The web app has a deliberate SECOND copy of the fold, in `features/merchants/normalise.ts`.** It
  exists so the duplicate-name warning agrees with the server's `CONFLICT` instead of contradicting
  it. `packages/nlp` is still a stub (Phase 2 task 2.1.1 owns it) and is where both should end up;
  until then the duplication is the lesser evil, and the two are tested on the same cases.
- **Normalise keywords and aliases through `common/text/normalise`, never a local copy.** All three
  fold to the same form the classifier will compare against. `Đ/đ` needed an explicit rule: it has no
  canonical decomposition, so the combining-mark strip that handles `č/ć/š/ž` left it intact and
  `Đorđe` never matched `Djordje`. Cyrillic transliteration (docs/04 §3) is still missing and belongs
  to Phase 2 task 2.1.1, which also moves this into `packages/nlp`.
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
