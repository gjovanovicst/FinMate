# 05 — Architecture

---

## 1. Stack decision

Chosen to match the team's existing strengths (Angular, NestJS/Go, GraphQL, Docker) and to minimise
the number of moving parts that must be operated by a team of 1–2 people.

| Layer | Choice | Why this, and not the alternative |
|---|---|---|
| **Web client** | **Angular 20+** (standalone components, signals, typed forms, `@defer`) | Team fluency; signals give fine-grained reactivity for a live dashboard; first-class PWA support covers mobile. React would be an option but adds no capability we lack. |
| **Mobile** | **PWA first**, `@angular/pwa` + service worker; **Capacitor** shell in v2 | One codebase, instant updates, no store review for v1. Capacitor adds native camera/push/store presence later without a rewrite. See [07](07-platform-strategy-mobile-desktop.md). |
| **Client state** | Signals + a thin store (`@ngrx/signals` or hand-rolled feature stores) | Full NgRx is ceremony we do not need; the domain is small and mostly server-owned. |
| **API** | **NestJS + GraphQL (code-first, Apollo driver)** + a small REST surface | GraphQL fits the nested read shapes (transaction + splits + tags + receipt items) and avoids over-fetching on mobile. REST for file upload, OCR webhook, and health. |
| **Realtime** | GraphQL subscriptions over WebSocket (or SSE) | Multi-device sync updates; notification badge counts. |
| **DB** | **PostgreSQL 16+** | Relational money data, strong constraints, `pg_trgm` for fuzzy matching, `pgvector` for household embeddings, JSONB for rule payloads. The source transcript's instinct was right. |
| **ORM / migrations** | **Prisma** (recommended) — alternative Drizzle | Type-safe client, good migration workflow, easy raw-SQL escape hatch for the recursive category/rollup queries. See [ADR-005](14-decisions-and-risks.md). |
| **Cache / queues** | **Redis 7** + **BullMQ** | Rule cache, budget rollups, idempotency keys, job queues (recurring materialisation, notification dispatch, insight generation, OCR polling, rollup refresh). |
| **AI** | `AiProvider` abstraction (§4) | Provider-agnostic; the source transcript's requirement, and it is also cost insurance. |
| **Auth** | JWT access (15 min) + rotating refresh token in httpOnly cookie; argon2id | Simple, stateless, revocable. Passkeys and TOTP are additive later. |
| **Object storage** | S3-compatible (MinIO self-hosted, or a provider) | Receipt images. Presigned URLs, never proxied through the API. |
| **Monorepo** | **pnpm workspaces + Nx** | Nx is the natural fit for Angular + Nest in one repo, with caching that materially speeds up CI. |
| **Deployment** | Docker Compose (dev + single-node prod) → Kubernetes only if scale demands | Deliberate: resist operational complexity. See [11](11-devops-and-observability.md). |

> **Explicit non-choice:** no microservices. This is a modular monolith. Module boundaries are
> enforced in code, not in the network, until a measured scaling or team reason forces a split.

---

## 2. Monorepo layout

```text
finmate/
├── apps/
│   ├── api/                    # NestJS application
│   │   └── src/
│   │       ├── modules/        # feature modules (see §3)
│   │       ├── graphql/        # schema wiring, scalars (Money, Date, UUID)
│   │       ├── common/         # guards, interceptors, tenancy context, filters
│   │       └── main.ts
│   ├── web/                    # Angular application
│   │   └── src/app/
│   │       ├── core/           # auth, http, graphql, error handling, i18n
│   │       ├── shared/         # design-system components (ui-*)
│   │       ├── features/       # feature areas (see §5)
│   │       └── app.routes.ts
│   └── worker/                 # BullMQ processors (can start life inside api, split when needed)
├── packages/
│   ├── domain/                 # entities, value objects, invariants, money math — zero deps
│   ├── nlp/                    # normalization, segmentation, extraction (pure, no I/O)
│   ├── rules-engine/           # deterministic rule evaluation + keyword scoring
│   ├── ai/                     # AiProvider interface + adapters + prompt templates
│   ├── contracts/              # shared DTOs / GraphQL types / zod schemas
│   └── config/                 # eslint, tsconfig, tailwind preset, shared tooling
├── infra/
│   ├── docker/                 # Dockerfiles, compose files
│   ├── migrations/             # SQL migrations
│   └── terraform/              # (v2) if hosting moves to a cloud
├── docs/                       # this documentation set
└── nx.json, pnpm-workspace.yaml, package.json
```

**Dependency rule (enforced by `eslint-plugin-boundaries` in CI):**

```text
apps/*        →  packages/*        →  (packages/domain only)
packages/nlp      must NOT import ai
packages/rules-engine must NOT import ai or database
packages/ai       must NOT import database
packages/domain   imports nothing
```

The `nlp`, `rules-engine` and `domain` packages being pure and dependency-free is what makes the
categorization core fast, unit-testable without a database, and reusable in a future worker or edge
function.

---

## 3. Backend modules

Each module owns its tables, exposes a service, and never reaches into another module's tables
directly — cross-module reads go through the owning service or a read-model query.

| Module | Responsibility | Key tables |
|---|---|---|
| `identity` | Users, credentials, sessions, refresh tokens, email verification, password reset | `users` |
| `household` | Households, members, roles, invitations, settings, timezone/currency | `households`, `household_members` |
| `accounts` | Accounts, balances (computed), archival | `accounts` |
| `ledger` | **Transactions, splits, tags, transfers.** The money core. Owns all balance arithmetic. | `transactions`, `transaction_splits`, `transaction_tags`, `tags` |
| `taxonomy` | Categories, keywords, merchants, aliases, counterparties, aliases | `categories`, `category_keywords`, `merchants`, `merchant_aliases`, `counterparties`, `counterparty_aliases` |
| `capture` | Natural-language entry orchestration, bulk segmenting, idempotency, duplicate detection | writes `transactions` via `ledger` |
| `classification` | Pipeline orchestration, rules engine integration, confidence gating, review queue, corrections, rule synthesis | `rules`, `classification_decisions`, `corrections` |
| `receipts` | Upload, OCR orchestration, item extraction, reconciliation | `receipts`, `receipt_items`, `attachments` |
| `budgeting` | Budgets, consumption calculation, safe-to-spend, rollovers | `budgets` |
| `goals` | Saving goals and contributions | `saving_goals`, `goal_contributions` |
| `recurring` | Recurring rules, RRULE expansion, materialisation job, subscription detection | `recurring_rules` |
| `insights` | Deterministic insight generation (pace, spikes, trends), month-end projection | `insights` |
| `notifications` | Alert rules, dedupe, channel dispatch (in-app, email, web push), quiet hours | `alert_rules`, `notifications` |
| `assistant` | Query planner (intent → template), fact assembly, narration, provenance | **reads many; writes nothing.** `costMicros`/`latencyMs` are returned on the answer and logged — a narration is not a classification decision, and `classification_decisions.decided_by` has no value that means "narration" (docs/06 §8.8) |
| `ai` | Provider adapters, routing, circuit breakers, budget guards, prompt registry | `ai_provider_configs`, `prompt_templates` |
| `files` | Presigned upload/download, virus scan hook, lifecycle/purge | `attachments` |
| `audit` | Append-only audit trail, GDPR export & purge orchestration | `audit_log` |

**The most important boundary:** `ledger` owns every arithmetic operation on money. No other module
computes a balance, a total, or a budget remainder inline. `insights`, `budgeting`, `assistant` and
`goals` all consume `ledger`'s (or a read-model's) computed values. This is what makes invariant I-4
([03](03-domain-model.md#5-invariants-enforced-in-the-service-layer--tests)) auditable.

---

## 4. The AI layer as an architectural boundary

```text
                       ┌──────────────────────────────┐
   capture ──────────► │ classification orchestration │
                       └───────┬─────────────┬────────┘
                               │             │
                 ┌─────────────▼───┐   ┌─────▼──────────────┐
                 │ rules-engine    │   │ ai (AiProvider)    │
                 │ pure, no I/O    │   │ external, async    │
                 └─────────────────┘   └─────┬──────────────┘
                                             │
                                     ┌───────▼────────┐
                                     │ provider adapters│  OpenAI | Anthropic
                                     │ + circuit breaker│  Gemini | DeepSeek | Local
                                     └────────────────┘
```

Rules for anything crossing this boundary:

1. The AI package returns **only** `Proposal` types — never entities, never DB writes.
2. The classification module is the **only** place proposals become persisted state, and it validates
   every field (category in list, amount parses, kind ∈ enum) before writing.
3. Every AI call is wrapped in a `withAiBudget()` guard that enforces per-household daily token caps
   and records cost.
4. Every AI call is wrapped in `withFallback()` that walks the routing chain and ultimately returns
   `null` — and `null` is always handled by a deterministic path.

---

## 5. Frontend architecture

### 5.1 Feature areas

```text
features/
├── auth/           sign-in, sign-up, verify, reset, (passkey later)
├── onboarding/     F-13 wizard: starter tree, people, merchants, income, first guided entry
├── dashboard/      F-19 safe-to-spend, F-21 projection, recent activity, insight feed
├── capture/        F-05/F-06 the input field, parse preview, bulk confirm, receipt upload
├── transactions/   list, filters, saved views, detail/edit, splits, bulk actions, CSV
├── review/         F-08 the review queue (badged from the nav)
├── categories/     F-02/F-03 tree editor, keywords include/exclude, AI description
├── merchants/      F-10 management, aliases, defaults, merge
├── counterparties/ F-11 people/companies, aliases, defaults
├── receipts/       F-14 capture, OCR progress, itemised breakdown, reconciliation
├── budgets/        F-17 budget editor, per-category progress
├── goals/          F-18 goals + contributions
├── recurring/      F-16 subscriptions, upcoming bills, detected candidates
├── insights/       F-20 analytics, charts, trends, month comparison
├── assistant/      F-23 chat surface with provenance and citations
├── rules/          rule list, editor, hit counts, conflict resolution, cleanup
└── settings/       profile, household, accounts, currency, AI preferences, notification prefs, export, delete
```

### 5.2 Rendering and data

- **Route-level code splitting** by default; the assistant and analytics bundles load on demand via
  `@defer`.
- **GraphQL cache** (Apollo InMemoryCache) normalised by id, so a confirmed transaction updates the
  dashboard, the list and the budget tile without refetching.
- **Route resolvers / `httpResource`** for initial data; no blocking spinners on the capture path —
  capture must be interactive before any network call completes.
- **SSR is not required** for v1. The app is behind auth, so there is no SEO surface; adding SSR
  would cost complexity for no gain. (Revisit only if a public marketing/landing route is served from
  the same app — the recommendation is to keep marketing separate.)

### 5.3 The capture path (performance-critical)

```text
input event ──► local normalize + extract (packages/nlp, in-browser, ~2ms)
           ──► optimistic local row appears immediately
           ──► POST /capture:parse (debounced 250ms)
           ──► preview updates with categories + confidence
           ──► user confirms ──► POST /capture:commit (atomic, idempotent)
```

The preview must feel instant. Running `packages/nlp` **client-side** for segmentation and amount
extraction is what delivers that: the user sees structure before the server responds. The same
package runs server-side, guaranteeing consistent parsing (one implementation, two runtimes).

### 5.4 Design system

A small, strict component library in `shared/ui` (buttons, inputs, money-input, category-picker,
confidence-badge, chart wrappers, sheet/dialog, toast). Rules:

- **Tokens, not magic values** — one spacing scale, one type scale, semantic colour roles
  (`--color-danger` not `--red-500`), so dark mode is free.
- **Mobile-first CSS** with container queries for the two-pane desktop layouts.
- **Money is always rendered by a single `<ui-money>` component** so currency, locale grouping and
  the minor-unit conversion exist in exactly one place. This is a correctness control, not styling.
- **Every interactive control is keyboard-reachable and labelled** (WCAG 2.2 AA, see
  [07](07-platform-strategy-mobile-desktop.md)).

---

## 6. Multi-tenancy

- **Every** household-scoped query is filtered by `household_id`, resolved from the authenticated
  session — never from client input. A client may never *name* a household id in a mutation.
- Enforced in three layers: (1) a request-scoped `TenantContext` set by an auth guard,
  (2) a Prisma client extension that injects the household filter and **throws** if a household-scoped
  model is queried without a tenant context, (3) optional PostgreSQL Row-Level Security as
  defence-in-depth (recommended before any enterprise deal).
- Cross-household access is a **P0 security bug**; there is a dedicated integration test suite that
  attempts it ([10](10-testing-and-quality.md)).

---

## 7. Offline & multi-device sync (F-26)

Mobile reality: capture must work on the metro. Design:

- **Client-generated `client_id`** (UUIDv7) on every locally created transaction → server dedupes via
  the unique index.
- **Local persistence** in IndexedDB (a thin repository over `idb`, not a full local-first framework).
  Scope is deliberately narrow: pending captures, the last-synced ledger snapshot, taxonomy cache.
- **Outbox pattern:** mutations queue locally with an `idempotency_key`, flush in order on
  reconnect. Failed items surface in a "pending" tray with retry — never silently dropped.
- **Conflict policy:** last-write-wins on scalar fields using the `version` column for optimistic
  concurrency; a `409`-equivalent returns the server state and the client shows a diff for money
  fields rather than silently clobbering.
- **Server-side re-classification of offline rows** is surfaced as a reviewable diff — an offline row
  captured with no AI available may be categorised differently once synced, and the user must see
  that rather than be surprised by a changed category.
- **Read model cache:** the ledger snapshot is stored with a `syncedAt` timestamp and every offline
  figure in the UI is labelled `as of <time>`. Showing a stale "safe to spend" without a timestamp is
  a trust bug.

---

## 8. Background jobs

All via BullMQ, idempotent, with retries and dead-letter queues. **Implemented in task 3.4.1** —
[ADR-022](14-decisions-and-risks.md) records the shape: `apps/worker` boots the API's feature modules as
a Nest application context and calls the **same service methods the mutations call**, one queue per job
with a scheduler id per name (a redeploy replaces a schedule rather than stacking a second copy),
`attempts: 3` with exponential backoff, and bounded `removeOnComplete`/`removeOnFail` history. A job
enumerates Households through the **job scope** (`runAsSystem`, the one sanctioned cross-Household read)
and then does each Household's work inside `runWithTenant`, so the service sees exactly what a request
would give it. Four jobs are registered today — `recurring.materialise`, `recurring.detect`,
`insights.generate`, `notifications.dispatch`; the rest of the table is unbuilt, and each entry below
says what makes a second run safe, which ADR-022 makes a precondition for adding one.

| Job | Schedule | Responsibility |
|---|---|---|
| `recurring.materialise` | hourly | Materialise due `recurring_rules` into transactions (respecting `auto_confirm`) |
| `recurring.detect` | daily | Infer probable subscriptions from history; propose, never auto-create |
| `insights.generate` | daily 06:00 local | Deterministic insight generation per household |
| `notifications.dispatch` | every minute | Drain queued notifications, respect quiet hours and `dedupe_key` |
| `budget.rollups` | hourly | Refresh period rollups used by dashboard tiles |
| `ledger.reconcile` | nightly | Recompute balances from the transaction log; alert on drift (I-4) |
| `classification.calibrate` | weekly | Refit isotonic confidence mapping per (task, model, prompt version) |
| `ai.embed.refresh` | daily | Refresh household entity/merchant embeddings |
| `rules.audit` | weekly | Flag dead/contradictory rules for user review |
| `files.purge` | daily | Hard-delete orphaned attachments; enforce retention |
| `gdpr.purge` | on demand | Full household purge with completion receipt |
| `evals.nightly` | nightly | Run the golden-dataset evaluation; publish accuracy metrics |

---

## 9. Notification pipeline

```text
insight/alert condition ──► AlertEvaluator (deterministic)
                        ──► dedupe by (user_id, dedupe_key)
                        ──► quiet hours / rate limit check
                        ──► channel fan-out: IN_APP | EMAIL | WEB_PUSH
                        ──► record delivery status; never re-send the same condition twice
```

`dedupe_key` design matters: e.g. `BUDGET_THRESHOLD:category-17:2026-10:80` fires once per category
per month per threshold. Re-alerting every time the dashboard loads is the fastest way to get
notifications disabled — and a disabled channel means the retention mechanic is gone.

---

## 10. Observability hooks built in from day one

Not an afterthought; the metrics below are how the success metrics in
[00](00-executive-summary.md#success-metrics) get measured.

| Signal | Where | Why |
|---|---|---|
| `capture.parse.duration`, `.outcome` | API | The core latency promise (≤ 4 s to log) |
| `classification.layer` (`RULE`/`KEYWORD`/`AI`/`FALLBACK`) | classification | Tracks the rules-vs-AI ratio and therefore cost |
| `classification.confidence_bucket` × `was_corrected` | classification | Feeds calibration and the overconfident-wrong gate |
| `ai.tokens`, `ai.cost_micros` per household | ai | Unit economics and abuse detection |
| `correction.rate` per household per week | classification | The compounding-moat signal |
| `sync.pending_age` | web | Offline backlog health |
| `ledger.balance_drift` | reconcile job | Should always be 0; non-zero is a P1 |

Structured JSON logs with a `requestId` propagated to every AI call, so "why did this transaction get
this category?" is answerable from logs alone.

---

## 11. Failure modes and their designed responses

| Failure | User-visible behaviour | System behaviour |
|---|---|---|
| LLM provider timeout | Entry still saves, marked for review | Fall through routing chain → rules-only → `PENDING` |
| LLM returns an invalid category | No visible error | Validation rejects → `null` category + `needs_review` |
| LLM narrates a fabricated number | Answer replaced by a template | Numeric validator rejects → single retry → template fallback |
| Redis unavailable | Slightly slower dashboard | Cache bypassed; reads hit Postgres directly |
| Postgres unavailable | Read-only degraded app with a banner | API returns cached snapshots; capture queues locally |
| OCR provider down | "We'll finish this shortly" on the receipt | Job retries with backoff; user can itemise manually meanwhile |
| Rule cache stale after a correction | Correct behaviour within seconds | Cache invalidated on write; pub/sub to other nodes |
| Duplicate offline flush | Nothing duplicated | Unique index on `(household_id, client_id)` rejects the replay |
