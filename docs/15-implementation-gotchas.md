# Implementation gotchas

> **Read this before debugging anything that "should work".** Every entry here is something that has
> already cost real time in this repository, each written to say *what it looks like when it goes
> wrong* — because the symptom is usually in a different place from the cause.

This file was split out of `AGENTS.md` (task 2.3.3) for a concrete reason: `AGENTS.md` had grown past
the 64 KB instruction budget, so the end of it — including **Do not build without asking** — was being
silently truncated when an agent loaded it. The rules stay in `AGENTS.md`; the accumulated detail lives
here, where it can keep growing. `AGENTS.md` keeps the dozen that bite hardest inline.

**Ordering.** Within a group, entries appear roughly oldest-first. There is no priority implied by
position — the grouping is by *where you will be standing* when the problem appears.

---

## Contents

1. [Toolchain, build and the dev environment](#1-toolchain-build-and-the-dev-environment)
2. [Prisma and the database](#2-prisma-and-the-database)
3. [Tenancy and the guard](#3-tenancy-and-the-guard)
4. [GraphQL and the API surface](#4-graphql-and-the-api-surface)
5. [Domain: money, dates and Serbian input](#5-domain-money-dates-and-serbian-input)
6. [Classification, rules and the learning loop](#6-classification-rules-and-the-learning-loop)
7. [Capture and the commit path](#7-capture-and-the-commit-path)
8. [Taxonomy: categories, keywords, merchants](#8-taxonomy-categories-keywords-merchants)
9. [Web UI, templates and i18n](#9-web-ui-templates-and-i18n)
10. [Cross-cutting rules of the codebase](#10-cross-cutting-rules-of-the-codebase)

---

## 1. Toolchain, build and the dev environment

Everything here has cost time at least once, and most of it fails in a way that names the wrong problem: a missing module instead of a resolution mode, a syntax error instead of a template, a proxy error instead of a port mismatch.

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

- **The dev API runs on 3001 because the web proxy targets 3001, and `.env` says 3000 — so `api:serve`
  PINS the port.** `apps/web/proxy.conf.json` forwards `/api` and `/graphql` to `localhost:3001`, while
  `.env`/`.env.example` set `API_PORT=3000` (the port for a direct `node src/main.ts`, a container or CI).
  `nx run api:serve --configuration=production` and plain `node` still honour `.env`; only the dev
  `options.command` overrides it. **This cost real debugging time**: with the API on 3000 and the proxy
  pointed at 3001, every request through the SPA fails as a proxy error and the sign-in page reports
  "something went wrong" — which reads like an auth or CORS bug and is neither. If you change one
  port, change both. **A stopped API produces the same message**, and that is the more common case: the
  dev proxy answers **502** with no upstream (measured), so the SPA reports a transport failure and the
  human is invited to retry something that cannot succeed. It happens *because* the suite is run: the API
  is stopped first so it cannot contend for the database. So check both before handing work back —
  `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/health` and the same through `:4200`.
  The client now says *"The server is not reachable"* for `status 0`/`502`/`503`/`504` instead of the
  generic sentence, which is a better message and still not a running server.
  (`/proc` is restricted and `lsof`/`fuser` are absent here, so use `ss -ltn` or
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

- **`**/.angular/**` must stay in the eslint ignores.** The Angular build cache contains bundled
  dependency output, so linting it reports hundreds of errors in `@angular/forms`' own bundle.

- **Angular targets run with `cwd: {projectRoot}` and project-relative binaries.** Mixing a
  workspace-relative binary path with `cwd: {projectRoot}` yields `ng: not found`.

- **`packages/domain` sets `testTimeout: 30_000`, and that is load-bearing.** Its test style is
  deliberately exhaustive over ranges rather than example-based — that is what 100 % branch coverage on
  money math requires. Two tests are therefore multi-second: the I-1 allocation loop (5001 totals × 6
  ratio sets) and the `instantForLocalNoon` round-trip (every day of 2026 × 5 zones). Under `pnpm test`
  with seven projects in parallel they measured **4886–5881 ms against Vitest's 5000 ms default**, so
  both failed intermittently, on the money path, for reasons unrelated to money. The budget is
  package-level because the *next* exhaustive test would otherwise reintroduce the same flake. Do not
  lower it; 30 s is only reached by a test that is genuinely hung, which still fails the run.

---

- **`KEY=` in `.env` is not "unset" — it is a present variable holding nothing, and every seam in this
  codebase tests `=== undefined`.** `node --env-file`, `dotenv` and Compose all turn an empty value into
  `''`, so `cp .env.example .env` did not mean "leave these blank"; it meant "configure them with
  nothing". Three real consequences, all silent: `VAPID_PUBLIC_KEY=''`/`VAPID_PRIVATE_KEY=''` produced a
  real `RfcWebPushSender` (constructed with empty keys) instead of the inert sender its own header
  promises; `DEEPSEEK_EU_BASE_URL=''` failed boot with *"Invalid url"* — a message about a typo, for a
  variable that is visibly empty; and a future `LOCAL_AI_BASE_URL=''` would have handed the composition
  root a base URL of `''`. **Fixed**: `config.ts` normalises a blank value to `undefined` once
  (`blankIsAbsent` + `optionalText`/`optionalUrl`) for every optional setting, so "not configured" has a
  single representation. The general rule: when a seam decides by `=== undefined`, the schema must make
  blank mean undefined, not the seam.

- **A full page load signs the user out on this dev setup, and the cause is a cookie *path*, not a
  prefix or an auth bug.** The API scopes the refresh cookie to `Path=/auth` on purpose (the token must
  not ride ordinary data requests), but the browser has to ask the dev proxy for `/api/auth/refresh`,
  and **a browser matches a cookie's path against the URL it can see**. `/api/auth/refresh` does not
  start with `/auth`, so the cookie is never attached; `AuthStore.restore()` gets
  `{"accessToken":"","expiresIn":0}`, clears itself, and `authenticatedGuard` redirects to `/sign-in`.
  What makes it hide for so long is that the access token lives in memory, so *in-app navigation* keeps
  working — only F5, a deep link, or the service worker's own reload exposes it. Diagnose it in one
  command: take the `finmate_refresh` value out of a signup's `Set-Cookie` and send it explicitly —
  `curl -X POST -H 'content-type: application/json' -d '{}' --cookie "finmate_refresh=$REF" /api/auth/refresh`
  returns a real JWT where the same call with a cookie jar returns an empty one. **Fixed in 4.3.5** (R-26):
  the cookie path now follows `PUBLIC_API_PREFIX` — the path the *browser* reaches the API under, default
  `''` for a root-mounted API and `/api` in dev — used by the `Set-Cookie` *and* by both `clearCookie`
  calls, because a browser only deletes a cookie whose attributes match. Do not "fix" it again by widening
  the cookie to `Path=/` or by giving the client two prefixes. The general lesson is bigger than the bug:
  **an attribute that describes the API's internal route can be wrong in the browser's terms** — the
  server never sees the prefix a proxy strips, so anything path-scoped has to be configured, not derived
  from the controller's own route. Verify any auth change with a **hard reload** in a browser,
  never only through the SPA's own router or a REST call to `/auth/*`.

- **The web dev server does not watch files either — `ng serve` served 15-hour-old CSS, silently.** The
  API's version of this is in `AGENTS.md` ("the dev API does not watch files — restart before live
  verification"); on this machine `ng serve` in `apps/web` behaves the same way, so an edit to a
  component's `styles` can be invisible in a browser that is loading fresh. It cost real time in 4.3.1:
  a `minmax(0, 1fr)` fix measured *zero* effect, because the page was being served the old stylesheet, and
  the fix looked wrong rather than unloaded. Three ways to tell, cheapest first. (1) `curl` the served
  bundle and grep for the new value: `curl -s http://127.0.0.1:4200/main.js | grep -c 'minmax(0, 1fr)'`
  — 0 means the server, not your change, is the problem. (2) Compare `stat -c %y` of the log against the
  file's mtime. (3) Ask the browser: `getComputedStyle(...)` for the value you just set. **Restart
  `ng serve` after every source edit before verifying live**, exactly as with the API — and do not kill it
  with `pkill -f "ng serve ..."`, because the pattern matches your own shell's command line and kills the
  command that is doing the killing (use `pkill -f "ng ser[v]e"`).

## 2. Prisma and the database

Prisma 7 plus a tenancy extension plus hand-written SQL means the driver is not the only thing deciding what a query does.

- **Prisma 7 moved things.** The connection URL is no longer in `schema.prisma`; it lives in
  `prisma.config.ts` for the CLI and is passed to `PrismaClient` through `@prisma/adapter-pg`. The
  generator is `prisma-client` with a mandatory `output`, not `prisma-client-js`. Never run
  `prisma migrate dev` — it would generate SQL that drops the CHECK constraints, partial indexes and
  expression indexes doc 03 depends on.

- **`runWithTenant` aside, never use the outer client inside an interactive `$transaction`.** Each
  inner query then waits for a second connection from the same pool and stalls until the transaction
  times out — surfacing only as an opaque INTERNAL. Always use the `tx` the callback receives.

- **`transactions.source` has a database DEFAULT but not in the derived Prisma schema.** A direct
  `transactions.create` must pass `source`; the service does. `prisma db pull` cannot carry a
  PostgreSQL enum default through.

- **`runWithTenant(ctx, () => prisma.x.findMany())` works now, but used to lose the context.** A
  Prisma query object is *lazy* and does not run until awaited, so `storage.run` exited before the
  query executed and it threw `TenantContextMissingError` from a distance. `runWithTenant` chains a
  returned thenable inside the context. Service methods were never affected because they `await`
  internally; one-line test helpers are where it bites.

- **A nested relation write needs `update`/`create`, never `updateMany`/`createMany`.** Prisma raises
  `Unknown argument` for a relation field inside `updateMany`'s `data`, and an XOR CreateInput means
  an unchecked scalar (`updated_at`) alongside a relation field is also rejected. This is why
  `TransactionsService.update` runs an interactive `$transaction` — `updateMany` for the versioned
  field edit (which is also the row lock), then `update` for the `transaction_tags` replacement — and
  why `TagsService.remove` loops `transactions.update` over the scoped holders rather than one
  `updateMany`. Both pass a *scoped* `where`; do not "simplify" either into raw SQL to get one round
  trip, or the tenant predicate becomes something a human has to remember.

- **Never trust a `RETURNING` capture from `psql`** without a CTE. `psql -tAc "INSERT ... RETURNING id"`
  also prints the `INSERT 0 1` command tag, which silently corrupts a captured id. Wrap it:
  `WITH ins AS (INSERT ... RETURNING id) SELECT id FROM ins;`.

- **Postgres sorts NULLs FIRST in a `DESC` order, so `orderBy: { nullable_column: 'desc' }` does the opposite
  of "non-null first".** `merchants.list` ordered `household_id: 'desc'` with a comment claiming it put the
  Household's own rows above the seeded ones; it put the ~62 global rows first and buried every owned copy.
  Nothing failed until the catalogue outgrew the 50-row page, at which point a Household's own merchants
  vanished from the list. Use `orderBy: { household_id: { sort: 'desc', nulls: 'last' } }`. Same trap applies
  to any nullable column used as a sort key (`deleted_at`, `parent_id`, a COW copy's fields).

---

- **A `CHECK` constraint you did not read is part of the algorithm.** `receipt_items.amount_minor` is
  `CHECK (amount_minor >= 0)` (docs/03 §4), and the obvious implementation of `ADD_ROUNDING_LINE` — a
  line carrying `-variance` so the sum matches — is therefore **unrepresentable** the moment the lines
  overshoot the total. The domain function returns `null` instead of a negative amount and the service
  refuses with the reason, pointing at `ADJUST_ITEM`/`ADJUST_TOTAL`. Read the DDL's CHECKs before
  designing the arithmetic around a column, not after Postgres refuses the insert.

- **The dev API does not watch your files, so a live pass can be testing code you replaced an hour
  ago.** `nx run api:serve` is a plain `node -r @swc-node/register src/main.ts` with no watcher, and
  every restart is manual. Two live failures in one task (a `needsReview` flag and an error code) were
  the *old* process answering, not the new code being wrong — the integration suites were green
  throughout because they build fresh. Restart the API before a live verification, and if a live result
  contradicts a passing test, suspect the process before the patch.

- **`push_subscriptions.endpoint` is globally `UNIQUE`, so a soft-deleted row still owns its endpoint
  — registering it again must *revive* it, not insert.** `endpoint` is the identity a browser mints, and
  it does not change when a push service retires the subscription; so the register path clears
  `deleted_at` and updates `p256dh`/`auth`/`user_agent` on the existing row. An `insert` looks correct
  and fails with a unique-constraint violation the moment a user re-subscribes, i.e. exactly when a
  `404`/`410` soft-delete happened (verified live: register → delete → register returns the **same** id).
  The partial `push_subscriptions_live_idx` is on `deleted_at IS NULL` for the same reason — the row
  exists, it is just not live.

## 3. Tenancy and the guard

ADR-008 is enforced by an extension, not by discipline — which is why these two are about what the guard *cannot* do for you.

- **`merchants` and `ai_provider_configs` are `HOUSEHOLD_SCOPED_WITH_GLOBAL_READS`, not plain
  household-scoped.** Their `household_id` is nullable, and docs/08 §"Layer 2" puts those rows on the
  global allow-list. Reads get `AND: [{ OR: [{ household_id: ctx }, { household_id: null }] }]`;
  **writes keep the strict predicate**, or any Household could rename or delete the seeded platform
  catalogue. `is_global` is forced false on create and on an upsert's create branch. Adding a model to
  this group requires a nullable `household_id` — a spec asserts it. The `AND` wrapper is deliberate:
  Prisma's `where` holds one `OR`, so setting ours there would discard a caller's own.

- **Count a parent-scoped join by joining through the parent, not by `groupBy`.** Prisma's `groupBy`
  `by` accepts only scalar fields (`Expected TransactionsScalarFieldEnum`), so `transaction_tags`
  cannot be grouped — and the guard refuses the model directly anyway. `TagsService.transactionCounts`
  is one parameterised `$queryRaw` joining `transactions` on `household_id` and `deleted_at IS NULL`;
  the join *is* the tenancy predicate. One grouped statement for the page, never a count per row.

- **A `transaction_splits` row must carry `household_id`, and a `transaction_tags` row cannot be
  written at all, only through its parent.** The two look alike in docs/03 and behave differently in
  code: `transaction_splits` has its own `household_id` (added by the
  `20260914160000_scope_aggregated_children` migration, after the init DDL), so a fixture inserts it
  directly — but forget the column and the insert fails on NOT NULL, not on tenancy.
  `transaction_tags` has **no** `household_id` and is `PARENT_SCOPED`: `prisma.transaction_tags.create`
  throws `TenancyError`, and the assignment must ride along as
  `transactions.create({ data: { …, transaction_tags: { create: [{ tag_id }] } } })`. Reading it is the
  same shape (`include: { transaction_tags: true }`), which is why a fixture that wants a tagged row
  has to create the Transaction and the Tag together.

- **A cross-tenant test is only testing cross-tenancy when the *tenant* is the other Household.** The
  guard scopes every query to `TenantContext.householdId` and the service passes its own `householdId`
  argument into the same `where`; under a session for Household A, calling
  `files.downloadTarget('B-id', 'A-attachment')` does **not** simulate Household B — the guard answers
  from A's rows, so a `PENDING` attachment of A's came back as if B had asked. The failing assertion
  looked like a missing `404`, and the fix was `runWithTenant(otherContext, …)`, not a service change.
  The ADR-008 rule that clients never send a `householdId` is what makes this safe in production — the
  two values always agree there — and what makes a mismatched pair meaningless in a test.

---

- **Nest refuses to export a provider a module only *imports*.** Moving `AI_CLASSIFIER` into the AI
  composition root and leaving `{ exports: [AI_CLASSIFIER] }` on `ClassificationModule` does not fail
  typecheck, lint or any unit test — it fails at **boot** with `UnknownExportException: Nest cannot
  export a provider/module that is not a part of the currently processed module`. Re-export the *module*
  (`exports: [AiModule]`) instead, and treat "module graph changed" as a reason to boot the API before
  handing work back.

- **A spec that deletes a `households` row must do it inside a tenant context.** `households` is scoped
  by its own primary key (docs/15 group 3), so `prisma.client.households.deleteMany(...)` in an
  `afterAll` throws `TenantContextMissingError` — after every test has passed, which vitest reports as a
  failed *suite* with 10 green tests and no obvious connection to the teardown. Wrap each delete in
  `runWithTenant(ctx, ...)`.

- **"Newest row wins" needs a tiebreaker, and the tie is the dangerous case.** `consents` records its
  state as the newest row per `(household_id, kind)`, ordered by `recorded_at`. Two decisions a
  millisecond apart — a GRANT followed immediately by a WITHDRAW — share a `recorded_at`, because
  `recorded_at` is `timestamptz` but the value comes from a JS `Date`. Postgres is then free to return
  either, and the wrong answer silently re-admits egress after a user revoked it. Order by
  `[{ recorded_at: 'desc' }, { id: 'desc' }]`: `id` is a UUIDv7 whose 12-bit in-millisecond sequence
  makes "newest" total.

## 4. GraphQL and the API surface

Code-first GraphQL with custom scalars: most of these are registration problems that surface as runtime boot failures or a client seeing the wrong shape.

- **GraphQL errors need an explicit conversion.** NestJS does **not** populate `originalError` for
  GraphQL contexts, so an `ApiError`'s `code` is dropped and everything surfaces as
  `INTERNAL_SERVER_ERROR`. `AllExceptionsFilter` converts `ApiError` into a `GraphQLError` with
  `extensions.code` when `host.getType() === 'graphql'`; `formatError` then surfaces it. Do not
  "simplify" that branch away — clients branch on `UNAUTHENTICATED` to refresh a token.

- **A custom scalar used as INPUT must be registered without a type function.** `@Scalar('Money')`,
  not `@Scalar('Money', () => Object)` — the latter makes Nest treat it as an object type and every
  input field fails with `CannotDetermineInputTypeError`.

- **A custom scalar must be listed in a module's `providers` or Nest cannot use it as an INPUT.** `@Scalar('JSON')` +
  `@Field(() => JsonScalar)` is not enough: without the provider, boot fails with
  `CannotDetermineInputTypeError ... for the "conditions"`, which names the *class* and reads like a decorator
  problem. `accounts.module.ts` is the precedent (`MoneyScalar`, `BalanceScalar`, `UuidScalar`, `LocalDateScalar`);
  `classification.module.ts` now provides `JsonScalar` the same way.

- **`CategoryModel.path` is `[String!]!` on the wire, not a `string`.** A hand-written response interface is a
  claim, not a check, and `/rules` had `path: string` — so a rule's category rendered as a comma-joined array
  (`Hrana,Supermarket`) rather than the ` › ` breadcrumb every other screen builds. Ask what the type actually
  is before typing the response: `apps/api/schema.gql` is generated and is the answer.

- **`GET /export/transactions.csv` is REST on purpose** (docs/06 §9.7): a download is a navigation,
  not a fetch. It is a *browser* URL under `/api/...`; the client fetches it through `HttpClient` so a
  failure lands in the error banner instead of downloading a file full of JSON. Distinct from the
  async whole-household `exportData` (docs/06 §5.11), which needs the worker and is not built.

- **A nullable GraphQL argument arrives as `null`, never as `undefined`.** `assistantAnswer(question,
  locale: String)` was written as `locale?: string` with `locale === undefined ? default : …`, so every
  question asked **without** a locale threw `TypeError: Cannot read properties of null (reading
  'length')` and surfaced as an opaque `INTERNAL` — while the integration tests stayed green, because
  they passed the field as absent (the same trap as the capture path's *absent vs explicit `null`*, on
  the input side). Handle both, or normalise at the resolver. It took a live query to find, which is
  the argument for the live pass even when the tests are thorough.

- **Inserting a method above a decorated one steals its decorator, and nothing catches it but a live
  call.** Adding `dispatchNotifications` immediately above the existing `runAlerts` in a resolver put
  the new method *between* `runAlerts`'s `@Mutation(...)` and the method it described, so
  `dispatchNotifications` got that decorator (and its description) and `runAlerts` lost its own —
  disappearing from the schema entirely. `typecheck`, `lint` and every unit test stayed green; the
  failure surfaced when a client asked for a field the schema no longer had
  (`Cannot query field "runAlerts" on type Mutation`). After inserting a method into a decorated
  class, check the **decorator count** and re-read the generated `schema.gql` — a field silently
  vanishing is the one regression no test in this repo asserts.

- **A monthly Budget is one row per scope, and `period_start` does not roll forward by itself.**
  `budgets_unique_scope` is unique on the Household/category scope, not on the period, so a Household
  that has not touched its budget this month still has a row anchored in an **earlier** month — and
  `periodBounds('MONTHLY', row.period_start)` then describes that earlier month. Two consequences worth
  knowing: inserting a second budget for the same category fails with `budgets_unique_scope` (move
  `period_start` instead), and the insight generator's pace rule correctly filters on
  `periodStart === current period`, so a stale budget produces **no** pace insight rather than one
  projected against the wrong window. Whether the app should roll the row forward automatically is the
  budgets module's question (1.3.1), not the insight job's.

- **Never persist a suppressed notification: it burns the `UNIQUE (user_id, dedupe_key)` forever.**
  `notifications` dedupes on `(user_id, dedupe_key)`, so writing a row for a condition we *decided not
  to send* (rate-limited, rule off) makes that condition permanently undeliverable once the reason
  clears — the notification equivalent of poisoning a cache. Only `SENT` and `QUEUED` are rows;
  suppression is reported in the run summary. `QUEUED` **does** occupy the key, correctly: quiet hours
  delay, they do not drop.

- **An `HH:MM` quiet-hours window that crosses midnight inverts if you write the obvious comparison.**
  `time >= start && time < end` is correct for `12:00–13:00` and exactly **backwards** for the common
  case `21:00–08:00`, where it mutes the daytime and alerts at 3 a.m. The crossing case needs
  `time >= start || time < end`. Two adjacent traps: `start === end` must mean *never quiet* (a user
  setting both ends to `00:00` means "do not hold anything back", and reading it as "always" silently
  switches every alert off), and quiet hours **delay** rather than drop — the row is written `QUEUED`
  for docs/05 §8's `notifications.dispatch` to drain, because "do not interrupt me" is not "keep me
  ignorant". Asserted on both sides of every boundary in `packages/domain/src/alerts.spec.ts`.

- **A custom scalar provided by two modules breaks the schema at boot, not in tests.** `JsonScalar`
  was legitimately added to `InsightsModule`'s providers exactly as `ClassificationModule` has it, and
  the whole app then failed to start with `Schema must contain uniquely named types but contains multiple
  types named "JSON"`. `api:test` stayed green throughout, because a spec builds one module, not eleven.
  Shared scalars now live in `GraphQLScalarsModule` and are **imported**; never add a `@Scalar()` class to
  a second module's `providers`.

- **A service that gains a dependency must be resolvable by every module that provides it — and the
  failure is at boot, not at typecheck.** `OnboardingService` was given `EntityEmbeddingsService`
  (task 2.3.4) without adding `ClassificationModule` to `OnboardingModule`'s imports. `typecheck` was
  green; Nest failed to construct the provider with
  `Nest can't resolve dependencies of the OnboardingService (PrismaService, MerchantsService, ?)`. The
  `?` is "the dependency at index *n*", so count the constructor parameters. In a test run it is worse
  than a failure: the suite reports **18 skipped** tests, because a spec whose module cannot compile
  skips. When you add a provider, grep for every other module whose providers construct that service.

- **An insight generator whose condition is not month-scoped breaks the writer's dedupe lookup, and the
  symptom is duplicate rows rather than an error.** `InsightsService.generate` loaded the existing
  conditions with `period_start = <this run's month>`, which was safe only while every generator filed
  its draft under that month. `RECURRING_DUE` (3.4.3) files under the **occurrence's** month, so a bill
  dated the 1st was announced on the last day of the month before and then re-inserted on every run —
  the notification's `dedupe_key` hid it, so the user saw one alert while the `insights` table grew. The
  writer now looks the key up over the periods its own drafts use. When you add a generator, ask which
  period its row is filed under before assuming the run's.

- **A presigned S3 URL signs `host` but the client must not send it, and MinIO does not create a bucket
  for you.** Three traps on the upload path, all of which look like an auth failure: (1) the signer's
  header map includes `host` because it is in `SignedHeaders`, but a browser cannot set `Host` and a
  scripted client should not — the runtime sets the real one, and passing the signed value through to
  `fetch` gets it dropped or rejected; `clientHeaders`/`sendHeaders` strip it and the signature still
  verifies because the value sent is the value signed. (2) `PUT` to a nonexistent bucket answers
  `NoSuchBucket`, and MinIO never creates one on first write, so a fresh `pnpm dev:infra` needs
  `pnpm storage:init` before any presign works. (3) A presigned **PUT** cannot constrain the body —
  `content-length-range` needs a POST policy — so nothing enforces the declared size or sha until
  `commitAttachment` `HEAD`s the object; a client that lies is caught there, as `FAILED`, not at upload.

- **A row is not an object: deleting a Household leaves its uploads in the bucket.** `files.purge`
  walks `attachments` rows, and a cascade delete takes the rows away with the Household, so the
  object each row pointed at is never listed again — the dev bucket held seven orphaned
  `household/…/*.png` after a live pass' Households were deleted by hand (found while cleaning up
  task 4.1.5, then removed with a throwaway script that signs `ListObjects`/`DeleteObject` with the
  repo's own `signS3Request`; note the signer has no query-string support, so bucket-level `GET`
  — ListObjects v1 — is the form that verifies). Nothing user-facing deletes a Household yet, so
  nothing leaks in normal use, but the deletion feature docs/08's retention section implies needs an
  **object** delete or a bucket lifecycle rule, and it has to run *before* the rows disappear, because
  nothing records the key once they are gone.

- **The dispatch *reasons* are on `dispatchNotifications`, not on `runAlerts`.** `runAlerts` returns
  `AlertRunModel` — how many insights it wrote, how many conditions were deduped, queued, rate-limited
  or suppressed — and has no `reasons` field at all; asking for one is a `GRAPHQL_VALIDATION_FAILED`
  with `Cannot query field "reasons"`. The per-row explanation of an undelivered push (ADR-028
  decision 2) is on `dispatchNotifications: AlertDispatchModel`. Two mutations that call into the same
  notification pipeline, two different summaries — read the generated `schema.gql` for the one you want
  rather than assuming they share a shape.

- **`aiConsents` enumerates every purpose the client may ask about, so `NOT_ASKED` arrives as a *row* with
  `recordedAt: null` — it is not a row in the database.** The table is append-only and has no
  "asked but unanswered" state, so the absence of a decision is expressed by the API filling in the
  missing kinds (the four product purposes map onto three kinds, and only three are exposed). Two
  consequences: a client that tests `records.length === 0` to mean "nothing decided yet" is **wrong**, and
  so is a test that asserts it; and a test that asserts `records.length === 1` after one grant is wrong
  for the same reason. Read the state *per kind* (`stateOf(records, kind)`, or the row whose `kind`
  matches) and check `recordedAt` to tell "decided" from "not asked" (found live in 5.2a).

- **A test stub that returns the same array reference hides a signal transition.** A `ConsentService` stub
  that answered `aiConsents` with the very array it also pushed to made `askable` — a `computed` over
  `records` — stay cached on the first read, because `signal.set(sameReference)` is a no-op under
  `Object.is` and never notifies. Real answers arrive as freshly parsed JSON, so this is purely an
  artifact of a hand-written stub (5.2a's trigger spec): return a copy, or the transition under test
  cannot happen. The same trap applies to any stub that mutates and re-returns a signal's current value.

---

## 5. Domain: money, dates and Serbian input

The rules the domain exists to keep (ADR-003, ADR-016, I-1, I-2).

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

- **A date-only write must send `occurredLocalDate`, never an invented instant.** The server derives
  `occurred_local_date` from the instant in the *Household's* timezone, so `T12:00:00Z` is the 15th
  for a Household in `Pacific/Auckland` (UTC+13) — and the wrong *month* at a boundary, silently
  corrupting every budget total for that period. `occurredLocalDate` wins when both are sent (I-2).

- **Offline capture is idempotent** via client-generated `client_id` + `idempotency_key`. Never
  "check then insert" — rely on the unique index. *(ADR-016)*

- **An unscoped spend total must not add `transaction_splits` to whole Transactions.** A split
  Transaction carries the **full** `amount_minor` — its splits partition it, they do not sit beside it —
  so `SUM(transactions.amount_minor) + SUM(transaction_splits.amount_minor)` over the same window
  counts the split portion **twice**. The symptom is a total that is exactly one receipt too high: a
  2 245,00 basket answered as 4 490,00, and an unscoped number wrong while every per-Category figure
  beside it was right (those two sets *are* disjoint — I-1 makes a split Transaction's own `category_id`
  null). Splits are added **only** when the scope names Categories. Found in 3.3.1 when the assistant's
  fact assembly moved onto `SpendReadModel.total`; the read model's own spec now asserts the identity
  `uncategorised + Σ byCategory === total`.

- **A split's predicate belongs on its parent, not on `transaction_splits`.** A Tag lives in
  `transaction_tags`, which is parent-scoped and has no `household_id`, so filtering
  `transaction_splits` by `{ transaction_tags: { some: … } }` is an **unknown argument** — and because
  the where-clause is built by a helper whose return type is inferred, `tsc` stays green and Prisma
  fails only when that path runs. Everything that belongs to the Transaction (kind, account, merchant,
  tag, date, status) goes inside `transactions: { … }`; only `category_id` and `household_id` sit on the
  split itself.

- **A per-Category count is a count of contributions, and a Category whose spend arrived only as a
  split used to report `0`.** `byCategory`'s direct branch counts rows, and its split branch originally
  added money while leaving the count alone ("the direct count already counted this Transaction once")
  — which is false, because a split Transaction is never in a Category's direct group (I-1). A
  supermarket row therefore read *0 transactions, 17.450,00 spent*. The split rows are now read and
  counted as **distinct `transaction_id`s** (there is no unique key on
  `(transaction_id, category_id)`, so `_count._all` would have double-counted a duplicated split). The
  rollup then sums those counts, so a **subtree** figure is a sum of contributions: one receipt split
  across two children of the same parent counts twice under the parent. That is documented on the field
  rather than fixed, because a distinct count per node needs a query per node.

- **A `categoryIds` scope does not expand a parent into its children — the caller must.** The read
  model scopes by the ids it is given, and a parent Category with no spending of its own is the normal
  case, so `spendOverTime(categoryIds: [root])` silently answers **zero** for a Category whose children
  hold all the money. 3.3.1's analytics spec found it on the first run. Analytics expands the subtree
  itself (`withDescendants`, a fixpoint over the parent links) before calling the read model, which is
  also what the assistant's planner does; anything new that takes a Category id has to do the same or
  it will report a plausible zero.

- **A derived difference is a `Balance`, never a `Money`.** `Money` is non-negative by contract
  (ADR-003) because a Transaction's direction lives in `kind`, but `monthComparison.delta` and
  `cashflow.net` are *sums of many movements* and are routinely negative — a month that spent less than
  its baseline, or one that paid out more than it took in. docs/06 §4.3 wrote both as `Money`, which
  cannot be serialised at all: the domain's `money()` helper rejects a negative amount, so the first
  deficit month is an INTERNAL rather than a number. They are `Balance` (write-only on the wire, since a
  client must never supply one).

- **A docs SDL sketch omits the `Model` suffix that code-first NestJS adds.** The documents write
  `type CategorySpend`, `type Budget`, `type Insight`; `apps/api/schema.gql` has `CategorySpendModel`,
  `BudgetModel`, `InsightModel`, because Nest names an `@ObjectType()` after its **class**. Renaming the
  class to match the document renames the type on the wire and breaks every client query — the document
  is the shorthand, the generated schema is the contract.


---

## 6. Classification, rules and the learning loop

docs/04 is canonical for all of this. The recurring theme is that a second copy of a decision — a fold, a threshold, an entity — silently becomes a different decision.

- **Confidence is calibrated, not raw.** Never gate on the model's self-reported number. *(ADR-009)*

- **Category keywords are normalised, so what is stored differs from what was typed.** `addKeyword`
  lower-cases and strips accents (`septička` → `septicka`), matching how the pipeline normalises
  transaction text — which is correct, but means the chip shown back is not the input. The editor
  says so next to the field. Do not "fix" the chip to echo the input; that would break matching.

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

- **A keyword at the schema default weight can never decide a category — and neither can any seed that writes
  them at the default.** `category_keywords.weight` defaults to **1.0**; docs/04 §5.4 decides from keywords
  only at a score of **≥ 2.0** and by a margin of **≥ 1.0**. One default-weight hit scores 1.0 and falls
  through, so the shipped starter tree categorised *nothing* until 2.3.3 weighted it. The failure is invisible
  in the demo Household, because a Household-owned merchant's `default_category_id` is a *different stage*
  that always decides: **test the cold start on a fresh signup, not on seeded data.** The content now
  separates decisive (`strong`, weight 2.0) from corroborating (`include`, weight 1.0) words, and the writers
  **raise** an existing row whose weight is wrong rather than skipping it, so an old Household repairs itself.
  See docs/04 §8.1.3.

- **A resolved entity's default category used to be written at confidence 1.00 whichever rung found the
  entity — so a similarity guess auto-applied a category.** `resolutionWinner` returned only the entity and
  dropped the rung's confidence, so stage 3.5 (`MERCHANT_DEFAULT`/`COUNTERPARTY_DEFAULT`) gated at `1.00` for
  a rung-4 trigram hit (`0.55–0.85`) and a rung-5 embedding hit (`0.60–0.85`) alike. docs/04 §4 says the
  opposite in one sentence: *"rung 4 produces a candidate with a confidence, not a decision: the caller's
  confidence gate decides the lane."* Fixed in 2.3.4 by carrying `ResolvedEntity.confidence` into
  `fromEntityDefault`. When you add a rung, **carry its confidence to the gate** — and assert the *band*, not
  a flag: `needs_review` stays false here on purpose (it is I-8's blocking lane only, `< 0.60` or a `NULL`
  category), and `advisory` stays false because docs/04 §7 scopes it to `category_source = 'AI'`. The 🟡 badge
  the user sees is derived from the number itself (`apps/web/src/app/shared/confidence.ts`). See docs/04 §8.1.4.

- **`entity_embeddings.embedding` is `VECTOR(384)`, so a test fixture's stub vector must be 384 numbers.**
  A 64-dimension "small enough for a test" vector does not mis-compare, it fails every insert with
  `expected 384 dimensions, not 64` — on the sync path, one row at a time, which reads like a Prisma or
  pgvector bug. The width is a `CHECK` in docs/03 §4, not a convention; `EMBEDDING_DIMS` is the one constant
  for it, and a provider of another width is treated as *unavailable* (rung 5 inert) rather than broken.

- **Rung 5 is inert by default and that is a feature, not a missing implementation.** `EMBEDDINGS` resolves to
  `UNCONFIGURED_EMBEDDINGS` (`model: 'none'`, `dims: 0`), so the ladder ends at rung 4 in this build, the
  `embedded` count on `applyMerchantSelection` is honestly `0`, and no vector row is written. Do not "make it
  work" with a lexeme stand-in behind the interface — it would clear some thresholds and not others and become
  the thing under test instead of the plumbing (ADR-021, docs/04 §8.1.4).

- **A reversal word must not be categorised — not by a rule, not by a keyword, not by an entity default.**
  `@finmate/nlp` sets `needsDirectionConfirmation` on `Lidl vraćeno 2000` / `storno Lidl` / `refund Lidl`
  and pins no `kind` for them, because the sign is a question only the user can answer. Nothing read that
  flag until task 2.3.5, so the keyword tier matched `lidl` and the row was **auto-applied** as
  `Hrana / Supermarket` at 0.923 — an EXPENSE Category on a direction the parser had refused to guess.
  Every Category carries a `kind` (I-3), so the pipeline now returns an uncategorised **blocking** row for
  those fragments, keeping the resolved entity (so the row stays learnable) and the losing candidates (so
  the audit shows what it would have said, marked `direction-unconfirmed`). The AI is not asked either:
  a model cannot know the user's intent. Found by the evaluation harness's first run — see docs/04 §8.1.5.

- **The evaluation harness reads the shipped content, so a fixture tree would hide a seed defect.** The
  harness seeds the real starter tree and merchant catalogue through `OnboardingService` and runs all 300
  v1 golden cases through `ClassificationService.parse`. Its first run found that `categories.ts` listed
  `yettel` as a keyword of `Kuća / Internet i TV` while `merchants.ts` gives the `Yettel` merchant a
  `Kuća / Telefon` default — and a keyword outranks an entity default, so `Yettel 2,50` came out as
  *Internet i TV*. When you add a keyword, check the merchant catalogue for the same name: a name in both
  places is a contradiction waiting for whichever stage runs first. The corollary is the reason
  `dataset.spec.ts` fails on an **unlabelled** description rather than defaulting: a dataset that shrinks
  silently makes every rate that is a fraction of cases look better (docs/10 §5.9).

---

- **The first real AI provider found two prompt defects that no test, typecheck, lint or build could
  see.** Both were in the *composition* of `apps/api`'s prompt with `packages/ai`'s adapter, which is
  why neither package's own suite caught them: `packages/ai`'s adapter specs build their own `user`
  string, and `apps/api`'s tests asserted the prompt `promptFor` produced rather than the request that
  shipped. Every AI answer came back `decidedBy: AI` with `categoryId: null`.

  1. **The category list was rendered twice — once with real UUIDs, once with placeholders.** The
     adapter replaces every id with an opaque placeholder (`c1`, `c2`, …) before the request ships
     (docs/08 §6.3), so an id is not resolvable unless the adapter rendered it. `promptFor` was also
     rendering the list, with real ids, because the system prompt says *"choose a category ONLY from
     the provided list of ids"*. The model answered with a real id; `resolveId` correctly refused it,
     because the map only knows placeholders. **The split is: the caller renders the instructions, the
     adapter renders the payload.** `promptFor()` now returns the rules and one task sentence, and
     nothing that the adapter appends. Regression: `apps/api/src/modules/classification/ai-classifier.spec.ts`,
     which asserts the *shipped* message has exactly one category list, that it is the placeholder list,
     and that a `c2` answer resolves to the real id.

  2. **`json_object` mode was never told the field names.** `withJsonInstruction` appended
     *"Respond with a single JSON object and nothing else."* — while its own doc comment claimed the
     shape was described. `json_object` constrains syntax and says nothing about keys, so DeepSeek
     answered `{"category_id": "c2", "reason": "…", "alternatives": ["c3","c1"]}`: snake_case, its own
     key names, and alternatives as bare strings. Every field the adapter reads was absent. The
     `json_schema` path transmits the schema, so OpenAI was never affected — which is exactly why the
     defect survived: the one provider that needed steering was the one nobody had configured. **Fixed**
     by threading the schema into `withJsonInstruction(user, schema)` from the same constant the
     `json_schema` path transmits, so the two modes cannot describe different shapes. It costs tokens
     on every `json_object` call, which is the honest price of a provider that does not enforce a
     schema.

  The lesson for any seam that composes several layers into one wire message: **assert the bytes that
  ship**, not the value each layer returns.

- **An EXPENSE row in an INCOME category: the model's category and the deterministic direction are never
  reconciled.** The rules decide `kind` from docs/04 §3.1's Serbian income vocabulary and set
  `needsDirectionConfirmation` when the sign is a question. The AI stage decides only a *category* — and
  `PipelineCategory` carries `kind`, so the pipeline holds both halves and never compares them. Real
  symptom, reproduced live on 2026-09-16 by re-typing a user's entry: `salary 150000` → `decidedBy: AI`,
  category `Plata` (an INCOME category) and `kind = EXPENSE`, at 0.765 — the **verify** lane, so not
  blocking, not flagged, and nothing downstream ever asks. `income 150000` → `Uplata`, same shape. The
  Serbian spelling is fine (`plata 150000` → KEYWORD, `INCOME`). It is the mirror of docs/04 §8.1.5: there
  a stage decided while the direction was *unknown* (fixed by a gate that refuses); here the direction is
  *known* and a later stage contradicts it. Open, scheduled as task 2.2.7 — every fix (filter the
  candidate list by direction, flip `kind`, drop the category and ask, or set the direction flag and let
  8.1.5's gate handle it) is a product decision about which side wins, so it is recorded rather than
  patched. docs/04 §8.1.6.

- **A cached row cannot become `Money` without a currency, and the whitelist does not hold one.** The
  ledger-rows record keeps `amountMinor` as a string and no currency code — correctly, since docs/08 §3.9
  minimises *rows* — but `fm-money` takes `MoneyWire{amountMinor, currency}` and the domain's `money()`
  refuses to build a `Money` without one (ADR-003). So the moment a screen first tried to serve those
  rows there was nothing to render. The fix is on the **record**, not on the row: `LedgerSnapshot.currency`,
  because ADR-011 gives a Household exactly one ledger currency, and a currency code is not personal data
  the whitelist was written to exclude. The general shape: a cache designed for *storage* will be missing
  something a cache designed for *rendering* needs, and the gap only shows up when the first screen reads it.

- **A successful read must not clear an error another concurrent path wrote.** `/transactions` loads the
  list and, for `/transactions/:id`, fetches one row by id — two floating promises started in the same
  constructor. When the list succeeded it called `error.set(null)`, which raced the drill-in's refusal and
  wiped it: the user got an empty sheet and **no message**. The existing spec caught it
  ("surfaces a refused id in the banner"), which is the argument for asserting *observer-visible* state
  after a mount rather than the state each call returns. The rule: clear an error **before** the work that
  may fail, never after a *different* operation succeeds.

- **`whenStable()` does not wait for a floating promise chain, and the deeper the chain the more obvious
  it is.** A mounted component whose constructor starts `void this.load()` runs taxonomy → list → cache
  write, each `await` a turn. `fixture.whenStable()` resolves once the app has no queued *work*, which is
  not the same thing: one turn reaches the list query, and an assertion about what was **written to the
  cache afterwards** sees nothing. The symptom is a spec that fails while the same assertion passes by
  hand in the browser. In a mounted Angular spec, flush a few macrotasks (`await new Promise(r =>
  setTimeout(r, 0))` then `whenStable()`, three times) before asserting on a side effect that sits behind
  the promise chain.

- **A screen that serves a cache must be told what the cache does *not* hold, or it will render defaults
  the server never said.** The ledger-rows whitelist has no id, no `status`, no `needsReview` and no
  splits, and `category: null` collapses two different server states ("uncategorised" and "divided")
  into one value. Every one of those is a place a cached list could quietly lie: a row that looks
  tappable and is not, a ✓ that was never checked, "Bez kategorije" printed over a row with three
  categories. The screen's answer is to claim less — no button, no flag, nothing where the category is
  absent — and to say in one sentence that the mode is a summary. Recorded in ADR-027's 4.2.8b amendment
  with the four fields a future task would have to widen the whitelist for, and why it does not.

- **`if (row.categoryId)` is not "the row has a category" when a *proposal* supplies one.** `captureCommit`
  validated invariant I-3 in the batch phase — kind against the category's kind — behind that guard, but
  in the preview → confirm flow a row carries **no** `categoryId`: the category comes from
  `acceptedProposalId`, whose decision row is loaded later in the same method. So for that whole flow the
  check never ran. Measured, not theorised: `salary 150000` classified by the model into the INCOME
  category `Plata` on an `EXPENSE` row, committed verbatim through `captureCommit`, produced a live
  `transactions` row violating I-3 — with the suite green, because every existing test that exercised the
  proposal path happened to use a matching category. Three changes close it: the pipeline refuses the
  contradiction when it classifies (docs/04 §8.1.6), a second phase validates the category a proposal
  brings, and the write loop asserts the pair before `create` so any source nobody has thought of yet
  cannot become a row. The general shape: **a guard on `input.field` is not a guard on the value that
  will actually be written** — resolve the effective value first, then check it.

- **A stage's chosen category was never compared with the row's direction — for any stage.** Every
  Category carries a `kind` (invariant I-3) and a Transaction carries its direction in `kind` rather than
  in a sign (ADR-003), and nothing reconciled the two: rules, keywords, entity defaults and the model all
  ran. Two live shapes: the model suggesting the INCOME category `Plata` for an `EXPENSE` fragment
  (`salary 150000`, at 0.765 — the verify lane, so nothing asked), and a **keyword** putting an `INCOME`
  row described `Lidl mesec` into the `EXPENSE` category `Supermarket`, which the commit path had been
  writing since 2.2.x. The reconciliation now lives in `runPipeline`'s `finish()` — the one function all
  five stage arms return through — and refuses the category, leaving the row blocking with the suggestion
  kept as a `direction-mismatch` candidate. It is the mirror of §8.1.5's gate: there the direction was
  *unknown* and a stage had to be stopped from guessing; here the direction is *known* and a stage
  contradicted it. **One place, because the alternative is five** — a per-stage check is a check the sixth
  stage will not have.

- **A `captureCommit` row's direction never reached the classifier.** `classifyForCommit` classifies from
  `rawText` alone, and a commit row carries its amount and direction as *fields* — so `extractFragment`
  read the description `Lidl mesec` as `UNKNOWN` even for a row whose `kind` was `INCOME`, and the
  direction reconciliation had nothing to compare against. `CommitRowClassification` now takes `kind`,
  mapped explicitly from `TransactionKind` at the call site (the same rule `resolveRow` applies to
  `categorySource`: a new arm on either side should be a compile error, not a silent pass). In the normal
  flow the two agree, because the client echoes the kind the parser gave it, so only a row whose direction
  the user set — or an offline row carrying one — is affected.

## 7. Capture and the commit path

F-05/F-06 and I-10: the path where a mistake costs the user money.

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

- **Every Transaction filter goes through one builder (`buildWhere`).** The page and its `totalCount`
  used to be assembled separately and the count silently ignored the date range, so a date-filtered
  list read "8 transactions" above seven rows. The CSV export uses the same builder, so the file
  always matches the screen. Never add a predicate to only one caller.

---

- **A diff built from a partial "before" reports the row's own untouched values as changes.** The
  conflict diff (ADR-030) compares a client-held snapshot against the row the server just returned; the
  first version passed only the fields the edit *carried as different* and compared all five, so every
  field missing from the snapshot looked like a change from `null` to whatever the server held — a
  five-row diff for a one-field edit. Two rules came out of it: the comparison is limited to the fields
  the edit carried, and the snapshot must be complete **for those fields**. Asserted in
  `sync.service.spec.ts`, which is how it was caught.

## 8. Taxonomy: categories, keywords, merchants

The tables hold platform content beside the Household’s own rows, which is where most of these come from.

- **Merchants are copy-on-write, and that includes a merge target.** A global row is read-only, so
  `updateMerchant`, `setMerchantAliases` and a `mergeMerchants` whose *target* is global all create a
  Household-owned copy and move this Household's references onto it. Merging into a seed is a write
  to it (the alias union must be stored), so without the copy it fails as an opaque `P2025`. Never
  "simplify" this by relaxing the write predicate.

- **Merging is the deletion path for a Merchant in use.** `deleteMerchant` refuses with `CONFLICT`
  while Transactions, Receipts or RecurringRules reference the row; `mergeMerchants` moves them. A
  shipped Merchant is never deletable at all. The `merchants` table has **no `version` column**, so
  Merchant writes are last-write-wins — acceptable because the row holds no money.

- **Category deletion is a refusal, not a cascade.** `deleteCategory` throws `CONFLICT` while
  Transactions, Splits or subcategories still reference the row (I-12); the UI turns that into a
  reassign-target picker. Passing `reassignToId` moves children, Transactions **and** Splits. The
  CONFLICT counts are the API's, so a split-only reference reports "0 transactions, 3 splits".

- **`updateTransaction` cannot change `kind` or `splits`.** Direction is not a flippable property,
  and the parts of a divided Transaction must be edited as parts. `update()` refuses an amount change
  on a split Transaction with `VALIDATION_FAILED` rather than deleting the splits to satisfy I-1.

- **You cannot copy a global Merchant by creating one.** `MerchantsService.assertNameFree` searches every
  visible row, global ones included, so `create({ name: 'Lidl' })` is refused with `CONFLICT` — "already
  exists, merge into it instead" — which is the duplicate-name guard working as intended. The way to make a
  global row the Household's own is `update`, whose copy-on-write branch clones it and moves references.
  Onboarding step 4 depends on that, and so does any future "adopt a shipped merchant" path.

---

- **An element with `role="img"` hides everything inside it, including the links a chart needs.** A
  bar chart whose rows drill through to `/transactions` cannot be wrapped in `role="img"` "for the
  accessible label": assistive technology treats the subtree as a single replaced object, so the
  anchors inside become unreachable — an accessibility regression that *improves* the automated
  signal (the label is there) while removing the only way to reach the rows. The rule docs/07 §7.3
  actually wants is a **table equivalent** plus a takeaway label: a list of labelled, linked rows is
  already its own text alternative, and only graphics that carry no text at all (the sparkline) get
  `role="img"` and an `aria-label` saying which way the series went.


---

## 9. Web UI, templates and i18n

- **A spec that uses `TestBed` needs BOTH `// @vitest-environment jsdom` as its first line AND
  `initAngularTesting()` imported before any Angular import.** They fail differently and neither message
  names the cause: without the JIT compiler it is `Cannot read properties of null (reading 'ngModule')`,
  and without a DOM it is `ReferenceError: document is not defined` from `platform-browser`'s
  `DOCUMENT` factory. A *pure* spec (no `TestBed`) needs neither, which is why most specs do not show
  the pattern — and why a service spec that injects `GraphqlClient` (which injects `HttpClient`) does.

- **`ngsw-worker.js` shows nothing at all unless the push payload has `notification.title`.** Its
  `Driver.handlePush` broadcasts the payload to any open client and *then* returns early —
  `if (!data.notification || !data.notification.title) return;` — so a "minimal" payload of
  `{notificationId, kind, deepLink}` produces a silent no-op when the app is closed, which is the only
  moment push exists for. The title has to come from the payload because the SPA (and its i18n
  catalogue) is not running, and the click target has to be
  `notification.data.onActionClick.default = {operation: 'navigateLastFocusedOrOpen', url}` — those two
  shapes are implementation, not documented API, so read the installed worker before changing a
  payload (ADR-028's 4.2.5 amendment, R-24).

- **`SwPush.subscription` is `NEVER` when the service worker is disabled, so `firstValueFrom` on it
  never settles.** `provideServiceWorker(…, {enabled: false})` is every dev build (`!isDevMode()`), and
  in that state `SwPush` sets all four observables to `NEVER` and `requestSubscription` rejects with
  `ERR_SW_NOT_SUPPORTED`. An unguarded `await firstValueFrom(this.swPush.subscription)` is therefore a
  promise that never resolves and never rejects — no error, no timeout, just a UI stuck on "working".
  Every `SwPush` read must be behind `isEnabled`.

- **`TestBed.inject` needs a DOM even for a service with no template.** A service spec that injects
  anything the platform browser provides (`DOCUMENT`, and therefore almost everything) fails with
  `ReferenceError: document is not defined` from `platform-browser`'s factory — *not* with a message about
  the missing environment. `// @vitest-environment jsdom` on the first line is the fix, and it is needed
  even when the spec itself never touches the DOM.

- **`openDB(name, version)` without an `upgrade` callback creates an EMPTY database.** The next
  `db.getAll(store)` throws `NotFoundError: No objectStore named …`, which reads like a corrupted database
  rather than a missing schema. A spec that wants to inspect the raw database has to mirror the store's own
  `upgrade` (ADR-025 decision 1) or wait until the app has created it. Do **not** reach for `deleteDB`
  between tests: it hangs in `fake-indexeddb` (see group 2).

Angular 22 zoneless + signals, and three separate ways a template literal or a type-checker can mislead you.

- **A signal `viewChild()` read inside `afterNextRender` (or `ngAfterViewInit`) is `undefined` under
  the mounted-spec harness.** The hook *runs* — a `console.log` inside it prints — but the query signal
  has no value yet, so `this.input()?.nativeElement.focus()` silently does nothing and the test fails
  for a reason that looks like the browser's fault. Query the host element instead
  (`inject(ElementRef).nativeElement.querySelector('#the-input')`), which is available immediately and
  behaves the same in the harness and in the app. Related, and easy to get wrong in the same test: a
  fixture must be appended to `document.body` before a focus assertion means anything, because an
  element that is not in the document cannot take focus and `document.activeElement` stays `BODY`.

- **A selection set on a SCALAR is a runtime 400, and the mounted specs cannot see it.** The assistant
  screen asked for `totals { money { amountMinor currency } }`; `Money` is a custom **scalar**, so the
  query is invalid and the API answered `400 GRAPHQL_VALIDATION_FAILED` — in the app, every assistant
  answer failed to load, while `typecheck`, `lint`, `web:build` and the mounted spec (which mocks
  `GraphqlClient`) all stayed green, because the spec never sends the query anywhere. Scalars are
  selected **bare** (`money`, `amount`, `formatted` — `JSON` and `Money` alike), and the only thing that
  catches a mistake here is a request against the real schema: **validate every client query against
  `apps/api/schema.gql`** (the `graphql` package can do it in a test) or run the screen live.

- **`[routerLink]` with a query string inside the string percent-encodes the question mark.** The
  assistant's drill-through built `'/transactions?from=2026-09-01&to=2026-09-30'` and rendered
  `href="/transactions%3Ffrom%3D2026-09-01&to%3D…"`, because Angular treats the whole string as a
  single path **segment** — the link goes nowhere, and nothing fails: no error, no 404 until the user
  clicks. Route and parameters are separate inputs:
  `[routerLink]="target.route" [queryParams]="target.queryParams"`. A test asserting the rendered
  `href` is what catches it; the pure "what URL should this be" function cannot, because the bug is in
  what Angular does with the string.

- **A CSS custom property nobody defines still resolves — to its fallback, silently — and for a colour
  that means picking a theme.** The app's tokens are `--color-*` (`apps/web/src/styles.css`). Four
  components — `notifications`, `settings`, `consent-purpose`, `consent-sheet` — referenced `--fm-muted`,
  `--fm-border`, `--fm-surface`, `--fm-critical`, `--fm-positive`, `--fm-warning` and `--fm-accent`, and
  **not one of those is defined anywhere in the repository**. Every use carried a light-theme fallback, so
  the fallback always won: in the dark default theme the consent sheet drew `#fff` behind text set in
  `--color-text` (`#ececf1`) — a measured **1.18:1**, an invisible heading — and the settings and
  notifications muted text came out at **3.31:1**, under the 4.5:1 the DoD requires. Nothing caught it,
  for four compounding reasons: no test asserts colour; jsdom has neither layout nor computed custom
  properties; the mounted specs and the live pass asserted `textContent`, which is non-empty even when
  the text cannot be seen; and `typecheck`, `lint` and `web:build` are all indifferent to CSS values.
  The 25 occurrences were mostly **copied** — the two consent components were written from the settings
  and notifications styles — which is how a phantom token spreads.
  The fix is a token swap (`--fm-muted`/`--fm-border`/`--fm-surface`/`--fm-accent`/`--fm-critical`/
  `--fm-positive`/`--fm-warning` → `--color-text-muted`/`--color-border`/`--color-surface-raised`/
  `--color-primary`/`--color-danger`/`--color-success`/`--color-warning`), after which the same
  measurements read 14.06:1 dark and 18.02:1 light for the sheet's heading, 7.37:1 and 6.26:1 for
  settings' muted text. **The rule: never write `var(--x, fallback)` for a token you have not seen
  defined** — grep it in `apps/web/src/styles.css` first. A fallback is a silent default, and a silent
  default for a colour is a theme nobody chose. Note the asymmetry that makes this nastier than a typo:
  an *undefined* token with no fallback is also silent (the declaration is dropped) but fails loudly on
  screen, whereas one *with* a fallback renders something plausible. **There is no automated guard**, and
  the honest reason is that tokens are legitimately defined outside `styles.css` — component-local custom
  properties, inline `[style.--x]` bindings — so a "every referenced token is defined" check has real
  false positives. The instrument is the measurement: resolve the computed `color` and the nearest
  non-transparent ancestor background and compute the ratio (a few lines, run through Playwright).

- **`position: sticky` does nothing when the element is the last child of its containing block.** The
  shift a sticky element may take is bounded by its containing block, so a bar at the *end* of a column has
  no slack below it to be pulled up into — it stays exactly where it would have been. Measured in 4.3.1b:
  `position: sticky; inset-block-end: 0` on the capture screen's action row computed to `sticky` while the
  confirm button still sat **1431 px down on a 720 px viewport**. The trap is that a sticky rule which does
  nothing looks identical to one that works if you only measure at the end of the scroll: scrolling to the
  document end puts the element there naturally, so the check passes for the wrong reason (the first
  version of this very check did). Measure the *middle* of a scroll. The fixes are to give a parent
  `overflow-y: auto` and stick *inside* that scroll container — where the slack is the scrollable overflow
  — or to leave the flow entirely with `position: fixed`, offset by whatever sits below. Recorded for
  `/capture` as task 4.3.1c.

- **A colour can be *defined* and still be unreadable — and an *undefined* one falls back to the user
  agent's blue.** The phantom-token entry above is about `var(--x, fallback)` where `--x` does not exist.
  4.3.1d's audit found the two neighbouring shapes, and both look like working CSS:
  - `--color-text-subtle` **was** defined, at `#6e6e80` — **3.31:1** on `--color-surface-raised`, below
    the 4.5:1 docs/02 §9 requires, across **153 element-route pairs** on 20 screens (hints, row metadata,
    the topbar role, the capture examples label, account and merchant row badges). No test, typecheck or
    build can see it: a token's *value* is only wrong relative to the surfaces it lands on.
  - **three anchors had no `color` at all** (`fm-budgets`' footnote link, `analytics.controls__csv`,
    `settings`' `a.btn`) and therefore rendered the browser default `#0000EE` — **2.02:1** on
    `--color-bg`, i.e. invisible. There was no global `a` rule; the app's convention was a per-component
    `.link { color: var(--color-primary) }`, so every new anchor was one omission away from the same bug.
    Fixed at the class level, not the instance level: a single `a { color: var(--color-primary) }` in
    `styles.css`, which component classes still override.
  **The instrument is the only thing that finds this**, and it is cheap: resolve each text element's
  computed `color` and its nearest non-transparent ancestor background, compute the ratio, compare it
  against 4.5 (or 3 for large text). Two details that keep such a report honest: **disabled controls are
  exempt** (WCAG 1.4.3) and must be *reported as exempt* rather than dropped, or the exemption looks like
  a pass; and a token swap has **two** halves, so a light theme has to be measured separately — a fix that
  darkens text for the dark theme can as easily fail on white.

- **Offline, `ngsw` answers an uncached request with a synthetic `504`, not a network rejection.** Angular's
  service worker does not fail a `fetch` for a URL it has no strategy for — it *responds* `504 Gateway
  Timeout*. So a client that classifies "we are offline" by catching a thrown `TypeError`/`net::ERR_*` will
  mis-read it, and one that classifies by status has to treat `504` as retryable. Measured in 4.3.6 while
  verifying F-26 offline: `/graphql` is deliberately outside the worker's `navigationUrls` and has no
  `dataGroups`, so every offline GraphQL call came back **504**, and that is what makes the offline capture
  take the queue path at all (the capture's own commit sees a retryable failure and queues). ⚠️ The first
  reading of that pass — *a queued capture is dropped on flush* — is **refuted by 4.3.6's diagnosis**: the
  flush was refused by the server, the client parked it as *cannot be sent*, and the tray said so on the
  page that flushed it. What was missing was the **store** it was parked in: see the two entries below.
  A second consequence worth knowing before writing an offline test: `context.setOffline(true)` in
  Playwright *plus* a service worker means the page still gets HTTP responses — the app is not "offline"
  in the sense of "no responses", which is exactly why the shell can boot at all.

- **The API's structured log is boot-only, so a client/server disagreement cannot be split by reading it.** Found trying to
  diagnose R-27: the pass showed a queued capture's flush returning **HTTP 200** while the database held nothing, and the obvious
  next question — "did the request even reach the API?" — has **no answer in the logs**, because `/tmp/api-dev.log` contains the
  Nest boot sequence and nothing per-request (`grep -c graphql` returns the module-loader line). docs/11 asks for structured JSON
  logs and the filter/error paths do log, but there is no request log, so a live cross-check between what the browser saw and what
  the server did is impossible. When a defect is "the client thinks X, the server did Y", **add the request log before hunting** —
  otherwise the only evidence is the client's own account of events.

- **`page.route` does not see service-worker-mediated requests, so "no requests" is not "no requests made".** Chasing
  R-27, a Playwright route handler on `**/graphql` recorded **nothing** during a flush, which read as "the response came from
  the service worker". It did not: the page was controlled by `ngsw`, and Playwright's `page.route` does not intercept traffic
  the worker mediates (the docs' remedy is `serviceWorkers: 'block'`, which for this app is useless — a lazy route cannot load
  its chunk offline without the worker). **The instrument that works is inside the page**: an `addInitScript` that wraps both
  `window.fetch` *and* `XMLHttpRequest.prototype.send` (Angular's `HttpClient` may use either) and records the body of every
  `/graphql` response. It immediately produced the server's own refusal message, which the network layer could not.
  Two lessons worth keeping: when the app consumes a response body, **Playwright cannot read it afterwards** — record it in the
  page or not at all; and a *fetch/XHR* wrapper is agnostic to both the transport and the service worker, which is what a
  client/server disagreement needs.

- **A documented method that was never written is a silent hole.** `app-lock.service.ts`'s module doc says
  "`OfflineStoreHolder.invalidate()` rebuilds the backing when the state changes" — and `OfflineStoreHolder`
  has no such method; its whole API is `repository()` and `generation()`. Found by 4.3.6's diagnosis of
  R-27, after the offline pass showed a queued capture that survived nothing. The backing is chosen from
  `keyProvider.persistent` **when `repository()` is called**, so while the app is locked the boot builds the
  in-memory backing — and after the unlock it stays in memory unless some *data* consumer (the dashboard's
  snapshot, the ledger cache, a taxonomy record) happens to call `repository()` again. The queue's own
  consumer never does: `SyncService.outbox()` reads `generation()` **before** it calls `repository()`, so it
  cannot notice a change nobody triggered. Measured in the production build, lock armed and unlocked:
  IndexedDB's `outbox` is **empty** after an offline capture the chip counts as queued (*Waiting to send
  (1)*), and one fresh dashboard mount after the unlock makes the *same* capture land there
  (`outbox: ["1"]`). The rule generalises: when a class doc names a method, grep for it — a missing one is
  invisible to typecheck, lint, and every spec that constructs the class around a working fake. **Fixed in 4.3.6a** (ADR-025's amendment): the provider announces the change as a `durability` signal, the holder watches it, and `SyncService` reacts by dropping its cached outbox and re-reading. One thing the fix must **not** do: invalidate on the effect's *first* run — that discards an in-memory backing whose contents are the only copy, and the dashboard's mounted spec (which seeds a snapshot before the first change detection) caught exactly that.

- **A record on disk is not a record the app can read.** The other half of the same defect, and it is why
  "the queue survives a reload, on disk" was believed for two releases. In the production build the reload's
  tray reads *0 waiting to send, 0 refused — Nothing is waiting to be sent* **while IndexedDB holds
  `outbox: ["1"]`**. The boot happens locked, so `SyncService`'s constructor flush builds an outbox over the
  in-memory backing and `refresh()` reads that one; unlocking changes the durability the holder *would*
  report but nothing re-reads the queue, so the signals stay empty even after a consumer switches the
  backing. A fix has to do both halves — rebuild **and** re-read — and the honest test is the user-visible
  one, not a count of IndexedDB records: reload, unlock, open the tray, and see the entry with its state. **Both halves are fixed in 4.3.6a** and verified live 4/4 against the production build.

- **A task an adapter implements but a factory never declares is `TASK_NOT_SUPPORTED` at runtime.** The
  assistant answered every question with the deterministic template — `narrationMode: TEMPLATE_FALLBACK`,
  `reason: PROVIDER_UNAVAILABLE:TASK_NOT_SUPPORTED` — while `aiEgress` listed `NARRATE` as routed. Both cloud
  factories declared only `PARSE` and `CLASSIFY` in their model map; `LOCAL` declared all five. The adapter's
  `narrate()`/`callNarrate()` were implemented and tested, and the router's own `supportsTask` said yes, so the
  refusal came from *inside* the adapter, where "a task with no entry in `models` is not supported by this
  adapter" is the rule. A deployment that configured EEA-hosted narration — the configuration docs/04 §9
  describes as the intended one — therefore got templates, silently, and the reason named the *task*, not the
  map. Fixed by declaring `NARRATE` in both cloud factories, with a spec asserting every factory declares each
  chat task. Two lessons: **`aiEgress` reports the routing table, not the adapter's capability**, so it is not
  proof that a call will work; and when a seam has an `UNCONFIGURED_*` twin, read the factory's model map before
  believing a task is routed.

- **The same suite can differ from CI by *collation*, not by code.** The run right after the seed fix failed
  on one assertion: `tags.integration.spec.ts` listed `['alpha', 'Beta', '#vanredno']` where the test expected
  `['#vanredno', 'Beta', 'alpha']`. Nothing in the code had changed — the **database's collation** had. That
  assertion re-sorted the returned names with JavaScript's `<`/`>` (code-unit order), which is what a `C`
  cluster returns and *not* what an `en_US.utf8` one does: glibc ignores leading punctuation at the primary
  level, so `#vanredno` sorts last there and first under `C`, and case is a secondary difference, so
  `alpha`/`Beta` swap too. `infra/docker/compose.dev.yml` pins `--encoding=UTF8 --locale=C` ("so ORDER BY does
  not differ between machines"), and CI's service container passed no `POSTGRES_INITDB_ARGS`, so it got the
  image's `en_US.utf8` default. Reproduced exactly — character for character — by creating one scratch
  database with `LC_COLLATE 'en_US.utf8'` on the same server; the failure is one file, and the whole API suite
  passes on that database once the assertion stops assuming a collation. **`ORDER BY` on text is a deployment
  property, not a contract**: assert it with names every collation agrees on (lowercase ASCII, created in the
  opposite order to their names so insertion order cannot pass for name order), and pin the *cluster* locale in
  CI as well as in dev. A "CI-like" reproduction that only matches the database's *contents* is not CI-like —
  the locale is part of the environment.

- **A suite that needs seeded content is green locally and red in CI — and the failures name the assertions,
  not the seed.** Found by CI on 4.3.6's push: `api:test` failed every run while the same command passed on this
  machine. The difference was the database, not the code: three API integration specs (`global-reads`,
  `merchants`, `onboarding`) assert how the **shipped** merchant catalogue behaves, and that catalogue is
  `pnpm db:seed` output that every developer's database happens to have. On a database with migrations and
  nothing else — which is what the CI service container is — they failed with **eleven** assertion errors across
  the three files, none of which mentioned a missing seed. Reproduced exactly by migrating a scratch database and
  running the suite against it with no `.env`. The fix has two halves, because either alone is a half-measure:
  **CI seeds the globals** before the suite (the shipped content is part of the environment the specs document,
  and no spec can create a global row — ADR-008 has no unguarded write path), and the three specs call
  `requireShippedGlobals` from `apps/api/test/shipped-globals.ts`, which fails by name with the command to run.
  The general rule: when a spec depends on data it does not create, say so in *code* — a precondition that
  fails with the fix in its message costs three lines, and an eleven-failure mystery costs an afternoon.

- **A guard that redirects has already consumed the deep link, so a later state change cannot honour it.**
  Found while verifying 4.3.6c: a reload offline on `/transactions` runs the router's **initial** navigation
  while the lock is still `LOCKED`, so `authenticatedGuard` sends it to `/sign-in` — and by the time the PIN
  unlocks the app, `location.pathname` is `/sign-in` and the requested route is gone. A shell effect that
  then navigates (`offlineOnly() → /pending`) works, but the user's destination is lost: the cached ledger
  was reachable **by URL only**, from a screen with no navigation. The fix is not to remember the URL — it is
  to offer the routes that work as **links** on the state's own screen (ADR-033 decision 2). The general
  rule: when a guard redirects on a state that can change without a navigation, the destination has to be
  re-reachable from the new state's UI, or it is gone.

- **An offline capture has no account, so the server refuses the whole batch.** `capture.component.ts`'s
  `load()` reads `accounts` and `categories` together and sets `accountId` from the first live account; when
  that query fails — offline it always does, and the worker answers `504` rather than rejecting — the signal
  stays `''` and `commit()` sends `defaultAccountId: null`. The online path hides it completely, because
  there the same query answered a moment earlier. The API will not default it (docs/06 §5.2.1) and refuses
  the whole atomic batch with its own message (*a row with no accountId needs a defaultAccountId on the
  request*), so an offline capture can never land until the composer has an account offline. Found by R-27's
  diagnosis, 4.3.6. **Fixed in 4.3.6b**: the composer writes and reads ADR-025 decision 5's taxonomy
  cache — the same record that names *"the categories and accounts the composer needs"* — so the
  `taxonomy` store finally has a writer and a drained batch carries a real account.

- **A cache warmed while the lock is off is memory-only, so the reload that arms it throws the cache away.**
  Found while verifying 4.3.6b: the first live run opened `/capture` online *before* arming the app lock, so
  the account and category lists went to the in-memory backing (ADR-025 decision 3 — with no wrapping secret
  nothing confidential reaches disk), and after `reload` → arm → unlock the offline capture had no account
  and was refused exactly as before the fix. The order is the whole story: **arm the lock, unlock, then let
  the screen that caches something read it.** The same trap applies to the snapshot and the ledger cache —
  both are written by whatever screen reads them, so a session that armed the lock afterwards has nothing
  cached until it visits those screens again. (It also means the exit criterion is verified in the order a
  user would take: nothing else about offline storage works before the lock is armed.)

- **No hardcoded user-facing copy.** Every string goes through `I18nService.t('key')`. English is
  primary and is the source of the key set: add the string to `translations/en.ts` first, then to
  `sr-latn.ts` (typed, so a miss is a compile error). `sr-Cyrl` is generated — never edit it. A
  component that calls `t('key')` in its template re-renders on a language change because `t` reads
  the locale signal; do NOT introduce an impure pipe for this.

- **`fm-money` takes its locale from the active language**, so an amount is never formatted in one
  language while the page is in another.

- **`nx run web:typecheck` does NOT check templates; `nx run web:build` does.** `tsc --noEmit` skips
  Angular's template type-checker, so a dynamic `i18n.t('x.' + value)` (not assignable to
  `TranslationKey`) or a required `input()` read in a constructor (NG8118) pass `typecheck` and fail
  `build`. Run `web:build` before believing a UI change is green.

- **Never put a backtick inside a `template:` or `styles:` literal — including inside a comment.**
  Both are JS template literals, so a backtick *terminates the string* and the remainder is parsed as
  code. The error names neither the file nor the real problem: `Failed to resolve styles at position
  N to a string` / `Failed to resolve template at position N`, usually surfacing as
  `Angular compilation initialization failed`. **It has cost real time sixteen times**, and the shape of
  the cause never changes: a comment that names a property, a class or a CSS value reaches for backticks
  by reflex. Twice from a CSS comment documenting a property; three times in 2.3.2b from *two* HTML
  comments and a CSS comment written in the same sitting; again in 2.3.3b from a comment quoting
  `septička jama`, **written minutes after adding this entry**; again in 3.1.4's follow-up from an HTML
  comment naming the `NAV_ITEMS` constant; again in 4.2.1b from an HTML comment inside the shell
  template; again in 4.2.6b naming the new settings route; again in 4.2.7b quoting the tray's own *Zašto*
  line; again in 4.2.8b quoting the word `null` in the cached-list branch; again in 5.2a quoting a
  computed's name in a comment *about* this trap; and then **five times in 4.3.1 alone** — five comment
  blocks in one task, three of them in `styles:` blocks quoting a CSS value (`minmax(0, 1fr)`, `100vh`,
  `flex-end`).
  Two failure shapes, and they look different. When the stray backtick pairs with a *later* delimiter
  into something syntactically invalid, `tsc` reports `TS1005: ',' expected` or oxc reports
  `PARSE_ERROR` **at the first markup line after the comment** — naming neither the file's template nor
  the comment — and `const X = /* GraphQL */ \`` lines further down show as stray backticks. When it
  pairs into a valid *interpolation*, the file compiles and Angular fails later with the position-N
  message above, naming no file at all (that is the 4.3.1 shape). In an **HTML comment** inside a
  template the errors are worse than a parse failure: `web:typecheck` reported `TS2322` and
  `TS2304: Cannot find name 'settings'` against a `routerLink` two lines below, because everything after
  the stray backtick parsed as an interpolation. If a template error names an identifier that is
  obviously fine, count the backticks in the file before anything else. **Scan the whole file, not the
  `template:` region** — 4.3.1 proved why: a targeted scanner desynchronises on the `grid-template:`
  shorthand, which looks like a `template:` property, and then cheerfully reports zero strays on a file
  that has one. Two habits still worth having: describe an example in words (a bill such as septicka
  jama), and write CSS/HTML comment prose with no backticks at all.

  **Guarded since 4.3.1.** `eslint.config.mjs` carries a local rule, `local/no-interpolation`, which
  errors on any `template:` or `styles:` literal containing an interpolation — precisely what the
  compiling variant of this bug produces, and therefore the case Angular reports without a location. It
  was verified to fire on a fixture and verified to have **no false positives** across all 9 projects:
  the app has zero legitimate interpolations in those two properties, because Angular's syntax is
  `{{ }}`, `[x]` and `@if` while CSS has no `${`. The non-compiling variant remains a parse error that
  oxc reports with a location. `pnpm lint` runs in CI, so this class cannot reach `main` again — but the
  cause is a reflex, so the guard is a net, not a licence.

- **A spec file's decorators need that file to be inside its tsconfig's `include`.** Vite resolves a
  file's tsconfig *by path*, and a file the tsconfig excludes is transformed without
  `experimentalDecorators` — so an `@Component` in an excluded spec fails with a bare
  `SyntaxError: Invalid or unexpected token` that names neither the file nor the decorator. This is
  why `apps/web/tsconfig.json` includes specs (and why `web:typecheck` now checks them, which it never
  did before) while `tsconfig.app.json` excludes them again so the production program stays clean.
  Three consequences worth knowing. (1) `paths` in a child tsconfig **replaces** the parent's map, so the
  `@finmate/*` aliases are repeated there. (2) A mounted-component spec needs
  `// @vitest-environment jsdom` plus `initAngularTesting()` from `@web-test/angular-testing` imported
  **first**, before any other Angular import — the partially compiled Angular packages need
  `@angular/compiler` already loaded, or it fails with "The injectable 'PlatformLocation' needs to be
  compiled using the JIT compiler". `@angular/router` is the usual trigger, but `@angular/common` is the
  one that names it, so importing `Location` or `DOCUMENT` from it directly fails the same way (hit in
  4.2.1b). (3) **Because the build compiles specs, a spec may not import a Node builtin.** Adding
  `node:fs` to read a config file type-checked fine under the vitest transform and then failed
  `web:build` with `TS2591: Cannot find name 'node:fs'` (the web tsconfig has `"types": []`); the fix is
  to `import` the JSON instead, which needs `resolveJsonModule` (4.2.1b's `ngsw-config.spec.ts`).

- **Angular's JIT does not discover `input()` signal inputs, so a mounted test cannot render a
  signal-input child — and `CUSTOM_ELEMENTS_SCHEMA` alone does not make it opaque.** Under JIT (which is
  what Vitest runs, unlike the AOT production build) the parent's binding is dropped, the child's required
  input never arrives, and reading it throws NG0950. `web:build` accepts the very same binding, so it is a
  JIT limitation and not a template bug. Two ways out, and the difference matters:
  - **Drop it**: `TestBed.overrideComponent(Parent, { remove: { imports: [Child] }, add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] } })`.
    `remove` is the load-bearing half — adding the schema *without* removing the import still instantiates
    the real component, because the decorator's `imports` win over the schema, and the spec fails with the
    same NG0950 it was trying to avoid (measured in 5.2a). Then assert the parent's own contract and let
    the child's own spec mount it directly.
  - **Mount it directly**: `setSignalInput(component, 'name', value)` from `apps/web/test/angular-testing.ts`
    (`Reflect.get(field, ɵSIGNAL)` + `applyValueToInputSignal`), which is how the consent card and sheet
    specs assert their sentences.
  - **And not `viewChild()` either** (found in 4.3.1b): a `viewChild.required<ElementRef<...>>('x')` on an
    element the template *does* render still throws NG0951 under JIT, so a component that touches its own
    DOM through a signal query cannot be mounted in a spec at all. `@ViewChild` (the decorator) is
    discovered; the signal API is not. When a spec needs the behaviour anyway, **spy on the private method
    that consumes the query** — `vi.spyOn(component as unknown as { close: () => void }, 'close')
    .mockImplementation(() => undefined)` — and assert the decision, then verify the platform half live.
  - **jsdom implements no `<dialog>`**: `HTMLDialogElement.prototype.showModal` and `close` are both
    `undefined`, so a native-dialog sheet cannot be opened, closed or cancelled in a spec — `close()`
    neither sets `open = false` nor fires a `close` event. Everything a dialog does for free (top layer,
    focus containment, `Esc`, inertness of the page behind it) is therefore platform behaviour, verified
    in a browser (4.3.1b's live pass) and not in CI. Do not paper over it with a hand-rolled div modal:
    the platform version is the one that is correct.

  Callers that need the *real* child rendered inside a parent have no option yet: AOT-compiled tests would
  fix it and the repo does not run them. `capture.component.spec.ts` drops both `fm-money` and
  `fm-consent-sheet` for this reason, and asserts amounts and the trigger on the component's own state.
  Do not "fix" any of this by weakening the component.

- **An attribute binding stringifies whatever it is given, so `[attr.x]="signal"` silently renders the
  signal.** Forgetting the call on `[attr.aria-labelledby]="headingId"` and `[id]="headingId"` produced
  `[Computed: consent-ask-ai_data_processing]` as the element's id and its label reference — a region
  labelled by a string that names no element, which is an accessibility bug with no console warning.
  **`web:typecheck` cannot see it and `web:build` accepts it** (an attribute binding takes `unknown`), so
  only a spec that reads the rendered attribute catches it; two of them in one file went unnoticed until a
  spec asserted `aria-labelledby` equals the heading's `id` (5.2a). Prefer the property form where one
  exists, and assert the DOM value — not the component field — for any id/`aria-*` pair that must agree.

- **`fm-money`'s `accessibleLabel` hardcodes the Serbian words `prihod`/`trošak`.** Found while reading the
  component in 2.3.2b; **not fixed**, because it is a shipped component on the money path and the fix (two
  `confidence`-style catalogue keys plus `i18n.t`) deserves its own change and its own test run. It violates
  the DoD's "no hardcoded user-facing strings" rule, and it is the only known instance.

- **A glob pattern inside a block comment terminates it.** `src/**/*.ts` contains the sequence `*/`, so a
  `/** … */` doc comment that names a glob closes early and the rest of the sentence is parsed as code. The
  error is a bare parse failure pointing at the comment (`[PARSE_ERROR] Unexpected token` / `TS1005`), which
  reads like a syntax typo in the file. Same family as the backtick-in-a-template trap: **prose that quotes
  code is prose that can end its own container.** Say "the source tree" instead, or escape it as
  `src/**&#47;*.ts`. Cost real time on `packages/domain/src/seed/index.ts`, explaining why that content does
  not live beside `src`.

- **A running worker and the API integration suite share one dev database, so the worker will act on
  the tests' Households.** `runAsSystem` enumerates **every** Household by design (ADR-022), so a
  per-minute `notifications.dispatch` — or an hourly `recurring.materialise` — happily writes rows into
  the synthetic Household an integration test created two seconds ago. A test that counts insights,
  notifications or transactions then sees work it did not do, and the symptom is a suite that passes on
  its own and fails in a full `pnpm test`, with no code change to explain it (measured: `api:test` green
  alone, red in a full run with the worker up, green again once it was stopped). Stop the worker before
  running the suite, or point it at its own database. The worker's own spec is immune because it calls
  `runJob` directly and never starts the scheduler.

- **A mutation's selection is not the screen's state: a field the mutation does not ask for is
  `undefined`, not "unchanged".** `reconcileReceipt` is called for five different actions and its
  document selects no `transactionId` (the published selection is deliberately partial), so a screen
  that read the link straight off the *response* would draw `DETACH_TRANSACTION` as a no-op — and a
  caller that asserts `response.transactionId` gets `KeyError`. The receipts screen sidesteps it by
  re-reading the full `receipt` query after every mutation; a probe that reuses the screen's own
  document must do the same. Merging a partial answer into screen state is how one row silently loses
  a field (docs/02 §4.11, `receipt-detail.component.ts`'s class doc).

- **A spec that dispatches on the query string can serve the wrong document, so it proves nothing about
  the real schema.** `transactions.component.spec.ts` mocked `GraphqlClient` by matching
  `document.includes('query Transactions')`, which also matches the drill-in's `query Transaction(`;
  the mock needs the parenthesis, and the list filter needs the closing one. This is a second face of
  the 3.2.4 defect (a `money { amountMinor }` selection set on a **scalar**, which every mock accepted
  and the API refused with a 400). Until a test parses every feature's documents against
  `apps/api/schema.gql`, a mounted spec proves wiring and **not** that the API will answer — so any new
  document still needs one live call (task 4.1.5 ran its own documents out of the component source
  against a fresh Household for exactly this reason).


---

- **`vi.fn()` with no declared parameters makes `mock.calls[0][0]` a compile error — and only `web:build`
  reports it.** A bare `vi.fn(() => Promise.resolve(x))` infers a **zero-argument** signature, so
  `mock.calls` is typed `[][]` and `calls[0]?.[0]` is `TS2493: Tuple type '[]' of length '0' has no element
  at index '0'`. `npx tsc --noEmit -p apps/web/tsconfig.json` passed on the same file;
  `npx nx run web:build` failed, because the Angular build type-checks **specs** as well as templates (the
  counterpart of the `web:typecheck` does-not-check-templates trap). Type the double's signature when it is
  read back — `vi.fn<(document: string, variables?: Record<string, unknown>) => Promise<unknown>>(…)` — and
  a cast of `mock.calls[i]` needs `as unknown as […]`, the same shape the capture specs already use.

- **A disclosure must come from the server, because a hardcoded provider name is a claim.** The consent
  sheet has to name the provider and the region (docs/08 §6.6), and the tempting implementation is a string
  in the client's catalogue: `"DeepSeek (China)"`. That is precisely the class of assertion ADR-031 exists
  to remove — `DEEPSEEK_EU` was a suffix on a Chinese host and the suffix satisfied the residency check — so
  the answer comes from `aiEgress`, which projects the *routing table the router enforces* and derives the
  region from the registry's own predicates. The client supplies only the sentence and the translations.
  One consequence worth knowing when reading that mapping: it fails **closed**, so an endpoint that is
  neither `LOCAL` nor `_EU` is reported NON_EEA rather than defaulting to something reassuring.

- **Modelling "no value" as an empty catalogue string is a defect, not a shorthand.** A per-purpose note
  key with `''` for the two purposes that need none fails the i18n spec, which asserts every catalogue value
  in every locale is non-empty (`consent.kind.*.note` did exactly that). The fix is one key for the case
  that needs a sentence plus one condition, rather than three keys of which two are empty — and it keeps
  the missing-key cast out of the template.

- **In a mounted spec, scope a query to the card you are testing.** The settings screen renders every
  consent purpose, so `querySelectorAll('button')` finds the *other* purposes' buttons: an assertion like
  "Decline is not offered once permission is held" fails for a reason that has nothing to do with the
  purpose under test — the screen was right and the test was wrong. Find the `article` by the name it
  renders, then query inside it.

## 10. Cross-cutting rules of the codebase

- **A live check that measures the wrong element lies in both directions.** Three times in 4.3.1 a
  browser assertion was wrong about the app rather than wrong in the app, and each had the same shape:
  the selector matched a *different* element that happened to satisfy it. (1) `fm-capture .actions`
  matched the **consent sheet's** action row, because the sheet renders inside the capture screen and
  comes first in DOM order — the check then reported a static bar and "proved" the pinned bar was broken.
  (2) `page.fill('input[formcontrolname="amount"]', ...)` filled the capture screen's amount field rather
  than the dialog's, silently, because page-level `fill` uses the **first** match while `locator()` is
  strict — so the sheet's form never became dirty and the dirty guard looked broken (it works: with the
  locator scoped to `dialog[open]`, `Esc` raises the confirm). (3) A count taken immediately after a
  route change read `0` while the next `click()` on the same locator succeeded — a missing `waitFor`, not
  a missing row.
  The rules that follow: **scope every locator to the component under test** (`dialog[open] …`,
  `.preview .actions`), never to a bare class name that another component may also use; prefer
  `locator()` over page-level `fill`/`click`, and read the complaint when it is strict about two matches;
  and when a check fails, prove the *element* before believing the *finding* — in all three cases the
  app was fine and the instrument was pointed at the wrong node.

Short, and load-bearing.

- **`račun` is ambiguous in Serbian** — it means both *Account* and *receipt/bill*. Never use bare
  `račun` in UI copy for a Receipt.

- **If code and docs disagree, that is a bug in one of them.** Fix the right one and say which.

- **A spec that builds a service by hand (`new SomeService(prisma, stub, store)`) breaks when a
  constructor parameter is inserted in the middle — and it breaks as `X is not a function`, not as a
  type error.** Nest injects by type, so the module graph survives an inserted dependency; a manual
  `new` injects **by position**, so every later argument shifts one place and the service holds a
  `CalibrationStore` where it expects an embeddings service. That is how 37 tests failed in 2.3.4 while
  `typecheck` and `api:build` stayed green: `this.embeddings.isAvailable is not a function`, thrown
  from deep inside `parse`. Prefer the module under test (`Test.createTestingModule`) over a manual
  `new`, and when you do construct by hand, prefer one options object over positional arguments.

- **`classification_decisions` has no `needs_review` column, and a test will not tell you until it
  runs.** `needs_review` lives on `transactions` (I-8 is about the row the user sees), so a decision's
  blocking status is *derived* from its confidence and whether a category was decided at all. `tsc`
  catches the bad `select` (`TS2353 ... does not exist in type 'classification_decisionsSelect'`), but
  **Vitest runs under SWC and does not typecheck**, so the mistake reaches Postgres and fails as
  `Unknown field 'needs_review' for select statement on model 'classification_decisions'`. Assert the
  confidence on the decision row and the flag on the transaction.

- **A scheduled job that calls "generate" without "evaluate" writes rows that never become anything.**
  `insights.generate` called `InsightsService.generate`, while the pipeline's second half — turning an
  insight into a notification — lived only in `NotificationsService.run`, which only the `runAlerts`
  mutation called. The scheduler was green, the `insights` table filled, and no user was ever told
  anything. A scheduled job must call the **pipeline's** entry point (`run`), not its first stage;
  docs/05 §8 now says so for this job, and `apps/worker/src/jobs.integration.spec.ts` asserts a condition
  reaches the notification table.

- **Vitest's 5 s default timeout is a flake generator once `nx run-many -t test` runs the api and worker
  integration suites against one database in parallel.** The recurring suite's *"materialises every due
  rule when no ids are given"* takes ~3.7 s alone and crossed 5 s under that load, failing as
  `Test timed out` on a change that touched neither. There is no global `testTimeout` in
  `apps/api/vitest.config.mts`, so a genuinely heavy integration test needs an explicit
  `it(name, { timeout }, fn)` — and the comment should say the work is real rather than slow code. It
  also failed in a full run and **passed alone**, which is the signature of every load-sensitive flake.
  The web suite has the same problem now that it mounts 14 components: `onboarding.component.spec.ts`'s
  *"shows step 1 with the tree it is about to create"* builds the 39-node seed tree in the component
  (~3.8 s alone) and timed out in 4.2.1b's full run, so it carries an explicit `{ timeout: 20_000 }`
  too.

- **Piping `nx` into `tail` throws the exit code away.** `npx nx run web:typecheck 2>&1 | tail -4 && nx run web:build`
  runs the build even when the typecheck failed, because a pipeline's status is the **last** command's —
  `tail` exits 0. Four real type errors were read past this way in 4.2.1b, and the only reason the build
  caught them is that the Angular compiler reports them too. Either check `$?` immediately, drop the
  pipe, or use `set -o pipefail`; when a chained command runs something that "should not have run", this
  is why.

- **`pnpm install` can split `@nestjs/core` between two workspace projects, and the worker's Nest
  bootstrap then dies with a misleading dependency error.** The committed lockfile resolved
  `@nestjs/core` to `12.0.1(@nestjs/common@12.0.1(reflect-metadata@0.2.2)(rxjs@7.8.2))(...)` for
  `apps/api` but to the `(@nestjs/common@…(supports-color@7.2.0))` **peer variant** for
  `apps/worker`, so the two projects loaded two copies of `@nestjs/core` — and `Reflector` from one
  instance cannot be injected into a module built by the other. The symptom is not "two NestJS copies":
  it is Nest aborting the process during `NestFactory.createApplicationContext` with
  *"Is FilesModule a valid NestJS module? / If Reflector is a provider, is it part of the current
  FilesModule?"*, which reads like a missing `imports:` line in the API. It is invisible until the
  layout is rebuilt — the on-disk links happened to agree for several tasks, and the first
  `pnpm install` (adding a dependency in 4.2.1b) relinked them apart. `pnpm dedupe` collapses the
  variants (it removed 108 duplicate package instances) and `worker:test` passes again; a `logger:
  false` bootstrap hides the reason entirely (Nest calls `process.abort()` with no output), so the
  diagnostic is to boot the module with `logger: ['error']` and `abortOnError: false`. **After any
  dependency change, run `nx run worker:test`, not just the project you touched** — the worker is the
  only place the API's module graph and the worker's injector meet (ADR-022).

  Operational rule after any dependency change: **`pnpm install` rewrites the peer-variant assignment**
  (the split came back on the very next install, 4.2.2b, and `auto-install-peers=false` did **not** fix
  it — the two variants are a valid resolution for two different closures, not a mis-set option). Run
  `pnpm dedupe` afterwards, which collapses them, and then `nx run worker:test`. CI already installs with
  `--frozen-lockfile`, so the committed (deduped) lockfile is what CI builds and CI is unaffected — but a
  developer who runs a plain `pnpm install` and then the suite will see the worker fail with the
  *Reflector* message above, and the cure is `pnpm dedupe`.

- **An `idempotencyKey` owns its row: a resend with *different* money returns the ORIGINAL, not an
  error.** Verified live in 4.2.3 against `captureCommit`: the same batch twice collapses to one
  Transaction with `wasReplayed: true` and `replayed: true` (I-10 working exactly as designed), but a
  third call with the **same key and a different amount** also returns the original row — 200000, not
  the 999900 that was sent — with `wasReplayed: true` and no refusal. So a replay is safe **only if the
  payload never changes**: the first payload wins, silently. The consequence for the outbox is a design
  constraint, not a nicety — **a queued entry is immutable**, and the pending tray offers retry and
  discard but never "edit and resend", because editing one would show the user a success while the
  server kept the old figure. A changed payload needs a new key (which is what a fresh `clientRowId` +
  `idempotencyKey` from a new capture gives it).

- **`AGENTS.md` has a hard size budget, and per-task narratives grow it back.** It was split into this
  file at task 2.3.3 because it had passed 64 KB and the harness was silently truncating it — dropping
  the end of the file, including *Do not build without asking*. By 4.2.5 it had grown back to
  **66 773 bytes** and was being truncated again (the session reports "truncated AGENTS.md from … to
  …"), because every task appended a paragraph to the build-state line: that one line reached **20 KB**.
  The rule the file's own doctrine already states is the fix: the build state is **phase-level**, one
  bullet per phase, plus a `Next:` line — and the per-task decisions, deviations and defects belong in
  the doc that owns them (docs/09 §6 for sequencing, docs/02's per-screen build-state notes, docs/06 §5's
  implementation notes, docs/14 for ADRs and risks, this file for gotchas). Compressing that line back to
  a summary cut the file to **49 KB** without losing a fact. **Check `wc -c AGENTS.md` when you touch it
  and keep it under ~55 KB**, so the next task has room; a file that has to be truncated cannot be
  obeyed, and the truncated part is always the rules at the end.

- **`deleteDB` hangs in a `fake-indexeddb` spec, so the test times out with no error worth reading.**
  `idb`'s `deleteDB` waits for every open connection to close, and a connection only closes on a
  `versionchange` event — which `idb` reports through the `blocking` callback the store has to opt into.
  A store that memoises its connection (as the offline repository does, deliberately) therefore blocks
  its own deletion, and the failure looks like a hanging test rather than a database problem. The
  offline store's spec **purges instead of deleting**, which is also what the app does on logout; assert
  the purge empties every store and leave `deleteDB` alone (task 4.2.2b).

- **The Angular service worker fails at runtime, never at build time.** A resource listed in an
  `assetGroups` glob that the build does not emit makes the **whole version install fail** — the app
  silently keeps the previous version (or nothing, on a first visit) — and a glob that matches nothing
  caches nothing; neither is an error `ng build` reports. `@angular/pwa`'s default config lists
  `/favicon.ico`, which this app does not ship, so copying it verbatim is exactly that bug (4.2.1b
  writes its own list instead). Two checks catch it: every `hashTable` entry in the generated
  `ngsw.json` must exist on disk, and the `assetGroups` urls must equal the hash table — both are in
  the service-worker verification. Note also that `ngsw-worker.js`, `safety-worker.js` and
  `worker-basic.min.js` are deliberately **absent** from the hash table: they must be served unhashed
  and revalidated rather than cached by the app group.

- **A job-list assertion is a tripwire for every new job.** `apps/worker/src/jobs.integration.spec.ts`
  asserts `JOBS.map(job => job.name).sort()` against a literal list, so adding `files.purge` (4.1.1)
  broke it while `api:test` stayed green — the worker suite simply was not run as part of that task's
  verification. When you add a job, run `nx run worker:test`, not only `api:test`.

- **An `_EU` suffix is a *claim*, not a check — and `DEEPSEEK_EU` pointed at a non-EEA host.** The
  residency guard is a string predicate (`isEeaOrLocal`: `LOCAL`, or anything ending `_EU`) plus a boot
  check in `apps/api/src/config/config.ts`. That is enough to stop a *typo*; it cannot stop a **name
  that lies**, and one did: `DEEPSEEK_BASE_URL = 'https://api.deepseek.com'` — DeepSeek's own platform,
  hosted in China — was registered under the endpoint `DEEPSEEK_EU`, and it is the fallback in
  `DEFAULT_ROUTING` for `PARSE` and `CLASSIFY`. So `AI_CLASSIFY_PRIMARY=DEEPSEEK_EU` passed the guard
  while sending household free text (merchant and person names) to a non-adequacy jurisdiction, i.e. the
  Chapter V transfer docs/04 §9 says was *removed as a default* — reinstated by one environment
  variable, with the code reporting itself compliant. Found on 2026-09-16 when a DeepSeek key was
  supplied for evaluation. **Fixed for the registry in ADR-031**: an `*_EU` endpoint must be configured
  with the EEA host it means and has no default, DeepSeek's own platform is named `DEEPSEEK_GLOBAL`
  (in `NON_EEA_ENDPOINTS`, admitted only through `isAdmissible(endpoint, consent)`), and
  `DEFAULT_ROUTING` is `LOCAL`-only. **Both halves landed in ADR-032** — the composition root and the
  per-Household consent gate — and the lesson generalises twice over: when a rule is enforced by string
  matching, the string is the attack surface; and a residency guarantee that no code path exercises is
  a guarantee nobody has tested (wiring the first real provider immediately found two prompt defects —
  see group 6).

---

## Related

- `docs/10-testing-and-quality.md` — what a change has to prove before it is done.
- `docs/04-categorization-and-ai-engine.md` — canonical for the pipeline, the gates and the learning loop;
  its §8.1.x subsections record defects found while building and are the long form of several entries here.
- `docs/06-api-specification.md` — canonical for every operation, with per-task implementation notes
  recording deviations.
- `AGENTS.md` — the non-negotiable rules, the build state, and the traps that bite hardest.
