# 06 — API Specification

**Status:** Baseline for MVP · **Transport:** GraphQL (code-first, Apollo driver) + a small REST surface ·
**Contract owner:** `apps/api` · **Vocabulary:** canonical per [03](03-domain-model.md), feature IDs per [01](01-product-requirements.md).

This document is the interface contract between `apps/web` (and any future client) and `apps/api`. It is
subordinate to [03](03-domain-model.md) (names and invariants), [04](04-categorization-and-ai-engine.md)
(pipeline semantics) and [05](05-architecture.md) (modules, tenancy, offline model). Where this document
appears to disagree with them, they win and this document has a bug.

---

## 1. Conventions

### 1.1 Transport decision

| Surface | Transport | Why |
|---|---|---|
| Reads (ledger, taxonomy, dashboard, analytics, review queue, sync delta) | **GraphQL** | The read shapes are deeply nested (`Transaction` → `splits` → `category`, `tags`, `receipt.items`, `classificationDecision`) and mobile must not over-fetch. One round trip per screen is the latency budget ([01 §7](01-product-requirements.md)). |
| Writes (CRUD + domain mutations) | **GraphQL** | Same schema, same auth, same error model, same typed payloads. A second write path would duplicate authorization and validation logic — the two things that must not be duplicated in a tenancy-sensitive product. |
| Realtime | **GraphQL subscriptions** over `graphql-ws` | Already in the schema; no second protocol to secure. |
| **File upload/download** | **REST** | Binary bodies, `Content-Length`, range/`PUT` semantics, and presigned URLs are not GraphQL problems. Bytes never transit the API ([05 §1](05-architecture.md)). |
| **OCR provider webhook** | **REST** | Third-party caller with an HMAC signature and no session; it is not a Member and must not see the schema. |
| **Health & metrics** | **REST** | Consumed by Docker healthchecks, uptime probes and Prometheus scrapers, none of which speak GraphQL. |

Explicitly rejected: a REST CRUD mirror of the domain. Two write paths means two authorization matrices,
and ADR-008 (household-scoped tenancy from day one) makes an authorization matrix the highest-risk
duplication surface in the codebase.

> **Reconciling shorthand in the spine docs.** [04 §8](04-categorization-and-ai-engine.md) and
> [05 §5.3](05-architecture.md) sketch `PATCH /transactions/:id` and `POST /capture:parse` as readable
> shorthand. Those are **GraphQL operations**, not REST routes. The mapping is fixed:
>
> | Spine shorthand | Actual operation |
> |---|---|
> | `PATCH /transactions/:id { categoryId }` | `mutation correctTransaction` (§5.3) |
> | `POST /rules { fromCorrectionId }` | `mutation createRuleFromCorrection` (§5.4) |
> | `POST /capture:parse` | `mutation captureParse` (§5.1) |
> | `POST /capture:commit` | `mutation captureCommit` (§5.2) |

### 1.2 Endpoints and versioning

| Endpoint | Purpose |
|---|---|
| `POST /graphql` | Queries and mutations. Persisted queries (APQ) enabled; persisted-query-only mode in production for first-party clients. |
| `WS /graphql` | Subscriptions (`graphql-ws` subprotocol). Auth via the same access cookie/header. |
| `GET /graphql` | `GET` is disabled. Every operation is a `POST`. |
| `/v1/files/*`, `/v1/webhooks/*`, `/health*`, `/metrics` | REST surface (§9). |

**Versioning policy.** The GraphQL schema is **additive-only within a major version**. There is no URL
version. Breaking changes require either a new field with a new name or the field's removal behind the
deprecation window in §11.5. REST routes are explicitly versioned (`/v1`) because third parties (OCR
providers, infrastructure) depend on them and cannot follow a schema registry.

**Schema governance.** The schema is code-first, but the **generated SDL artifact is committed** to
`packages/contracts/schema.graphql` and is the review surface for every API change. A CI check diffs the
generated schema against the committed artifact and fails on an unreviewed change. `apps/web` codegen
consumes the same artifact, so a client-side compile error is the first signal of a breaking change.

**Operation limits.** Max query depth 12, max complexity 1000 points, max aliases per operation 15, max
`first` of 200. Exceeding these returns `VALIDATION_FAILED` with HTTP 400.

### 1.3 Scalars

```graphql
scalar Money      # JSON object, see below
scalar Date       # "2026-10-01"            (household-local calendar day)
scalar DateTime   # "2026-10-01T14:22:31.000Z" (RFC 3339, always UTC with offset)
scalar UUID       # "0192f3a1-..."          (UUIDv7, time-ordered)
scalar Cursor     # opaque, base64url       (never parsed by clients)
scalar JSON       # escape hatch: rule conditions/actions, insight payloads, facts
```

**`Money` is the only representation of money on the wire** (ADR-003). It mirrors the
`amount_minor` / `currency` column pair in [03 §3.1](03-domain-model.md) exactly:

```json
{ "amountMinor": "200000", "currency": "RSD" }
```

| Rule | Detail |
|---|---|
| `amountMinor` is a **string** | Always. `200000` = `2.000,00 RSD`. JavaScript `Number` is a float and `Number.MAX_SAFE_INTEGER` is a rounding bug waiting for a large enough balance. |
| `amountMinor` is **always positive or zero** | Direction is carried by `Transaction.kind` (`EXPENSE` \| `INCOME`), never by sign. This is what makes the sign-bug class impossible. |
| `currency` is ISO-4217, uppercase | Equals the household's `ledger_currency` in v1 (ADR-011). A mismatch is `VALIDATION_FAILED`. |
| **No floats anywhere** | Not in inputs, not in outputs, not in `JSON` blobs that carry money. `Money` is rejected by the scalar parser if `amountMinor` is a JSON number rather than a string. |
| Display formatting is a client concern | The API never returns a pre-formatted string for a money field; `ui-money` ([05 §5.4](05-architecture.md)) is the single formatter. Pre-formatted strings appear **only** inside assistant `facts` (§8), where they exist to stop the narrator from reformatting a number. |

**`Date` vs `DateTime` is not a style choice.** [03 §3.2](03-domain-model.md) requires both
`occurred_at` and `occurred_local_date`: *"which day was this?"* is a local-calendar question and
*"when?"* is an instant question. `Transaction.occurredLocalDate` is a `Date`; `Transaction.occurredAt`
is a `DateTime`; `createdAt`/`updatedAt` are `DateTime`. Period boundaries (`periodStart`, `periodEnd`)
are `Date`. Conflating them breaks month boundaries across timezones and DST.

On writes, `createTransaction` and `updateTransaction` accept `occurredLocalDate` — the calendar day
the user picked. The server derives `occurredAt` as local noon on that day **in the Household
timezone**, so a client never has to know that timezone. When both are sent, `occurredLocalDate` wins;
one of the two is required on create.

### 1.4 Pagination

Relay-style cursor connections, everywhere, with no offset pagination anywhere in the schema. Offsets
are unstable over a ledger that is being written to while the user scrolls — rows shift and the user
sees a duplicate or misses a transaction.

```graphql
type PageInfo {
  hasNextPage: Boolean!
  hasPreviousPage: Boolean!
  startCursor: Cursor
  endCursor: Cursor
}

type TransactionEdge {
  node: Transaction!
  cursor: Cursor!
}

# Illustrative only — the authoritative definitions of every connection type are in §3.4.
# TransactionConnection {
#   edges: [TransactionEdge!]!
#   pageInfo: PageInfo!
#   totalCount: Int!      # only computed when selected; Redis-cached 60s per filter hash
# }
```

Conventions:

- Cursors are **opaque**. They encode `(occurred_local_date, id)` for ledger ordering so that the sort
  key is stable, and are versioned — a cursor from a superseded encoding returns `VALIDATION_FAILED`
  with `extensions.reason = "STALE_CURSOR"` rather than silently mis-paging.
- `first` is the only supported forward argument; `after` is the only backward-compatible cursor.
  `last`/`before` are not implemented — the UI never needs to page backwards in a ledger.
- Default page size when `first` is omitted: **50**. Hard maximum: **200**.
- Mutations that create a row return the entity, not the connection. Clients update the normalised
  Apollo cache ([05 §5.2](05-architecture.md)) rather than refetching a page.

### 1.5 Sorting and filtering

Every list query takes a typed `filter` input and an ordered `sort` list. Both are **closed enums**, never
free-form strings, so the resolvers can be enumerated and each one mapped to an index.

```graphql
enum SortDirection { ASC DESC }

input TransactionSortInput {
  field: TransactionSortField!
  direction: SortDirection!
}

enum TransactionSortField {
  OCCURRED_LOCAL_DATE
  AMOUNT_MINOR
  CREATED_AT
  CONFIDENCE
  DESCRIPTION
}
```

Rules:

1. Every sort list has a **mandatory final tiebreaker** on `id ASC`, appended by the server if absent.
   Without it, pagination over equal keys is non-deterministic.
2. Default sort for ledger queries is `OCCURRED_LOCAL_DATE DESC, id ASC`.
3. Filters compose with `AND` at the top level; each field's semantics match the DB column exactly.
4. Filters **always** imply `deleted_at IS NULL` ([03 §3.4](03-domain-model.md)). There is no
   `includeDeleted` argument in v1; restores are an admin/audit operation.
5. A filter hash is the Redis cache key for `totalCount`.

```graphql
input TransactionFilterInput {
  kind: [TransactionKind!]
  accountIds: [UUID!]
  categoryIds: [UUID!]          # includes the category subtree
  categoryIdsExact: [UUID!]     # node only, no subtree
  merchantIds: [UUID!]
  counterpartyIds: [UUID!]
  tagIds: [UUID!]
  source: [TransactionSource!]
  status: [TransactionStatus!]
  needsReview: Boolean
  occurredOnOrAfter: Date
  occurredOnOrBefore: Date
  amountMinMinor: String
  amountMaxMinor: String
  text: String                  # trigram search over description/note/raw_input
  uncategorisedOnly: Boolean
  createdOrUpdatedSince: DateTime   # used by the sync delta (§4.9)
}
```

### 1.6 `clientMutationId`

Every mutation input includes `clientMutationId: String`, echoed verbatim on the payload. It exists to
correlate an optimistic local row with the server's acknowledgement in the offline outbox
([05 §7](05-architecture.md)); it carries **no** server semantics and is not a substitute for an
idempotency key. Clients that do not use it may omit it.

### 1.7 Optimistic concurrency

Write inputs for `Transaction`, `Budget`, `SavingGoal`, `RecurringRule`, `Rule`, `Category`, `Merchant`
and `Counterparty` carry an optional `version: Int`.

| Case | Behaviour |
|---|---|
| `version` omitted | Last-write-wins. Permitted for create operations and for single-device clients. |
| `version` supplied and equal to the stored value | Write proceeds, stored `version` is incremented by 1. |
| `version` supplied and **not** equal | Write is rejected; payload is `ConflictError` with `code: CONFLICT`, `expectedVersion`, `actualVersion`, and `current` (the server's current entity). Client shows a diff and lets the user choose. |
| `version` supplied on a soft-deleted row | `ConflictError` with `code: CONFLICT`, `reason: "DELETED"`. |

The server **never** merges money fields automatically. [05 §7](05-architecture.md): *"a 409-equivalent
returns the server state and the client shows a diff for money fields rather than silently clobbering."*
For a finance app, silently resolving a conflict is strictly worse than making the user look at it.

```graphql
type ConflictError {
  code: ErrorCode!
  message: String!
  entityType: String!
  entityId: UUID
  expectedVersion: Int
  actualVersion: Int
  current: JSON            # the server's current entity, for diffing
  clientMutationId: String
}
```

---

## 2. Authentication and session

> **Implementation deviation (Phase 0 task 0.6): authentication is REST, not GraphQL.**
> The endpoints live under `/auth/*` (`signup`, `login`, `refresh`, `logout`, `verify-email`,
> `request-password-reset`, `reset-password`, plus a protected `GET /auth/me`). Two reasons:
> session handling must set and clear `httpOnly` cookies, and cookie semantics sit awkwardly in a
> GraphQL response where every operation shares one envelope; and scoping the refresh cookie to the
> auth routes keeps it off ordinary data requests. GraphQL remains the transport for all domain
> operations. Recorded here rather than left as a silent divergence.
>
> **Cookie deviation, corrected and expanded (task 4.3.5).** The names and the scope below are the
> sketch, not the build, and the scope was actively wrong until 4.3.5. Shipped: cookies are
> `finmate_access` and `finmate_refresh` (never `fm_at`/`fm_rt`), the refresh cookie is
> `HttpOnly; Secure (production only); SameSite=Lax`, and its **`Path` is the path the browser reaches
> this API under, plus `/auth`** — `/api/auth` in dev, `/auth` when the API is mounted at the root —
> from the new `PUBLIC_API_PREFIX` setting. `Path=/graphql` in the block below, and docs/08 §3's
> `__Host-fm_rt; Path=/`, are both stale.
>
> Why it matters, and why it is not pedantry: a browser matches a cookie's path against the URL it can
> **see**, so the previously hard-coded `Path=/auth` never matched the `/api/auth/refresh` the browser
> actually requests through the dev proxy. The cookie was never sent, `restore()` came back with an
> empty token, and **every hard reload signed the user out** — R-26, found by 5.2a's browser pass and
> fixed here. **Still open**: docs/08 §3's `__Host-` prefix is a *different* hardening (it requires
> `Path=/` and no `Domain`, which a narrow path rules out). The build has no subdomains and prefers the
> narrow scope; if one is ever added, that choice has to be revisited. Recorded rather than reconciled
> silently — the security posture is docs/08's to own.
>
> **Client screens (task 5.8).** `verify-email`, `request-password-reset` and `reset-password` now have
> their screens, at the paths these mails already carried — `/verify-email?token=…` and
> `/reset-password?token=…`, both unguarded because a signed-in visitor is exactly who clicks an emailed
> link (docs/02 §2.1). Two facts about this group that the screens had to be written *around*, recorded
> here because they are the API's behaviour and not the client's:
>
> - **`request-password-reset` answers `204` for any address** (deliberate — a different answer would be
>   an account-enumeration oracle), so the screen may not tell the user whether their account exists, and
>   its copy is conditional for that reason.
> - **`verify-email` sets `users.email_verified_at`, and nothing reads that column.** `login` does not
>   require it, and no operation is gated on it. Verification is therefore **advisory in this build**: the
>   link must work, but confirming an address changes nothing yet. What it should gate is a product and
>   security decision (docs/09 5.8 names it), not something a screen may imply.
> - **There is no re-send operation.** `issueEmailToken` is called by `signup` and by
>   `request-password-reset` only, so an expired `VERIFY_EMAIL` token has **no in-app recovery** — the
>   honest reason it costs nothing today is the bullet above. Adding one is a self-service,
>   session-scoped `POST /auth/resend-verification`; it is unscheduled and named here rather than
>   discovered later.


### 2.1 Token strategy

Per [05 §1](05-architecture.md): **JWT access token, 15 minutes, plus a rotating refresh token in an
httpOnly cookie**, passwords hashed with argon2id.

| Token | Lifetime | Storage | Transport |
|---|---|---|---|
| Access token (JWT, RS256) | **15 min** | In-memory in the Angular app only — never `localStorage` | `Authorization: Bearer <jwt>` **or** the `fm_at` cookie (see below) |
| Refresh token | **30 days**, idle-expiring after 14 days | `fm_rt` cookie only — the client never sees the value | `Set-Cookie` / cookie auto-send |
| Email verification token | 24 h, single use | Opaque, hashed at rest | Link in email → `verifyEmail` mutation |
| Password reset token | 30 min, single use | Opaque, hashed at rest; invalidates all refresh tokens on use | Link in email → `resetPassword` mutation |

**Cookie strategy.** The refresh token is issued as:

```http
# The sketch. Shipped names and scope differ — see the deviation note above.
Set-Cookie: finmate_refresh=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=<PUBLIC_API_PREFIX>/auth; Max-Age=2592000
```

- `HttpOnly` — JavaScript cannot read it, so an XSS bug cannot exfiltrate a 30-day session.
- `SameSite=Lax` + `Path=/graphql` — the cookie is attached only to the API origin's GraphQL endpoint,
  not to arbitrary subrequests. `Lax` (not `Strict`) because the PWA is opened from a home-screen icon
  and email links, and `Strict` would drop the session on those navigations.
- `Secure` always; `Domain` unset (host-only).
- CSRF defence is a **double-submit token**: the access token is sent both as `Authorization: Bearer`
  and, for browser clients, the server requires the `X-FM-CSRF` header to equal a non-httpOnly `fm_csrf`
  cookie. A cookie-only request without the header is rejected with `FORBIDDEN`.

**Rotation.** Every `refreshSession` call mints a new refresh token and **invalidates the presented
one**. Reuse of an already-rotated token is treated as theft: the entire token family is revoked, all
sessions for that user are terminated, and a `SECURITY` audit row plus an email notification are
written. This is the standard refresh-token-reuse detection and it is the main reason rotation exists.

### 2.2 Auth SDL

```graphql
type AuthPayload {
  accessToken: String!
  expiresIn: Int!            # seconds; always 900 in v1
  user: User!
  household: Household!      # the active household; see §2.3
  memberships: [Membership!]!
  clientMutationId: String
}

type Membership {
  id: UUID!
  household: Household!
  role: HouseholdRole!
  createdAt: DateTime!
}

type User {
  id: UUID!
  email: String!
  emailVerified: Boolean!
  displayName: String!
  locale: String!
  status: UserStatus!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Household {
  id: UUID!
  name: String!
  ledgerCurrency: String!        # ADR-011: exactly one, immutable in v1
  ianaTimezone: String!
  members: [Membership!]!
  settings: HouseholdSettings!
  createdAt: DateTime!
}

type HouseholdSettings {
  autoConfirmThreshold: Float!   # default 0.90 (ADR-009)
  reviewThreshold: Float!        # default 0.60 (ADR-009)
  aiConsentGiven: Boolean!       # §11.3 / [08]
  aiRouting: [AiRoutingEntry!]!
}

# IMPLEMENTATION NOTE (ADR-032). `aiConsentGiven` and `AiRoutingEntry` above are NOT what shipped, and the
# deviation is deliberate rather than pending. The shipped consent surface is:
#
#   query    aiConsents: [ConsentModel!]!          # kind, state (NOT_ASKED|GRANTED|DECLINED|WITHDRAWN),
#                                                  # recordedAt, policyVersion, purposes
#   mutation recordAiConsent(input): ConsentModel! # OWNER-only (docs/08 §6.6, Q-11); append-only
#
# A single boolean cannot express docs/08 §6.6's granularity — it cannot answer "may the Receipt image go?"
# separately from "may the free text go?" — and `SignUpInput.aiConsentGiven` below ("cannot be omitted")
# contradicts the same section's "requested at first use, not buried in onboarding". Consent is recorded
# per purpose, so the surface is a list of per-purpose states plus one append-only mutation; the boolean
# is what a *screen* may render as a summary of it. `AiRoutingEntry.effectiveProvider` is also unbuilt:
# the composition root logs the routes at boot (`AiSeams`) and no query exposes them, so an operator reads
# the log rather than a field. Both deviations are recorded in docs/14 ADR-032.
#
# `aiConsents` has two consumers since task 5.2a: `/settings`' AI section and the **first-use sheet** the
# capture screen opens when `captureParse` comes back `degraded`. They share one client-side card
# (`ui-consent-purpose`), so the provider/region disclosure the server sends is rendered identically by
# both. Two properties of this document matter to a client and are easy to get wrong: the list
# **enumerates every exposed kind**, so a purpose nobody has decided arrives as `NOT_ASKED` with
# `recordedAt: null` rather than being absent (the table is append-only and has no "asked and unanswered"
# row); and `state` is derived from the newest row, so a client must re-read rather than assume what its
# own write did.

type AiRoutingEntry {
  task: AiTask!
  primary: AiProviderName!
  fallback: AiProviderName       # null ⇒ rules-only degradation when primary is unavailable
  effectiveProvider: AiProviderName!   # what is actually in use now (circuit-breaker aware)
  isOverriddenForHousehold: Boolean!   # false ⇒ platform default from [04 §9]
  dailyTokenBudget: Int
  dailyTokensUsed: Int!
}

# Thresholds and routing are per-household settings (04 §7 requires the thresholds be tunable and
# every change audited). They have no dedicated column in [03 §4]; they live in the household settings
# aggregate and are written through updateHouseholdSettings, which writes an audit_log row.

enum HouseholdRole { OWNER ADMIN MEMBER VIEWER }
enum UserStatus { ACTIVE SUSPENDED DELETED }

input SignUpInput {
  email: String!
  password: String!              # min 12 chars, zxcvbn score >= 3
  displayName: String!
  locale: String                 # default "sr-Latn-RS"
  householdName: String          # default "<displayName>'s household"
  ledgerCurrency: String         # default "RSD"; immutable in v1
  ianaTimezone: String           # default "Europe/Belgrade"
  aiConsentGiven: Boolean!       # cannot be omitted; see [08]
  clientMutationId: String
}

input LogInInput {
  email: String!
  password: String!
  clientMutationId: String
}

input RefreshSessionInput { clientMutationId: String }
input LogOutInput { allSessions: Boolean = false, clientMutationId: String }
input VerifyEmailInput { token: String!, clientMutationId: String }
input RequestEmailVerificationInput { clientMutationId: String }
input RequestPasswordResetInput { email: String!, clientMutationId: String }
input ResetPasswordInput { token: String!, newPassword: String!, clientMutationId: String }

# Auth members of the single Mutation root. The root itself is declared once in §5;
# these eight fields are listed there alongside the domain mutations.
#   signUp(input: SignUpInput!): SignUpResult!
#   logIn(input: LogInInput!): LogInResult!
#   refreshSession(input: RefreshSessionInput): AuthPayload!
#   logOut(input: LogOutInput): LogOutPayload!
#   verifyEmail(input: VerifyEmailInput!): VerifyEmailPayload!
#   requestEmailVerification(input: RequestEmailVerificationInput): SimplePayload!
#   requestPasswordReset(input: RequestPasswordResetInput!): SimplePayload!
#   resetPassword(input: ResetPasswordInput!): SimplePayload!
```

`signUp` creates the `User`, a `Household` (the user is `OWNER`), the `Membership`, seeds the starter
category tree and the ~60 shipped `Merchant` rows per F-13 ([01 §5](01-product-requirements.md)), and
returns a session. Signup is **not** blocked on email verification in v1; verification unlocks
`EMAIL` channel notifications and account recovery only.

`requestPasswordReset` **always** returns `SimplePayload { ok: true }` regardless of whether the address
exists — account enumeration via a timing or content difference is a defect ([08](08-security-privacy-and-compliance.md)).

### 2.3 The guard chain and `TenantContext`

Every request passes through, in order:

```text
1. ThrottlerGuard        → rate limit by (ip, operation class)          §11.2
2. CsrfGuard             → X-FM-CSRF == fm_csrf for cookie-authenticated  §2.1
3. JwtAuthGuard          → Bearer header or fm_at cookie → SessionClaims
4. HouseholdGuard        → SessionClaims.householdId → TenantContext
5. RolesGuard            → @Roles(...) metadata vs. TenantContext.role   §11.1
6. IdempotencyInterceptor→ replays return the original result            §11.3
7. AiBudgetInterceptor   → withAiBudget() on AI-backed operations        §11.4
8. AuditInterceptor      → append-only audit_log row                     [03 §4]
```

`TenantContext` is a request-scoped provider holding `{ userId, householdId, role, sessionId }`. It is
established **only** from the access token's `householdId` claim or from the `X-Household-Id` header when
the user belongs to more than one household **and** that membership is verified server-side. It is then
pushed into a Prisma client extension that injects `household_id` into every query and **throws** if a
household-scoped model is touched without a tenant context ([05 §6](05-architecture.md)). PostgreSQL RLS
is the third layer and is enabled before any enterprise deal.

> ### Clients never send `householdId`
>
> No input type in this schema contains a `householdId` field. Not `CaptureCommitInput`, not
> `TransactionCreateInput`, not `SyncDeltaInput`. The household is a property of the **session**, and
> the API derives it. The Prisma extension throws on a missing context, so a resolver that "forgot" to
> scope a query fails loudly instead of leaking another household's ledger.
>
> A client that sends `householdId` anywhere gets `VALIDATION_FAILED` with
> `extensions.reason = "UNKNOWN_FIELD"` — GraphQL rejects unknown input fields by default, which makes
> this a schema-level guarantee rather than a runtime convention.
>
> Cross-household access is a **P0 security bug** with a dedicated integration suite
> ([05 §6](05-architecture.md), [10](10-testing-and-quality.md)).

---

## 3. GraphQL SDL — domain types

### 3.1 Enums

These mirror the `CHECK` constraints in [03 §4](03-domain-model.md) exactly. A new DB value is a schema
change, and a schema change is a review.

```graphql
enum TransactionKind      { EXPENSE INCOME }
enum TransactionStatus    { PENDING CONFIRMED VOID }
enum TransactionSource    { MANUAL NATURAL_LANGUAGE RECEIPT RECURRING IMPORT }
enum CategorySource       { USER RULE AI IMPORT DEFAULT }
enum SplitCategorySource  { USER RULE AI RECEIPT }
enum CategoryKind         { EXPENSE INCOME }
enum AccountKind          { CASH BANK CARD OTHER }
enum KeywordPolarity      { INCLUDE EXCLUDE }
enum KeywordMatchMode     { WORD PREFIX SUBSTRING }
enum CounterpartyType     { PERSON COMPANY GOVERNMENT OTHER }
enum RuleOrigin           { USER LEARNED SYSTEM IMPORT }
enum DecidedBy            { USER RULE AI MERCHANT_DEFAULT COUNTERPARTY_DEFAULT KEYWORD FALLBACK }
enum BudgetPeriod         { WEEKLY MONTHLY QUARTERLY YEARLY CUSTOM }
enum GoalStatus           { ACTIVE ACHIEVED ARCHIVED }
enum ReconciliationState  { PENDING MATCHED MISMATCH MANUAL }
enum InsightSeverity      { INFO POSITIVE WARNING CRITICAL }
enum NotificationChannel  { IN_APP EMAIL PUSH WEB_PUSH }
enum NotificationStatus   { QUEUED SENT FAILED SUPPRESSED }
enum AiTask               { PARSE CLASSIFY NARRATE OCR EMBED }
enum AiProviderName       { OPENAI ANTHROPIC GEMINI DEEPSEEK LOCAL }
enum AttachmentPurpose    { RECEIPT TRANSACTION_PROOF OTHER }
```

### 3.2 Core entity types

```graphql
type Account {
  id: UUID!
  name: String!
  kind: AccountKind!
  openingBalance: Money!
  currency: String!
  isArchived: Boolean!
  sortOrder: Int!
  balance: AccountBalance!          # computed, §3.3
  transactionCount: Int!
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Category {
  id: UUID!
  parentId: UUID
  name: String!
  kind: CategoryKind!
  icon: String
  color: String
  aiDescription: String
  isSystem: Boolean!
  sortOrder: Int!
  depth: Int!                       # 0-based; capped at 4 (depth <= 5, I-11)
  path: [CategoryPathSegment!]!     # root → self, for breadcrumbs
  keywords: [CategoryKeyword!]!
  children: [Category!]!
  descendantCount: Int!
  transactionCount: Int!
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type CategoryPathSegment { id: UUID! name: String! }

type CategoryKeyword {
  id: UUID!
  categoryId: UUID!
  keyword: String!                  # normalised, lowercased, unaccented
  polarity: KeywordPolarity!
  matchMode: KeywordMatchMode!
  weight: Float!
  createdAt: DateTime!
}

type Merchant {
  id: UUID!
  name: String!
  defaultCategoryId: UUID
  defaultCategory: Category
  aiHint: String
  isGlobal: Boolean!                # true = shipped seed row, householdId IS NULL
  isOwnedByHousehold: Boolean!      # false for global seeds; seeds are copy-on-write
  aliases: [MerchantAlias!]!
  transactionCount: Int!
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type MerchantAlias { id: UUID! merchantId: UUID! alias: String! createdAt: DateTime! }

type Counterparty {
  id: UUID!
  name: String!
  type: CounterpartyType!
  defaultCategoryId: UUID
  defaultCategory: Category
  note: String
  aliases: [CounterpartyAlias!]!
  transactionCount: Int!
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type CounterpartyAlias { id: UUID! counterpartyId: UUID! alias: String! createdAt: DateTime! }

type Tag {
  id: UUID!
  name: String!
  color: String
  transactionCount: Int!
  createdAt: DateTime!
}
```

```graphql
type Transaction {
  id: UUID!
  accountId: UUID!
  account: Account!
  kind: TransactionKind!
  amount: Money!
  currency: String!

  categoryId: UUID
  category: Category
  merchantId: UUID
  merchant: Merchant
  counterpartyId: UUID
  counterparty: Counterparty

  splits: [TransactionSplit!]!      # canonical term: Split; sums to amount (I-1)
  isSplit: Boolean!

  description: String!
  rawInput: String
  note: String

  occurredAt: DateTime!
  occurredLocalDate: Date!          # the local calendar day the user means

  status: TransactionStatus!
  source: TransactionSource!
  categorySource: CategorySource

  confidence: Float
  needsReview: Boolean!
  reviewReason: ReviewReason

  tags: [Tag!]!
  receipt: Receipt
  attachmentId: UUID                  # implemented (4.1.2); set only by commitAttachment (§5.15)
  recurringRuleId: UUID
  recurringRule: RecurringRule
  transferPeerId: UUID
  transferPeer: Transaction

  decisions: [ClassificationDecision!]!   # newest first; the audit trail (I-9)
  corrections: [Correction!]!
  lastCorrection: Correction

  clientId: String                   # offline-originated rows
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

enum ReviewReason { LOW_CONFIDENCE UNCATEGORISED AMBIGUOUS_AMOUNT RECEIPT_MISMATCH OFFLINE_RECLASSIFIED }

type TransactionSplit {
  id: UUID!
  transactionId: UUID!
  categoryId: UUID!
  category: Category!
  amount: Money!
  note: String
  confidence: Float
  categorySource: SplitCategorySource
  createdAt: DateTime!
}
```

```graphql
type Receipt {
  id: UUID!
  transactionId: UUID
  transaction: Transaction
  merchantId: UUID
  merchant: Merchant
  capturedAt: DateTime!
  total: Money
  ocrConfidence: Float
  reconciliation: ReconciliationState!
  itemsTotal: Money!                 # Σ items, computed
  variance: Money!                   # total − itemsTotal; MUST be <= 1 minor unit when MATCHED (I-6)
  items: [ReceiptItem!]!
  attachmentId: UUID
  attachment: Attachment
  createdAt: DateTime!
  updatedAt: DateTime!
}

type ReceiptItem {
  id: UUID!
  receiptId: UUID!
  lineNo: Int!
  rawText: String!
  normalizedName: String
  quantity: Float
  unitPrice: Money
  amount: Money!
  categoryId: UUID
  category: Category
  confidence: Float
  needsReview: Boolean!
  createdAt: DateTime!
}

type Attachment {
  id: UUID!
  purpose: AttachmentPurpose!        # canonical in [03 §4]; the values below are the DDL's
  mimeType: String!
  byteSize: Int!
  sha256: String!
  downloadUrl: String                # short-lived presigned GET; null while scanning
  scanState: FileScanState!          # canonical in [03 §4]
  createdAt: DateTime!
}

enum AttachmentPurpose { RECEIPT TRANSACTION IMPORT AVATAR }
enum FileScanState { PENDING CLEAN INFECTED FAILED SKIPPED }
```

> **Two columns promoted to canonical, and the enums corrected (task 4.1.1).** [03 §4](03-domain-model.md)
> defines `attachments` with both `purpose` (so an upload can be routed to receipt-OCR versus a plain
> transaction photo) and `scan_state` (so `downloadUrl` can be withheld until the virus/format scan
> promotes the row, §9.2). This sketch originally invented `TRANSACTION_PROOF`/`OTHER` and
> `REJECTED`/`CLEAN`/`PENDING`, which no `CHECK` constraint permits; the enums now carry the DDL's
> values. `storage_key` is deliberately **not** exposed on the GraphQL type: raw object paths are an
> internal detail, and clients receive presigned URLs instead.

```graphql
type Budget {
  id: UUID!
  categoryId: UUID                   # null = whole household
  category: Category
  period: BudgetPeriod!
  periodStart: Date!
  amount: Money!
  rollover: Boolean!
  includeSubcategories: Boolean!
  status: BudgetStatus!              # computed, §3.3
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type SavingGoal {
  id: UUID!
  name: String!
  target: Money!
  targetDate: LocalDate             # a Household day, not an instant (docs/03 §3.2)
  accountId: UUID
  account: Account
  status: GoalStatus!
  contributed: Money!                # Σ contributions, computed
  remaining: Money!
  progress: Float!                   # 0..1, capped at 1 for display
  requiredPerMonth: Money            # computed, null when no targetDate
  monthsRemaining: Int               # null when no targetDate; 0 means "due now"
  contributions: [GoalContribution!]!
  createdAt: DateTime!
  updatedAt: DateTime!
  # `version: Int!` was drawn here and is deliberately NOT implemented: `saving_goals` has no such
  # column (only `transactions` does), and inventing optimistic concurrency for one model is a
  # migration nobody asked for. Recorded in §5.7, exactly as `AlertRule.version` is (§5.14).
}

type GoalContribution {
  id: UUID!
  goalId: UUID!
  amount: Money!
  contributedOn: LocalDate!          # was `Date`: the schema has no `Date` scalar
  note: String
  createdAt: DateTime!
}

type RecurringRule {
  id: UUID!
  accountId: UUID!
  account: Account!
  kind: TransactionKind!
  amount: Money!
  categoryId: UUID
  category: Category
  merchantId: UUID
  merchant: Merchant
  description: String!
  rrule: String!                     # RFC 5545, restricted to the subset §5.8.1 lists
  nextOccurrenceOn: LocalDate!       # was `Date`: the schema has no `Date` scalar
  endsOn: LocalDate
  autoConfirm: Boolean!
  isDetected: Boolean!               # 3.3.4 fills this; nothing writes true yet
  isActive: Boolean!
  generatedCount: Int!               # COUNT of this rule's Transactions, derived on read
  upcomingOccurrences: [LocalDate!]! # next 6, expanded server-side
  createdAt: DateTime!
  updatedAt: DateTime!
  # `version: Int!` was drawn here and is deliberately NOT implemented: `recurring_rules` has no such
  # column (only `transactions` does). Recorded in §5.8.1, as for `SavingGoal` (§5.7) and `AlertRule`.
}
```

```graphql
type Rule {
  id: UUID!
  name: String!
  priority: Int!                     # lower wins
  isActive: Boolean!
  stopOnMatch: Boolean!
  conditions: JSON!                  # { all|any|none: [ { field, op, value } ] }
  actions: JSON!                     # { setCategoryId, setMerchantId, addTagIds, setDescription }
  origin: RuleOrigin!
  sourceCorrectionId: UUID
  hitCount: Int!
  lastHitAt: DateTime
  isStale: Boolean!                  # hitCount = 0 and age > 90 days ([04 §8.2])
  conflictsWith: [RuleConflict!]!    # higher-priority rules this would silently shadow
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type RuleConflict {
  ruleId: UUID!
  ruleName: String!
  priority: Int!
  overlappingField: String!
  existingValue: String
  proposedValue: String
}

type ClassificationDecision {
  id: UUID!
  transactionId: UUID
  receiptItemId: UUID
  rawInput: String!
  normalizedInput: String!
  decidedBy: DecidedBy!
  ruleId: UUID
  rule: Rule
  categoryId: UUID
  category: Category
  confidence: Float
  confidenceRaw: Float               # pre-calibration, for debugging ([04 §6.4])
  candidates: JSON                   # top-N alternatives with scores
  aiProvider: AiProviderName
  aiModel: String
  promptTemplateId: UUID
  promptVersion: Int
  latencyMs: Int
  costMicros: String                 # string: money-adjacent, never a float
  createdAt: DateTime!
}

type Correction {
  id: UUID!
  transactionId: UUID
  field: CorrectionField!
  fromValue: String
  toValue: String
  wasAiSuggested: Boolean!
  ruleCreatedId: UUID
  ruleCreated: Rule
  synthesisedRule: RuleProposal      # computed, uncommitted (§5.4)
  createdAt: DateTime!
}

enum CorrectionField { category merchant counterparty kind amount }
```

```graphql
type Insight {
  id: UUID!
  kind: String!                      # BUDGET_PACE, CATEGORY_SPIKE, SUBSCRIPTION_DUE, POSITIVE_TREND…
  severity: InsightSeverity!
  periodStart: Date!
  periodEnd: Date!
  payload: JSON!                     # deterministic computed facts
  narrative: String                  # AI-added, validated; never the source of the numbers
  isDismissed: Boolean!
  createdAt: DateTime!
}

type AlertRule {
  id: UUID!
  kind: String!                      # BUDGET_THRESHOLD, PACE_OVERRUN, RECURRING_DUE, UNUSUAL_SPEND, GOAL_REACHED
  threshold: JSON!
  channels: [NotificationChannel!]!
  quietHours: JSON
  isActive: Boolean!
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type Notification {
  id: UUID!
  insightId: UUID
  insight: Insight
  channel: NotificationChannel!
  title: String!
  body: String!
  sentAt: DateTime
  readAt: DateTime
  status: NotificationStatus!
  createdAt: DateTime!
}

type PushSubscription {              # generated as PushSubscriptionModel, ADR-028
  id: UUID!
  endpoint: String!                  # the push service URL the browser minted; globally UNIQUE
  lastSeenAt: DateTime!              # last subscribe / re-subscribe; the dispatch path reads it
}
```

### 3.3 Computed / derived types

Every field below is produced by a backend calculator — `ledger`, `budgeting`, `goals` or `insights`
([05 §3](05-architecture.md)). **None may be produced by an LLM** ([03 §6](03-domain-model.md)). Each
carries the inputs it used so the number is reproducible and auditable (F-19 acceptance criterion:
*"the API response includes every input used in the calculation"*).

```graphql
type AccountBalance {
  accountId: UUID!
  current: Money!
  opening: Money!
  incomeTotal: Money!
  expenseTotal: Money!
  pendingDelta: Money!               # net effect of PENDING rows; excluded from current (I-7)
  asOf: DateTime!
  computedFromTransactionCount: Int!
}

type BudgetStatus {
  budgetId: UUID!
  categoryId: UUID
  period: BudgetPeriod!
  periodStart: Date!
  periodEnd: Date!
  budgeted: Money!
  spent: Money!
  remaining: Money!
  rolloverCarried: Money!
  consumedRatio: Float!              # 0..1, may exceed 1
  daysElapsed: Int!
  daysInPeriod: Int!
  paceDelta: Money!                  # spent − (budgeted × daysElapsed / daysInPeriod)
  projectedPeriodTotal: Money!       # deterministic pace projection (F-21)
  isBreached: Boolean!
  breachedAt: DateTime
  asOf: DateTime!
}

type SafeToSpend {
  amount: Money!                     # F-19
  period: String!                    # "2026-10"
  daysRemaining: Int!
  inputs: SafeToSpendInputs!         # every term of the calculation, surfaced
  asOf: DateTime!
}

type SafeToSpendInputs {
  monthlyBudget: Money!
  spentToDate: Money!
  reservedForRecurring: Money!       # remaining recurring obligations in the period
  savingsTargetRemaining: Money!
  remainingDays: Int!
}

type MonthProjection {
  period: String!
  spentToDate: Money!
  projectedTotal: Money!
  projectedOverspend: Money!         # negative when under
  dailyPace: Money!
  daysElapsed: Int!
  daysInPeriod: Int!
  confidence: ProjectionConfidence!
  baselineMethod: String!            # "PACE_LINEAR" | "PACE_ADJUSTED_RECURRING"
  asOf: DateTime!
}

enum ProjectionConfidence { LOW MEDIUM HIGH }   # by daysElapsed, not by model

type CategorySpend {
  categoryId: UUID
  category: Category
  periodStart: Date!
  periodEnd: Date!
  total: Money!
  transactionCount: Int!
  shareOfTotal: Float!
  priorPeriodTotal: Money
  changeRatio: Float                 # null when priorPeriodTotal = 0
  isSubtreeAggregate: Boolean!
}

type ReviewQueueItem {
  id: UUID!
  kind: ReviewItemKind!
  transaction: Transaction
  receiptItem: ReceiptItem
  reason: ReviewReason!
  confidence: Float
  suggestedCategoryId: UUID
  suggestedCategory: Category
  candidates: [ClassificationCandidate!]!
  amount: Money!
  occurredOn: Date!
  ageHours: Int!
}

enum ReviewItemKind { TRANSACTION RECEIPT_ITEM }

type ClassificationCandidate { categoryId: UUID! category: Category! confidence: Float! rationale: String }

type RecurringOccurrence {
  ruleId: UUID!
  rule: RecurringRule!
  occursOn: Date!
  amount: Money!
  description: String!
  categoryId: UUID
  isOverdue: Boolean!
  daysUntil: Int!                    # negative when overdue
}

type OcrJobStatus {
  receiptId: UUID!
  attachmentId: UUID!
  state: OcrState!
  progress: Float!
  attempts: Int!
  itemsExtracted: Int!
  ocrConfidence: Float
  lastError: String
  queuedAt: DateTime!
  updatedAt: DateTime!
  estimatedCompletionAt: DateTime
}
```

### 3.4 Connection types

One `<Entity>Edge` / `<Entity>Connection` pair per listable entity, generated by a shared helper so the
shape is identical everywhere:

```graphql
type TransactionConnection   { edges: [TransactionEdge!]!   pageInfo: PageInfo! totalCount: Int! }
type AccountConnection       { edges: [AccountEdge!]!       pageInfo: PageInfo! totalCount: Int! }
type CategoryConnection      { edges: [CategoryEdge!]!      pageInfo: PageInfo! totalCount: Int! }
type MerchantConnection      { edges: [MerchantEdge!]!      pageInfo: PageInfo! totalCount: Int! }
type CounterpartyConnection  { edges: [CounterpartyEdge!]!  pageInfo: PageInfo! totalCount: Int! }
type TagConnection           { edges: [TagEdge!]!           pageInfo: PageInfo! totalCount: Int! }
type ReceiptConnection       { edges: [ReceiptEdge!]!       pageInfo: PageInfo! totalCount: Int! }
type BudgetConnection        { edges: [BudgetEdge!]!        pageInfo: PageInfo! totalCount: Int! }
type SavingGoalConnection    { edges: [SavingGoalEdge!]!    pageInfo: PageInfo! totalCount: Int! }
type RecurringRuleConnection { edges: [RecurringRuleEdge!]! pageInfo: PageInfo! totalCount: Int! }
type RuleConnection          { edges: [RuleEdge!]!          pageInfo: PageInfo! totalCount: Int! }
type InsightConnection       { edges: [InsightEdge!]!       pageInfo: PageInfo! totalCount: Int! }
type NotificationConnection  { edges: [NotificationEdge!]!  pageInfo: PageInfo! totalCount: Int! }
type ReviewQueueConnection   { edges: [ReviewQueueEdge!]!   pageInfo: PageInfo! totalCount: Int! }
```

### 3.5 Input types

Only the non-obvious ones are shown in full; the remainder follow the same shape as their entity and
mirror exactly the nullable columns in [03 §4](03-domain-model.md).

```graphql
input TransactionCreateInput {
  accountId: UUID!
  kind: TransactionKind!
  amount: Money!
  categoryId: UUID
  merchantId: UUID
  counterpartyId: UUID
  description: String!
  note: String
  occurredAt: DateTime
  occurredLocalDate: Date            # one of occurredAt/occurredLocalDate required; occurredLocalDate wins
  tagIds: [UUID!]
  splits: [TransactionSplitInput!]
  attachmentId: UUID                 # single direct FK on the transaction (F-34)
  clientId: String                   # offline origin — unique per household
  idempotencyKey: String             # required when clientId is set
  clientMutationId: String
}

input TransactionUpdateInput {
  id: UUID!
  version: Int
  accountId: UUID
  kind: TransactionKind
  amount: Money
  categoryId: UUID
  clearCategory: Boolean = false
  merchantId: UUID
  counterpartyId: UUID
  description: String
  note: String
  occurredAt: DateTime
  occurredLocalDate: Date            # preferred over occurredAt; the server derives the instant
  tagIds: [UUID!]
  splits: [TransactionSplitInput!]
  attachmentId: UUID
  status: TransactionStatus
  clientMutationId: String
}

input TransactionSplitInput {
  id: UUID
  categoryId: UUID!
  amount: Money!
  note: String
}

input CategoryCreateInput {
  name: String!
  parentId: UUID
  kind: CategoryKind!
  icon: String
  color: String
  aiDescription: String
  sortOrder: Int
  clientMutationId: String
}

input CategoryUpdateInput {
  id: UUID!
  version: Int
  name: String
  parentId: UUID
  icon: String
  color: String
  aiDescription: String
  sortOrder: Int
  clientMutationId: String
}

# TransactionFilterInput is declared in full in §1.5 and is not repeated here.

input CategoryKeywordInput {
  keyword: String!
  polarity: KeywordPolarity!
  matchMode: KeywordMatchMode = WORD
  weight: Float = 1.0
}

input RuleInput {
  name: String!
  priority: Int = 100
  isActive: Boolean = true
  stopOnMatch: Boolean = true
  conditions: JSON!
  actions: JSON!
  clientMutationId: String
}
```

### 3.6 Standard payload shapes

Rather than repeat a near-identical wrapper 22 times, every mutation returns one of the following
shapes. `X` below stands for the entity name (`Account`, `Category`, `Merchant`, `Counterparty`, `Tag`,
`Transaction`, `Rule`, `Budget`, `SavingGoal`, `RecurringRule`, `AlertRule`, `Attachment`, `Notification`,
`Insight`, `Receipt`, `User`, `Household`, `Membership`, `Invitation`, `AiProviderConfig`).

```graphql
# The success/conflict/not-found/validation pattern used by every entity mutation.
union XPayload     = XSuccess | ConflictError | NotFoundError | ValidationError
type XSuccess      { x: X!  clientMutationId: String }        # field named after the entity, e.g. account:
type BulkPayload   { updatedCount: Int!  affectedIds: [UUID!]!  userErrors: [UserError!]!  clientMutationId: String }
type SimplePayload { ok: Boolean!  userErrors: [UserError!]!  clientMutationId: String }

# Auth results — same pattern, plus the session.
union SignUpResult     = AuthPayload | ValidationError
union LogInResult      = AuthPayload | ValidationError | RateLimitedError
union LogOutPayload    = SimplePayload
union VerifyEmailPayload = SimplePayload | ValidationError
```

So `createAccount(input: AccountCreateInput!): AccountPayload!` is
`AccountSuccess | ConflictError | NotFoundError | ValidationError`, and
`deleteTag(id: UUID!): TagPayload!` is `TagSuccess | ConflictError | NotFoundError | ValidationError`.
`BudgetPayload`, `NotificationPayload` and `InsightPayload` are the same pattern with their own success
arms, documented at their mutation (§5.6, §5.10).

`ValidationError`, `NotFoundError`, `QuotaExceededError`, `UserError` and `ErrorCode` are defined in §10;
`ConflictError` in §1.7; `RateLimitedError` in §5.2.

### 3.7 Non-obvious input types

Entity create/update inputs mirror their entity field-for-field with every field optional on update and
required-on-create per [03 §4](03-domain-model.md). The inputs below carry semantics of their own and are
therefore specified:

```graphql
input TransactionBulkPatchInput {
  categoryId: UUID
  merchantId: UUID
  counterpartyId: UUID
  tagIds: [UUID!]
  addTagIds: [UUID!]
  status: TransactionStatus
}

input TransferInput {
  fromAccountId: UUID!
  toAccountId: UUID!
  amount: Money!
  description: String
  occurredOn: Date
  occurredAt: DateTime
  idempotencyKey: String!
}

input CommitAttachmentInput {
  attachmentId: UUID!
  purpose: AttachmentPurpose!
  receiptId: UUID              # attach to an existing receipt and kick off OCR
  transactionId: UUID
}

input UpdateReceiptItemInput {
  receiptItemId: UUID!
  categoryId: UUID
  amount: Money
  normalizedName: String
  markReviewed: Boolean = false
}

input BulkResolveReviewItemsInput {
  items: [ResolveReviewItemInput!]!   # max 50
  stopOnConflict: Boolean = true
}

input InsightFilterInput {
  kind: [String!]
  severity: [InsightSeverity!]
  includeDismissed: Boolean = false
  periodStartOnOrAfter: Date
}

input ReceiptFilterInput {
  merchantId: UUID
  reconciliation: [ReconciliationState!]
  capturedOnOrAfter: DateTime
  capturedOnOrBefore: DateTime
  unlinkedOnly: Boolean
}

input AlertRuleInput {
  kind: String!
  threshold: JSON!
  channels: [NotificationChannel!]!
  quietHours: JSON
  isActive: Boolean = true
}

input AlertRuleUpdateInput { id: UUID! version: Int kind: String threshold: JSON channels: [NotificationChannel!] quietHours: JSON isActive: Boolean }

input NotificationPreferencesInput {
  channels: [NotificationChannel!]!
  quietHours: JSON
  positiveFeedback: Boolean = true
  locale: String
}

input PushSubscriptionInput {         # only what a browser can mint; never a householdId (§2)
  endpoint: String!
  p256dh: String!
  auth: String!
  userAgent: String
}

input HouseholdSettingsInput {
  name: String
  ianaTimezone: String
  autoConfirmThreshold: Float          # 0..1; audit-logged on change (04 §7)
  reviewThreshold: Float               # 0..1
  aiConsentGiven: Boolean
}

input AiProviderConfigInput {
  task: AiTask!
  provider: AiProviderName!
  model: String!
  region: String
  params: JSON
  isActive: Boolean = true
}

input UpdateProfileInput { displayName: String locale: String }

input CreateInvitationInput {
  email: String!
  role: HouseholdRole!
  expiresInDays: Int = 7
}
# ExportDataInput is declared with its export semantics in §5.11 and is not repeated here.
```

---

## 4. Queries

One `Query` root, grouped by module. A trailing `# CP` comment marks a field on the dashboard critical
path, which must meet the p95 ≤ 300 ms budget ([01 §7](01-product-requirements.md)); the comment is
documentation only and is not part of the deployed SDL.

```graphql
type Query {
  # ---- identity & household
  me: User!
  activeHousehold: Household!                 # CP
  householdMembers: [Membership!]!

  # ---- ledger
  transactions(filter: TransactionFilterInput, sort: [TransactionSortInput!],
               first: Int, after: Cursor): TransactionConnection!                 # CP
  transaction(id: UUID!): Transaction
  account(id: UUID!): Account
  accounts(includeArchived: Boolean = false): [Account!]!                 # CP
  accountBalance(accountId: UUID!): AccountBalance!                 # CP

  # ---- taxonomy
  categories(kind: CategoryKind, includeArchived: Boolean = false): [Category!]!                 # CP
  category(id: UUID!): Category
  categoryTree(kind: CategoryKind): [Category!]!                 # CP
  categoryKeywords(categoryId: UUID!): [CategoryKeyword!]!
  merchants(search: String, first: Int, after: Cursor): MerchantConnection!
  merchant(id: UUID!): Merchant
  counterparties(search: String, first: Int, after: Cursor): CounterpartyConnection!
  counterparty(id: UUID!): Counterparty
  tags: [Tag!]!

  # ---- capture & classification
  reviewQueue(filter: ReviewQueueFilterInput, sort: [ReviewQueueSortInput!],
              first: Int, after: Cursor): ReviewQueueConnection!                 # CP
  reviewQueueCount: Int!                 # CP
  classificationDecision(id: UUID!): ClassificationDecision
  classificationDecisions(transactionId: UUID!, first: Int, after: Cursor): [ClassificationDecision!]!
  correction(id: UUID!): Correction
  corrections(transactionId: UUID, first: Int, after: Cursor): [Correction!]!
  rules(search: String, includeInactive: Boolean = false): [Rule!]!
  rule(id: UUID!): Rule

  # ---- receipts & files
  receipt(id: UUID!): Receipt
  receipts(filter: ReceiptFilterInput, first: Int, after: Cursor): ReceiptConnection!
  ocrJob(receiptId: UUID!): OcrJobStatus

  # ---- planning
  budgets(period: BudgetPeriod, includeArchived: Boolean = false): [Budget!]!                 # CP
  budget(id: UUID!): Budget
  budgetStatus(budgetId: UUID!, asOf: Date): BudgetStatus!                 # CP
  savingGoals(status: [GoalStatus!]): [SavingGoal!]!                 # CP
  savingGoal(id: UUID!): SavingGoal
  recurringRules(activeOnly: Boolean = true): [RecurringRule!]!                 # CP
  upcomingRecurring(withinDays: Int = 30): [RecurringOccurrence!]!                 # CP

  # ---- intelligence
  dashboard(asOf: Date, period: String): Dashboard!                 # CP
  insights(filter: InsightFilterInput, first: Int, after: Cursor): InsightConnection!                 # CP
  alerts: [AlertRule!]!
  notifications(unreadOnly: Boolean = false, first: Int, after: Cursor): NotificationConnection!
  unreadNotificationCount: Int!                 # CP
  pushPublicKey: String                         # VAPID public key, or null when push is unconfigured (ADR-028)

  # ---- analytics
  spendByCategory(range: DateRangeInput!, accountIds: [UUID!], includeSubcategories: Boolean = true): [CategorySpend!]!                 # CP
  spendOverTime(range: DateRangeInput!, bucket: TimeBucket!, categoryIds: [UUID!]): [SpendBucket!]!
  topMerchants(range: DateRangeInput!, limit: Int = 10): [MerchantSpend!]!
  monthComparison(period: String!, compareTo: String): MonthComparison!
  cashflow(range: DateRangeInput!, bucket: TimeBucket!): [CashflowBucket!]!
  safeToSpend(asOf: Date): SafeToSpend!                 # CP
  monthProjection(period: String, asOf: Date): MonthProjection!                 # CP

  # ---- assistant
  assistantAnswer(question: String!, locale: String): AssistantAnswerModel!      # 3.2.3
  assistantSuggestions: [String!]!                                    # 3.2.4, the starter chips
  assistantProposeAction(question: String!, kind: CategoryKind, locale: String): AssistantActionProposalModel!   # B-2a, ADR-035

  # ---- search
  search(query: String!, entities: [SearchEntity!], limit: Int = 20): SearchResults!

  # ---- offline sync
  syncChanges(since: Cursor, limit: Int = 500, entityTypes: [SyncEntityType!]): SyncDelta!                 # CP
  syncState: SyncState!                 # CP
}
```

### 4.1 Dashboard — one round trip for all tiles

The dashboard is a single query on purpose. Six tiles resolved by six requests is six round trips on a
mid-range Android device, and the F-19 acceptance criterion is that the figure is *there* when the
dashboard loads.

```graphql
type Dashboard {
  asOf: DateTime!
  period: String!                    # "2026-10"
  periodStart: Date!
  periodEnd: Date!
  timezone: String!                  # so the client renders boundaries without guessing

  spentThisMonth: Money!                 # CP
  incomeThisMonth: Money!                 # CP
  netThisMonth: Money!                 # CP
  safeToSpend: SafeToSpend!                 # CP
  monthProjection: MonthProjection!                 # CP
  budgetStatuses: [BudgetStatus!]!                 # CP
  topCategories: [CategorySpend!]!                 # CP
  goals: [SavingGoal!]!                 # CP
  recentTransactions(first: Int = 10): [Transaction!]!                 # CP
  reviewQueueCount: Int!                 # CP
  unreadNotificationCount: Int!                 # CP
  upcomingRecurring(withinDays: Int = 14): [RecurringOccurrence!]!                 # CP
  insights(limit: Int = 3): [Insight!]!                 # CP

  cachedAt: DateTime                 # set when served from Redis during degradation ([05 §11])
  isStale: Boolean!                  # client MUST show "as of <asOf>" when true
}
```

`isStale` and `cachedAt` exist because [05 §7](05-architecture.md) is explicit: *"showing a stale 'safe
to spend' without a timestamp is a trust bug."* Offline, the client renders the cached snapshot with the
same labelling.

### 4.2 Review queue

```graphql
input ReviewQueueFilterInput {
  kind: [ReviewItemKind!]
  reason: [ReviewReason!]
  confidenceBelow: Float
  occurredOnOrAfter: Date
  occurredOnOrBefore: Date
  categoryIds: [UUID!]
}

input ReviewQueueSortInput { field: ReviewQueueSortField! direction: SortDirection! }
enum ReviewQueueSortField { AGE CONFIDENCE AMOUNT OCCURRED_LOCAL_DATE }
```

Ordered by `ageHours DESC` by default. The queue is keyboard-driven on desktop (F-08) and bulk-resolvable
via `resolveReviewItem` with `applyToSimilar` (§5.5), which is the affordance that keeps the queue from
becoming a chore — and a nuisance queue is a churn driver ([04 §6.4](04-categorization-and-ai-engine.md)).

#### 4.2.1 Implementation notes (task 2.3.2a, and what the 2.3.2b screen does not use)

`reviewQueue` serves **Lane A only** — the blocking set from invariant I-8. Lane B, the advisory band
of [04 §7](04-categorization-and-ai-engine.md#7-stage-6-confidence-gates) (`category_source = 'AI'`,
confidence in `[0.60, 0.90)`), is **not reachable through this API**, and the screen that consumes it
(docs/02 §4.6) therefore ships without its tab. Two blockers, both structural rather than cosmetic:

- `reviewQueue` filters `needs_review: true`, and the advisory band never sets that flag — I-8 defines
  it as the blocking lane only. A lane argument would need a different SQL predicate, not a wider one;
- `resolveReviewItem` is a **no-op** on a row whose `needs_review` is already false (deliberately: two
  devices clearing the same queue is not an error). So even a listed advisory row could not be acted on
  without a lane-aware write predicate, which changes the meaning of the operation's guard.

That is a task, not a parameter, so it is recorded here rather than half-served.

**The `reason` and `confidenceBelow` filters are applied to the enriched item, not in SQL.** They work,
but a filtered page can come back **shorter than `first`** while matches sit on the next page, because
the page is fetched first and filtered afterwards. Nothing on the 2.3.2b screen uses them: a control
whose "nothing matches" can be false is worse than no control. Pushing either predicate into the
ledger's `list` (or paging until the page is full) is the prerequisite for a filter UI.

### 4.3 Analytics (task 3.3.1)

```graphql
input DateRangeInput { start: LocalDate! end: LocalDate! }   # inclusive, Household-local days
enum TimeBucket { DAY WEEK MONTH QUARTER }                   # derived from @finmate/domain's TIME_BUCKETS

type SpendBucket {
  bucketStart: LocalDate!
  bucketEnd: LocalDate!
  expenseTotal: Money!
  incomeTotal: Money!
  transactionCount: Int!
}

type CashflowBucket {
  bucketStart: LocalDate!
  income: Money!
  expense: Money!
  net: Balance!              # SIGNED — a month can pay out more than it takes in
}

type MerchantSpend {
  merchantId: UUID
  displayName: String!       # merchant name, or the raw description when unresolved
  total: Money!              # the WHOLE Transaction, splits included
  transactionCount: Int!
}

type CategorySpend {
  categoryId: UUID           # null is the uncategorised bucket
  category: Category
  periodStart: LocalDate!
  periodEnd: LocalDate!
  total: Money!
  transactionCount: Int!
  shareOfTotal: Float!
  priorPeriodTotal: Money
  changeRatio: Float         # null when there is no basis for a comparison
  isSubtreeAggregate: Boolean!
}

type MonthComparison {
  period: String!            # YYYY-MM
  compareTo: String!         # YYYY-MM
  total: Money!
  compareTotal: Money!
  delta: Balance!            # SIGNED
  deltaRatio: Float
  categories: [CategorySpend!]!   # each with priorPeriodTotal + changeRatio populated
}

type Query {
  spendByCategory(range: DateRangeInput!, accountIds: [UUID!], includeSubcategories: Boolean = true): [CategorySpend!]!
  spendOverTime(range: DateRangeInput!, bucket: TimeBucket!, categoryIds: [UUID!]): [SpendBucket!]!
  topMerchants(range: DateRangeInput!, limit: Int = 10): [MerchantSpend!]!
  monthComparison(period: String!, compareTo: String): MonthComparison!
  cashflow(range: DateRangeInput!, bucket: TimeBucket!): [CashflowBucket!]!
}
```

Aggregations run over `CONFIRMED`, non-deleted transactions only (I-7). Every response includes the
range it was computed over; there is no "guess what period this is" behaviour anywhere in the schema.
The generated SDL names the object types with the repo's `Model` suffix (`CategorySpendModel` and so
on); the sketch above uses the document's own shorthand.

**Splits (I-1, ADR-015).** Every figure comes from `SpendReadModel`, the one split-aware aggregate, so
analytics, the budget tile and the assistant cannot disagree about what a Category cost (§5.13).

- `spendByCategory` returns **every Category with spend plus every ancestor that aggregates it**, so a
  client can draw a tree. A flat chart reads the **roots** (a root's figure covers its subtree, and the
  roots partition the categorised spend) or asks for `includeSubcategories: false`, which returns only
  the Categories carrying spend of their own.
- The money that landed in **no** Category is a row with `categoryId: null` and `category: null`, and
  `shareOfTotal` is each row over the range's **whole** confirmed expense — so the leaf rows' shares add
  up to 1 *including* the uncategorised bucket. Omitting it would let a Household with 30 %
  uncategorised spend see shares describing only the other 70 %.
- `changeRatio` is **`null` when there is nothing to compare against** — no baseline spend at all, or a
  baseline of zero (an infinite increase is not a ratio). docs/02 §4.15 renders that as *nema osnova za
  poređenje*. `-1` is a real value: the Category fell by 100 %.
- `topMerchants` counts a split receipt under the shop that was paid, in full. A row whose Merchant was
  never resolved is listed under its raw description rather than dropped.
- `spendOverTime`'s `categoryIds` is a **subtree** scope (the ids given plus every descendant): a parent
  Category with no spending of its own is the normal case, and a series that answered zero for it would
  contradict the bar beside it. A split lands in its parent's bucket, on the parent's day and kind.
- `transactionCount` is the number of contributing Transactions: for a leaf Category that is exact, and
  for a subtree aggregate it is a **sum over the descendants**, so one receipt split across two children
  of the same parent counts once in each. A distinct-count-per-node query is not worth its cost for a
  chart that shows money.
- `monthComparison` accepts `period` as `YYYY-MM` (the format was unstated before 3.3.1); `compareTo`
  defaults to the month before. Both months are rolled up exactly as `spendByCategory` rolls up, and a
  Category that had spend **only** in the baseline month is present with `total: 0` and a ratio of `-1`
  rather than being dropped — disappearing is the most interesting thing a Category can do.

**Two corrections to this document, both forced by the type system rather than chosen.** `delta` and
`net` were written as `Money`, which is *non-negative by contract* (ADR-003): a deficit month or a
lower-spending month would have been unserialisable. They are `Balance`, the signed scalar that exists
for exactly this. And the ranges were written as `Date`; the schema has no `Date` scalar — a Household
day is `LocalDate` (docs/03 §3.2), which is why a range cannot be timezone-shifted by a client.

### 4.4 Assistant

**Implemented in 3.2.3** — this block is the generated `apps/api/schema.gql`, verbatim in shape. The
wire names carry the `Model` suffix, as every other object type in this schema does.

```graphql
type AssistantAnswerModel {
  id: UUID!
  question: String!
  intent: AssistantIntent!
  answered: Boolean!
  answerText: String!                # narrated, or template-rendered on fallback
  facts: AssistantFactsModel!        # the ONLY numbers the answer may contain
  provenance: ProvenanceModel!
  drillThrough: DrillThroughModel
  suggestions: [String!]!            # the canonical answerable questions when answered = false
  narrationMode: NarrationMode!      # LLM | TEMPLATE_FALLBACK
  latencyMs: Int!
  costMicros: String
  reason: String                     # why it is a refusal or a fallback; never shown as an error
}

enum NarrationMode { LLM TEMPLATE_FALLBACK }

type AssistantFactsModel {
  template: AssistantIntent!
  rows: [AssistantFactRowModel!]!
  totals: [AssistantFactTotalModel!]!
  formatted: JSON!                   # locale+currency pre-formatted strings (see §8.2)
}

type AssistantFactRowModel { label: String! value: String! formatted: String! categoryId: UUID merchantId: UUID }
type AssistantFactTotalModel { label: String! money: Money! formatted: String! }

type ProvenanceModel {
  periodStart: LocalDate!            # the aggregated range, which is not always the planned one (§8.3)
  periodEnd: LocalDate!
  transactionCount: Int!
  sourceQuery: String!
  filters: JSON
  computedAt: DateTime!
  ledgerCurrency: String!
}

type DrillThroughModel {
  route: String!                     # Angular route, e.g. /transactions, /review, /budgets, /accounts
  transactionIds: [UUID!]!           # the rows a LIST answer is made of; empty for an aggregate
  filter: JSON                       # the `transactions` arguments that reproduce the scope, by name
}
```

Three corrections against the sketch this section used to carry, each made when the operation was
built (docs/06 §8.7 has the reasoning):

| Sketch | Built | Why |
|---|---|---|
| `assistantAnswer(question, locale, conversationId)` | `assistantAnswer(question: String!, locale: String)` | There is no conversation store, so `conversationId` would be a parameter nothing honours. An accepted-and-ignored argument is a contract the API cannot keep. The transcript lives in the client until a store is designed. |
| `DrillThrough.filter: TransactionFilterInput` | `JSON` | No such input type exists: the `transactions` query takes **flat** arguments (`from`, `to`, `categoryId`, `accountId`, `kind`, `needsReview`), and this bag names exactly those, so the client maps it one-to-one rather than translating between two vocabularies. |
| `provenance.periodStart: Date!` | `LocalDate!` | A provenance range is a **calendar** range, not an instant; `LocalDate` is the scalar the rest of the API uses for one, and it is what the planner resolved. |

`drillThrough` is null in two cases, and both are deliberate rather than unfinished: a **refusal** has
nothing to link to, and a **merchant- or tag-scoped** answer has no route that can reproduce its scope
until `transactions` accepts `merchantId`/`tagId` (§8.8).

`assistantSuggestions` (added by 3.2.4) returns the canonical answerable questions from the intent
registry, so the screen's starter chips and a refusal's suggestions are the **same closed set**. Without
it the client would hold a second copy of the planner's question list, and the first one to drift would
send a user to a question the planner cannot route.

### 4.5 Search

```graphql
enum SearchEntity { TRANSACTION MERCHANT COUNTERPARTY CATEGORY TAG }

type SearchResults {
  transactions: [Transaction!]!
  merchants: [Merchant!]!
  counterparties: [Counterparty!]!
  categories: [Category!]!
  tags: [Tag!]!
  totalCount: Int!
}
```

Backed by `pg_trgm` plus the normalised (transliterated, unaccented) columns, so a Cyrillic query
`Лиди` matches the latin `Lidl` row. Cyrillic-tolerant search is a requirement, not a nicety
(F-27, [01 §3.4](01-product-requirements.md)).

### 4.6 Offline sync delta

```graphql
enum SyncEntityType {
  TRANSACTION ACCOUNT CATEGORY CATEGORY_KEYWORD MERCHANT MERCHANT_ALIAS
  COUNTERPARTY COUNTERPARTY_ALIAS TAG BUDGET SAVING_GOAL RECURRING_RULE
  RULE NOTIFICATION HOUSEHOLD_SETTINGS
}

type SyncDelta {
  cursor: Cursor!                    # opaque server position; pass back as `since`
  serverTime: DateTime!
  hasMore: Boolean!
  upserts: SyncUpserts!
  deletions: SyncDeletions!
  reclassificationDiffs: [ReclassificationDiff!]!
  counts: SyncCounts!
}

type SyncUpserts {
  transactions: [Transaction!]!
  accounts: [Account!]!
  categories: [Category!]!
  merchants: [Merchant!]!
  counterparties: [Counterparty!]!
  tags: [Tag!]!
  budgets: [Budget!]!
  savingGoals: [SavingGoal!]!
  recurringRules: [RecurringRule!]!
  rules: [Rule!]!
  notifications: [Notification!]!
}

type SyncDeletions {
  ids: [UUID!]!                      # soft-deleted rows the client must drop
  byType: JSON!                      # { "TRANSACTION": ["uuid", ...], ... }
}

type ReclassificationDiff {
  transactionId: UUID!
  clientId: String                   # present when the row originated offline
  fromCategoryId: UUID
  toCategoryId: UUID
  toCategory: Category
  confidence: Float
  decidedBy: DecidedBy!
  reason: ReviewReason!
  requiresUserConfirmation: Boolean!
}

type SyncCounts { upserted: Int! deleted: Int! diffs: Int! }

type SyncState {
  serverTime: DateTime!
  latestCursor: Cursor!
  serverSchemaVersion: String!
  minSupportedClientSchema: String!  # client shows a hard "update required" if below
}
```

`syncChanges` is the read half of F-26; `captureCommit` with `clientId` + `idempotencyKey` is the write
half. A full worked transcript is in §12.

`reclassificationDiffs` implements [05 §7](05-architecture.md): *"an offline row captured with no AI
available may be categorised differently once synced, and the user must see that rather than be surprised
by a changed category."* The diff is informational — the server's classification is already persisted —
but `requiresUserConfirmation = true` puts it in the review queue (§5.5) rather than changing the ledger
silently.

---

## 5. Mutations

Only the domain-specific payloads are shown in full. Every `*Create`/`*Update`/`*Delete` mutation returns
the entity plus `userErrors: [UserError!]!`, so expected failures do not require the client to parse a
GraphQL `errors` array. `ErrorCode`, `ConflictError` and the union pattern are defined in §10.

```graphql
type Mutation {
  # ---------- auth & session (F-28) — inputs and semantics in §2.2
  signUp(input: SignUpInput!): SignUpResult!
  logIn(input: LogInInput!): LogInResult!
  refreshSession(input: RefreshSessionInput): AuthPayload!
  logOut(input: LogOutInput): LogOutPayload!
  verifyEmail(input: VerifyEmailInput!): VerifyEmailPayload!
  requestEmailVerification(input: RequestEmailVerificationInput): SimplePayload!
  requestPasswordReset(input: RequestPasswordResetInput!): SimplePayload!
  resetPassword(input: ResetPasswordInput!): SimplePayload!

  # ---------- ledger (F-04)
  createTransaction(input: TransactionCreateInput!): TransactionPayload!
  updateTransaction(input: TransactionUpdateInput!): TransactionPayload!
  deleteTransaction(id: UUID!, version: Int): TransactionPayload!
  restoreTransaction(id: UUID!): TransactionPayload!
  splitTransaction(id: UUID!, splits: [TransactionSplitInput!]!, version: Int): TransactionPayload!
  bulkUpdateTransactions(ids: [UUID!]!, patch: TransactionBulkPatchInput!): BulkPayload!
  bulkDeleteTransactions(ids: [UUID!]!): BulkPayload!
  transferBetweenAccounts(input: TransferInput!): TransactionPayload!

  # ---------- accounts (F-01)
  createAccount(input: AccountCreateInput!): AccountPayload!
  updateAccount(input: AccountUpdateInput!): AccountPayload!
  archiveAccount(id: UUID!, version: Int): AccountPayload!
  reorderAccounts(ids: [UUID!]!): BulkPayload!

  # ---------- taxonomy (F-02, F-03, F-10, F-11, F-12)
  createCategory(input: CategoryCreateInput!): CategoryPayload!
  updateCategory(input: CategoryUpdateInput!): CategoryPayload!
  deleteCategory(id: UUID!, reassignToId: UUID, version: Int): CategoryPayload!
  moveCategory(id: UUID!, newParentId: UUID, version: Int): CategoryPayload!
  setCategoryKeywords(categoryId: UUID!, keywords: [CategoryKeywordInput!]!): CategoryPayload!
  createMerchant(input: MerchantCreateInput!): MerchantPayload!
  updateMerchant(input: MerchantUpdateInput!): MerchantPayload!
  deleteMerchant(id: UUID!, version: Int): MerchantPayload!
  mergeMerchants(sourceId: UUID!, targetId: UUID!): MerchantPayload!
  setMerchantAliases(merchantId: UUID!, aliases: [String!]!): MerchantPayload!
  createCounterparty(input: CounterpartyCreateInput!): CounterpartyPayload!
  updateCounterparty(input: CounterpartyUpdateInput!): CounterpartyPayload!
  deleteCounterparty(id: UUID!, version: Int): CounterpartyPayload!
  mergeCounterparties(sourceId: UUID!, targetId: UUID!): CounterpartyPayload!
  setCounterpartyAliases(counterpartyId: UUID!, aliases: [String!]!): CounterpartyPayload!
  createTag(input: TagCreateInput!): TagPayload!
  updateTag(input: TagUpdateInput!): TagPayload!
  deleteTag(id: UUID!): TagPayload!
  assignTags(transactionId: UUID!, tagIds: [UUID!]!): TransactionPayload!

  # ---------- capture (F-05, F-06)
  captureParse(input: CaptureParseInput!): CaptureParseResult!
  captureCommit(input: CaptureCommitInput!): CaptureCommitResult!

  # ---------- classification & learning (F-07, F-08, F-09, F-31)
  correctTransaction(input: CorrectTransactionInput!): CorrectTransactionResult!
  createRuleFromCorrection(input: CreateRuleFromCorrectionInput!): CreateRuleFromCorrectionResult!
  resolveReviewItem(input: ResolveReviewItemInput!): ResolveReviewItemResult!
  bulkResolveReviewItems(input: BulkResolveReviewItemsInput!): BulkPayload!
  createRule(input: RuleInput!): RulePayload!
  updateRule(input: RuleUpdateInput!): RulePayload!
  deleteRule(id: UUID!): RulePayload!
  applyRuleToExisting(ruleId: UUID!, previewOnly: Boolean = true): RuleBackfillResult!

  # ---------- receipts (F-14, F-34)
  commitReceipt(input: CommitReceiptInput!): ReceiptPayload!
  reconcileReceipt(input: ReconcileReceiptInput!): ReceiptPayload!
  updateReceiptItem(input: UpdateReceiptItemInput!): ReceiptPayload!
  attachReceiptToTransaction(receiptId: UUID!, transactionId: UUID!): ReceiptPayload!
  retryOcr(receiptId: UUID!): ReceiptPayload!

  # ---------- planning (F-17, F-18, F-16)
  createBudget(input: BudgetCreateInput!): BudgetPayload!
  updateBudget(input: UpdateBudgetInput!): BudgetPayload!
  deleteBudget(id: UUID!, version: Int): BudgetPayload!
  createSavingGoal(input: SavingGoalCreateInput!): SavingGoalPayload!
  updateSavingGoal(input: SavingGoalUpdateInput!): SavingGoalPayload!
  deleteSavingGoal(id: UUID!, version: Int): SavingGoalPayload!
  contributeToGoal(input: ContributeToGoalInput!): GoalContributionResult!
  deleteGoalContribution(id: UUID!): SavingGoalPayload!
  createRecurringRule(input: RecurringRuleCreateInput!): RecurringRulePayload!
  updateRecurringRule(input: RecurringRuleUpdateInput!): RecurringRulePayload!
  deleteRecurringRule(id: UUID!, version: Int): RecurringRulePayload!
  materialiseRecurring(input: MaterialiseRecurringInput!): MaterialiseRecurringResult!
  confirmDetectedSubscription(ruleId: UUID!): RecurringRulePayload!
  dismissDetectedSubscription(ruleId: UUID!): SimplePayload!

  # ---------- assistant writes (ADR-035, B-2a)
  # The assistant's ONE write path. It takes the proposal id and nothing else, so the action performed
  # is byte-for-byte the action the confirmation card showed. `idempotencyKey` makes a retry answer the
  # same result instead of writing a second time.
  assistantExecuteAction(proposalId: UUID!, idempotencyKey: String!): AssistantActionResultModel!

  # ---------- intelligence (F-22)
  dismissInsight(id: UUID!): InsightPayload!
  markNotificationRead(id: UUID!): NotificationPayload!
  markAllNotificationsRead(): BulkPayload!
  createAlertRule(input: AlertRuleInput!): AlertRulePayload!
  updateAlertRule(input: AlertRuleUpdateInput!): AlertRulePayload!
  deleteAlertRule(id: UUID!): AlertRulePayload!
  updateNotificationPreferences(input: NotificationPreferencesInput!): SimplePayload!
  registerPushSubscription(input: PushSubscriptionInput!): PushSubscription!   # generated as PushSubscriptionModel (ADR-028)
  deletePushSubscription(endpoint: String!): Boolean!

  # ---------- settings, household, lifecycle
  updateHouseholdSettings(input: HouseholdSettingsInput!): HouseholdPayload!
  updateProfile(input: UpdateProfileInput!): UserPayload!
  createInvitation(input: CreateInvitationInput!): InvitationPayload!
  acceptInvitation(token: String!): HouseholdPayload!
  updateMemberRole(membershipId: UUID!, role: HouseholdRole!): MembershipPayload!
  removeMember(membershipId: UUID!): SimplePayload!
  upsertAiProviderConfig(input: AiProviderConfigInput!): AiProviderConfigPayload!

  # ---------- files & data ownership (F-25, [08])
  commitAttachment(input: CommitAttachmentInput!): AttachmentPayload!
  deleteAttachment(id: UUID!): SimplePayload!
  exportData(input: ExportDataInput!): ExportDataResult!
  requestAccountDeletion(input: RequestAccountDeletionInput!): RequestAccountDeletionResult!
  cancelAccountDeletion(requestId: UUID!): SimplePayload!
}
```

### 5.0 Taxonomy mutations — implementation deviation (Merchants)

Merchants are implemented with the shapes in §3 and §4, with three deviations worth naming rather
than discovering:

| Spec | Implemented | Why |
|---|---|---|
| `createMerchant(input: MerchantCreateInput!): MerchantPayload!` | `createMerchant(name, defaultCategoryId, aiHint): Merchant!` | The implemented surface throughout Phase 1 returns the entity directly and uses `Boolean!` for deletes; the `XPayload` wrappers of §3.6 are not built yet. Introducing them for Merchants alone would make one module inconsistent with the rest. |
| `deleteMerchant(id: UUID!, version: Int): MerchantPayload!` | `deleteMerchant(id: UUID!): Boolean!` | `merchants` has **no `version` column**, so there is nothing to compare. Two devices editing one Merchant therefore last-write-wins. Acceptable because the row holds no money — a name, aliases and an optional default Category — so a lost update costs a rename, not a total. Adding the column is a migration and not worth one until it bites. |
| `defaultCategory: Category` | `defaultCategoryPath: [String!]` | A full `Category` carries depth, `sortOrder`, keywords and a path resolved against the whole tree, which is a lot of machinery to hang off an optional hint that ReceiptItem classification outranks anyway (docs/04 §6.3). The breadcrumb is what the UI renders. |

**Seeds are copy-on-write, and it applies to merge targets too.** A global Merchant (`is_global`,
`household_id IS NULL`) is read-only, so `updateMerchant`, `setMerchantAliases` and a `mergeMerchants`
whose *target* is global all produce a Household-owned copy and move this Household's references onto
it. Merging into a seed is a write to it — the alias union has to be stored somewhere — so without
the copy the merge failed as an opaque `P2025`. The platform row is never mutated.

**Merging is the deletion path for a Merchant in use.** `deleteMerchant` refuses with `CONFLICT` while
Transactions, Receipts or RecurringRules reference the row and names merging as the way forward;
`mergeMerchants` is what moves them. A Merchant that is still referenced is never deleted outright,
and a shipped Merchant is never deleted at all.

### 5.0.1 Taxonomy mutations — implementation deviation (Counterparties, Tags)

Counterparties and Tags are implemented with the shapes in §3 and §4 and the same Phase-1 conventions
Merchants established in §5.0 — mutations return the entity directly, deletes return `Boolean!`, and
there is no `version` argument, because neither `counterparties` nor `tags` has a `version` column.
Two deviations belong to these two tables specifically:

| Spec | Implemented | Why |
|---|---|---|
| `defaultCategory: Category` on `Counterparty` | `defaultCategoryPath: [String!]` | The same breadcrumb Merchants use and for the same reason: a full `Category` drags depth, `sortOrder`, keywords and a whole-tree path onto an optional hint. |
| `assignTags(transactionId, tagIds): TransactionPayload!` | `tagIds: [ID!]` on `createTransaction` / `updateTransaction` | Assignment belongs to the write that owns the Transaction. A separate mutation would have to re-check the `version` and re-implement the replace-vs-omit rule the update path already carries. On `update`, `tagIds` **replaces** the whole set when provided, is left alone when omitted, and an empty array clears it. |

**Tag deletion is a cascade, not a refusal — deliberately unlike a Merchant or a Category.**
`deleteMerchant` and `deleteCategory` refuse with `CONFLICT` while anything references the row and
name a reassignment path, because the reference is information the user cannot re-enter from memory:
which shop the payment went to, which category the cost belongs to. A Tag is a label, so there is
nothing to reassign `#vanredno` *to*; the analogue of reassignment here is removing the assignments.
`deleteTag` therefore soft-deletes the Tag **and deletes its `transaction_tags` rows for this
Household**. A dangling label is worse than a missing one: the Tag would vanish from the picker while
every Transaction still held an assignment that renders as nothing and can never be removed. The
Transaction itself is untouched — no amount, no category, no date.

**Counterparties have no copy-on-write, and no global rows.** `counterparties.household_id` is
`NOT NULL`, so the seeded-catalogue machinery Merchants need has nothing to protect here.
`deleteCounterparty` refuses while Transactions reference the row and names merging;
`mergeCounterparties` moves them, unions the folded aliases, then soft-deletes the source. There is no
"shipped" direction to refuse — only the self-merge. Counts cover Transactions only: `receipts` has no
`counterparty_id` column (docs/03 §4).

### 5.1 `captureParse`

The preview half of the capture path. Called debounced at 250 ms while the user types
([05 §5.3](05-architecture.md)). **Read-only with respect to the ledger**: it writes a
`classification_decisions` row for audit/cost and nothing else. It is safe to call on every keystroke
pause, and it is idempotent for a given input.

```graphql
input CaptureParseInput {
  text: String!                      # e.g. "Lidl 2000, gorivo 3500, plata 150000"
  defaultAccountId: UUID
  occurredAt: DateTime               # default: now, in the household timezone
  locale: String                     # default: household locale
  allowAi: Boolean = true            # false ⇒ rules/keywords only, no egress
  clientMutationId: String
}

type CaptureParseResult {
  parseId: UUID!                     # binds this preview to a later captureCommit
  rawText: String!
  fragments: [Proposal!]!            # one per detected fragment, in input order
  unresolvedSegments: [String!]!     # text the segmenter could not attach to a fragment
  usedAi: Boolean!
  degraded: Boolean!                 # true when the AI circuit was open (rules-only)
  latencyMs: Int!
  clientMutationId: String
}
```

### 5.2 `captureCommit`

The write half. **Atomic and idempotent.**

```graphql
input CaptureCommitInput {
  parseId: UUID                      # when echoing a captureParse result
  rows: [CaptureCommitRowInput!]!    # 1..50
  defaultAccountId: UUID
  occurredAt: DateTime
  discardProposalIds: [UUID!]        # fragments the user removed from the preview
  clientMutationId: String
}

input CaptureCommitRowInput {
  clientRowId: String!               # stable within the request; echoed back
  idempotencyKey: String!            # REQUIRED — unique per household (I-10)
  clientId: String                   # UUIDv7, present for offline-originated rows
  accountId: UUID
  kind: TransactionKind!
  amount: Money!
  categoryId: UUID                   # the user's override, if any
  merchantId: UUID
  counterpartyId: UUID
  description: String
  note: String
  occurredAt: DateTime
  occurredOn: Date
  tagIds: [UUID!]
  acceptedProposalId: UUID           # which Proposal this row came from, if any
  confirmDespiteLowConfidence: Boolean = false
}

union CaptureCommitResult =
    CaptureCommitSuccess
  | CaptureCommitRejected
  | ConflictError
  | RateLimitedError

type CaptureCommitSuccess {
  committed: [CommittedTransaction!]!
  skipped: [SkippedRow!]!
  duplicateSuspects: [DuplicateSuspect!]!
  replayed: Boolean!                 # true when the whole call was an idempotent replay
  cursor: Cursor!                    # new sync position
  dashboardDelta: DashboardDelta!    # §5.2.3
  clientMutationId: String
}

type CommittedTransaction {
  clientRowId: String!
  transaction: Transaction!
  idempotencyKey: String!
  wasReplayed: Boolean!
  classification: ClassificationDecision
}

type SkippedRow { clientRowId: String! reason: String! }

type CaptureCommitRejected {
  rejected: [RejectedRow!]!
  code: ErrorCode!
  message: String!
  clientMutationId: String
}

type RejectedRow { clientRowId: String! code: ErrorCode! message: String! field: String }

type RateLimitedError { retryAfterSeconds: Int! clientMutationId: String }
```

#### 5.2.1 Atomicity

`captureCommit` is **all-or-nothing per request**, not per row. The whole `rows` array is validated,
classified and written inside a single database transaction. If any row fails validation (unparseable
amount, category of the wrong `kind` — invariant I-3, account outside the household), **no** row is
written and the payload is `CaptureCommitRejected` naming every offending row.

> **Implementation note (task 2.2.7).** I-3 is checked against the category that will actually be
> written, which is one of three things: the client's `categoryId` override, the category the
> `acceptedProposalId`'s decision chose, or — for a row with neither — the classification this method
> runs itself. The check used to be guarded by `if (row.categoryId)`, so the whole preview → confirm
> flow (which sends the *proposal*, not an override) skipped it and could write an `EXPENSE` row in an
> INCOME category. A proposal that contradicts the row's `kind` is still **refused** rather than
> silently re-categorised: the user confirmed a category the preview showed, so replacing it would
> write something they did not agree to, and re-parsing fixes it. A row this method classified itself
> has no such problem — the pipeline refuses the contradiction before the row is built (docs/04
> §8.1.6), so it arrives uncategorised and blocking.

The one deliberate exception is the low-confidence case, which is **not** a validation failure:

| Row state | Behaviour |
|---|---|
| `confidence >= 0.90` | Written `CONFIRMED`, `needs_review = false` |
| `0.60 <= confidence < 0.90` | Written `CONFIRMED`, `needs_review = false` — the **advisory** lane, derived from `category_source = 'AI'` + `confidence` (ADR-009, invariant I-8). The batch is **not** blocked |
| `confidence < 0.60` | Written **`PENDING`**, `needs_review = true`; requires `confirmDespiteLowConfidence` to be written `CONFIRMED` |
| `categoryId` unresolved | Written `PENDING`, uncategorised, enters the review queue whatever the confidence |
| `amount` unparseable / missing | **Row rejected ⇒ whole request rejected** |

> **Correction (task 2.2.4).** This table previously read `needs_review = true` for the
> `0.60–0.89` band while citing ADR-009. That contradicted
> [03 invariant I-8](03-domain-model.md#5-invariants-enforced-in-the-service-layer--tests) and
> [04 §7](04-categorization-and-ai-engine.md#7-stage-6-confidence-gates), which define
> `needs_review` as the **blocking** lane only and derive the advisory lane from
> `category_source` + `confidence`. The invariant wins: an advisory row that set the flag would make
> the nav badge count rows that are already applied and valid. `applyConfidenceGate` in the
> classification module remains the one implementation of this table.


This is the F-06 acceptance criterion *"the other rows can still be confirmed without resolving it"*
implemented literally: one ambiguous row never blocks a batch, but a structurally invalid row always
does. The distinction is deliberate and it is the single most important atomicity rule in the API.

#### 5.2.2 Idempotency and duplicate detection

Three distinct mechanisms, doing three distinct jobs — conflating them is how duplicate transactions get
shipped:

| Mechanism | Key | Scope | Purpose |
|---|---|---|---|
| **Idempotency key** | `row.idempotencyKey` | Unique per household (I-10), 24 h retention in Redis + the unique index in Postgres | *Retry safety.* A retried request returns the original transaction and `wasReplayed = true`. Never creates a second row. |
| **Client id** | `row.clientId` | Unique per household, permanent (DB index) | *Offline dedupe.* An outbox flushed twice, or two devices replaying the same queued row, collapses to one transaction. |
| **Duplicate suspect** | computed | 60-second window (configurable) | *User-intent dedupe.* Two **genuinely different** submissions of `Lidl 2000`. Not blocked — flagged. |

Duplicate-suspect matching rules — a row is a suspect when **all** of the following hold against an
existing non-deleted transaction that is **not `VOID`**:

1. same `household_id` (implicit) and same `account_id`;
2. same `kind` and identical `amount_minor`;
3. `occurred_local_date` within ±2 days;
4. normalised `description` trigram similarity ≥ 0.85 **or** identical resolved `merchant_id`.

> **Corrections and clarifications (task 2.2.5).** Three things were ambiguous or wrong when the
> mechanism was built, and the implementation is the record of how they were resolved.
>
> **1. `CONFIRMED` → non-`VOID`.** Rule 0 originally read *"an existing `CONFIRMED`, non-deleted
> transaction"*. Taken literally that makes the whole mechanism unreachable for the household that
> needs it most: with no keywords, no rules and no AI provider — F-13's cold start, and every fresh
> signup today — *every* captured row is written `PENDING`, so no candidate would ever exist and a
> user could type `Lidl 2000` twice in a row with no warning at all. Status is not what makes a row a
> duplicate; the user's two submissions are. `VOID` stays excluded, because the user has said that row
> never happened, and `deleted_at IS NOT NULL` stays excluded for the same reason.
>
> **2. Two windows, not one.** The table above says "60-second window (configurable)" while rule 3
> says ±2 days, and [02 §3](02-ux-flows-and-screens.md) says the same `occurred_local_date` "within
> 5 minutes". These answer two different questions and both survive: the **submission** window bounds
> how long ago the *existing* row was created (`created_at`), and the **date tolerance** bounds how far
> apart the rows claim the money moved (`occurred_local_date`). The submission window is **5 minutes**
> — the UX-facing number, which strictly contains the 60-second one — and it is only safe to be
> generous *because* the mechanism never blocks a row. A blocking version would have to take the
> tighter window. The three numbers live in `duplicate-detection.ts` as named constants so a later
> settings task can make them per-household without touching the logic.
>
> **3. Symmetric, per-row reporting.** Two identical rows in one batch are reported from **both**
> sides: each names the other. That is rule 1's *"a row is a suspect when…"* applied literally, and it
> avoids asserting which of the two the user "meant", which the ledger cannot know.
>
> `duplicateSuspects` is present and is `[]` when the check ran and found nothing — the two are
> distinguishable because the check always runs on a commit that wrote something.

Behaviour on a suspect: the row **is written** (the user may legitimately buy the same thing twice), the
payload lists it in `duplicateSuspects`, and the UI offers a one-tap undo. It is never a hard rejection:
blocking a legitimate second purchase is a worse failure than showing an unnecessary "same as 30 seconds
ago — undo?" chip, and [01 §6](01-product-requirements.md) says *"I am warned … rather than silently
creating it"*, not *"I am prevented"*.

The undo is one call for the whole batch, so a toast cannot half-apply:

```graphql
# Soft-deletes; never a hard delete (03 §3.4). Ids outside this Household match nothing.
# Returns how many were actually undone, so "already undone" is reportable rather than assumed.
undoCapture(transactionIds: [UUID!]!): Int!
```

```graphql
type DuplicateSuspect {
  clientRowId: String!
  transactionId: UUID!               # the row just written
  existingTransactionId: UUID!
  existingTransaction: Transaction!
  similarity: Float!                 # folded-description trigram similarity, reported even for a merchant match
  matchedOn: [String!]!              # ["amount","description","date"] — amount and date are always present
}
```

#### 5.2.3 `DashboardDelta`

Every successful commit returns the recomputed tile values so the client does not need a follow-up
dashboard query on the hottest path in the app.

```graphql
type DashboardDelta {
  period: String!
  spentThisMonth: Money!
  safeToSpend: SafeToSpend!
  monthProjection: MonthProjection!
  affectedBudgetStatuses: [BudgetStatus!]!
  affectedAccountBalances: [AccountBalance!]!
  reviewQueueCount: Int!
}
```

#### 5.2.4 Implementation deviations (tasks 2.2.4–2.2.5)

The write half shipped in `apps/api/src/modules/ledger/transactions.service.ts`
(`captureCommit`), with the GraphQL surface in `capture-commit.model.ts` and the mutation on
`TransactionsResolver`. The SDL above is the design; these are the places the build differs, and why.

| Design | Built | Why |
|---|---|---|
| `union CaptureCommitResult = CaptureCommitSuccess \| CaptureCommitRejected \| ConflictError \| RateLimitedError` | Two arms: `CaptureCommitSuccessModel \| CaptureCommitRejectedModel` | `CONFLICT` and `RATE_LIMITED` already travel as typed GraphQL errors on `extensions.code` (`ApiError` → `AllExceptionsFilter`), which every client branches on to refresh a session. A second representation of the same code in the same schema would be two sources of truth for one contract. A **row** rejection is different in kind — a successful round trip carrying per-row diagnostics — so it stays a union arm. |
| `code: ErrorCode!` | `code: CaptureRejectionCode!` (`VALIDATION_FAILED`, `NOT_FOUND`, `CONFLICT`) | §3.1 declares no global `ErrorCode` enum, so `ErrorCode` was an undeclared type. The enum is scoped to the field that uses it rather than committing the schema to a global error enum here. |
| `type CaptureCommitSuccess` | `type CaptureCommitSuccessModel` | Every GraphQL object type in this build carries the `Model` suffix (`TransactionModel`, `ProposalModel`, …). Renaming one type would make the schema inconsistent with itself. |
| `duplicateSuspects: [DuplicateSuspect!]!` | **Built** (task 2.2.5) | See §5.2.2's corrections: the comparison is against non-`VOID` rows, and the submission window is 5 minutes. |
| `dashboardDelta: DashboardDelta!` | **Not built**; `reviewQueueCount: Int!` and `cursor: ID!` are on the success payload | §5.2.3's delta is a caching optimisation for a client with a normalised store. This client refetches `dashboard`, which already exists as one round trip, on a screen the user is leaving. `reviewQueueCount` is the one value capture itself changes and is cheap to compute. |
| `occurredOn: Date` | `occurredOn: LocalDate` | The codebase's calendar-day scalar; `Date` here would be an instant and would reintroduce the timezone bug I-2 exists to prevent. |
| row input has no `splits` | confirmed | A capture row is one category; a divided Transaction is edited as parts (ADR-015, I-1). |
| `confirmDespiteLowConfidence` writes `CONFIRMED` | also clears `needs_review` | I-8's "unless a user explicitly cleared the flag". Writing `CONFIRMED` while leaving the flag set would keep the row in the queue the user just emptied. It cannot rescue a `null` category: an uncategorised Transaction is an unanswered question, not a low-confidence answer. |
| `discardProposalIds` | marks the decision `wasAccepted: false` with `transaction_id` still `null` | The only durable evidence that a proposal was shown and rejected rather than never generated — the negative half of §6.4's `(raw_confidence, was_accepted)` pair. |
| undo is a client-side loop over `deleteTransaction` | `undoCapture(transactionIds: [UUID!]!): Int!` — one call, one transaction | docs/02 §3 says one call, and a toast that only half-applied would leave the user unable to tell which rows survived. It returns the count actually undone, so "already undone" is reportable rather than assumed. **The `audit_log` entry docs/02 §3 promises is not written**: the `AuditInterceptor` in [06 §3](#3-the-guard-chain) is a Phase 5 item ([08 §10.3](08-security-privacy-and-compliance.md#103-tamper-resistance) puts hash chaining there too), and writing `audit_log` rows without the chain would be half of a tamper-evidence feature. The deletion is still soft, so the rows and their `classification_decisions` survive for a later Restore. |

Two behaviours worth stating because they are not visible in the SDL:

- **A replay short-circuits before validation.** A retry echoes a proposal the first call has since
  linked to a Transaction, so validating it would see "already committed" and refuse the very retry
  I-10 exists to serve.
- **Rejections are accumulated and returned in the caller's row order.** Validation runs in phases
  (fields, then existence, then previews), so a payload assembled phase by phase would arrive out of
  order and a row with two problems would appear twice.

The audit blob in `classification_decisions.candidates` gained one key, `wasAccepted`
(`null` until the user resolves the proposal, then `true` or `false`). It is the label
[04 §6.4](04-categorization-and-ai-engine.md#64-confidence-calibration) consumes, and `null` must stay
distinguishable from `false`: an unresolved proposal is not a rejection.

### 5.3 `correctTransaction`

The learning-loop entry point, and the documented replacement for the `PATCH /transactions/:id`
shorthand in [04 §8](04-categorization-and-ai-engine.md).

```graphql
input CorrectTransactionInput {
  transactionId: UUID!
  version: Int
  field: CorrectionField!
  categoryId: UUID                  # for field = category
  merchantId: UUID                  # for field = merchant
  counterpartyId: UUID              # for field = counterparty
  kind: TransactionKind             # for field = kind
  amount: Money                     # for field = amount
  note: String
  rememberForFuture: Boolean = false   # the "Zapamti za ubuduće" checkbox (F-09)
  applyToSimilarCount: Int = 0         # optional bulk re-classify of N similar rows
  clientMutationId: String
}

union CorrectTransactionResult =
    CorrectTransactionSuccess
  | RuleConflictError                  # remember was requested but the rule would shadow an existing one
  | ConflictError
  | NotFoundError

type CorrectTransactionSuccess {
  transaction: Transaction!
  correction: Correction!            # the durable learning signal
  synthesisedRule: RuleProposal      # present when rememberForFuture = true
  ruleCreated: Rule                  # present when the rule was unambiguous and created
  backfillPreview: RuleBackfillPreview
  dashboardDelta: DashboardDelta!
  clientMutationId: String
}

type RuleProposal {
  name: String!
  priority: Int!
  conditions: JSON!
  actions: JSON!
  origin: RuleOrigin!
  explanation: String!               # plain-language, shown verbatim in the UI ([04 §8.1])
  trigger: RuleSynthesisTrigger!
  confidence: Float!
}

enum RuleSynthesisTrigger {
  COUNTERPARTY_RESOLVED
  MERCHANT_RESOLVED
  DISTINCTIVE_TOKEN
  REPEATED_MERCHANT_CORRECTION
  CONTRADICTS_EXISTING_RULE
}

type RuleConflictError {
  code: ErrorCode!
  message: String!
  proposal: RuleProposal!
  conflicting: [RuleConflict!]!      # offers "edit the existing rule" rather than shadowing ([04 §8.2])
  clientMutationId: String
}
```

Per [04 §8.2](04-categorization-and-ai-engine.md): the API **never auto-creates a rule**. It synthesises,
explains in plain language, and waits. `ruleCreated` is populated only in the narrow case where the user
has already ticked "remember" **and** the trigger is a resolved entity with no conflict.

#### 5.3.1 Implementation notes (task 2.3.1)

Built in `apps/api/src/modules/classification/`: `rule-synthesis.ts` (pure), `rules.service.ts`
(owns `rules`), `corrections.service.ts` (owns `corrections`), and `correctTransaction` on the
**ledger's** `TransactionsService` — it writes a Transaction, and the module edge stays one-directional
(`ledger → classification`), which `captureCommit` had already established.

| Design | Built | Why |
|---|---|---|
| `union CorrectTransactionResult = … \| RuleConflictError \| ConflictError \| NotFoundError` | The **success type directly**; conflicts ride on it as `ruleConflicts` | `CONFLICT`/`NOT_FOUND` are already typed GraphQL errors on `extensions.code`. `RuleConflictError` cannot apply: the correction was **applied and recorded** before a proposal conflict is known, so an error arm would tell the client nothing happened. |
| `explanation: String!` shown verbatim | `explanation` is the safe English fallback; **`explanationCode`** (additive) is what the client localises | The same rule as the API's error codes: the server owns a stable code, the *client* owns the wording, so a proposal reads in the user's language. |
| `Rule.version: Int!` | **Absent** | `rules` has no `version` column (docs/03 §4). Rules hold no money, so last-write-wins is acceptable; `merchants` set the precedent. |
| `backfillPreview` / `backfill`, `dashboardDelta` | **Not built** | The bulk re-classify rewrites `category_id` on N Transactions and needs its own correctness story (I-3, the audit trail, a diff the user can read); `dashboardDelta` is absent for the reason §5.2.4 records. |
| `acceptProposal: false` "records the refusal as a signal" | The rule is not created; the refusal is **not persisted** | `corrections` has no column for it, so the only durable trace is `rule_created_id IS NULL` — which is also what "never asked" looks like. Recorded as a gap, not hidden. |

Two behaviours that are not visible in the SDL:

- **A `kind` correction is refused**, with a message that says to delete and re-record. The CHECK allows
  the value because the table is shared with imports, but direction is not a flippable property, and
  recording a Correction for a change that was not applied would put a fiction in the audit trail.
- **The conflict guardrail runs the real engine.** Synthesis produces a *witness* — an input the
  proposal matches — and `checkShadowing` asks `evaluateRules` who wins on it, with and without the
  proposal. It also treats "already decided to the **same** category" as a shadow, because the
  proposal would add nothing; without that arm, ticking "remember" twice would pile up duplicate rules.
  A proposal is evaluated with `createdAt = now`, because docs/04 §5.3.1 breaks a specificity tie on
  `created_at DESC` and an epoch timestamp would make every proposal lose every tie.

### 5.4 `createRuleFromCorrection`

```graphql
input CreateRuleFromCorrectionInput {
  correctionId: UUID!
  acceptProposal: Boolean = true     # false ⇒ this was a one-off; record the refusal as a signal
  overrides: RuleOverrideInput       # the user edited the synthesised rule before saving
  applyToExisting: Boolean = false
  previewOnly: Boolean = false
  clientMutationId: String
}

input RuleOverrideInput { name: String priority: Int isActive: Boolean conditions: JSON actions: JSON }

union CreateRuleFromCorrectionResult =
    CreateRuleFromCorrectionSuccess
  | RuleConflictError
  | NotFoundError

type CreateRuleFromCorrectionSuccess {
  rule: Rule!
  correction: Correction!
  cacheInvalidatedAt: DateTime!      # rule cache busted; next parse resolves with zero AI calls
  backfill: RuleBackfillResult
  clientMutationId: String
}

type RuleBackfillPreview {
  matchedCount: Int!
  sample: [Transaction!]!            # first 20, for the diff preview ([04 §8.2])
  summary: String!                   # "23 transactions would move to Kuća / Septička jama"
}

type RuleBackfillResult {
  preview: RuleBackfillPreview!
  applied: Boolean!
  updatedCount: Int!
  skippedCount: Int!
}
```

### 5.5 `resolveReviewItem`

```graphql
input ResolveReviewItemInput {
  id: UUID!
  kind: ReviewItemKind!
  action: ReviewResolveAction!
  categoryId: UUID
  merchantId: UUID
  counterpartyId: UUID
  rememberForFuture: Boolean = false
  applyToSimilar: Boolean = false    # bulk-resolve same merchant/counterparty + same suggestion
  clientMutationId: String
}

enum ReviewResolveAction { ACCEPT_SUGGESTION SET_CATEGORY MARK_AS_DUPLICATE VOID DELETE KEEP_AS_IS }

union ResolveReviewItemResult = ResolveReviewItemSuccess | RuleConflictError | ConflictError | NotFoundError

type ResolveReviewItemSuccess {
  item: ReviewQueueItem!             # refreshed after resolution
  transaction: Transaction
  correction: Correction
  synthesisedRule: RuleProposal
  ruleCreated: Rule
  resolvedSimilarCount: Int!
  reviewQueueCount: Int!
  dashboardDelta: DashboardDelta!
  clientMutationId: String
}
```

`applyToSimilar` is the desktop power affordance from F-08 and [09](09-implementation-plan.md) task
2.3.2: it resolves every queued row sharing the same resolved entity **and** the same suggestion in one
operation, then reports `resolvedSimilarCount`.

#### 5.5.1 Implementation notes (task 2.3.2a)

The **read** half is `ReviewService` in the classification module (it joins each Transaction to the
`classification_decisions` row behind it); the **write** half is `TransactionsService.resolveReviewItem`
on the ledger, next to `correctTransaction`, because resolving is a Transaction write and it is the
learning loop. The resolver is on the **ledger**, because composing the queue needs both services and
only that module can reach both (`ledger → classification` is the one-directional edge).

| Design | Built | Why |
|---|---|---|
| `reviewQueue(filter: ReviewQueueFilterInput, sort: [ReviewQueueSortInput!])` | Plain arguments | Two enums and four scalars do not need an input object with no contract of its own. |
| `enum ReviewItemKind { TRANSACTION RECEIPT_ITEM }` | `TRANSACTION` only | `RECEIPT_ITEM` needs the receipts module, which is not built. Declaring the arm without a producer is the empty-list problem `duplicateSuspects` avoided. |
| `enum ReviewReason` (5 arms) | `LOW_CONFIDENCE \| UNCATEGORISED` | These are I-8's two disjuncts and the only reasons the gate can produce. `AMBIGUOUS_AMOUNT`, `RECEIPT_MISMATCH` and `OFFLINE_RECLASSIFIED` have no producer yet. |
| `sort: [ReviewQueueSortInput!]` with `AGE \| CONFIDENCE \| AMOUNT \| OCCURRED_LOCAL_DATE` | Four **id-aligned** modes: `RECORDED_ASC` (default) / `RECORDED_DESC` / `OCCURRED_DESC` / `OCCURRED_ASC` | The cursor is a bare UUID, so a keyset page is only exact when the sort key **is** the id (a UUIDv7 is the creation order). A page boundary on a non-unique key — amount, confidence — silently repeats or skips rows, so those sorts are absent rather than approximate. |
| `union ResolveReviewItemResult = … \| RuleConflictError \| ConflictError \| NotFoundError` | The success type directly | The resolution has already been applied by the time a proposal conflict is known, so an error arm would tell the client nothing happened — the same reasoning as `correctTransaction` (§5.3.1). |
| `bulkResolveReviewItems` | **Not built** | `applyToSimilar` is the bulk affordance this UI uses. A second bulk path with its own conflict semantics is its own task. |
| `dashboardDelta` | Absent | As everywhere else (§5.2.4). |
| `ReviewQueueItem.amount` / `.occurredOn` | On the `transaction` field | The item *is* a Transaction; a second copy is a second thing that can disagree. |

**Resolving an already-resolved row is a NO-OP, not a CONFLICT.** Two devices clearing the same queue
is not an error, and the write's predicate carries `needs_review: true`, so it clears the rows that
still need it and reports how many that was.

**`applyToSimilar` matches on the resolved entity AND the suggestion**, both read *before* the write
(the resolution is about to change them), and excludes rows of the other `kind` (I-3), rows with
splits (I-1) and `VOID` rows. One decision produces **one** Correction: the peers are an application of
it, not N separate answers, and N rows would inflate the calibration re-fit with duplicates of one
fact.

**Correction (task 2.3.2b): an absent `merchantId`/`counterpartyId` is not the same as an explicit
`null` on a commit row.** §5.5's own note said the ledger "does not re-run resolution", and taken
literally that made `captureCommit` discard the entity resolved by the classification it had *already
run to get the category*: a row with no category and no proposal is classified server-side, and the
result carried `merchantId`/`counterpartyId` that were then thrown away in favour of the row's own
(often absent) pair. A live check caught it — the same text resolved to a Merchant in `captureParse`
and stored `merchant_id = null` through `captureCommit`, which silently made `applyToSimilar` and a
counterparty rule unlearnable for any client that commits without previewing first.

The rule is now: **the row's pair wins when it carries one; an absent field is filled from the
classification that decided the category; an explicit `null` is left alone.** The three arms are one
line each in `resolveRow`, and the absent-vs-`null` distinction has to survive the resolver — where
`?? null` used to erase it, so it now lives in a pure `toCommitRow` with its own spec. The browser is
unaffected: the capture screen always echoes the preview's pair, so behaviour there is unchanged.

#### 5.5.2 Implementation notes (task 2.3.2b — the screen)

`/review` (docs/02 §4.6) is served by this API with no additions. Three things it deliberately does
**not** do, each because the alternative would render a control that lies:

- **No lane B tab**, for the structural reasons in §4.2.1;
- **No reason/confidence filter**, for the filtered-page reason in §4.2.1;
- **The "Zapamti za ubuduće" checkbox is only rendered where the server honours it.** It appears when
  the resolution writes a category *change*, because that is the only path that reaches
  `correctTransaction` and reads `rememberForFuture`. Confirming a suggestion as it stands is a
  positive signal the schema cannot store (a `Correction` means "this changed"), so the row says so
  instead of offering a dead control. Persisting that signal — "confirm the suggestion and remember
  it" — is its own task: it needs either a consenting arm on `acceptProposal` or a new Correction kind.

`applyToSimilar` is offered only where a Merchant or Counterparty resolved, because
`similarQueuedRows` returns nothing without one. The count of swept rows is **not** known before the
call, so the checkbox does not promise one; the response's `resolvedSimilarCount` is what is reported.
The count-bearing offer *"Primeni i na 4 slične?"* with a diff preview is the rule backfill
(`backfillPreview`, §5.3), which is not built.

---

### 5.6 `updateBudget`

```graphql
input UpdateBudgetInput {
  budgetId: UUID!
  version: Int
  amount: Money
  period: BudgetPeriod
  periodStart: Date
  rollover: Boolean
  includeSubcategories: Boolean
  categoryId: UUID
  clearCategory: Boolean = false     # move scope from a category to whole-household
  clientMutationId: String
}

union BudgetPayload = BudgetSuccess | ConflictError | NotFoundError | ValidationError

type BudgetSuccess {
  budget: Budget!
  status: BudgetStatus!              # recomputed immediately; never cached across the write
  dashboardDelta: DashboardDelta
  clientMutationId: String
}
```

`updateBudget` exists as a named mutation (rather than only generic CRUD) because it is the write behind
the budget editor and it must return a freshly recomputed `BudgetStatus` — the Redis 60 s cache from
[03 §6](03-domain-model.md) is invalidated in the same request, so the user never sees a stale bar after
saving.

### 5.7 `contributeToGoal`

```graphql
input ContributeToGoalInput {
  goalId: UUID!
  amount: Money!
  contributedOn: Date
  note: String
  accountId: UUID
  createTransaction: Boolean = false   # also record the outflow from the account
  idempotencyKey: String!              # contributions are money; always idempotent
  clientMutationId: String
}

union GoalContributionResult = GoalContributionSuccess | ConflictError | NotFoundError | ValidationError

type GoalContributionSuccess {
  goal: SavingGoal!                    # with refreshed contributed/remaining/requiredPerMonth
  contribution: GoalContribution!
  transaction: Transaction             # present when createTransaction = true
  wasReplayed: Boolean!
  clientMutationId: String
}
```

#### 5.7.1 Implementation notes (task 3.3.2)

| Decision | Built | Why |
|---|---|---|
| `contributeToGoal` returns `GoalContributionSuccess` **directly** | `GoalContributionResultModel` instead of the union | The four union arms are already the typed `ApiError` codes every other module returns (`VALIDATION_FAILED`, `NOT_FOUND`, `RATE_LIMITED`); declaring arms with no distinct producer is the pattern this repo has declined twice (§5.5, §5.13). `wasReplayed` is kept — it is the one piece of information the union carried that a plain model does not. |
| `input.createTransaction` | **Not implemented** | A contribution is a `goal_contribution` and **not** a Transaction (docs/02 §4.13, stated there to prevent double-counting). Recording the outflow is an Account-to-Account transfer — the ledger supports it through `transfer_peer_id` and no feature builds it yet — and a naive `EXPENSE` row would invent spending for money that was not spent. |
| `idempotencyKey` | Required, enforced by a **new partial unique index** | The contract says a contribution is money and always idempotent, and `goal_contributions` had no column for the key. Migration `20260915120000_goal_contribution_idempotency` adds it nullable with `UNIQUE (household_id, idempotency_key) WHERE idempotency_key IS NOT NULL` — the same shape `transactions.idempotency_key` already has. Additive and forward-only. |
| `status = ACHIEVED` | **Recomputed** on every write that can change it, never latched | `contributed >= target` is derived (ADR-001), so deleting the contribution that crossed the target puts a goal back to `ACTIVE` rather than leaving it "achieved" with 0 % saved. `ARCHIVED` is the one status a person chooses and it is never overridden. `reconcileGoalStatus` is pure and tested in `packages/domain/src/goals.spec.ts`. |
| The currency | The Household ledger currency governs; the client's `Money.currency` is ignored | ADR-011, and the same rule as an Account's opening balance and a Budget's amount. A goal has no per-goal currency, and a contribution has no currency column of its own — it is denominated in the goal's. |
| `requiredPerMonth` | `ceil((target − contributed) / months remaining)`, **rounded up** | A plan that truncates leaves the goal short on the deadline, which the user discovers on the day it matters. `months remaining` counts **calendar month boundaries**, so it does not move with the day of the month the screen is opened on. An overdue goal reports `monthsRemaining: 0` and asks for the whole remainder — not `null`, which would hide the problem, and not a division by zero. |
| Deleting a goal | Soft delete; its contributions stay attached | docs/03 §4 keeps financial rows, and the contributed total is history a Phase 5 audit view can recover. `deleteSavingGoal` reads the goal **before** removing it so the response describes what was removed. |
| Not built | `Dashboard.goals` (§4.1) and the `GoalStatus`-driven insight/alert producers | The goals surface ships as its own queries and mutations; a dashboard tile and the `GOAL_REACHED` producer are separate tasks, recorded in AGENTS. |

### 5.8 `materialiseRecurring` (task 3.3.3)

Called by the `recurring.materialise` BullMQ job ([05 §8](05-architecture.md)) **and** available to the
client for the "post it now" affordance on an upcoming bill.

```graphql
input MaterialiseRecurringInput {
  ruleIds: [UUID!]                     # empty ⇒ all due rules for the household
  asOf: Date
  dryRun: Boolean = false              # preview what would be created, write nothing
  idempotencyKey: String!              # job retries must not double-post
  clientMutationId: String
}

type MaterialiseRecurringResult {
  created: [Transaction!]!
  previewed: [Transaction!]!           # dryRun only
  skipped: [RecurringSkip!]!
  newNextOccurrences: [RecurringOccurrence!]!
  wasReplayed: Boolean!
  clientMutationId: String
}

type RecurringSkip { ruleId: UUID! reason: String! }
```

Materialised transactions are `source = RECURRING`; `status = CONFIRMED` when `auto_confirm` is true,
otherwise `PENDING` with `needs_review = true` — a subscription the household did not actually pay this
month must not silently consume budget (I-7).

#### 5.8.1 Implementation notes (task 3.3.3)

| Decision | Built | Why |
|---|---|---|
| `input.idempotencyKey` | **Not in the input** | A materialised Transaction's key is derived from `(ruleId, occurrence date)`, so a retry is safe *whatever* the caller sends — including the same job running twice under two different keys, which a batch key cannot prevent. `wasReplayed` reports when a run posted nothing because an earlier one already had. This is strictly stronger than the document asked for. |
| `previewed: [Transaction!]!` | `[RecurringPreviewModel!]!` | A preview has no id and no `createdAt`; declaring it a `Transaction` would mean inventing both for a row that does not exist. The preview carries exactly what the client shows: rule, date, account, amount, description and the status it *would* be written with. |
| `Transaction.recurringRuleId` | Added | `transactions.recurring_rule_id` existed with no way to read it. It links a posted bill back to its standing order, and `generatedCount` is derived from it. |
| The RRULE subset | `FREQ` (DAILY/WEEKLY/MONTHLY/YEARLY), `INTERVAL`, `BYMONTHDAY`, `BYDAY`, `COUNT`, `UNTIL`; `WKST` accepted and ignored | A full RFC 5545 implementation is a dependency (ADR-004) and thousands of lines for `BYSETPOS`/`BYYEARDAY` this model has no column for. A part outside the subset is **refused with a reason**, never ignored: silently dropping `BYSETPOS` produces dates nobody asked for. The stored text is the **canonical** form, so two equal rules look equal and a client cannot smuggle in an unsupported part. |
| A month without the requested day | **Skipped**, per RFC 5545 | `FREQ=MONTHLY;BYMONTHDAY=31` produces nothing in February. Rolling back to the 28th would move a bill the household budgets for. |
| Dates, never instants | Everything is a `LocalDate` (I-2) | A rule on the 15th is the 15th on both sides of a DST transition; the instant is derived once, on the write path, from `occurred_local_date`. docs/10 §5.3's "expands across DST" is a property of the representation rather than a special case. |
| `COUNT` | Compared against `generatedCount` (the rows the rule posted), not against expansion steps | A paused or retried run must not lose an occurrence, and the column that records what actually happened is the ledger. A rule that has used up its `COUNT` retires itself. |
| Catch-up | Every occurrence inside the rule's own window is posted, then the rule retires | A job that missed two months still owes those rows; the RRULE plus `ends_on` define exactly which occurrences exist. Dropping them would silently lose months of a bill the household paid. |
| `next_occurrence_on` when a rule finishes | Set to the **last occurrence it posted**, not left stale | A stale date makes the row read as if that occurrence were still pending, and reactivating the rule would re-post from there. |
| The write path | `TransactionsService.create` | A materialised row gets I-3's category/kind check, ADR-011's currency, the local-day derivation and I-10's idempotency from the same code a hand-typed row uses. |
| Jobs | `recurring.materialise` (hourly) and `recurring.detect` (daily) since 3.4.1, over the **same** service methods the mutations call | ADR-022's rule: a job is a schedule plus a written idempotency story, and these two inherit the mutation's — materialisation is idempotent per `(rule, occurrence)`, detection by identity. |

#### 5.8.2 Subscription detection (task 3.3.4)

`detectSubscriptions` is a mutation here, not a query, because it **writes**: a run inserts a
`RecurringRule` per candidate with `is_detected = true` and `is_active = false`. That is what gives the
client something to accept, and what makes a dismissal stick.

| Decision | Built | Why |
|---|---|---|
| Propose, never auto-create | Every candidate is an inactive, detected rule | docs/04 §8.2's guardrail; the screen shows the evidence and the user answers (*Prihvati* / *✕*). An inactive rule posts nothing, and the integration spec asserts as much. |
| `dismissDetectedSubscription` | Soft-deletes the row | The detector skips an identity the Household already rules on, already has a proposal for, **or has dismissed** — a dismissal that could be re-proposed is a nag. It is also refused for a rule the Household made, because dismissing one would look like a delete. |
| The candidate rules (`@finmate/domain/src/subscriptions.ts`) | ≥ 3 charges, amounts within 2 % of the median, gaps within 4 days (+3 for the calendar's slack in a month), last charge within 45 days | Three is where a coincidence becomes a pattern; the tolerance absorbs a price rise but not a different purchase; the recency window is why a cancelled subscription stops being one. The **period is chosen from the gaps** (weekly/monthly/quarterly/yearly) rather than assumed — assuming monthly is how a weekly delivery becomes a monthly bill. |
| Identity | The resolved Merchant, else the **folded** description | The same fold the classifier and the entity ladder use, so `NETFLIX` and `Netflix` are one bill. |
| Scheduled | `recurring.detect` runs daily at 03:30 since 3.4.1, over the same `detect` method | The mutation stays as the on-demand entry point the screen's *Look for subscriptions* action uses; both are idempotent by identity, so a run never re-proposes what is already known or dismissed. |
| Built since | `committedMinor` (3.4.2) and the `RECURRING_DUE` insight + alert (3.4.3) | The projection and the alert read one `pendingOccurrences`, so they cannot disagree about a bill; the alert is `INFO`, one day ahead, and keyed on the occurrence. Recorded in §5.13/§5.14 and AGENTS. |

### 5.9 `commitReceipt` and `reconcileReceipt`

```graphql
input CommitReceiptInput {
  attachmentId: UUID!
  merchantId: UUID
  capturedAt: DateTime
  total: Money
  items: [ReceiptItemInput!]!
  createTransaction: Boolean = true
  accountId: UUID
  idempotencyKey: String!
  clientMutationId: String
}

input ReceiptItemInput {
  lineNo: Int!
  rawText: String!
  quantity: Float
  unitPrice: Money
  amount: Money!
  categoryId: UUID
}

input ReconcileReceiptInput {
  receiptId: UUID!
  action: ReconcileAction!
  adjustmentItemId: UUID              # for ADJUST_ITEM
  adjustment: Money                   # for ADJUST_TOTAL
  absorbCategoryId: UUID              # for ADD_ROUNDING_LINE
  clientMutationId: String
}

enum ReconcileAction { ACCEPT_MATCH ADJUST_ITEM ADJUST_TOTAL ADD_ROUNDING_LINE DETACH_TRANSACTION }

union ReceiptPayload = ReceiptSuccess | ConflictError | NotFoundError | ValidationError

type ReceiptSuccess {
  receipt: Receipt!
  transaction: Transaction
  reconciliation: ReconciliationState!
  variance: Money!
  clientMutationId: String
}
```

I-6 is enforced here: `reconciliation` becomes `MATCHED` only when `|total − Σ items| <= 1` minor unit.
Otherwise the receipt stays `MISMATCH` and the transaction is not confirmed — which is exactly the F-14
acceptance criterion *"the transaction is only marked confirmed once the total reconciles."*

**Implemented in task 4.1.3, with recorded deviations.** The OCR adapter itself is `packages/ai`'s
(since 2.2.1); this task added the caller — `apps/api/src/modules/receipts`, the `OCR` seam
(`UNCONFIGURED_OCR` in this build, exactly as `AI_CLASSIFIER` and `NARRATOR` resolve to their
unconfigured twins), item extraction, item-level classification and I-6.

| Decision | Built | Why |
|---|---|---|
| `commitReceipt` | **Split**: `createReceipt` (attachment → receipt), `extractReceipt` (OCR → items), `updateReceiptItem`/`addReceiptItem`/`removeReceiptItem`, `reconcileReceipt` | §5.9's single mutation also created the Transaction. The itemised screen and the *Napravi transakciju* button are 4.1.4/4.1.5, so the creation arm is not declared yet — a union arm or a parameter with no producer is the pattern this repo declines (§5.5). |
| `variance` | **`Balance!`, not `Money!`** | The variance is **signed** — the lines can overshoot the total — and `Money` is non-negative by ADR-003 (`money()` throws on a negative). `Balance` is the scalar already added for exactly this distinction (§5.1). |
| `ReconcileReceiptInput.adjustment` | **The absolute new amount** (`ADJUST_ITEM` sets the item, `ADJUST_TOTAL` sets the total) | §5.9 sketched a `Money` *delta*, which cannot express a decrease: `Money` is non-negative, so a client could only ever raise a figure. Taking the new absolute value makes both directions expressible with the scalar the money path already has. |
| `ADD_ROUNDING_LINE` | Only when `variance > 0`; the receipt becomes `MANUAL` | `receipt_items.amount_minor` is `CHECK (amount_minor >= 0)`, so an added line can only be positive. When the lines *overshoot*, no non-negative line can absorb the gap and the API refuses with the reason, pointing at `ADJUST_ITEM`/`ADJUST_TOTAL`. |
| Reconciliation states | `PENDING` = no total yet · `MATCHED` = the receipt's own figures agree · `MISMATCH` = they do not · `MANUAL` = they agree because the user added the absorbing line | All four now have a producer, and the `MATCHED`/`MANUAL` split records **who** reconciled — a screen can say "reconciled by hand" without re-deriving it. |
| Re-extraction | Replaces the items; a fresh provider total wins, an existing total is kept when the provider read none | `extractReceipt` is an explicit retry, so a retry that kept a stale total could never fix a bad read. What the provider could **not** read never erases a total the user asserted. |
| A line with no amount | Skipped, and reported as `linesWithoutAmount` | Guessing `0` understates the receipt and inventing the difference is exactly what I-6 exists to catch. |
| A total in another currency | Ignored (`currencyMismatch: true`); the items are still written | ADR-011: one ledger currency. Converting a model's EUR total would be the API inventing an exchange rate. |
| Manual itemisation | `addReceiptItem` sets `needsReview` when it has no category | A line the user typed without a category is a question, not an answer: `commitReceipt` turns items into Splits, and a Split without a Category is I-8's blocking lane. |
| `ReceiptPayload` union | **The model directly** | The §5.5 precedent, fifth time: the arms are the typed `ApiError` codes every module returns. |
| `ReceiptItem.createdAt`, `Receipt.currency` | Not exposed | Every `Money`/`Balance` on the type already carries its currency, so a separate field would be a second source of truth; no screen needs an item's creation time. |
| Posting the receipt (4.1.4a) | `commitReceipt(receiptId, accountId, description?)` → **one** CONFIRMED Transaction with a Split per Category, through `TransactionsService.create` | I-6 gates it (only `MATCHED`/`MANUAL` post), then every line must have a Category (a Split without one is I-1 with a hole in it), then I-1 must hold: the receipt's own tolerance means the lines can be a filler away from the total, and that filler is added to the **largest** Split — deterministically — so the Transaction claims what was paid *and* its Splits add up to it. Idempotent on the receipt, and the create carries `receipt:<id>` as the ledger's `idempotencyKey` (I-10) so a race cannot post twice. The photo follows the purchase through `files.commit`, so the ledger is never asked to validate an attachment. |
| `DETACH_TRANSACTION` (4.1.4a) | Unlinks the Receipt from its Transaction; the Transaction and its attachment stay | A confirmed row of the Household's money is not deleted because a photo was detached, and `attachment_id` is a separate link (docs/03 §4). |
| The mismatch screen (4.1.4b) | `/receipts` (the library, with the capture action) and `/receipts/:id` (the detail) | The banner states the **exact difference in money** and never a percentage — I-6 is minor units, and "2 % off" is not a fact a person can act on. The confidence badge is icon **and** text, so ADR-009's gates are not colour-only. *Napravi transakciju* is disabled until the receipt reconciles **and** every line has a Category, and the hint names the unmet condition rather than leaving a dead button. Capture reuses 4.1.2's pipeline (presign → PUT → `commitAttachment`) and then opens a Receipt instead of attaching to a Transaction. |
| `receipts` (4.1.5) | **`receipts(after: String, first: Int): [ReceiptModel!]!`** — a plain list, not §5.5's `ReceiptConnection`, and there is no `filter` | The shipped shape was settled with the read model in 4.1.3. Two consequences the library lives with rather than hides: there is no `totalCount`, so the screen cannot claim "4 of 214" (§4.4's own copy does) and says `{count} shown, newest first` instead; and with no cursor UI it reads the **first 50**. Both are the screen telling the truth about the API it has, and a `ReceiptConnection` + filter is the change that closes them. |
| `extractReceipt` from the screen | **Not called by `/receipts/:id`** | Extraction is an explicit retry and no OCR provider is configured in this build (`AI_UNAVAILABLE:no-provider-configured`), so the screen offers manual itemisation, which is the path the wireframe already draws as an alternative to the spinner. A button that always fails with "no provider" would be a control this build cannot honour. |
| The `POST /v1/webhooks/ocr` path (§9.5) | **Not built** | This task ships the **synchronous** extraction: the API reads the object and calls the provider. The async webhook (HMAC, delivery-id idempotency, delivery order) is a separate integration with the same seam behind it, and it is recorded rather than half-built. Until then the provider contract is "answer within the OCR timeout". |

### 5.10 `dismissInsight`, `markNotificationRead`

```graphql
union InsightPayload = InsightSuccess | NotFoundError
type InsightSuccess { insight: Insight! clientMutationId: String }

union NotificationPayload = NotificationSuccess | NotFoundError
type NotificationSuccess {
  notification: Notification!
  unreadNotificationCount: Int!
  clientMutationId: String
}
```

`dismissInsight` sets `is_dismissed = true`. Insights are never deleted by the user — the feed is a
record, and a dismissed insight still feeds the "what did we tell you" audit.

### 5.11 `exportData` and `requestAccountDeletion`

Both are GDPR surfaces ([08](08-security-privacy-and-compliance.md)) and both are asynchronous because
they touch every table in the household.

```graphql
input ExportDataInput {
  format: ExportFormat!               # CSV | JSON  (both, for F-25's "data is theirs" promise)
  range: DateRangeInput               # omit ⇒ everything
  includeAttachments: Boolean = false
  clientMutationId: String
}

enum ExportFormat { CSV JSON }

union ExportDataResult = ExportDataQueued | QuotaExceededError

type ExportDataQueued {
  jobId: UUID!
  estimatedRows: Int!
  notificationOnCompletion: Boolean!  # always true; delivered as a Notification + emailed link
  clientMutationId: String
}

input RequestAccountDeletionInput {
  scope: DeletionScope!
  confirmHouseholdName: String!       # must equal the household name verbatim
  password: String!                   # re-authentication; a stolen session must not be enough
  clientMutationId: String
}

enum DeletionScope { USER_ACCOUNT HOUSEHOLD }

type RequestAccountDeletionResult {
  requestId: UUID!
  scope: DeletionScope!
  scheduledPurgeAt: DateTime!         # now + 14 days grace
  cancelledBy: DateTime               # latest time a cancel is still accepted; equals scheduledPurgeAt
  receiptEmailSentTo: String!
  clientMutationId: String
}
```

`requestAccountDeletion` does **not** delete synchronously. It schedules `gdpr.purge`
([05 §8](05-architecture.md)) for 14 days out, revokes all sessions, and returns a cancellation handle.
The purge is a full hard delete (not the soft delete of [03 §3.4](03-domain-model.md)) and produces a
completion receipt emailed to the user.

---

### 5.12 Onboarding (F-13)

```graphql
type OnboardingState {
  step: Int!                 # 1..6, or 7 once complete
  completedAt: DateTime
  seedVersion: Int           # null when the starter tree was skipped
  categories: Int!
  keywords: Int!
  merchants: Int!            # this Household's OWN rows; global seeds are not counted
  accounts: Int!
}

type StarterSeedResult  { categories: Int! keywords: Int! reused: Int! }
type MerchantSelectionResult {
  applied: Int!
  alreadyOwned: Int!
  unresolved: [String!]!     # selected names not in the shipped catalogue
  withoutCategory: [String!]!
  embedded: Int!             # rung-5 vectors written; 0 when no embedding model is configured (ADR-021)
}

type Query    { onboardingState: OnboardingState! }
type Mutation {
  setOnboardingStep(step: Int!): OnboardingState!
  seedStarterCategories: StarterSeedResult!
  applyMerchantSelection(names: [String!]!): MerchantSelectionResult!
  completeOnboarding: OnboardingState!
}
```

**Only two of the six steps are operations here.** Step 2 creates an Account with `createAccount`,
step 3 creates a Counterparty (and, only if the user accepts, a Rule) with the existing mutations, and
step 5 sets a budget with `upsertBudget`. A mutation per step would be six ways to write rows the
editors already validate. What is genuinely new is bulk-writing the shipped knowledge, plus progress.

Every operation is scoped from the session — there is no `householdId` argument (ADR-008) — and every
one is safe to call twice, because docs/01 F-13 makes onboarding re-enterable from settings.

#### 5.12.1 Implementation notes (task 2.3.3)

| Design | Built | Why |
|---|---|---|
| Per-step mutations | **Two operations** | Steps 1 and 4 are the only ones that need to write many rows; steps 2, 3 and 5 reuse `createAccount`, the Counterparty mutations and `upsertBudget`. |
| The starter tree shipped to the client | Read from `@finmate/domain` (`src/seed/`) by both apps | One document, so the wizard previews exactly what the server will create. docs/11 §2.3 asked for the content to be versioned in the domain package. |
| `seedStarterCategories(kinds:)` | No argument | Step 1's two tree tabs are display, not a filter; the spec never asks to seed one direction only. |
| Progress on the Member (docs/02 §4.1) | `households.settings.onboarding` | `household_members` has no settings column, and in v1 a Household has exactly one Member (F-29 is a `Won't`), so the two are the same unit. Next to `aiConfidenceThresholds`, which already lives there. A per-member step becomes meaningful when sharing lands. |
| A `Cursor` `onboardingState` page | A single object | It is one row's worth of state, and the counts are four scoped COUNTs. |
| `applyMerchantSelection` via `MerchantsService.create` | Via `update` (copy-on-write) | `create`'s duplicate-name check sees **global** rows and refuses `Lidl` as "already exists". Copy-on-write is also what brings the shipped aliases along and what keeps the global row untouched for other Households. |
| A default Category on a global merchant | A `categoryKey` in the seed | `categories.household_id` is `NOT NULL`, so there is no global category for a global merchant to point at. Onboarding resolves the key against the tree it just created, **by path**, and reports `withoutCategory` when the path is gone (a rename in step 1) rather than guessing. |

**`seedStarterCategories` is one interactive transaction and is idempotent by `(parent, name)`.**
Node identity is not the seed key: keys belong to the document and mean nothing inside a Household, so
matching on them would create a second `Hrana` the moment a user renamed theirs. A keyword already
present at the **wrong weight** is corrected rather than skipped, which is what lets a Household that
ran the pre-2.3.3 seed repair its tree by re-entering onboarding.

**`applyMerchantSelection` is not atomic, deliberately.** Each merchant goes through
`MerchantsService.update`, which is the shipped copy-on-write path with its own transaction; a failure
half-way leaves some merchants copied and the call is idempotent, so "press Continue again" is a
correct recovery. Wrapping 62 copy-on-write transactions in a third one would hold a connection for the
duration to protect against a state the retry already handles.

**The `strong`/`include` keyword split is why step 1 is enough.** docs/04 §5.4 decides a category from
keywords only at a score of **2.0**, and `category_keywords.weight` defaults to **1.0** — so a tree
seeded at the default cannot decide a single input, which is exactly what the shipped tree did until
this task. Decisive words (a merchant's name, or the word that *is* the category) are now written at
2.0 and corroborating ones at 1.0. See [04 §8.1.3](04-categorization-and-ai-engine.md).

**`applyMerchantSelection` also indexes what it wrote (`embedded`, task 2.3.4).** Copying the
Household's chosen merchants is the moment its entity set changes, so that is where docs/04 §4 rung 5's
vectors are built: one `syncMissing` call, one vector per Merchant and Counterparty that has none for
the current model. It is **not** on the parse path — a keystroke debounce must never become a batch of
embedding writes. `embedded` says how many rows were written, and it is `0` in this build because no
embedding model is configured, which is the honest answer rather than an error
([ADR-021](14-decisions-and-risks.md), [04 §8.1.4](04-categorization-and-ai-engine.md#814-the-rung-that-found-an-entity-carries-its-confidence-fixed-in-234)).

---

### 5.13 Insight generation (task 3.1.1)

The four generators (this task) and their thresholds are canonical in
[01 §6 F-22](01-product-requirements.md). This section records only the **contract**.

| Decision | Built | Why |
|---|---|---|
| Where the rules live | `packages/domain/src/insights.ts`, pure | The numbers in the feed are the same class of number as a balance (ADR-001), and the package whose job is arithmetic with tests is where they belong. The API loads facts and stores results; it computes nothing. |
| Reusing F-21's projection | `projectMonthEnd` + `MIN_PACE_DAYS` from `./budget`, imported | A second copy of the pace arithmetic would be a second answer to "what will this month cost?", and the two would drift. |
| `hint`-style severity | `insights.severity` CHECK: `INFO`, `POSITIVE`, `WARNING`, `CRITICAL` | Already in the schema (docs/03 §4); no migration in this task. |
| A new column for the identity | **`dedupeKey` inside `payload`** | `insights` has no column for it and adding one is a migration this task does not need. The precedent is `classification_decisions.candidates.parseId`. The writer looks a key up before inserting, so a re-run for the same period is a no-op. ⚠️ Without a database constraint this is writer-enforced idempotence, not a guarantee: a concurrent double-run could duplicate. The nightly job is single-run, and 3.1.2's notification `dedupe_key` work is where a real constraint belongs. |
| Money in the payload | Minor-unit **strings** | A JSON number in the money path is a float (ADR-003). Ratios stay numbers: they are comparisons, not money. |
| `narrative` | Left `null` | It is the AI's field (docs/04 §9 `NARRATE`). Nothing in this task writes it, and the feed renders the payload's facts without it. |
| `Dashboard.insights(limit)` | **Reads the same table**, most recent first, dismissed excluded | The dashboard tile and the feed must not disagree about what the newest insight is. |

The service exposes `generate` (persist new drafts), `list` (filtered, keyset page on the UUIDv7 id),
`dismiss` and `latest` (the dashboard's N). `generate` is what the `insights.generate` job calls
([05 §8](05-architecture.md)); wiring the scheduler is task 3.1.2's alert path plus the worker, so in
this task the same method is reachable as the `generateInsights` mutation — the **same** service method
the job will call, so wiring the job later changes nothing here.

**Deviations from the SDL, all deliberate.** `kind` stays `String` (a new generator must not need a
schema change; the column is open `TEXT`), while `severity` **is** an enum because it has a closed CHECK
constraint and clients branch on it. `dismissInsight` returns the model directly, `nullable`, instead of
the `InsightPayload` union: a missing insight is not a case the UI distinguishes, and the repo already
declines to declare union arms with no producer (§5.5). The dashboard rail is `latestInsights(limit:)`
rather than `Dashboard.insights(limit:)`, because the `dashboard` query belongs to `budgeting` and is
not built out to the docs/06 §4.1 shape yet — moving the field is a later edit, not a client change.

**A budget belongs to one period at a time.** `budgets_unique_scope` allows a single row per scope,
and nothing rolls `period_start` forward on its own, so the pace generator only speaks for a Household
whose budget is anchored in the current period. A stale row is filtered out rather than projected
against the wrong window; whether the app should roll it automatically belongs to the budgets module
(1.3.1), and the `BUDGET_THRESHOLD` alert kind has no insight producer for the same reason — the
`BUDGET_PACE` insight maps to `PACE_OVERRUN`, and a "% of budget used" alert would be a second
generator.

**`committedMinor` is wired (3.4.2), and the same read powers the due alert (3.4.3).** A budget's
projection carries the recurring EXPENSE occurrences still to be posted inside its period —
subtree-scoped for a Category budget, everything for the whole-Household one, and excluding occurrences
that already have a Transaction behind them, because those are `spent`. `InsightsService` and the new
`RECURRING_DUE` generator read the **same** `RecurringService` occurrences (one private
`pendingOccurrences`, with `committed` summing it and `dueSoon` listing it), so the projection and the
alert cannot disagree about what is still due — the reconciliation 3.3.1 did for spend. An
`UNUSUAL_SPEND` candidate is still a **direct** Transaction row: comparing a whole purchase against a
split's *portion* would compare two different things, so the check reads
`SpendReadModel.directExpenseRows` on purpose rather than the split-aware aggregate.

**One generator is not month-scoped: `RECURRING_DUE` (3.4.3).** Its condition is a single occurrence
(`RECURRING_DUE:<occurredOn>:<ruleId>`), and the row may therefore be filed under a **different month**
than the run's period — a bill on the 1st is announced on the last day of the month before. That made
the writer's dedupe lookup wrong: it fetched existing insights for the run's `period_start` only, so
that condition was re-inserted on every retry. The writer now looks the key up over the periods its
drafts actually use. The alternative — filing the draft under the run's month — was rejected because
the row's period is what the feed groups and links by.

**Reconciled in 3.3.1.** The category **trend** baseline is no longer built from direct rows: it reads
`SpendReadModel.byCategory`, the same split-aware aggregate the budget tile and the assistant use
(`LedgerModule` supplies it, §5.1). `BudgetsService.spendIn` remains a **third** split-aware
implementation, deliberately left alone in this task; the analytics integration spec asserts that all
three paths return the same figure for the same Category and a split-containing month, so a future
drift between them fails a test rather than reaching a screen.

**One more defect found while wiring this.** Providing the same custom scalar in two feature modules
gives the schema two types named `JSON` and **fails at boot** with
*"Schema must contain uniquely named types"* — invisible to `api:test`, which builds per-module testing
modules. `JSON` now lives in `GraphQLScalarsModule` and is imported, never re-provided.

### 5.14 Alert rules and notifications (task 3.1.2)

The evaluator's rules are canonical in [01 §6 F-22](01-product-requirements.md); this records the
contract. The pipeline is docs/05 §9's, and the storage is docs/03 §4's two tables — no migration.

| Decision | Built | Why |
|---|---|---|
| `dedupe_key` shape | `<insight dedupeKey>:<channel>`, enforced by `UNIQUE (user_id, dedupe_key)` | The insight's key already names the condition (kind, period, subject), which is docs/05 §9's `BUDGET_THRESHOLD:category-17:2026-10:80` in this build's vocabulary. Per **channel**, because an in-app row does not mean the email was sent — they have different costs and different meanings. |
| Quiet hours | `{ "start": "HH:MM", "end": "HH:MM" }`, may cross midnight; `start === end` means never | docs/05 §9 puts the check before the channel fan-out: nothing is delivered inside the window. A crossing window inverts if written as `>= start && < end`, and `start === end` read as "always" would silently switch every alert off. |
| Quiet hours outcome | `status = 'QUEUED'` | docs/05 §8's `notifications.dispatch` job drains queued rows, so quiet hours **delay**. Dropping would answer "do not interrupt me" with "keep me ignorant". |
| Rate limit | 10 notifications per user per rolling 24 h; `CRITICAL` exempt | Not previously specified. A cap exists for noise, and a cap that can swallow the one alert that mattered does more damage than the noise it prevents. |
| Insight → rule mapping | `BUDGET_PACE → PACE_OVERRUN`; `CATEGORY_SPIKE`/`UNUSUAL_SPEND → UNUSUAL_SPEND`; `RECURRING_DUE → RECURRING_DUE` | One question ("is this normal?") at two grains; two switches for one intention is configuration nobody understands. A due bill is its own intention — *"tell me before a charge lands"* — so it keeps its own switch. `GOAL_REACHED` stays in the vocabulary with **no producer** until 3.3.2's goals surface grows one — the §5.5 precedent. |
| `POSITIVE` delivery | In-app only, and only when `positiveFeedback` is on | Good news is not worth a push, and docs/02 §7.1 gives it its own tab rather than the interrupt path. |
| `AlertRule.version` | **Not implemented** | docs/06 §3.2 declares `version: Int!` and `AlertRuleUpdateInput.version`, but neither docs/03 §4's DDL nor the migrated table has the column. Rather than invent a migration for optimistic concurrency on a settings list nobody edits concurrently, the field is omitted and this line is the record. Adding it later is one migration and one input field. |
| Notification copy | **English only, rendered server-side** | `notifications.title`/`body` are `TEXT NOT NULL` and the API has no i18n catalogue — the web's lives in `apps/web`. This is a **Definition-of-Done breach** of the same shape as `fm-money`'s hardcoded label: it is recorded here, and the fix is either a shared catalogue in a package or storing a key plus payload parameters and rendering at read time. `NotificationPreferencesInput.locale` exists and is not yet honoured. |
| `EMAIL`/`PUSH`/`WEB_PUSH` | **Channel fan-out is built** — the writer decides per channel and `dispatchNotifications` (the `notifications.dispatch` job) delivers | This row predicted that 3.1.3 would change only the writer, and it did: `IN_APP` becomes `SENT` (the row *is* the delivery), `EMAIL` goes through SMTP, and `PUSH`/`WEB_PUSH` go to the live browser subscriptions when VAPID keys exist (4.2.9, [ADR-028](14-decisions-and-risks.md)). A row that cannot be delivered stays `QUEUED` and is reported `skipped` **with a reason**. |
| Rule CRUD | `alerts`, `createAlertRule`, `updateAlertRule`, `deleteAlertRule` | Without one, the evaluator is unconfigurable and unverifiable end to end. The settings **screen** is 3.1.4. |
| Defaults | Three rows written by `ensureDefaultRules` on the first run (`PACE_OVERRUN`, `UNUSUAL_SPEND`, `RECURRING_DUE`; `IN_APP`; active) | docs/02 §7.1 shows alerts arriving without the user visiting settings, so "no rules" cannot mean "no alerts". They are **rows, not hidden code defaults**, so the screen shows what is actually on and editing a rule edits the thing that decides. Written once, only for a Household that has configured nothing. |
| `SUPPRESSED` decisions | **Not persisted** | `notifications` is `UNIQUE (user_id, dedupe_key)`. Writing a rate-limited row burns the key and makes that condition **permanently undeliverable** once the cap resets — the notification equivalent of poisoning a cache. Only `SENT` and `QUEUED` become rows; suppression is reported in the `runAlerts` summary instead. `QUEUED` occupies the key correctly: the row exists and will be delivered. |
| Non-in-app channels | Stored `QUEUED` until a sender **accepts** them | The evaluator's `SENT` means "deliverable". `EMAIL` is delivered through SMTP, and `PUSH`/`WEB_PUSH` when the deployment has a VAPID pair *and* the owner has a live subscription; otherwise the row keeps `QUEUED` rather than claiming a delivery that has not happened ([ADR-028](14-decisions-and-risks.md) decision 2). |
| `markNotificationRead` | Returns `{ notification, unreadNotificationCount }` | The badge is on every screen; making it a second round trip is a badge that lags. `markAllNotificationsRead` returns how many rows changed. |
| `updateNotificationPreferences` | **Built in 3.1.3**, in `households.settings.notifications` | `NotificationPreferencesInput` has no table (docs/03 §4 defines none), and the same pattern as onboarding progress works: a Household-scoped JSONB key with per-field fallback, so a malformed document degrades to the documented default instead of erroring the notification centre. The settings **screen** is 3.1.4. |
| Channel-aware copy | **Per channel**, in `notification-copy.ts` | T-09 forbids amounts and entity names on a lock screen, so one `title`/`body` for every channel is a disclosure by construction. `IN_APP` carries the figures; every other channel carries **no digit at all** — asserted by a test that does not enumerate payload keys, so it survives the next generator. |
| `EMAIL` delivery | `MailService.sendNotification`, plain text | nodemailer and Mailhog are already in the stack (docs/11 §1) and `MailService` already existed for verification mail — its own comment reserved it for "budget alerts". No dependency was added. Verified live: the message arrives in Mailhog with a body containing no digits. |
| `PUSH`/`WEB_PUSH` delivery | **Built in 4.2.9**, client half in **4.2.5** ([ADR-028](14-decisions-and-risks.md)) | `web-push@3.6.7` + `@types/web-push` behind the `WEB_PUSH` token, with an **inert default** (`UNCONFIGURED_WEB_PUSH`) exactly like `EMBEDDINGS` and `OBJECT_STORAGE`: no VAPID pair means no network call at all, the rows stay `QUEUED`, and `dispatchNotifications.reasons` names the missing setting. The payload is `buildWebPushPayload`'s — `{ notificationId, kind, deepLink }` plus a `notification` block, because `ngsw-worker.js` shows **nothing** without `notification.title`; the only text in it is `APP_NAME` (the brand, not a sentence), and the row's own `title`/`body` are passed in and deliberately never read, so no amount or entity name can reach a lock screen (T-09). `notification.data.onActionClick.default.url` is the deep link, which is how a tap opens the screen that caused the row. A `404`/`410` from the push service **soft-deletes** that subscription and still counts the notification delivered (a vanished endpoint is not a retry); any other rejection is `FAILED` with its reason. ⚠️ ADR-028 decision 4 said the payload would carry **no sentence at all**, relying on the client's catalogue; that is impossible for a background push, so the ADR carries a 4.2.5 amendment and this is the module that implements it. |
| `push_subscriptions` | New in 4.2.9: `20260916120000_push_subscriptions` | `endpoint` is globally `UNIQUE` (docs/03 §4), so **register is an upsert that clears `deleted_at`**: an endpoint a `404`/`410` retired is revived by the next re-subscribe instead of colliding with its own dead row (verified live). `push_subscriptions_live_idx` is partial on `deleted_at IS NULL` because every dispatch read wants live rows only. The Household and user come from the session; no input carries either (ADR-008). |
| `registerPushSubscription` / `deletePushSubscription` / `pushPublicKey` | **Built in 4.2.9**, consumed by 4.2.5 | Register is an upsert and delete is **soft** (a second call returns `false` rather than erroring), both verified live. `pushPublicKey` returns the VAPID **public** key or `null`, and `null` is the client's signal that no device can receive anything: `/notifications`' device panel renders `SERVER_OFF` from it instead of offering a permission the deployment cannot honour. A foreign Household's endpoint cannot be read, revived or deleted. ⚠️ Inside one Household the re-register path updates the row without checking `user_id` — v1 has exactly one Member, so the two coincide; F-29 makes it a real case. |
| `APP_NAME` | Added to the API config, defaulting to the working title | AGENTS.md forbids hardcoding a brand string (ADR-014). ⚠️ The web holds the same string as the `app.name` i18n key, so this is a **second source of truth** until a shared constant lands. The name is now decided (`FinMate`, ADR-014 amended 2026-09-17, screening outstanding as R-28) and both copies were **not** changed by that decision — they already carried it, which is what the rule was for. |
| `notificationReceived` subscription | **Not built** | It needs a pub/sub transport the API does not have (docs/06 §6). The bell polls on auth and on navigation, and a mark-read applies the count the mutation returns — the same mechanism the review-queue badge uses (docs/02 §2.3). |
| `Notification.insightKind` / `insightSeverity` | Flattened scalars, added in 3.1.4 | The screen needs two things from the insight behind a row — its **tone** and where the row **links** — and a nested `insight { … }` field would invite a join per row on a list the bell reads constantly. Two scalars cost one `include`. |
| The notification centre's screen | `/notifications`, with the preferences beneath the list | docs/02 §4.18 files notification preferences under a **Settings shell that does not exist yet**. Rather than invent one for a single section, "what you get told" sits under "what you were told"; when the settings shell lands it hosts the same panel unchanged. The header bell (docs/02 §2.2) is the entry point and carries the unread count; the nav's one badged **slot** remains the review queue. |
| `runAlerts` | A mutation, and the method the daily job calls | The worker exists since 3.4.1, and since 3.4.4 `insights.generate` calls the **same** `NotificationsService.run` this mutation does — generate, then evaluate against the rules, in the pipeline's order. Both are idempotent (insight dedupe keys, `notifications.dedupe_key`), and `notifications.dispatch` remains the per-minute drain. Before 3.4.4 the job called `InsightsService.generate` alone, so a scheduled run wrote insight rows that nothing ever turned into a notification. |

### 5.15 Attachments and object storage (tasks 4.1.1–4.1.2)

F-34's attachments, and the presigned upload/download docs/06 §9 specifies. `files` owns `attachments`
and nothing else; the bytes never transit the API (ADR-018).

| Decision | Built | Why |
|---|---|---|
| `presign` and the download route | **REST**, `/v1/files/presign` and `/v1/files/:id` | §9's reasoning, unchanged: one is a URL a browser PUTs to, the other a `302`. GraphQL has neither an upload nor a redirect. |
| Signing | `sigv4.ts`, a **dependency-free** SigV4 signer | `@aws-sdk/client-s3` plus its presigner is tens of megabytes and a supply-chain surface for three operations. ADR-004 asks for an ADR before a dependency; the answer here is not to add one. Tested against AWS's published presigned-GET vector and self-consistency of every emitted signature. |
| Storage seam | `OBJECT_STORAGE` token; `S3ObjectStorage` when all four `S3_*` settings exist, otherwise an **unavailable** default | The same inert-default shape as `EMBEDDINGS` (ADR-021). CI has no MinIO, so `api:test` must boot the module; a presign on an unconfigured deployment fails with a readable message instead of a URL that cannot work. |
| The scan hook | `SCANNER` token, `UNCONFIGURED_SCANNER` answering `SKIPPED` | docs/08 §9.4 expects ClamAV; this build has none, and `SKIPPED` is the honest state — `CLEAN` would claim a check that never ran. `SKIPPED` is linkable, which is exactly why it must not be read as `CLEAN`. ⚠️ **A production deployment must configure a scanner**; recorded in docs/08 §9.4 and AGENTS. |
| Idempotency | `(purpose, sha256)` within 24 h returns the existing row | §9.2's rule. It is the identity a client can state, and a retried upload must not produce a second row. Outside the window a new row is allocated. |
| Object key | `household/<id>/<randomUUID>.<ext>` | docs/08 T-04 asks for scoped, unguessable keys. The doc's `uuidv7` is time-ordered; a random v4 suffix is strictly harder to guess, and the Household prefix is what makes the namespace per-tenant. |
| `commitAttachment` | HEADs the object, compares `byte-length` and the upload's `x-amz-meta-sha256`, runs the scan hook, then links | A presigned PUT cannot enforce a body hash (`content-length-range` needs a POST policy), so verification happens on the commit that follows it. A missing, short or swapped object becomes `FAILED`; an `INFECTED` one is deleted at once. |
| `CommitAttachmentInput` | Drops docs/06's `purpose` and `receiptId` | The purpose was fixed at presign — accepting it again invites a contradiction — and nothing produces a Receipt yet (4.1.3 does). The §5.5 precedent: do not declare a parameter a contract cannot keep. |
| `deleteAttachment` | `Boolean`, not `SimplePayload` | `transactions.attachment_id` / `receipts.attachment_id` are `ON DELETE SET NULL`, so a referenced attachment detaches rather than blocking. The payload union's arms are the typed `ApiError` codes every module already returns (§5.5, §5.7, §5.13). |
| Linking (task 4.1.2) | `commitAttachment(input: { attachmentId, transactionId })`; `Transaction.attachmentId` is now exposed | This is what makes F-34 real — *a receipt photo on a Transaction* — and it is why `attachmentId` is on `Transaction` (it was declared in §5 here and unimplemented until now). The link is refused unless the row is `CLEAN` or `SKIPPED`: without that guard a second commit on a `FAILED`/`INFECTED` row would attach a blob the download path refuses to serve, so the "not downloadable" guarantee has to hold at the **reference** too, not only at the URL. `TransactionCreateInput.attachmentId`/`TransactionUpdateInput.attachmentId` stay unimplemented — an attachment is uploaded first, so the only writer is `commitAttachment`, and a create-time parameter would need the same linkable check in a second place. |
| Retention | `FilesService.purge`, the **`files.purge`** job (daily 04:00) | Quarantined (`INFECTED`/`FAILED`), abandoned (`PENDING` past the grace window), unreferenced, and everything past **24 months** (docs/08 §7 row 17). Idempotent, and a failed object deletion keeps the row so the next pass retries instead of orphaning the blob. |
| Bucket creation | `pnpm storage:init`, never on a request path | MinIO does not create a bucket on first write. A lazy create inside `presign` would be a side effect on the hot path needing permission the API otherwise does not use. |
| Not built | Magic-byte **sniffing**, `Content-Disposition`/`nosniff` on the object response, re-encoding/EXIF stripping, thumbnails, and the OCR webhook | Each is 4.1.x or Phase 5 work; docs/08 §9.4 now carries the implementation status line by line rather than implying all of it ships. |

**`GET /v1/files/:id` has three answers.** A foreign or unknown id is `404` (existence is information —
§9.4); a row that exists but is not linkable (`PENDING`/`INFECTED`/`FAILED`) is **`409`**, which §9.4 did
not specify. `404` would make the client show "file missing" during the ordinary window between a
successful PUT and `commitAttachment`, and serving the bytes anyway is what `scan_state` exists to
prevent.

**`Transaction` exposes `attachmentId`, not the nested `Attachment` object this section's sketch drew.**
Resolving the object per row means a join on a list the transaction feed reads constantly, and the repo
has already made that call twice (§5.14's flattened `insightKind`/`insightSeverity`). A client that
wants the image asks `attachment(id:)`, which is where the presigned `downloadUrl` is computed anyway —
one extra round trip on a sheet that is already loading one row, in exchange for a list query that does
not fan out.

---

## 6. Subscriptions

```graphql
type Subscription {
  transactionCreated(accountIds: [UUID!]): TransactionEvent!
  transactionUpdated(ids: [UUID!]): TransactionEvent!
  notificationReceived: NotificationEvent!
  receiptOcrProgress(receiptId: UUID!): OcrProgressEvent!
  syncInvalidated(scope: SyncInvalidationScope! = ALL): SyncInvalidationEvent!
}

type TransactionEvent {
  transaction: Transaction!
  mutation: MutationKind!             # CREATED | UPDATED | DELETED | RESTORED
  originSessionId: String             # so the originating device can ignore its own echo
  dashboardDelta: DashboardDelta
  occurredAt: DateTime!
}

type NotificationEvent {
  notification: Notification!
  unreadNotificationCount: Int!
}

type OcrProgressEvent {
  receiptId: UUID!
  state: OcrState!
  progress: Float!                    # 0..1
  itemsExtracted: Int!
  message: String
}

enum OcrState { QUEUED UPLOADING EXTRACTING CLASSIFYING RECONCILING COMPLETE FAILED }

type SyncInvalidationEvent {
  reason: SyncInvalidationReason!
  entityTypes: [SyncEntityType!]!
  latestCursor: Cursor!
}

enum SyncInvalidationReason { RULE_CREATED RULE_UPDATED CATEGORY_CHANGED MERCHANT_CHANGED BULK_IMPORT JOB_MATERIALISED }
enum SyncInvalidationScope { ALL TAXONOMY LEDGER PLANNING }
enum MutationKind { CREATED UPDATED DELETED RESTORED }
```

Rules:

- Subscriptions are **household-scoped by the same `TenantContext`** as everything else. A subscriber can
  only ever receive events for their own household, and the guard runs on connection *and* on every
  message.
- `originSessionId` lets the writing device skip its own echo — Apollo's normalised cache already has the
  row, and re-applying it causes a visible flicker on the capture path.
- `syncInvalidated` is a **thin signal**, not a payload. It tells the client *"your taxonomy/ledger
  assumption is stale; call `syncChanges`"*. Pushing the delta itself over the socket duplicates the
  authoritative sync path and creates a second place where ordering can go wrong.
- Delivery is best-effort. **Correctness never depends on a subscription arriving** — every client
  re-syncs on reconnect and on foreground, and `syncState.latestCursor` is the recovery point.

---

## 7. The capture contract in detail

This is the signature feature (F-06) and the highest-traffic path in the API. It is specified here in
full because the preview/commit split is the only place where an unpersisted `Proposal`
([03 §1](03-domain-model.md)) crosses the wire.

### 7.1 The `Proposal` type

```graphql
type Proposal {
  proposalId: UUID!                  # stable across re-parses of the same fragment
  fragmentIndex: Int!                # position in the segmented input
  rawText: String!
  normalizedText: String!

  amount: Money
  amountCandidates: [AmountCandidate!]!   # ambiguity is ALWAYS surfaced, never resolved silently
  kind: TransactionKind!
  kindIsCertain: Boolean!
  occurredOn: Date
  description: String!

  categoryId: UUID
  category: Category
  categoryCandidates: [ClassificationCandidate!]!
  confidence: Float                  # calibrated, 0..1; null when nothing matched ([04 §6.4])
  confidenceBand: ConfidenceBand!
  decidedBy: DecidedBy!
  rationale: String                  # <= 140 chars, shown in the preview

  merchantId: UUID
  merchant: Merchant
  merchantProposal: EntityProposal
  counterpartyId: UUID
  counterparty: Counterparty
  counterpartyProposal: EntityProposal

  needsUserInput: [NeedsUserInput!]!
  warnings: [ProposalWarning!]!
  isCommittable: Boolean!            # false ⇒ structurally invalid; blocks the whole batch (§5.2.1)

  decisionId: UUID                   # the classification_decisions audit row (I-9)
  aiProvider: AiProviderName
  aiModel: String
  latencyMs: Int
  costMicros: String
}

enum ConfidenceBand { AUTO VERIFY ASK UNKNOWN }   # >= 0.90 | 0.60–0.89 | < 0.60 | null

type AmountCandidate { amount: Money! reason: String! probability: Float! }

type EntityProposal { name: String! type: EntityProposalType! confidence: Float! }
enum EntityProposalType { MERCHANT COUNTERPARTY }

type NeedsUserInput { fragmentIndex: Int! field: String! question: String! options: [String!]! }

type ProposalWarning { code: ProposalWarningCode! message: String! }
enum ProposalWarningCode {
  AMBIGUOUS_AMOUNT
  MISSING_AMOUNT
  INCOME_INDICATOR
  REFUND_INDICATOR
  UNKNOWN_ENTITY
  CATEGORY_KIND_MISMATCH
  LIKELY_DUPLICATE
  DATE_IN_FUTURE
  AI_UNAVAILABLE
}
```

Design rules encoded in that shape:

1. **`confidence` is the calibrated value**, never the raw model number. `confidenceRaw` is available on
   `ClassificationDecision` for debugging ([04 §6.4](04-categorization-and-ai-engine.md)).
2. **`amountCandidates` is non-empty whenever the parser is unsure.** [04 §3.1](04-categorization-and-ai-engine.md):
   *"It never silently picks."* `1.200` arrives as two candidates with probabilities.
3. **`categoryCandidates` carries the top 2–3 alternatives** with scores, so the UI can offer them as
   one-tap corrections in the preview instead of forcing a trip to the taxonomy editor.
4. **`categoryId` is validated against the household's own tree.** An unlisted id from the model is
   rejected and replaced by `null` + low confidence ([04 §6.2](04-categorization-and-ai-engine.md)).
5. **`isCommittable = false`** is the only thing that blocks a batch. It is set for structural problems
   (no amount, negative amount, category of the wrong `kind`), never for low confidence.

### 7.2 Worked example — `Lidl 2000, gorivo 3500, plata 150000`

```
mutation {
  captureParse(input: {
    text: "Lidl 2000, gorivo 3500, plata 150000"
    defaultAccountId: "0192f3a1-0c00-7000-8000-000000000001"
  }) { parseId rawText usedAi degraded fragments { ...ProposalFields } }
}
```

Response (abridged to the semantically important fields):

```json
{
  "data": {
    "captureParse": {
      "parseId": "0192f3a1-1a00-7000-8000-0000000000a1",
      "rawText": "Lidl 2000, gorivo 3500, plata 150000",
      "usedAi": false,
      "degraded": false,
      "fragments": [
        {
          "proposalId": "0192f3a1-1a01-7000-8000-0000000000b1",
          "fragmentIndex": 0,
          "rawText": "Lidl 2000",
          "amount": { "amountMinor": "200000", "currency": "RSD" },
          "amountCandidates": [],
          "kind": "EXPENSE",
          "kindIsCertain": true,
          "occurredOn": "2026-10-10",
          "description": "Lidl",
          "categoryId": "0192f3a1-0c01-7000-8000-0000000000c1",
          "confidence": 1.0,
          "confidenceBand": "AUTO",
          "decidedBy": "RULE",
          "rationale": "Matched your rule: Lidl → Hrana / Supermarket",
          "merchant": { "id": "0192f3a1-0d01-7000-8000-0000000000d1", "name": "Lidl" },
          "needsUserInput": [],
          "warnings": [],
          "isCommittable": true,
          "decisionId": "0192f3a1-1e01-7000-8000-0000000000e1",
          "latencyMs": 7,
          "costMicros": "0"
        },
        {
          "proposalId": "0192f3a1-1a02-7000-8000-0000000000b2",
          "fragmentIndex": 1,
          "rawText": "gorivo 3500",
          "amount": { "amountMinor": "350000", "currency": "RSD" },
          "amountCandidates": [],
          "kind": "EXPENSE",
          "kindIsCertain": true,
          "occurredOn": "2026-10-10",
          "description": "gorivo",
          "categoryId": "0192f3a1-0c17-7000-8000-0000000000c2",
          "confidence": 0.94,
          "confidenceBand": "AUTO",
          "decidedBy": "KEYWORD",
          "rationale": "Keyword match: gorivo → Auto / Gorivo",
          "needsUserInput": [],
          "warnings": [],
          "isCommittable": true,
          "decisionId": "0192f3a1-1e02-7000-8000-0000000000e2",
          "latencyMs": 9,
          "costMicros": "0"
        },
        {
          "proposalId": "0192f3a1-1a03-7000-8000-0000000000b3",
          "fragmentIndex": 2,
          "rawText": "plata 150000",
          "amount": { "amountMinor": "15000000", "currency": "RSD" },
          "amountCandidates": [
            { "amount": { "amountMinor": "15000000", "currency": "RSD" }, "reason": "no decimal separator", "probability": 0.97 },
            { "amount": { "amountMinor": "150000",   "currency": "RSD" }, "reason": "trailing-digit grouping", "probability": 0.03 }
          ],
          "kind": "INCOME",
          "kindIsCertain": true,
          "occurredOn": "2026-10-10",
          "description": "plata",
          "categoryId": null,
          "category": null,
          "categoryCandidates": [
            { "categoryId": "0192f3a1-0c40-7000-8000-0000000000c9", "confidence": 0.58, "rationale": "Salary-like income, but your tree has no 'Plata' node yet" },
            { "categoryId": "0192f3a1-0c41-7000-8000-0000000000ca", "confidence": 0.21, "rationale": "Other income" }
          ],
          "confidence": 0.58,
          "confidenceBand": "ASK",
          "decidedBy": "AI",
          "rationale": "Recognised as income (plata), but no matching income category exists",
          "needsUserInput": [
            { "fragmentIndex": 2, "field": "categoryId", "question": "Which income category is 'plata'?", "options": ["Create 'Plata' under Prihodi", "Other income"] }
          ],
          "warnings": [
            { "code": "INCOME_INDICATOR", "message": "'plata' is treated as INCOME, not EXPENSE." },
            { "code": "AMBIGUOUS_AMOUNT", "message": "'150000' could be read as 150.000 or 1.500,00 — confirm the amount." }
          ],
          "isCommittable": true,
          "aiProvider": "DEEPSEEK",
          "aiModel": "deepseek-chat",
          "decisionId": "0192f3a1-1e03-7000-8000-0000000000e3",
          "latencyMs": 612,
          "costMicros": "184"
        }
      ]
    }
  },
  "extensions": {
    "cost": { "aiMicros": "184", "tokensIn": 812, "tokensOut": 96, "provider": "DEEPSEEK", "model": "deepseek-chat", "degraded": false }
  }
}
```

What that example demonstrates, deliberately:

- Fragment 0 resolved by a **user rule** at zero cost and 7 ms — the common case (P-1).
- Fragment 1 resolved by **keywords** at zero cost.
- Fragment 2 shows the three-band behaviour: `confidenceBand = "ASK"`, `needsUserInput`, and
  `confidence = 0.58` — **below the 0.60 gate**, so on commit it is written `PENDING`
  (`needs_review = true`, I-8) while fragments 0 and 1 are written `CONFIRMED` in the **same atomic
  request**. This is the F-06 "ambiguous item in a batch" scenario, and the batch is not blocked.
- `isCommittable` is `true` for all three rows even though fragment 2 is uncertain. Uncertainty is not a
  structural failure.
- `amountCandidates` is populated for fragment 2 despite the parser being 97 % sure — ambiguity is
  surfaced, never hidden.

The commit call:

```json
{
  "input": {
    "parseId": "0192f3a1-1a00-7000-8000-0000000000a1",
    "defaultAccountId": "0192f3a1-0c00-7000-8000-000000000001",
    "rows": [
      { "clientRowId": "r1", "idempotencyKey": "idem-0192f3a1-aa01", "acceptedProposalId": "0192f3a1-1a01-7000-8000-0000000000b1",
        "kind": "EXPENSE", "amount": { "amountMinor": "200000", "currency": "RSD" }, "description": "Lidl" },
      { "clientRowId": "r2", "idempotencyKey": "idem-0192f3a1-aa02", "acceptedProposalId": "0192f3a1-1a02-7000-8000-0000000000b2",
        "kind": "EXPENSE", "amount": { "amountMinor": "350000", "currency": "RSD" }, "description": "gorivo" },
      { "clientRowId": "r3", "idempotencyKey": "idem-0192f3a1-aa03", "acceptedProposalId": "0192f3a1-1a03-7000-8000-0000000000b3",
        "kind": "INCOME", "amount": { "amountMinor": "15000000", "currency": "RSD" }, "description": "plata" }
    ]
  }
}
```

Result: 3 transactions written in one DB transaction; `r1` and `r2` `CONFIRMED` with
`needs_review = false`; `r3` `PENDING` with `needs_review = true` and `reviewQueueCount` incremented by
1 in `dashboardDelta`. Exactly one round trip after the preview.

---

## 8. The assistant contract

The assistant is the most dangerous surface in the API for hallucinated numbers, so its contract is
deliberately narrow: the **query planner selects a template, the backend computes the facts, the LLM only
narrates** ([04 §10](04-categorization-and-ai-engine.md), ADR-001).

### 8.1 The fixed intent template set

`AssistantIntent` is a closed enum. The planner never emits SQL; each member maps to exactly one
parameterised, household-scoped repository method, so the model cannot reach data the user is not
entitled to.

```graphql
enum AssistantIntent {
  # spending
  SPEND_TOTAL
  SPEND_BY_CATEGORY
  SPEND_BY_MERCHANT
  SPEND_BY_ACCOUNT
  SPEND_BY_TAG
  TOP_CATEGORIES
  TOP_MERCHANTS
  LARGEST_TRANSACTIONS
  AVERAGE_DAILY_SPEND
  TRANSACTION_COUNT
  TRANSACTION_LIST
  UNCATEGORISED_REVIEW

  # income & flow
  INCOME_TOTAL
  INCOME_BY_CATEGORY
  NET_CASHFLOW
  ACCOUNT_BALANCE
  ACCOUNT_BALANCE_ALL

  # budgets & pace
  BUDGET_STATUS
  BUDGET_LIST
  SAFE_TO_SPEND
  MONTH_PROJECTION
  BUDGET_PACE_VS_PLAN

  # comparison & trend
  TREND_VS_LAST_MONTH
  COMPARE_PERIODS
  TREND_VS_AVERAGE

  # goals & recurring
  GOAL_PROGRESS
  GOAL_REQUIRED_MONTHLY
  SAVINGS_PROPOSAL
  RECURRING_UPCOMING
  RECURRING_LIST

  # explicit refusal
  NO_TEMPLATE_MATCH
}
```

Each template declares: required slots (`categoryId`, `period`, `merchantId`, `limit`…), the period
resolution default (current month unless stated), the repository method, and the fact-row shape. Adding a
member is a schema change and requires a new repository method — there is no generic "run this query"
escape hatch, deliberately.

### 8.2 The `facts` payload shape

`facts.formatted` is the exact set of strings handed to the narrator. **The narrator is given
pre-formatted strings, not raw numbers** ([04 §10](04-categorization-and-ai-engine.md): *"not given raw
floats to reformat"*), and is instructed to reproduce them verbatim.

```json
{
  "template": "SPEND_BY_CATEGORY",
  "rows": [
    { "label": "Hrana",  "formatted": "27.450 RSD", "value": "2745000", "categoryId": "0192…c1" },
    { "label": "Prevoz", "formatted": "4.200 RSD",  "value": "420000",  "categoryId": "0192…c2" }
  ],
  "totals": [
    { "label": "Ukupno", "money": { "amountMinor": "3165000", "currency": "RSD" }, "formatted": "31.650 RSD" }
  ],
  "formatted": {
    "period": "1–31 oktobar 2026",
    "currencySymbol": "RSD",
    "locale": "sr-Latn-RS",
    "headline": "31.650 RSD"
  }
}
```

`rows[].value` carries the machine value alongside the formatted string so the client can build charts
without parsing `"27.450 RSD"`.

> **`totals[].money` is a `Balance`, not a `Money` — and it may be negative.** Every total is derived
> from movements rather than typed by a person, so `Income − spending`, a period-over-period change, a
> budget's `remaining`, an account's `balance` and a projection's overrun can all legitimately be
> negative. `Money` is non-negative by ADR-003 and **throws** on a negative amount, in the domain and
> at the scalar, which made all five of those an INTERNAL error until A-1 (see §8.9). The same rule
> already governs the analytics `delta`/`net` and every `remaining` in the budgeting module; the
> assistant's own totals are the last place it was wrong.

> **`formatted.scope` — the one key that is not a figure, and why it exists (2026-09-17).** A **scoped**
> total also carries the scope as a **phrase**: `at Lidl`, `on Hrana / Supermarket`, `from Tekući`,
> `tagged Putovanje` — the same string that appears in the total's own label (`Spending at Lidl`). It is
> there because of a measured failure: the scope used to live only in `provenance.filters` as a
> `merchantId` UUID, so a merchant question produced facts reading `Spending: 4.000,00 RSD` with nothing
> tying the figure to Lidl. The narrator is told *"if the facts do not contain the number the question
> asks for, say that you cannot answer it — do not guess"*, and it followed that rule: `koliko sam
> potrošio u lidlu` answered *"the data does not contain the spend for Lidl"* **while the correct figure
> was in the payload**. The deterministic fallback was scope-blind in exactly the same way
> (*"You spent 4.000,00 RSD."*), so this was a **payload** defect rather than a narration one, and it
> affected every `SPEND_BY_MERCHANT` / `SPEND_BY_CATEGORY` / `SPEND_BY_ACCOUNT` / `SPEND_BY_TAG`
> question. The phrase is built from the plan's **resolved slot** (the node the question named, not the
> subtree the query widened to) and is `null` — absent, never invented — for an unscoped total or a name
> that cannot be read. **Verified live 11/11**, in both narration modes (`LLM` and `TEMPLATE_FALLBACK`).
> **Not yet scoped the same way** (recorded, not hidden): `TRANSACTION_COUNT`, `TRANSACTION_LIST`,
> `LARGEST_TRANSACTIONS`, `TREND_VS_LAST_MONTH`, `TREND_VS_AVERAGE` and `BUDGET_STATUS` accept a scope and
> still do not name it in their sentences.

### 8.3 Provenance

Every answer carries the four required provenance fields plus the filter that produced them, and a
drill-through link. [04 §10](04-categorization-and-ai-engine.md): *"Trust comes from being checkable."*

| Field | Meaning | Required |
|---|---|---|
| `periodStart` | Inclusive first `Date` of the aggregated range, household-local | **Yes** |
| `periodEnd` | Inclusive last `Date` | **Yes** |
| `transactionCount` | Number of `CONFIRMED`, non-deleted transactions aggregated | **Yes** |
| `sourceQuery` | Template-level identifier of the repository method, e.g. `"spend.byCategory.v1"` | **Yes** |
| `filters` | The resolved slots (category ids, account ids, merchant ids, kind) | Yes |
| `computedAt` | Server instant the aggregate ran | Yes |
| `ledgerCurrency` | Currency of the totals (ADR-011) | Yes |

**The range must describe the aggregate, not the question.** A template that does not aggregate the
period the question named says so: `periodStart`/`periodEnd` carry the range it *did* use — a Budget's own
`period_start`, the dashboard's current month. A **state** figure has no range at all (a balance is the
whole ledger; the review queue is the current queue), so it reports `periodStart = periodEnd =` the
household's local today with `filters.asOf = "now"`. A range that is merely the one the question named is
the one kind of provenance that is worse than none.

If `transactionCount = 0`, `answerText` must say so plainly and `answered` may still be `true` — "you
spent nothing on that" is a correct answer, and the F-23 acceptance criterion forbids fabricating a
figure, not reporting a zero.

### 8.4 What the planner actually is (task 3.2.1)

`apps/api/src/modules/assistant/` — `assistant-intents.ts` (the registry) and `query-planner.ts`
(**pure**, 30 tests, no database).

| Decision | Built | Why |
|---|---|---|
| The registry is a `Record<AssistantIntent, IntentTemplate>` | Every intent has exactly one template naming a repository method | ADR-017's "no generic *run this query* escape hatch" becomes a **compile-time** property: an intent added to the enum without a template fails `tsc`, and there is no `default:` arm to fall into. `registeredSourceQueries()` prints the allow-list a reviewer can read. |
| The planner is pure, and its output type has no field a query could travel in | `Plan { intent, template, slots, matchedOn }` | The guarantee is the shape, not a promise: the caller looks the intent up and calls the named method with the slots. A test asserts the serialised plan contains no SQL-shaped word. |
| Entity slots match the Household's **own** names, through the shared fold | `matchEntity` over categories/merchants/accounts/tags | A keyword list here would drift from the tree the user actually has. The fold is `common/text/normalise` — the same one the classifier and the editors use. |
| …with **stem tolerance**, because Serbian inflects | A 3-character common prefix, at most two trailing characters free | `Hrana` is the category; people type *"na hranu"*. Word-for-word matching found nothing and the question fell through to `SPEND_TOTAL` — a confident wrong answer to a question the template set *can* answer. `Gorivo`/`goriva`, `Tekući`/`tekućeg`, `Lidl`/`lidlu` are the same shape. An exact occurrence still scores above a stem match. ⚠️ Bounded cost: a name beginning with a month stem (`Martin`) reads as March; the period is provenance the user sees (`matchedOn`), so a wrong guess is visible rather than silent. |
| A **scoped** spend question with an unresolved scope is refused | "na/za/u/kod X" where X resolved to no entity ⇒ `NO_TEMPLATE_MATCH` | *"koliko sam potrošio na more"* must not be answered with the month's total: that is a true figure to a question nobody asked, which is the failure ADR-017 exists to make impossible. The words the **period** consumed are resolved by definition — `koliko sam potrošio u avgustu` was refused until 3.2.2, because the phrase table's own answer (`avgustu`) was then re-read as an unresolved entity. |
| A trend question's `prošli mesec` is the **baseline**, not the period | `TREND_VS_LAST_MONTH` with that phrase anchors on the current month and records `baseline:prošlog meseca` | *"Kako stojim u odnosu na prošli mesec?"* asked in September compares September with August. Reading the phrase as the period compared August with July — a true answer to a different question, and the phrase table cannot tell the two apart before the intent is known. |
| Period resolution is a phrase table, and a named month resolves to its **most recent** occurrence | `danas`/`juče`/`ove i prošle nedelje`/`ovog i prošlog meseca`/`ove i prošle godine`/`poslednjih N dana`/month stems | Asking in March about *avgust* means last August; answering with one that has not happened yet gives a figure the user cannot reconcile. The default is the current month and it says so. |
| `isRunnable` + `missingSlots` are separate from matching | A routed intent with an unresolved **required** slot is refused | Goals and recurring rules have no slot resolution yet (3.3.2/3.3.3), so a goal question routes correctly and is then refused — the difference between "not implemented" and "answered with something else". |
| `matchedOn` carries the cues | Period phrase, `category:<name>`, `intent:<phrase>` | docs/06 §8.3 requires an answer to be checkable; "why did it think I meant Hrana?" is the first question a wrong answer raises, and this answers it from the audit instead of by re-reading the planner. |

**Reachability is asserted.** One test pins the set of intents a phrase can select today, so an arm that
nothing routes to — the class of dead configuration `RECURRING_DUE` was for alerts — fails rather than
sits in the enum looking available.

### 8.5 The numeric-validator guarantee

**Guarantee:** an `AssistantAnswer` returned with `narrationMode = "LLM"` contains **no numeral that is
not present in its own `facts` payload**.

The enforcement path, applied on every narrated answer:

```text
1. Extract every numeral token from answerText (Unicode decimal digits, grouped and ungrouped).
2. Normalise each: strip group separators for the household locale, resolve "," decimal marker.
3. Assert each normalised value matches, within the payload:
     - a facts.formatted string, or
     - a rows[].value / totals[].money.amountMinor **after locale formatting**, or
     - a rows[].label (a Household may name a Category "Stan 2"), or
     - a provenance count (transactionCount) or a date component (periodStart/periodEnd).
     The bare minor-unit digits are deliberately NOT authorised: "4665000" for "46.650,00" is wrong
     by 100×, and accepting it would let a factor-of-100 error through.
4. On any unaccounted numeral: regenerate ONCE with a stricter instruction.
5. On a second failure — or on a transport failure, which gets no retry because the same payload to
   the same unreachable endpoint is noise — return the TEMPLATE_FALLBACK rendering with
   narrationMode = "TEMPLATE_FALLBACK". The user still gets the correct answer: it is rendered by a
   deterministic formatter that reads only the facts payload (§8.7).
```

The single-digit caveat, stated rather than discovered: a date component **is** a numeral, so for a
monthly range `1` and `30` are authorised. §8.5 says so by listing the period as an allowed source; it
means the validator is not absolute for single digits, and it is still absolute for every figure.

Consequences that are part of the contract:

- `narrationMode` is always populated, and since **4.3.7b** the UI **discloses it** — inside the answer's
  provenance panel, plus one visible sentence when the fallback was a decision the reader can undo
  (`CONSENT_DECLINED`, with a link to `/settings`). The earlier wording here said the UI *"is expected to
  make template fallback invisible"*, and it was right while it was written: every deployment fell back, so
  the mode carried no information and a badge on every answer is how a person learns to distrust the
  figures. Once `NARRATE` is routable (ADR-032) the mode is the only *statement* of which path produced the
  words — the remaining clue is that the fallback's copy is English and a model answers in the household's
  locale, which is a clue rather than a statement (and the second instance of §5.14's no-catalogue breach).
  The distinction the old rule protected is kept by the **wording**: the fallback is described as what it is
  (*"put into words by the app itself"*), never as a failure, and it is never framed as an error.
- `NO_TEMPLATE_MATCH` ⇒ `answered = false`, `answerText` says the ledger cannot answer it, and
  `suggestions` lists the canonical answerable questions. **No figure is ever produced**, and the
  narrator is not called at all (§8.7).
- `reason` carries *why* an answer is a refusal or a fallback — `UNACCOUNTED_NUMERALS:99.000,00`,
  `AI_UNAVAILABLE:no-provider-configured`, `NO_TARGET_DATE`, `UNRUNNABLE:goalId`. It is diagnostic, not
  an error.
- This is the same guarantee as the CI gate *"fabricated-numeral rate in narration: 0"*
  ([04 §11.2](04-categorization-and-ai-engine.md)) and the test in [09](09-implementation-plan.md)
  §5 — it is asserted over every template fallback and over scripted model output; the CI gate itself
  still has no measured denominator (§8.8).

### 8.6 What fact assembly is (task 3.2.2)

`apps/api/src/modules/assistant/fact-assembly.service.ts`, with `fact-assembly.integration.spec.ts`
(48 tests) against a real database.

| Decision | Built | Why |
|---|---|---|
| The builder registry is a `Record<AssistantIntent, …>` | A builder for every intent, or `tsc` fails | The same reason as the planner's registry: completeness is a compile-time property with no `default:` arm to fall into. |
| An intent whose data does not exist **refuses with a reason** | `available: false` + `reason: "NO_TARGET_DATE"` / `"NEEDS_TWO_PERIODS"` / `"NO_TEMPLATE_MATCH"` / `"UNRUNNABLE:…"`, with **empty** facts | "That goal has no deadline, so there is no monthly amount" and "somebody forgot to write the builder" must not look identical from outside. An unavailable template must not be narratable, so its facts are empty rather than plausible. Since A-2 built the last four builders, no shipped intent refuses with `NOT_BUILT` at all — the arm stays for the next declaration. |
| The **assembler** enforces `isRunnable`, not only its caller | `reason: "UNRUNNABLE:categoryId"` | `SPEND_BY_CATEGORY` with no resolved category aggregates *everything* and can be labelled with the category that was not found — a true figure answering a question nobody asked. 3.2.4's UI is a caller that can forget; this is the layer that must not. |
| Splits are included, and a parent Category expands to its children | Two aggregates (Transaction + Split) plus a subtree walk | I-1/I-11 and ADR-015: the question must aggregate what the **budget tile the user is looking at** aggregates. ⚠️ A deliberate divergence: the 3.1.1 insight generators count direct rows only, so the two figures can differ for a split — 3.3.1's analytics work must reconcile them. |
| Every money figure is a pre-formatted string **and** its minor units | `rows[].value`, `totals[].money.amountMinor`, `formatted.*` | §8.2: the narrator reproduces strings instead of reformatting raw numbers (ADR-003), and the client builds a chart without parsing `"27.450 RSD"`. |
| Balances and budget consumption come from their owning services | `AccountsService.list`, `BudgetsService.list`/`dashboard` — never a local aggregate | I-4 and I-5 arithmetic already exists in exactly one place; re-deriving it is how the assistant and the screen the user is comparing against start disagreeing. |
| Provenance reports the range that was **actually** aggregated | `Built.period`, set by the budget and dashboard templates; `filters.asOf = "now"` for a balance or the review queue | See §8.3. A balance is the whole ledger and a projection is the current month, so the plan's period would be a claim about the number that is not true. |
| `transactionCount` for a `LIST` shape is the number of rows in the payload | `rows.length` | For a list the aggregate *is* the page: that is the set which was counted and the set the narrator may cite. |
| A zero result is an answer | `available: true`, count `0`, `"0 RSD"` | §8.3: "you spent nothing on that" is correct. F-23 forbids fabricating a figure, not reporting a zero. |

**`AssistantModule` boots and now exposes §4.4's operation** (3.2.3). At 3.2.2 it did not: `answerText`
and `narrationMode` are the narrator and the template fallback, and publishing the operation before
them would have published a contract the API could not keep. The module was registered in
`app.module.ts` anyway — an unresolvable dependency is a boot failure that `typecheck` does not catch
(task 2.3.4's lesson) — so 3.2.2 changed nothing in `schema.gql`.

### 8.7 What narration is (task 3.2.3)

> **Four more findings from a measured bad-answer report (2026-09-17).** A batch of **37 natural
> questions** through the live API answered 25 and refused 12. The refusals, with what each one is:
>
> 1. **Scope-blind facts — fixed above (§8.2).** Any by-merchant/category/account/tag question was
>    answered with *"the data does not contain …"* while the figure sat in the payload. This was the
>    user-visible "very often" and the largest single cause; it is fixed and verified.
> 2. **A signed derived figure could not be rendered at all — `MONTH_PROJECTION` 500'd, and it was one
>    of eight call sites. FIXED (§8.9).** `koliko ću potrošiti do kraja meseca` →
>    `MoneyError: amountMinor must be non-negative`, because `dashboard.projectedOverrun` is a **signed**
>    Balance (negative = *under* budget, which is the ordinary case) and the builder guarded only `null`.
>    The reported instance was one line; the **call** was in eight places — `NET_CASHFLOW`'s
>    `income − spending`, both trend templates' change, a budget's `remaining`, an account's `balance`,
>    `SAFE_TO_SPEND`, and the projection's overrun — every one of them an ordinary state (a month that
>    spent less than the last one, an overspent budget, an overdrawn account) that answered an INTERNAL
>    error. See §8.9 for the fix and why the `Money`/`Balance` distinction is now enforced on the wire.
> 3. **Planner cue coverage, 7 of the 12 refusals.** The planner is a closed registry of Serbian cue
>    phrases, and these natural phrasings miss it although the template exists: `koliko imam na računu`
>    (the cue needs *stanje na računu* or *na računu imam*), `koliko mi novca ostaje` (the cue is
>    `koliko mi ostaje`), `da li sam preko plana` (pace routes only when *budžet* is also present),
>    `kolika mi je penzija` / `kada mi sledeća plata dolazi` (no income cue for *penzija*/*plata*),
>    `koliko sam dao za kiriju` (*dao* is not in the spend-verb list), and **both English questions**
>    (`what did I spend this month`) — there are **no English cues at all** although the catalogue's
>    primary language is English. **Open**, and it is the largest single reduction available.
> 4. **`NOT_BUILT:recurring` × 2 — FIXED in A-2, and it was four intents, not two.** `šta mi se plaća
>    uskoro` and `koje pretplate imam` routed correctly and refused because the templates had no
>    repository method; so did `GOAL_PROGRESS` and `GOAL_REQUIRED_MONTHLY`. All four are built (§8.10),
>    from `GoalsService`/`RecurringService` — the methods the `/goals` and `/recurring` screens already
>    read — after the planner was given the two name lists it needed to resolve their slots at all.
> 5. **The refusal copy is English** (*"I cannot answer that from your ledger. Try one of the questions
>    below."*) even for a Serbian question with `locale=sr-Latn` — the §5.14 no-catalogue breach, and the
>    sentence a user actually quotes back. **Open.**
>
> One honest exception in the same batch: `koliko sam potrošio u Maksiju` refuses because the Merchant
> is not in the Household's context, and answering the *unscoped* total instead would answer a
> different question under the one that was asked (ADR-017). That one is the design working, not a gap —
> the fix is merchant/alias coverage, not a weaker rule.
>
> **A-3 (2026-09-17) fixed the cue half of this list and re-classified the rest.** Three of the nine were
> really vocabulary (§8.11): `koliko imam na računu`, `koliko mi novca ostaje`, `da li sam preko plana`,
> plus `dao` as a spend verb; and **A-3b** added the English cues and English period phrases, which is
> what item 3 below and both English questions needed. The battery is **32 of 37 answered** now. The other six are **not** cue gaps, and calling them that would have meant
> adding phrases that answer a different question:
>
> - **Two were English — FIXED in A-3b** (§8.11), which needed an [ADR-019](14-decisions-and-risks.md)
>   amendment because "one ordered rule list, each rule's phrases per language" is an i18n decision and
>   not a phrase list. `how much did I spend on food` still refuses, for the taxonomy reason recorded
>   below rather than a cue one.
> - **`Maxi` vs `Maksiju` was a FOLD gap — FIXED in A-10 (§8.13).** `normaliseForMatching('Maxi')` was
>   `maxi` and `'Maksiju'` was `maksiju`, so neither the exact rung nor the case-ending rung matched the
>   Serbian spelling of a foreign name. `packages/nlp` now folds a run of `x` to `ks` (docs/04 §3.1), which
>   makes `maksi` occur inside `maksiju` — so the Merchant resolves — and the same
>   fold makes a **typed** `Maksi 2000` resolve the `Maxi` Merchant in the classifier. The re-fold of stored
>   keywords/aliases this was expected to need turned out to be **unnecessary**: every reader re-folds
>   stored folded text through the current folder, so the change is retroactive (docs/04 §8.1.7, which also
>   records the one lookup that does *not* self-heal). ✅ **Live it answered the Category rather than the
>   Merchant** at first — a pre-existing keyword-substring collision A-10 exposed and A-12 **fixed** (§8.14):
>   the demo now answers `SPEND_BY_MERCHANT` with `scope: at Maxi`.
> - **`kolika mi je penzija` / `kada mi sledeća plata dolazi` were a REGISTRY gap — FIXED in A-9 (§8.12).**
>   `Penzija` and `Plata` are INCOME Categories and both resolved, but no template aggregated income by
>   Category: `SPEND_BY_CATEGORY` declares `kind: 'EXPENSE'` and `INCOME_TOTAL` accepts no `categoryId`.
>   `INCOME_BY_CATEGORY` now closes it — the registry gained one member, the builder is the same
>   split-aware `byCategory` call with `kind: 'INCOME'`, and the narration verb follows the entry's `kind`.
>   The *second* question is still a gap for its own reason: it asks **when** money arrives, which is a
>   schedule question, and `dueSoon` filters `kind: 'EXPENSE'` — so income occurrences are not listed and
>   the refusal now offers the amount question about `Plata` instead.
> 6. **Two misroutes the A-4 battery fixture found before the gate was written — both FIXED (2026-09-17).**
>    They are worth reading together, because one *lowered* the answered count and improved the product.
>    - **`koliko sam potrošio na benzin` was answered with a pharmacy's total.** The planner's stem rung
>      bounded the difference between a name and a word by the **shorter** of the two, so a
>      four-character name could diverge from its third character on: `Apoteka Benu` matched the word
>      `benzin` on the three-letter prefix `ben`. The rule now requires the **whole** difference to be a
>      case ending — at most two characters at the end of the longer word — which still matches
>      `hrana`/`hranu`, `automobil`/`automobilu` and `lidl`/`lidlu` and rejects `benu`/`benzin`. **The
>      scope is now unresolved and the question refuses**: the Household has no Category named `benzin`,
>      even though its tree carries `benzin` as a strong **keyword** of `Gorivo` (see the gap below).
>    - **`how much did I spend on netflix` returned the subscription list**, and `koliko sam platio
>      struju` would have too, for a Household with a rule of that name: a matching recurring-rule
>      **name** entered the recurring branch before the spend branch was reached. A spend verb with a
>      resolved scope now outranks a rule name; the name remains evidence (it is why *"kada mi sledeći
>      Netflix dolazi"* still routes to the schedule), it just cannot outrank an explicit spend question.
>
>    Net effect on the measured battery: **52 → 51 answered**. One wrong answer became a refusal, which
>    is the trade ADR-017 asks for — and the reason A-4 gates on *"every question behaves as declared"*
>    rather than on maximising the answered count.
>
> - **The planner matches entity NAMES, not the CategoryKeywords the classifier uses — FIXED in A-5**
>   (§8.11). `benzin` is a seeded strong keyword of `Gorivo`, so the classifier categorised a typed
>   `benzin 5000` correctly while the assistant could not resolve the Category; the planner now matches
>   `INCLUDE` keywords below names. This was the single mechanism behind three of the six refusals, and
>   it took the battery to **52 of 58**. `kiriju` and the English `food` still refuse, honestly: nothing
>   in a Serbian-named tree carries either word, so what remains for them is English/`kirija` **seed
>   content**, which is docs/04's, not the planner's.
>
> - **`koliko sam dao za kiriju` is correct as it stands** — `dao` is a cue now, and this Household has no
>   Category or Merchant named `Kirija`, so the question refuses instead of totalling everything. A
>   Household that *does* have one gets `SPEND_BY_CATEGORY`. The battery counts it as a refusal; the
>   behaviour is the design working.

`apps/api/src/modules/assistant/` — `assistant.service.ts` (the pipeline), `numeric-validator.ts`
(**pure**), `narration-template.ts` (**pure**), `narrate-prompt.ts` (**pure**),
`assistant-narrator.ts` (the `NARRATE` seam), `assistant.model.ts` + `assistant.resolver.ts` (the
wire). 211 tests in the module, of which 23 script a model and 48 assemble facts against Postgres.

| Decision | Built | Why |
|---|---|---|
| The pipeline refuses **before** it narrates | `NO_TEMPLATE_MATCH` and an unavailable template return `answered: false` with the assembled (empty) payload | §8.5 forbids a figure for a question the ledger cannot answer, and the way to guarantee that is for the narrator to have no figure to narrate. The integration test scripts a narrator that throws if it is called and asserts it is not. |
| One stricter retry, then the template | `for (const strict of [false, true])`, then `TEMPLATE_FALLBACK` | §8.5 step 4. A model that invents a figure twice will not be talked out of it, and every extra attempt is paid for by the household. The `reason` names the **decisive** rejection, and `costMicros` sums **both** attempts — a discarded call was still billed. |
| A **transport** failure gets no retry | The loop breaks and the template renders | Sending the same payload to the same unreachable endpoint is noise, not a second opinion. The distinction is only expressible because the narrator returns a value (`ok: false`) rather than throwing. |
| The validator compares **values**, with the locale's own separators read from `Intl` | `27.450,00` ≡ `27.450`; a bare `4665000` is refused | §8.5 step 3's "after locale formatting" is load-bearing: allowing the machine value would let a factor-of-100 error through, and refusing a dropped decimal part would send correct answers to the fallback for nothing. |
| What the payload authorises is enumerated, including labels | `formatted`, the locale-formatted machine values, `transactionCount`, the date components, and `rows[].label` | A Household may name a Category `Stan 2`, so its own label's numerals are authorised; a numeral in a different digit set is not, which is why the canonical form is never ASCII-folded. |
| Every intent's fallback is **proved** unable to fabricate | `narration-template.spec.ts` runs `validateNarration` over the rendered answer for all 29 intents | §8.5 says the guarantee is "asserted, not aspirational". The frame is chosen by a `Record<AssistantIntent, Frame>`, so a new intent fails `tsc` until somebody decides how it reads. |
| The cost guard applies to **paid** calls only | `AssistantNarrator.available`; the `AI_NARRATE` budget is consumed when it is true | §11.2 limits `assistantAnswer` because it is the one place a user can trigger unbounded LLM cost. A template answer costs nothing, so rationing it would refuse a correct, free answer — a self-inflicted outage. When no provider is configured (this build) the limiter is never called, which the integration test asserts. |
| The prompt contains no numeral at all, and the retry does not name the numerals that failed | Bulleted rules; `narratePrompt({ strict })` | An instruction containing the answer is one the validator can no longer check, and a model copying from the prompt rather than the facts must not pass by accident. For the same reason `locale` is validated as letters-and-hyphens before it can reach the prompt. |
| The narrator's input is built from pre-formatted strings | `factStrings()` | §8.2. The machine values are deliberately excluded — the model is not handed minor units or floats to reformat. |
| A drill-through is offered only where a route can reproduce the scope | `DRILL_ROUTES`, `null` for `SPEND_BY_MERCHANT`, `SPEND_BY_TAG`, `TOP_MERCHANTS` | See §8.8. A link that shows rows the answer did not come from is worse than no link. |

| The savings proposal is a **pure domain calculator**, not a prompt | `proposeSavings` in `@finmate/domain` (11 tests), fed by the period's per-Category spend with splits included | F-30 says *"backend computes, AI explains"*, and [08 §6.7](08-security-privacy-and-compliance.md) lists the proposal as unchanged without AI consent — so it cannot live in a prompt. It also shares `categorySpend` with `TOP_CATEGORIES`, so the plan and the ranked view can never disagree about what a Category spent. |
| The target amount is read from the question, anchored to the verb | `resolveTarget`: the first numeral after `SAVINGS_CUES`, parsed alone through `parseAmount` | *"kako da uštedim 20.000 u avgustu 2025"* has two numerals and the second is a year, so "the last number" plans around 2.025 RSD. The token is parsed alone because `parseAmount` reads a grouped number **differently** in prose (*`20.000` → twenty*) than on its own (*→ twenty thousand, or twenty, in that order*) — silently, and 1000× off for a target. |
| An ambiguous target is taken, not refused | `1.200` → 1.200,00 RSD (the parser's first reading) | docs/04 §3.1's "never silently picks" is about the **capture** path, where the number becomes money in the ledger. Here the number is a target the answer repeats on its face (*"Target 1.200,00 RSD"*), and refusing would make F-30's own canonical question unanswerable. |
| A savings question without an amount is refused | `UNRUNNABLE:targetMinor` → *"I could not tell how much you want to save."* | "How do I save?" is a different question from "how do I save 20.000?", and answering it with a default target would be inventing the most important input. |
| `sourceQuery` is `savings.proposal.v1`, not `goals.savingsProposal.v1` | The registry entry renamed | A savings proposal reads the ledger's spend and needs no SavingGoal (3.3.2 owns those); a provenance string naming a table the figure never touched is a small lie in the one place the product promises to be checkable. |

### 8.8 Known gaps in the assistant (3.2.3)

- **Narration cost is not persisted.** `costMicros` is returned on the answer and logged; nothing
  writes a row. docs/05 §3's assistant row said it "writes `classification_decisions` for cost" —
  **the document was wrong and is corrected**: a narrated answer is not a classification decision, and
  `classification_decisions.decided_by` has no value that means "narration", so writing one there would
  corrupt every accuracy metric built on that table. A per-household narration spend ledger needs a
  table (or a column set) that means what it says; that is a decision, not an oversight.
- **The fallback copy is English.** `narration-template.ts` and `renderRefusal()` are server-rendered
  strings, so they are the second instance of the DoD breach §5.14 records for notification copy: the
  API has no i18n catalogue. The money is in the household's locale and the Household's own names are
  untranslated (they are the user's words); the connectives are not. Fixing it means the API gains a
  catalogue **or** the client renders the fallback from `facts` — §5.14's decision, and both surfaces
  should be fixed together.
- **`conversationId` is absent** from `assistantAnswer` (see §4.4): there is no conversation store.
  A follow-up question therefore has no context, and the client owns the transcript.
- **A merchant- or tag-scoped answer offers no drill-through**, because `transactions(...)` takes
  `categoryId` and `accountId` but not `merchantId` or `tagId`. Adding them is a ledger change
  (§4.1 + §5.1) and belongs with 3.2.4's UI, where the missing link is visible.
- **A drill-through now lands filtered** (3.2.4): `/transactions` reads the six arguments out of the URL
  before its first query (`filtersFromQuery`), and the link carries route and parameters separately
  because one string containing `?from=…` made `routerLink` encode the question mark (docs/15). The
  screen reads the URL and never writes its own filters back to it, so a filter edit is not a history
  entry — which also means a manually filtered list is still lost on reload.
- **The assistant screen has a question composer, not docs/02 §3's `CaptureField`.** §3 and DP-1 want
  *one* capture field mounted on the dashboard, the transactions list, the assistant and the mobile
  shell; it is built nowhere, and capture remains its own full screen (`/capture`). A question and a
  transaction fragment are different inputs to different pipelines, and unifying them is a UX change
  across four surfaces rather than part of F-23.
- **The transcript is the client's, for the visit.** With no `conversationId` there is no context for a
  follow-up ("and last month?"), and a reload clears the thread. The empty state says so rather than
  implying memory the API does not have.
- **F-30 stops at the proposal.** `SAVINGS_PROPOSAL` computes and presents a plan (3.2.5) — a target, a
  reduction per Category, the shortfall — and **nothing is applied**: docs/02 §4.16's *Primeni* button is
  not built. It is not an oversight but an unmade decision, and a real one: a Budget is a limit, so
  "apply" means writing `current spend − reduction` into the Budget for each line — which can *raise* a
  Budget the Household had already set lower, and can lower one below what it has already spent this
  period. Who wins, whether an existing tighter Budget is left alone, and whether the write is one
  mutation or the client's existing `upsertBudget` per line are product decisions (docs/02 owns them),
  so the screen says *"a suggestion only — no budget has been changed"* instead of guessing.
- **The proposal's cut rule is uniform, because nothing marks a Category as discretionary.** It is 20 %
  of each Category's own spend, biggest first (`proposeSavings`, `@finmate/domain`). That is defensible
  and stated, but it will happily propose cutting rent: the wireframe cuts `Hrana`/`Gorivo`/`Pretplate`,
  which implies a notion of essential spending the data model does not have. Adding it is a
  `categories` column and a product decision, not a heuristic to slip into the calculator.
- **`/assistant` has not been looked at by a human at any width** — the same standing gap as `/review`
  and `/notifications` (docs/02 §9). Its mounted spec proves the flow; it cannot prove the layout.
- **The planner matches against at most 200 Merchants and Accounts** per question (`MAX_PAGE_SIZE`).
  Beyond that an entity can be in the Household's ledger and still not resolve. A single unbounded read
  for planning is a taxonomy-module decision.
- **Four declared intents have no fact builder, and two of them cannot even resolve their slot.**
  `GOAL_PROGRESS`, `GOAL_REQUIRED_MONTHLY`, `RECURRING_UPCOMING` and `RECURRING_LIST` answer
  `NOT_BUILT`, although `GoalsService.list()` and `RecurringService.list/occurrencesBetween/dueSoon`
  already exist and `GoalView` already carries every derived figure they need. They are also
  `UNRUNNABLE:goalId`/`UNRUNNABLE:recurringRuleId` first, because `PlannerContext` carries no goal or
  recurring-rule name list to match against. Both halves are one slice.
- **The planner's cue vocabulary is Serbian-only** while the catalogue is English-primary (ADR-019), so
  an English question is refused by an English-primary product — the largest single refusal bucket
  measured (9 of the 12 refusals in a 37-question battery).
- **The read-coverage and write-action design is [16](16-assistant-context-and-actions.md)** — including
  the closed **action registry** and why write actions need an ADR (Q-11) before any code.
- **Narration is never evaluated.** `pnpm test:evals` still reports the two narration gates as
  `skipped`, because no provider is configured and the dataset holds classification cases, not
  questions. The validator's guarantee *is* asserted — over the fallback for every intent, and over
  scripted model output in the integration spec — but §04 §11.2's "fabricated-numeral rate" gate has no
  measured number until a provider and a narration slice exist.

### 8.9 A derived figure is a `Balance`, never a `Money` (task A-1, 2026-09-17)

Every total in the facts payload is **derived** from movements, so any of them can legitimately be
negative — and `Money` is non-negative by ADR-003, in the domain (`money()` throws) *and* on the wire
(`MoneyScalar` refuses to serialise one). The assistant's totals were typed `Money`, which made
`Income − spending` a **500** on any month that spent more than it earned; the same defect sat in the
projection's overrun, both trend templates' change, a budget's `remaining` and an account's `balance`
— **eight call sites**, each an ordinary state rather than an edge case.

| Decision | Built | Why |
|---|---|---|
| The facts total is a **`Balance`** | `AssistantFactTotalModel.money: Balance!` (`BalanceScalar`); the wire shape is unchanged | This is the distinction the analytics `delta`/`net` (§5.1) and every budget `remaining` (§6.3) already make, so the assistant stops being the one module that conflates them. The client already renders through `formatBalance` and `money-text.overrunText` gates on the sign, so **no query, no component and no type on the web changed** — only the schema's type name. |
| One formatter, and it is the **signed** one | the private `format` in `fact-assembly.service.ts` renders via `formatBalance(balance(…))` | For a non-negative value the output is byte-identical (`Intl.NumberFormat`, same options), so the change is invisible except that a negative renders with a minus instead of throwing. Patching the *call sites* would have left the ninth one to be written later — which is how this arrived. |
| The narration must keep the **sign** | `numeric-validator.ts` compares each numeral **with the sign it was written with** | Digits alone stopped being sufficient the moment a negative became renderable: `5.000,00` and `-5.000,00` tokenise identically, so a sign-blind check would accept *"you spent 5.000 more than last month"* for a month that spent 5.000 **less** — trading a 500 for a confidently wrong direction. Only `-` and `−` (U+2212) count as a sign: an en dash is this document's period-range separator and a hyphen with a digit before it is a date (`2026-09-01`) or a range (`1-31`), either of which would otherwise have dropped the payload's own date components out of the allowed set. |
| A negative overrun is **not** a fact | `monthProjection` emits the overrun total only when it is `> 0` | The label says *Projected overrun*, and the `PROJECTION` frame reads this total **by that label** — so a negative one would render *"over by -25.000,00 RSD"* and assert an overspend that is not there. This is the rule the client's `overrunText` already applies; the under-budget case is not lost, because the headline is the projected total and the frame then reads *"You are on track for … this month."* |

**Verified live 9/9** (`/tmp/verify-a1.mjs`), including the state the report came from: with a
Household budget above the projection, `projectedOverrun` is **−92.871.644** and MONTH_PROJECTION
answers *"Do kraja meseca predviđena potrošnja iznosi 207.179,11 RSD."* — no overrun fact, no 500. The
probe created and deleted that budget itself and asserted the dashboard was back to `null`. The
`formatMoney` sweep across `apps/api` now returns **no** call site at all, and the analytics,
budgeting, accounts, goals, receipts, recurring and ledger models were already using `BalanceScalar`
for their signed figures — the assistant was the outlier.

> **Named, not fixed:** two template frames read awkwardly for a negative — `SAFE` (*"You can spend
> −1.000,00 RSD safely today"*) and `BUDGET` (*"You have −2.000,00 RSD left"*). The facts and the sign
> are right and the sentence is not a lie, but it is clumsy; that is A-7's copy work and it is recorded
> here rather than papered over with a special case per frame.

### 8.10 Goals and recurring rules: the four templates that refused (task A-2, 2026-09-17)

Four intents declared in §8.1 answered `NOT_BUILT`. The services behind them already existed and were
already exported — `GoalsService.list` and `RecurringService.list`/`dueSoon` — which is why this was
plumbing rather than a feature: `/goals` and `/recurring` had been reading those figures all along.

**Why they refused for two reasons at once, and the second was invisible.** Each had no fact builder —
the obvious half. Each was *also* unrunnable before the builder was reached, because `GOAL_*` requires a
`goalId` and `RECURRING_*` accepts a `recurringRuleId`, and `PlannerContext` carried no goals or
recurring rules to match a question's names against. So the plan died at `UNRUNNABLE:goalId` and never
arrived at the `NOT_BUILT` branch the earlier battery had recorded.

| Decision | Built | Why |
|---|---|---|
| `PlannerContext` gains `goals` **and** `recurringRules`, both optional | A household's goal names and rule descriptions, matched by the shared fold | A slot with no vocabulary to resolve it is unrunnable by construction. Optional so a caller that never asks about goals need not read them, and an absent list resolves to nothing rather than to everything. |
| A goal or a rule resolves on the **exact** rung only | `matchEntityScored(...).exact` gates both the slot and the intent cue | Every other entity kind scopes a question whose verb already chose the template, so the stem rung is a pure win. These two **pick the template**, and the rung is loose enough to collide with ordinary words: a goal named `Novi telefon` shares a four-character stem with `novca`, which routed *"Na šta mi odlazi najviše novca ovog meseca?"* to `GOAL_PROGRESS`. An inflected name that misses exactly (`u letovanju`) falls back to the vocabulary cue and refuses with `UNRUNNABLE:goalId` — a refusal, not a wrong answer. |
| The savings **verbs** are cues now | `usted`/`ušted` join `cilj`/`štednja` in the goal branch, and `sledec` replaces the neuter-only `sledece` | `Koliko sam uštedeo za letovanje?` had no cue at all — the goal templates were reachable only through the noun. `Kada mi sledeći Netflix dolazi?` routed to the *list* for the same reason: the imminence cue knew only `sledeće`. Both are A-3's vocabulary gap arriving early, in the one place the fix was a precondition for the feature rather than a follow-up. |
| Goal figures come from `GoalsService`, and a contribution is **not** a Transaction | `GOAL_PROGRESS`/`GOAL_REQUIRED_MONTHLY` share `goalProgress` with the `/goals` screen; `provenance.transactionCount` is **0** | §8.3's `transactionCount` means "CONFIRMED, non-deleted Transactions aggregated", and docs/03 is explicit that goal progress is the sum of `goal_contributions`, which write no ledger row. Reporting the contribution count there would put a claim in the provenance panel that the figure never touched. |
| A goal with no target date is refused **by name** | `reason: "NO_TARGET_DATE"` with empty facts | There is no monthly amount that reaches an undated goal, and a default horizon would be the answer's most important input invented. `requiredPerMonthMinor` is null in exactly that case, which is a **state** rather than a missing builder — the distinction `NEEDS_TWO_PERIODS` draws. |
| Recurring rules are listed **paused ones included**, and labelled | `recurring.list(householdId, false)`; a paused row reads `Teretana (paused)` and `formatted.pausedCount` carries the number | Hiding a paused rule would make *"koje pretplate imam"* answer a shorter list than the `/recurring` screen shows — the contradiction a drill-through exists to prevent. |
| "Due soon" is `dueSoon(…, withinDays: 30)` | The same `pendingOccurrences` read that feeds a budget's `committed` figure and the `RECURRING_DUE` alert | Three surfaces, one predicate: the assistant, the dashboard's projection and the notification cannot disagree about what is still to be charged — including the rule that an occurrence already posted as a Transaction is not due again. Thirty days because that is the `/recurring` screen's own next-30-days line, which the new drill-through opens. |
| Two new `shape`s and four new frames | `GOAL`/`GOAL_MONTHLY`/`SCHEDULE`/`DUE`, chosen by the per-intent `FRAMES` record | "You spent X" is wrong for a goal and "3 transactions" is wrong for a bill. `SCHEDULE` and `DUE` read `formatted.count`, **not** `provenance.transactionCount`, for the reason above. |
| All four drill through | `/goals` and `/recurring` | Both screens show the same figures from the same services, so the link reproduces the answer. |

**Verified live 15/15** (`/tmp/verify-a2.mjs`): the probe creates its own goal (with a date, contributed
to), a dateless goal and a recurring rule in the demo Household, asks the four questions, and asserts
each answer's figure **equals what the `/goals` and `/recurring` queries return** — 25.000,00 RSD saved
at 25 %, a 7.500,00 RSD required month that matches the screen's own `requiredPerMonth`, `NO_TARGET_DATE`
by name, a schedule and a due list whose counts and dates match the rules — then deletes everything it
created and asserts the Household is back to empty. It also asserts the two regressions this work
introduced and fixed: the spending question stays a spending question, and naming a rule routes to the
**due** template rather than the list.

**A-1 + A-2 re-measured the §8.8 battery: 28 of 37 answered, 9 refused** (it was 25/12). Every remaining
refusal is `NO_TEMPLATE_MATCH` — the cue-coverage bucket A-3 exists for, both English questions included —
and there is **no `NOT_BUILT` and no error left**. One measurement note worth keeping: the battery has to
be **paced**, because §11.2's `AI_NARRATE` budget is 30 a minute per Household and an unpaced 37-question
burst reports ~30 refusals that are really one `RATE_LIMITED` (2.2 s between questions is enough, and an
unpaced run is how the first attempt "found" 35 refusals).

> **Named, not fixed:** `GOAL_PROGRESS` requires a goal to be **named**. A Household with exactly one
> goal, asked *"koliko sam uštedeo za cilj"*, is refused rather than answered, because resolving the only
> goal would be the planner inferring a scope the question did not state. That is a product call rather
> than a bug, and it belongs with A-7's refusal work — the suggestions a refusal offers are still the six
> static ones.

### 8.11 The cue vocabulary a measured battery found missing (task A-3a, 2026-09-17)

The battery's nine refusals were re-classified **before** any phrase was added, and only three were
vocabulary. That distinction is the substance of this task: a cue list is easy to widen and the wrong
widening answers a different question, so each addition below is paired with what it must *not* catch.

| Cue added | The measured question | Why it is safe — and what it deliberately does not cover |
|---|---|---|
| `preko plana`, `iznad plana`, `isplanirano`, `prekoračio plan`, `odstupa od plana` — checked **before** the budget branch | `da li sam preko plana` | The rule lived *inside* `if (has('budžet'))`, so a question naming the judgement but not the noun was refused. Checked first because the phrase does not contain the word that branch looks for. With the noun it routes identically, so the two phrasings cannot disagree. |
| `imam na računu` (and the `_ALL`/named-account split unchanged) | `koliko imam na računu` | The list knew `stanje na računu` and the inverted `na računu imam`, but not the natural order. ⚠️ **A bare `koliko imam` is deliberately not a cue**: it fronts goals, budgets and everything else a Household has, so treating it as "balance" would answer a different question. Whether the plan is `ACCOUNT_BALANCE` or `ACCOUNT_BALANCE_ALL` is decided by the **Household's own account names** — the demo has `Tekući račun`, so the same question resolves that account and answers for it. |
| `novca ostaje` | `koliko mi novca ostaje` | `koliko mi ostaje` missed the version with a word inserted. The **budget** branch is ordered first and still wins for `koliko mi je ostalo od budžeta`, which the spec asserts. |
| `dao`, `dala`, `dali`, `kupovao`, `kupovala`, `placao`/`plaćao` as spend verbs | `koliko sam dao za kiriju` | Adding a verb cannot make an unanswerable question answerable: that branch answers only when a Category, Merchant, Account or Tag resolved and refuses otherwise — so a question about a name the Household does not have still refuses rather than totalling everything. Asserted in both directions. |

**Verified live 8/8** (`/tmp/verify-a3.mjs`), and **the battery went 28 → 31 answered, 9 → 6 refused**.
The six are the re-classified ones above: two English (A-3b), `Maxi`/`Maksiju` (a fold gap — **fixed in
A-10**, §8.13), `kolika mi je penzija` and `kada mi sledeća plata dolazi` (a registry gap — the first
**fixed in A-9**, §8.12), and `koliko sam dao za
kiriju` (correct as it stands — this Household has no such Category). All four additions are also
asserted in `query-planner.spec.ts`, including the cases they must **not** catch.

**A-3b (same day) added English, and the two halves belong together.** The catalogue is English-primary
(ADR-019) while the planner matched Serbian phrases only, so *"what did I spend this month"* was refused
by an English-primary product — and `resolvePeriod` was Serbian-only, so translating the cues alone would
have answered *"what did I spend last month"* with **this** month. `resolvePeriod` now resolves
`today`/`yesterday`/`this week`/`last week`/`last month`/`this month`/`this year`/`last year`/`last 30
days` and an English month name, and every rule's phrase set covers both languages **in the one ordered
list** — the ADR-019 amendment records why a per-locale table was rejected (two orders to keep in step,
drifting silently in one language only).

| Decision | Built | Why |
|---|---|---|
| One ordered rule list, phrase sets per language | Every cue rule carries its English phrases beside its Serbian ones | A second rule list is a second order; the failure when the two drift is silent misrouting in one language, which only a speaker of that language notices. |
| An English month resolves only after `in`/`during` | `\b(?:in|during)\s+(january|…|december)\b` | `may`, `march` and `august` are ordinary English words. Matching them bare would read *"may I ask…"* as May. |
| `hasUnresolvedScope` takes English prepositions | `on`, `for`, `at`, `in`, `to` joined `na`, `za`, `u`, `kod` | **The safety-critical half.** Without it *"how much did I spend on food"* fell through to `SPEND_TOTAL` and answered the month's whole spend — a true figure to a different question, which is exactly what ADR-017 forbids. Provenance is unaffected: a period introduced by the same preposition (`in august`, `this month`) is a **resolved** scope and still answers. |
| The cash-flow cue is multi-word | `cash flow`, `left over`, `what is left`, `have left` — never a bare `net` | `netflix` contains `net`, so a bare cue would turn *"how much did I spend on netflix"* into a cash-flow question. Asserted in the spec. |
| The **monthly** goal phrases stay inside the goal branch | `per month`, `a month`, `monthly` | As an entry cue, *"how much do I spend per month"* would become a goal question and then refuse for want of a `goalId`. It is a spend question. |
| `salary` and `pension` are **not** income cues | Deliberately absent | `INCOME_TOTAL` is unscoped, so *"how much is my pension"* would be answered with the month's whole income. The missing piece is an income-scoped template (built as `INCOME_BY_CATEGORY` in A-9, §8.12), not a phrase. |

**Verified live 11/11** (`/tmp/verify-a3b.mjs`), including the three things that must not happen: an
unresolvable English scope **refuses** rather than totalling, `on netflix` is a Merchant scope and not a
cash-flow question, and `in may` is May while `may I ask` is not. **The battery is now 32 of 37
answered** (it was 25/12 before A-1). The five left are all named above: `Maksiju` (a fold gap — **fixed
in A-10**, §8.13), `kolika mi je penzija` and `kada mi sledeća plata dolazi` (the registry gap — the
first **fixed in A-9**, §8.12), `koliko sam dao za kiriju`
(correct — this Household has no such Category), and `how much did I spend on food`.

**A-5 (2026-09-17): a Category resolves through its keywords, and a spend question cannot be scoped to an
income Category.** Two changes, both about the planner reading the taxonomy it was already being handed.

| Decision | Built | Why |
|---|---|---|
| A Category matches on name, breadcrumb **and** its `INCLUDE` keywords | `NamedEntity.keywords`, filled from the same `CategoriesService.list` call (no second read) | The tree's vocabulary already exists and the **capture path classifies with it**: `benzin` is a seeded strong keyword of `Gorivo`, so a typed `benzin 5000` was categorised correctly while *"koliko sam potrošio na benzin"* could not resolve the Category the Household obviously meant. This was the single mechanism behind three of the battery's remaining refusals (`benzin`, `kiriju`, the English `food`), and it is why the fix is one change rather than three. |
| **`EXCLUDE` keywords are never passed** | The filter lives in `assistant.service.plannerContext`, and a spec asserts both directions | An `EXCLUDE` keyword means *this word does not belong here* — docs/04 §5.4 uses one to keep `ulje` out of fuel. Using one to **attract** a question would invert the rule the classifier applies. The filter is at the service because that is where the rows are read; the planner cannot misuse what it is not given. |
| A **name** outranks a **keyword** | A four-tier score: name-exact > name-stem > keyword-exact > **no keyword-stem tier at all** (A-9's rung, made whole-word in A-12) | A name is what the user typed; a keyword is the tree's inference. Without the tiers, a keyword that also appears under a broader Category could steal a question that named a narrower one. A keyword resolves only as a **whole word or contiguous phrase**, which is what stops the seeded `maxi` from matching inside `maksiju` — see §8.13. |
| A spend question scoped to an **INCOME** Category **refuses** | `NamedEntity.kind`, and `hasIncomeCategory` in the cue set | `SPEND_BY_CATEGORY` declares `kind: 'EXPENSE'`, so resolving `Plata` for *"koliko sam potrošio na platu"* produced a confident **`0,00 RSD`** — a plausible figure answering a different question, which is what ADR-017 exists to prevent. The capture path reconciles category against direction in the pipeline's `finish()` (§2.2.7's finding); the planner had **no equivalent**, and now refuses. |
| Refusals about an income entity offer no chip for it | `refusalSuggestions` already filters by routability | The direction gate makes every scoped suggestion about an income Category unroutable, so the filter drops it — and the user is not offered a chip that refuses in turn. Asserted in both the gate spec and live. |

**Verified live 4/4** (`/tmp/verify-a5.mjs`): `na benzin` and `na gorivo` answer with the same Category,
and `na platu` refuses without offering a chip about `Plata`. **The battery is 52 of 58 answerable**
(89.66 %), still gated, and the `benzin` declaration was flipped from *refused* to *answered* as a
reviewed edit — which is what the gate asks for.

> **Named, not fixed (residual of the stem rung):** a five-letter name can still match a **verb** sharing
> its first three letters — `Plata` matches `platim` ("I pay") in *"koliko ću da platim porez"*. The cost
> is bounded and benign: the entity resolves, the question refuses for want of a spend verb or a template,
> and no figure is produced (the spec that asserted an empty `categoryId` on a refusal was corrected —
> resolving an entity and refusing a question are independent, and that resolution is what lets the
> refusal suggest something useful). Tightening the rung to four shared characters would break the
> legitimate matches it exists for (`kafa`/`kafu`, `plata`/`platu`), so it stays as it is, recorded.

**A-4 made the battery part of the build (2026-09-17).** `/tmp/ask-battery*.mjs` was a probe; it is now
`apps/api/src/evals/fixtures/assistant-questions.json` — 57 questions with a **frozen** planner context,
each declaring the intent it must route to and whether it is answerable — and it is gated by
`pnpm test:evals` (`evaluatePlannerGates`, docs/10 §5.9) *and* by `planner-gate.spec.ts` in the fast
suite, which it can be because the planner is pure and needs no database. Two gates: **every question
behaves as declared, in both directions** (a declared-answerable question that refuses fails, and so
does a recorded gap that quietly starts answering — closing a gap is a reviewed edit to the fixture),
and the **answerable share** at ≥ 0.85 as a floor. Measured today: **51 of 57 (89.5 %)**, with the six
gaps printed by the runner beside the reason recorded against each — *a fixture that cannot record a
refusal without saying what it is*.

**A-4b: the fuzzy second rung was built, measured, and rejected (2026-09-17).** docs/16 A-4 proposed
scoring an unmatched question against the registry's own corpus and routing to the best match when it
clears a threshold *and* a margin. It was implemented as a nearest-exemplar scorer over the battery
(token trigrams, cosine) and measured against twelve **held-out** colloquial Serbian questions:
**3 correct, 9 wrong answers**, with winner-runner-up margins of 0.006–0.083 — noise. `koliko mi je
ostalo para na kartici` scored 0.594 against `Koliko mi je ostalo od budžeta?` on `koliko mi je ostalo`
alone and was routed to `BUDGET_STATUS`, while the two words that decide it (`kartici` vs `budžeta`) are
exactly what the two do not share. **A lexical score is dominated by the words two questions share, and
in a money question those are the least informative ones** (`koliko`, `mi`, `je`, `ostalo`, `ovog
meseca`); the cue router already keys on the discriminating noun *and* the entity it resolved to. A rung
that threw that away would answer a *plausible* question instead of the one asked, which is worse than
the refusal it replaces. Recorded in docs/16 A-4 rather than left as an open idea to be re-proposed.

**And the refusal's suggestions were fixed structurally instead (A-4c).** A refusal now offers (1) what
the ledger *can* say about the entity the question named — `kolika mi je penzija` resolves the `Penzija`
Category, so the first chip is *"Koliko sam potrošio na kategoriji „Penzija" ovog meseca?"* — then (2) the
canonical questions **filtered to the ones this Household can actually have answered**. That second half
is a checked contract: `planner-gate.spec.ts` asserts every suggestion routes to a runnable plan in the
context that produced it, so a chip can never lead to a second refusal. Names are quoted and introduced
by a noun rather than inflected, because generating the accusative of an arbitrary Household name is how
a suggestion ends up reading like `na odeća i obuću`.

> **Why the gate is not "answer more questions".** Writing the fixture meant checking what each question
> actually did, and two were answering the wrong one. Both are fixed in the commit before the gate
> (§8.8 item 6), and the fixes took the answered count **down** — 52 → 51 — because a wrong answer
> became a refusal. An answered count rewards exactly the outcome ADR-017 forbids, so the gate is
> *behaves as declared* and the share is only a floor.

### 8.12 Income scoped by Category (task A-9, 2026-09-17)

The registry had **no template that could scope income**. `SPEND_BY_CATEGORY` declares
`kind: 'EXPENSE'` and `INCOME_TOTAL` accepts no `categoryId`, so *"kolika mi je penzija"* refused while
the Household's tree named `Penzija` and the ledger held the figure. Routing it to `INCOME_TOTAL` would
have answered "how much did I earn this month" — a true figure to a different question.

| Decision | Built | Why |
|---|---|---|
| One **new intent**, not a direction-aware `SPEND_BY_CATEGORY` | `INCOME_BY_CATEGORY`, `kind: 'INCOME'`, `shape: 'TOTAL'`, `requiredSlots: ['categoryId']` | The registry declares a direction per template and §8.1 says adding a member is a schema change; making an existing entry's `kind` mean "whichever the Category is" would turn a declaration into a runtime inference, and every `Record<AssistantIntent, …>` in the module (templates, builders, frames, drill routes) fails `tsc` until the new member is handled — which is what caught four missing entries in this very change. |
| The builder is the **same call** with a different `kind` | `this.spend(context, { categoryIds }, 'INCOME')` — no second aggregate | The split-aware `SpendReadModel.byCategory` is one implementation; the direction is an argument to it. `scopePhrase` reads the plan's resolved slot and the `TOTAL_AMOUNT` frame reads `template.kind`, so the sentence *"You received X on Plata"* follows from the registry entry rather than from a branch nobody would remember to update. |
| A **distinct** `sourceQuery` | `income.byCategory.v1`, not `spend.byCategory.v1` | The registry's own test asserts the provenance strings are unique — and it is right to: the string names the *question* the figure answers, and reusing a spend label would tell a reader that an income answer came from a spend query. |
| A **spend verb wins** over the new rule | `spendVerb` is hoisted above the income branch | *"koliko sam potrošio na platu"* names the same Category, and answering the salary would be a wrong figure rather than a scoped one. With a spend verb present the question reaches the spend branch and refuses (A-5's gate). |
| An income question scoped to an **EXPENSE** Category refuses | The mirror of the gate above | *"koliko sam zaradio na hrani"* has no template either, and the unscoped income total would answer a different question. |
| A refusal about an INCOME Category offers an **income** question | `refusalSuggestions` follows the Category's direction | A spend chip about an income Category is unroutable, so the routability filter would drop it and the refusal would say nothing about the entity the user asked about. |

**Two defects this closed on the way, both found by the fixture rather than by a user:**

- **The keyword rung was not actually exact-only.** A-5's rule scored keyword stems lower rather than
  disabling the rung, so `zarada` — a keyword of `Plata` — matched the **verb** `zaradio` on the stem
  `zarad`, and *"koliko sam zaradio ovog meseca"*, the **unscoped** income question, answered the salary.
  The rung is now disabled for keywords (`stemScore: null`); names keep it, because Serbian case endings
  attach to names in a question (`na hranu`, `od plate`).
- **`plati` was not a spend verb.** Only the past tense was listed, so *"koliko ću da platim porez"* was
  read as an **income** question scoped to `Plata` and answered the salary. `plati`/`placam`/`plaćam`
  cover the infinitive and the future/first person without catching the noun `plata`, and they also fix
  *"koliko ću da platim struju"* → `SPEND_BY_CATEGORY`.

**Verified live 6/6** (`/tmp/verify-a9.mjs`) and asserted against Postgres in
`fact-assembly.integration.spec.ts` (a 150.000 RSD salary filed under `Plata` is what
`INCOME_BY_CATEGORY` returns, labelled *Income on Plata*, and the same call scoped to an EXPENSE Category
is a true zero). **The battery is 53 of 58 answerable (91.4 %)** — `kolika mi je penzija` flipped from
*refused* to *answered*, a reviewed edit to the fixture. The five declared refusals that remain are four
gaps — the `x`↔`ks` fold pair, seed content for `kirija`/English, and the income *schedule* question
named below — plus `koliko sam potrošio na platu`, whose refusal is **correct**: `Plata` is an INCOME
Category, so no scoped spend figure exists to give.

> **Named, not fixed:** a question that asks **when** income arrives (*"kada mi sledeća plata dolazi"*)
> still refuses, because `RecurringService.dueSoon` filters `kind: 'EXPENSE'` — an income rule's
> occurrences are not listed anywhere. The refusal now offers the amount question about `Plata`, which is
> the honest thing it *can* answer. Listing income occurrences is a change to `dueSoon` and to the
> `/recurring` screen's own reading, so it is recorded rather than slipped in here.

> **Named, not fixed (A-3b's own residual):** an English question **about a Category** still refuses,
> because the seeded tree is Serbian-named with Serbian keywords — *"how much did I spend on food"* is
> understood as a scoped spend question and the scope resolves nothing. That is a taxonomy-vocabulary
> gap (English keywords or aliases on the seed content, docs/04), not a planner one, and the refusal is
> the correct behaviour in the meantime: answering the month's total would be a wrong answer to the
> question asked. Also still Serbian-only: the six `SUGGESTED_QUESTIONS` a refusal offers, and the
> refusal copy itself (English-only — §5.14's breach, A-7's work).

### 8.13 The `x`/`ks` fold, and why it needed no data migration (task A-10, 2026-09-17)

The last vocabulary gap the battery recorded — *"koliko sam potrošio u Maksiju"* — was a **fold**, not a
cue: `normaliseForMatching('Maxi')` was `maxi` and `'Maksiju'` was `maksiju`, so the two shared only `ma`,
which is not a Serbian case ending, and neither the exact nor the case-ending rung matched. The fix is
docs/04 §3.1's new **Orthography** row: a run of `x` folds to one `ks` (`Maxi` ≡ `Maksi`, `Cineplexx` ≡
`Cinepleks`).

| Decision | Built | Why |
|---|---|---|
| One fold rule, in the shared folder | `.replace(/x+/g, 'ks')` in `foldForMatching` | `x` is not a Serbian letter; it is a typographic variant of `ks`. Both sides of every comparison already pass through this one function, so the substitution is symmetric by construction — no second copy to drift. |
| A **run** of `x`, not each character | `x+` → `ks` | `Cineplexx`'s doubled `xx` is brand styling, not a longer sound. Folding each character gives `cinepleksks`, which matches neither `Cineplexx` nor `Cinepleks`. |
| **No data migration** | Nothing written to the database | Every reader re-folds stored folded text through the current folder — `scoreKeywords`, `resolveEntity`, `evaluateText` — so a row written under the old fold re-folds correctly under the new one. This was expected to need a re-fold and the expectation was **wrong**; docs/04 §8.1.7 is the measurement and names the one lookup (`addKeyword`'s by-value find) that does *not* self-heal. |

**Verified**: `packages/nlp` 152 tests (fold, idempotence, the alias re-fold), `classification.integration.spec.ts`
47 (a stored `maxi` keyword and a stored `univerexport` rule each match under the new fold), and the
battery's `koliko sam potrošio u Maksiju` **flips from refused to answerable** — a reviewed line in the
fixture, taking it to **54 of 58 answerable**. The fold also does what docs/06 §8.8 promised for the
classifier: a typed `Maksi 2000` now resolves the `Maxi` Merchant with zero AI calls (live-verified).

⚠️ **What the fold exposed, and it is not the fold — FIXED in A-12 (§8.14).** Measured live
(2026-09-17), the demo answered *"koliko sam potrošio u Maksiju"* as **`SPEND_BY_CATEGORY`** — not
`SPEND_BY_MERCHANT` as the battery declared. The cause was pre-existing and independent of A-10: the
planner's *exact* tier was `folded.includes(foldedName)` — a **substring** test, not word equality — so
the seeded `Supermarket` keyword `maxi` (folded `maksi`) matched *inside* `maksiju`, the Category
resolved alongside the Merchant, and the router's `hasCategory` branch won. `scopePhrase` preferred the
**Merchant**, so the answer rendered the **Category subtree's** total under the label *"at Maxi"* — a
figure wearing another scope's name, the ADR-017 risk. The same was already true of *"u Lidlu"* (keyword
`lidl` inside `lidlu`). The battery could not see it because its **frozen context did not carry the
seed's merchant-name keywords** — the shipped tree lists `maxi`, `lidl`, `idea`, `dis` on `Supermarket`
(docs/04 §8.1.3) and the fixture listed only `supermarket`, `kupovina`; **the fixture now carries them**,
so the gate covers the collision rather than a convenient version of it. The remaining design question —
which scope wins when a question genuinely names both, and what the label says — is **A-13**
([docs/16](16-assistant-context-and-actions.md)).

> **Named, not fixed:** the idempotency lookup above can leave a Household holding both `maxi` and `maksi`
> as keywords for one Category — the same meaning twice. It is untidy rather than wrong (both re-fold to
> `maksi` and both match), no release step repairs it, and a migration that "re-folded" rows would have
> been a no-op with a false history. Recorded in docs/04 §8.1.7.

### 8.14 The keyword rung was a substring test (task A-12, 2026-09-17)

A-10's live probe found that the planner's **exact** tier was `folded.includes(foldedName)` — a
substring test — while the module's own comment from A-9 claimed "a keyword matches as a **whole word
only**". The implementation and its documentation disagreed, and the difference was a wrong **figure**
rather than a missing one: the seeded `Supermarket` keyword `maxi` matched *inside* `maksiju`, so the
Category resolved alongside the `Maxi` Merchant, `hasCategory` won the route, and `scopePhrase` named the
Merchant — the Supermarket subtree's total under the label *"at Maxi"* (ADR-017). It was already true of
*"u Lidlu"*.

| Decision | Built | Why |
|---|---|---|
| A keyword matches **whole words**, or a **contiguous phrase** | `containsSequence(allWords, keywordWords)` on the keyword path; the name path keeps `folded.includes` and the stem rung | A keyword is a single token the tree lists, and a keyword takes no case ending. A name is different in kind: Serbian endings attach to it in a question (`na hranu` → `Hrana`, `od plate` → `Plata`), so names keep both rungs. The phrase form exists because the seed has multi-word keywords (`elektricna energija`), and a phrase has to match **in order**. |
| Two tokenizations | `allWords` (every token) feeds the keyword rung; `words` (≥3 characters) feeds the stem rung | The keyword rung must see one- and two-character tokens; the stem rung never should. |
| A keyword that folds to nothing never matches | `containsSequence` returns `false` for an empty needle | Otherwise an empty sequence is vacuously "contiguous" and that keyword would resolve every question in the Household. |

**The trade-off, asserted rather than discovered.** `benzina` no longer reaches `Gorivo`: the keyword is
`benzin`, a keyword takes no case-ending rung, and the Category's *name* is `Gorivo` — so *"na goriva"*
still resolves while *"na benzina"* refuses. That is the rule A-9 chose, now actually implemented, and a
question that resolves nothing **refuses**, which ADR-017 prefers to answering a different question.
`query-planner.spec.ts` asserts all three directions: the collision is gone (`Maksiju` and `Lidlu` both
answer `SPEND_BY_MERCHANT` with no Category slot), a multi-word keyword matches in order but not out of
order, and the inflected keyword form refuses.

**The battery's blind spot is closed with it.** The fixture's frozen context now carries the seed's
merchant-name keywords (`lidl`, `maxi`, `idea`, `dis`, `univerexport`, `shopgo` on `Supermarket`), so the
gate tests the collision instead of a context that happens to avoid it — `koliko sam potrošio u Maksiju`
passes because the **Merchant** wins, not because the Category was absent.

**Verified**: `query-planner.spec.ts` 71 tests, the battery 58/58 declarations, and **live 5/5**
(`/tmp/verify-a12.mjs`): `u Maksiju` and `u Lidlu` both answer `SPEND_BY_MERCHANT` with
`spend.byMerchant.v1` and `scope: at Maxi` / `at Lidl`; `na benzin` still resolves `Automobil / Gorivo`;
`na benzina` refuses (the trade-off); and the classifier still resolves `Maksi 2000` to a `Maxi` Merchant
with no AI call. ⚠️ The demo's `Maksiju` figure is `0,00 RSD` where the Category answer was
`102.200,00` — **not** a scoping error. The demo holds **two** `Maxi` merchant rows (a pre-existing data
duplicate, like the leftover `Test Hrana P1` category): the classifier resolved `01a0a539…`, whose row its
spend is attributed to, while the planner's deterministic id tiebreak picks `01a09f3e…`, which has none.
`spend-read-model.ts` filters by `merchant_id`, so a merchant with no rows is correctly zero — and the
pre-A-12 answer was the *Category's* total wearing the Merchant's name, which is the defect this fixed.

### 8.15 The label now follows the routed scope (task A-13a, 2026-09-17)

A-12 removed the collision when a Category matched only by a *shared keyword*. One way a figure could
still wear another scope's label remained, and it is structural rather than a matcher bug:
`planQuestionCore` fills `slots` from **every** entity the question resolved, whether or not the routed
template uses it (query-planner.ts, the `slots` literal). So *"na hranu u Lidlu"* arrives with a
`categoryId` **and** a `merchantId`, the router picks `SPEND_BY_CATEGORY`, `spend()` aggregates the
Category subtree — and `scopePhrase` preferred the Merchant, printing the Category's total as *"at
Lidl"*.

| Decision | Built | Why |
|---|---|---|
| The phrase is chosen by the **template's required slot**, not by which slots are filled | `context.plan.template.requiredSlots` gates each branch of `scopePhrase` | The phrase must name the scope `spend()` **aggregated by**; both read the declaration, so they cannot disagree. A label is a claim about a figure, and a claim that is merely *plausible* is the ADR-017 failure mode. |
| `SPEND_TOTAL` keeps no scope | Its `requiredSlots` is `[]`, so the phrase is `null` and the label is `Spending` | It resolves no scope by construction — the router only reaches it when no Category, Merchant, Account or Tag resolved. The optional `accountId`/`tagId` on its template belong to other templates that share the aggregate. |
| Trend builders are unaffected | `trendVsLastMonth` / `trendVsAverage` discard `spend()`'s label and build their own `formatted` | Their figures are unnamed by design (*This period* / *Previous period* / *Change*), so the phrase was never rendered. |

**Verified** in `fact-assembly.integration.spec.ts`: a plan carrying **both** a `categoryId` and a
`merchantId` labels `at Lidl` under `SPEND_BY_MERCHANT` and `on Hrana` under `SPEND_BY_CATEGORY`, and the
test asserts the two totals **differ** — which is what made the mislabel a wrong answer rather than a
cosmetic one. **Live 4/4** (`/tmp/verify-a13a.mjs`): *"koliko sam potrošio na hranu u Lidlu"* routes
`SPEND_BY_CATEGORY` and says **`on Test Hrana P1`** — the Category whose total it printed, and the demo's
leftover test Category that `na hranu` resolves to — where it used to say *"at Lidl"*; the Category-only
and Merchant-only controls still say `on` and `at` respectively.

> **Still open, and it is a product decision (A-13b):** the label is now honest. Which scope a question
> that names **both** actually *means* — `na hranu u Lidlu` could be the intersection, the Merchant, or a
> refusal for being ambiguous — is a product question no matcher fix answers.
> [docs/16](16-assistant-context-and-actions.md) A-13 carries it for the owner.

### 8.16 The assistant may propose a write; only a click executes it (task B-2a, 2026-09-17)

The owner's request had two halves, and this is the second one: *"and even do actions in app — let's say
to configure or add records, let's say add category name something and it does it"*. ADR-017 governs what
a narrator may **say**; it says nothing about what the assistant may **change**, so Part B needed its own
decision — **ADR-035**, which Q-11 answered on 2026-09-17. This section is that decision implemented.

| Decision | Built | Why |
|---|---|---|
| **Propose** is a `Query`; **execute** is the only `Mutation` | `assistantProposeAction(question, kind, locale)` and `assistantExecuteAction(proposalId, idempotencyKey)` | Proposing writes nothing to the ledger — it stores a proposal — so it is a read at the edge, exactly as `captureParse` is. Making it a `Mutation` would tell a client that asking changes state. |
| The confirmation carries **only** the proposal id | The execute mutation takes no arguments for the action | This is the load-bearing line. The server re-reads **its own** stored proposal, so the executed action is byte-for-byte the action the human saw, and the "the arguments changed between preview and execute" class of bug cannot exist. |
| A **closed registry**, `Record<AssistantAction, ActionTemplate>` | `assistant-actions.ts`; one member, `ADD_CATEGORY` | Adding an action is three compile-time edits (the union, the template, the executor `Record`). There is no `default:` arm, so "the model called something nobody wrote" fails `tsc` — ADR-017's argument, applied to writes. |
| The action names a method the **UI already calls** | `ADD_CATEGORY` → `CategoriesService.create`, the same call `createCategory` makes | The assistant gets no privilege the screen lacks: same service, same `TenantContext`, same validation, same audit. `registeredMutations()` is asserted in the registry spec. |
| **No auto-apply, at any confidence** | There is no code path from a question to a write | ADR-009's gates classify a *categorisation*; a write is not a classification. Recorded as a constraint so it is not quietly relaxed. |
| The duplicate check runs at **propose** time | `assertNameFree`, against the same rule the index enforces | A confirm button for a write that will fail is a lie the card does not need to tell. The check is `lower(name)`, **not** the fold: refusing a write the index would permit is a different bug from offering one that fails. |
| A **`text` slot** the planner extracts from the question | `action-planner.ts`, taking the name from the **raw** tokens | A name is display text the user invented; folding it would store `rodendan` because somebody typed `Rođendan`. Cues are matched on folded tokens, the name is sliced from raw ones — which is also what keeps a Cyrillic name Cyrillic. |
| A proposal lives in **Redis**, short TTL, **consumed atomically** | `pending-action.store.ts`; `GETDEL`, 600 s | Redis is already running (ADR-004), so this adds no datastore under rule 9. `GETDEL` is the whole concurrency story: two confirms racing on one proposal cannot both see it, so a double-click cannot create two Categories. |
| Execution is **idempotent per `idempotencyKey`** | The outcome is remembered against the key before the proposal is consumed | A retry after a timeout must not create a second row *or* report failure for a write that happened. The worst case is then "expired" for a write that did not happen. |
| The card is **backend-rendered**, per language | `renderPreview`; one sentence and a field diff, `sr`/`en` | A write confirmation is a numeral-bearing statement, so ADR-017 applies to it as to an answer — the model never describes a write. The two phrasings sit beside the action rather than in a catalogue, because the API has none yet (§5.14) and a confirmation is the one sentence worth not shipping English-only. |
| `VIEWER` is refused | The resolver's rank check against the template's declared role | `ADD_CATEGORY` declares `MEMBER`, which is what the UI allows. **This is the first write path that refuses a `VIEWER` at all** — see the gap below. |

**`proposed: false` is a refusal, not an error** — the shape `assistantAnswer`'s `answered: false`
established. `NOT_AN_ACTION` means the question asked for nothing this registry does (most questions
are reads, and the action planner runs first); `UNRUNNABLE:name` means the request was unmistakable but
did not say what to create, which asks the user rather than writing something nobody specified. A name
that is empty, over 80 characters, or already taken **does** throw (`VALIDATION_FAILED` / `CONFLICT`),
because those are failures of a request the user made, not refusals to answer a question.

**`ADD_TRANSACTION`, and the one contract change it forced (task B-3a, 2026-09-18).** The second
action reaches the capture path by a question — *"dodaj trošak kafa 180"*, *"unesi transakciju Lidl
2000"*, *"dodaj kafu 180"* — and inherits the whole pipeline rather than re-implementing any of it:
`ClassificationService.parse` at **propose** time (the audit row and the cost, `captureParse`'s own
call), and `TransactionsService.captureCommit` at **execute** time, with `acceptedProposalId` pointing
at the decision the card showed. So the pipeline runs once, the category the human approved is the
category stored, `allowAi: false` states the same thing from the other side, I-3 is enforced where it
always is, and a blocking row is written `PENDING` into the review queue exactly as `/capture` does.

| Decision | Why |
|---|---|
| **`assistantProposeAction` is now a `Mutation`** | Proposing a transaction runs the classifier, which records a `classification_decisions` row and may call a model. `captureParse` is a Mutation for precisely that reason, and the operation type must cover an operation at its worst — a Query that spends money is a lie about itself. The client's only change is the document keyword. |
| The card carries **`lines`** — structured rows, not prose | `label`, `amount` (the **`Money` scalar**), `category`, `occurredOn`, `needsReview`. The amount is minor units because the client renders every figure through `fm-money` (ADR-003); a pre-formatted *"180,00 RSD"* inside the sentence is a number no money component ever sees. The **sentence stays** and still carries the amount, because a value the store holds as a string (a `bigint` cannot be JSON) is what makes the confirmation readable on its own. |
| The proposal stores **`args`**, apart from `slots` | A slot is something a question states or a card may change (`kind`, `accountId`); an arg is an output of the parse — the amount, the decision id, the row's own idempotency key. Merging them would let a card's diff reach for a value and a value's edit path reach for a slot. |
| **One row**, and `MULTIPLE_ROWS` is a refusal | A batch needs per-row editing (categories, amounts, removals) that a confirmation card does not have, and showing only the first of three would be a card that misdescribes what the button does. The capture screen is the surface for more than one. |
| `NO_AMOUNT`, `AMBIGUOUS_AMOUNT`, `UNRUNNABLE:accountId` | The first is the parser finding nothing to record. The second is `1.200`, which is 1200 **and** 1.2 — the capture screen refuses the whole batch until a human picks, and a card cannot ask, so it must not guess (ADR-003). The third is a Household with no account: a slot nothing on the card could fill. |
| The **account** is filled and flagged `defaulted` | It is the account `/capture` preselects (newest live), which means the rule is duplicated — and a duplicated guess is only safe when it is *visible and changeable*, which is what the flag plus `assistantProposeAction`'s `accountId` argument make it. |
| The **kind** is flagged `defaulted` only when the text stated none | `storno 5000` has no direction, so the proposal picks the capture path's default and offers the toggle. A `defaulted` flag records that the **question** never said — so it stays true after the toggle is used, or the choice would be one-way. |
| `undo: 'UNDO_CAPTURE'` | `undoCapture([id])`, docs/02 §3's undo toast. The client's `undoPlan` refuses an undo it has no mutation for, so an action this client cannot take back offers no control. |

⚠️ **The cue list is matched against *folded* tokens, and the fold maps `x` → `ks`** (A-10). The English
object word therefore had to be written `ekspense`: `expense` matched nothing, and the rung fell through
to the amount anchor, producing the text `expense coffee 180`. Found by a planner test that asserted the
text of *"add expense coffee 180"* — a cue list that looks right and never fires is the quietest kind of
broken (docs/15).

⚠️ **Residual, stated rather than fixed:** the promised *"Lidl 2000"* shape — the fragment with no verb
at all — is **not** an assistant action. A bare fragment is the capture screen's signature interaction,
and matching one here would turn every unanswerable question containing a number into an offer to write.
The assistant needs an imperative; `dodaj kafu 180` and `dodaj trošak kafa 180` are the two shapes it
takes.

**`SET_BUDGET`, and the two things it had to decide (task B-4a, 2026-09-18).** The third action sets a
spending limit: *"postavi budžet za hranu na 20000"*, *"dodaj budžet za gorivo 8000"*, *"postavi limit za
benzin na 9000"*. Two decisions shaped it, and neither is a detail.

**1 · The slots are *resolved*, not invented — by the ladder that answers questions.** The Category comes
out of the phrase through `resolveEntityIn`, which is `matchEntity` — the same rungs, the same scoring,
the same name/breadcrumb/`INCLUDE`-keyword vocabulary the read planner uses, now shared through
`planner-entities.ts`. The amount comes from `extractFragment`, the capture path's own reader, so `1.200`
is refused as `AMBIGUOUS_AMOUNT` rather than guessed. The consequence is the property that matters and is
asserted live: **the budget scopes exactly the Category the answer beside it names**.

| Decision | Why |
|---|---|
| The action **creates and refuses to overwrite** | ⚠️ The undo is what forces this. `upsertBudget` would happily change an existing limit, but no operation in this build *restores* the previous amount — `deleteBudget` would destroy the budget the user already had. ADR-035 decision 7 says an action whose undo does not exist is not offered, so v1 offers the creation, refuses the change with `ALREADY_SET`, and names `/budgets` in the refusal. The trigger to revisit is a restore-shaped undo, which is its own task. |
| A phrase naming no Category the tree can resolve is a **refusal** (`UNRUNNABLE:categoryId`) | A Household-wide budget exists (`categoryId: null`, the one that drives safe-to-spend) and is deliberately **not** reachable here: a typo in a Category name would otherwise become a limit over every Category, which is R-29's wrong write. `/budgets` sets it explicitly. |
| The period is a **fixed** part of the action, not a default | It sets the monthly budget. Marking it `defaulted` would promise a control the card does not have; saying it in the sentence and the diff is honest about what the action means. Weekly/yearly limits are not reachable from here. |
| `afterMoney` on a diff row | A limit is an amount, and an amount the client prints from a string is a figure no money component ever sees (ADR-003). A row with `afterMoney` is drawn by `fm-money`; the string in `after` stays for the sentence. |
| The object word **beats another action's amount rung** | `planAction` now tries *every* action's object rung before *any* amount rung. Without that, *"dodaj budžet za hranu 20000"* matched `ADD_TRANSACTION`'s verb-plus-number rung (its imperative `dodaj` plus the amount) and proposed an entry whose description was the word *budžet*. The rule is stated in the code rather than left to the declaration order of the cue table. |

**2 · A command is not a question — and that is a fix to B-2b's ordering, not a reversal of it.** B-2b
made the client ask `assistantAnswer` first and offer a card only on a refusal, so that a question the
ledger *can* answer is never turned into an offer to write. But *"postavi budžet za gorivo na 7000"*
names a Category the spend planner can scope, so it came back as **a spend figure** — and the budget card
never appeared at all. Found by the browser pass; every API test had asked the proposal endpoint directly,
so nothing exercised the ordering between the two paths. `AssistantService.answer` now consults
`planAction` first and refuses with `reason: 'ACTION_REQUEST'` when the question is an unmistakable
command, with **no** suggestion chips (the card below it *is* the answer). The card still appears only on
a refusal — what narrowed is what a refusal *is*: there is no question in a command. The battery is
unaffected (54/58, same share), which is the gate that would have caught an over-eager cue list.

⚠️ **A named residual, measured, not fixed: the matcher's tie-break picks the *longest* name that shares a
stem, and a junk Category can win.** The demo Household carries a leftover probe Category named
`Test Hrana P1`, and *"hranu"* resolves to **it** rather than to `Hrana` — the stem rung scores both
equally and the longer name breaks the tie. That is pre-existing behaviour that affects **reads too** (a
spend question scoped by *"hranu"* uses the same Category), it is consistent between the two paths (which
is why the live probe asserts *consistency* rather than a name), and the demo data is left alone rather
than tidied. The refinement — prefer a match whose every name token is present over one only partially
matched — changes the battery-gated read path and belongs in its own task ([15](15-implementation-gotchas.md)).

**`ADD_GOAL` (task B-4b, 2026-09-18).** *"napravi cilj Letovanje 200000"*, *"dodaj cilj Letovanje 200000"*,
*"postavi cilj štednje 500000"*. This is the one action whose **name is not taken from an anchor**: the
text is the name and the amount together, the parser removes the amount, and what is left is the name —
`cleanName` (now shared with the category action) strips wrapping quotes, trailing punctuation and a
leading connector, and **nothing folds it**, so `Rođendan` stays `Rođendan` and `Путовања` stays
Cyrillic. The target is `extractFragment`'s reading, so `1.200` is refused as `AMBIGUOUS_AMOUNT`.

Three things are deliberately narrower than `createSavingGoal` itself:

| Decision | Why |
|---|---|
| **No target date**, and the card *says* so (`targetDate: "još bez roka"`, `defaulted: false`) | Relative dates have no parser ([16 B.3](16-assistant-context-and-actions.md)) — *"sledeći petak"* is not read anywhere in this build — so the action cannot honestly fill one. The diff row states the fact rather than offering a control the card cannot drive, and the integration spec asserts the consequence the reader will meet: `requiredPerMonthMinor` is `null` until `/goals` gets a deadline, because `GOAL_REQUIRED_MONTHLY` needs one to work anything out. |
| **No Account** | `createSavingGoal` accepts one; a goal does not need it, and the card would have to offer a picker for a field the question never implies. `/goals` sets it. |
| A target with **no name** is a refusal (`UNRUNNABLE:name`) | `"napravi cilj 200000"` has an amount and nothing to call it. That is the same distinction the category action draws: a missing slot is a question for the reader, while a name that is too long is a failure of a request they made. The shared `requireName` now takes the noun, so a goal is not told its *category* name is too long. |

**`ADD_TAG` (task B-4c, 2026-09-18).** *"dodaj tag Odmor"*, *"napravi oznaku Rođendan"*, *"add a label
Travel"*. The last of the three name-shaped actions: the category action's shape, a verb and then the
object, with the object list carrying `tag`/`oznaka`/`label` and their inflections. The name is whatever
follows the object, and `amountAnchor: false` keeps a bare *"dodaj tag 2"* from creating a Tag called `2`.

**Its one interesting property is that the Category action's duplicate rule is the wrong rule here**, and a
copy of it would have offered a doomed button:

| | `ADD_CATEGORY` | `ADD_TAG` |
|---|---|---|
| The write's rule | `categories_unique_name` compares **`lower(name)`** | `TagsService.assertNameFree` compares **`normaliseForMatching(name)`** — the fold |
| What that means | `Hrana` and `hrana` collide; `Храна` does not collide with `Hrana` | `Путовања` **and** `Putovanja` are one Tag, because the fold transliterates |
| The propose-time check | `assertNameFree` (`lower`) | `assertTagNameFree` (the fold) |

This is ADR-035 decision 5 in the small: the preview must check the rule the write enforces, or the card
offers a Confirm button for a call that cannot succeed. The integration suite asserts the discriminating
case — a Cyrillic Tag exists, its Latin spelling is refused — which is a pair `lower` cannot equate. Two
things came out of writing it down, both recorded in [15](15-implementation-gotchas.md): the fold maps
`đ` → `d` and leaves the digraph `dj` alone (so `Rođendan`/`Rodjendan` is *not* such a pair — the `đ`/`ђ`
asymmetry docs/04 §8.1.7 already owns), and a duplicate reaches the client as a **GraphQL `CONFLICT`
error**, not as a `proposed: false` reason, because only an `UnrunnableSlot` becomes a refusal.

Three smaller decisions:

- **No colour.** `/tags` can set one; the question never states one, and unlike a goal's missing deadline a
  colour changes nothing the reader needs to weigh. So `defaultedSlots` is empty and the diff is one row.
- **The undo is `deleteTag`** — a hard delete that cascades its assignments, which is correct *because* the
  row this action creates has none yet.
- **No Account, no Category, no amount** — the slot whitelist is `['name']`, so a client cannot inject one.

⚠️ **The card's `CONFLICT` sentence named a Category, and B-4c made that a lie.** The copy existed for the
category action (*"A category with that name already exists"*, `assistant.action.taken`) and was rendered
from the error code alone — and the error carries no action, so a refused **Tag** was announced as a
category the reader would then go looking for. It now names no noun. The browser pass asserts it.

**The transaction card (task B-3b, 2026-09-18).** `lines` is what the card draws: each row's text, its
amount **through `fm-money`**, the Category the pipeline chose, the day it will be filed under, and — when
the confidence gate will file it — that it goes to the review queue. The sentence stays above it, so the
amount is readable even before the rows are. Two consequences worth stating:

- **The account is a control, not a statement.** When the diff's `accountId` row is flagged `defaulted`,
  the card fetches the Household's live Accounts (lazily, once, and only for a card that offers it) and
  renders a picker whose change re-proposes with that `accountId`. That is what makes duplicating
  `/capture`'s preselection rule safe rather than silent — a guess the reader can correct. An archived
  Account is never offered, and a failed list leaves the row showing the Account the server named with no
  control at all, because a *convenience* control that cannot work must not become an error on a
  confirmation the reader can already make.
- **The archived-Account filter and the picker are the client's only account logic.** Which Account the
  proposal fills is the server's decision (`defaulted`), so the two cannot disagree about what the row
  says.

**The card, and the ordering it needed (task B-2b, 2026-09-17).** `/assistant` renders the proposal
after the answer, and **only after a refusal** — the client asks `assistantAnswer` first, and asks
`assistantProposeAction` only when `answered: false`. The order is the second line of defence behind the
cue list: a question the ledger can answer is never turned into an offer to change something, and no
proposal is created that nobody sees. The cost is one extra round trip on a refusal and none on the
ordinary path. The card itself: the server's sentence, the diff rows, a **`kind` toggle** offered only
where the server flagged the row `defaulted`, a **Confirm** button, the TTL rendered as a local clock
time, and — after the write — the returned row's sentence plus an **Undo** that calls `deleteCategory`,
the same mutation `/categories` calls.

Three things the card needed from the contract, each because a *label* cannot do a *control's* job:

- **`slot`** on each diff row. `field` is localized (`naziv`/`name`), so a card that has to attach a
  control to one row cannot identify it by name. ⚠️ **GraphQL serialises a string enum by its member
  *key*, not its value** — the first version declared `KIND = 'kind'` and the wire carried `"KIND"`, so
  the toggle silently never matched; the live pass caught it and the members are now named after their
  values ([15](15-implementation-gotchas.md)).
- **`afterValue`** on each row: `after` in the machine's vocabulary (`EXPENSE`/`INCOME` for `kind`),
  because the toggle has to know which kind is *currently proposed* without comparing the Serbian word
  `rashod` against a client-side copy of the API's vocabulary.
- **`expiresAt`**, so the card can say when the offer lapses rather than letting a `NOT_FOUND` be a
  mystery. A `NOT_FOUND` on confirm is handled as exactly that — R-29's *"a proposal lapses between
  render and click"*: the card stops offering a button that cannot work, and says why. Every other
  failure keeps the offer, because an unreachable server never reached the proposal and the same
  `idempotencyKey` is the right thing to send again.

⚠️ **A known limit of the re-propose design, measured live.** Re-proposing with the other `kind` stores a
**second** proposal; the first is not revoked, it merely expires. The card only ever shows the newest, so
the UI cannot confirm the stale one — and if anything did, the write is refused by the index
(`CONFLICT`, verified), not silently duplicated. Stated rather than fixed: revoking the superseded id
would need the store to track a lineage the design deliberately does not have.

⚠️ **A residual, not a defect:** a Category created here does not refresh the offline `taxonomy` cache
until `/capture` next reads the category list. The staleness is bounded by that screen's own mount, and a
missing picker entry is not a wrong write — unlike R-27(a2), which this deliberately does not repeat.

**A cue list is a heuristic, and B-2b measured it before rendering anything.** The action planner runs
*before* the read planner, so a word in its vocabulary is a word that means the action wherever it
appears. Listing the attributive adjectives `nova`/`novu`/`novi`/`novo`/`new` as verbs planned
*"koja je nova kategorija najveća"* as a request to create a Category named `najveća` and *"koliko sam
potrošio na novu kategoriju hrana"* as a write **beside** the `SPEND_BY_CATEGORY` answer it should have
got; English `make` did the same to *"make a report of spending by category"*. Two rules now separate
them, and both are tested in `action-planner.spec.ts`: an **imperative** counts anywhere before the
object (a request is still a request when it is asked — *"can you create a category Travel"*), while an
**adjective-only** request shape counts only as the question's **first** token (*"nova kategorija Hrana"*
is the whole request). `make` was dropped rather than rescued — a missed proposal is a refusal the user
retries, a wrong proposal is an offered write (R-29). The measurement, and the second line of defence
that the read planner answers first, are in [15](15-implementation-gotchas.md).

**Verified**: `action-planner.spec.ts` 10, `pending-action.store.spec.ts` 6, `assistant-actions.spec.ts`
4, `assistant-action.resolver.spec.ts` 5, `assistant-action.integration.spec.ts` 8 (a real Postgres: the
approved action writes the Category through the same service the screen uses, a repeated idempotency key
replays one row, a consumed proposal cannot be executed again, another Household's proposal is
unreachable, and the duplicate rule the preview checks is the one the index enforces). **Live 8/8**
(`/tmp/verify-b2a.mjs`): propose → confirm → the Category is in the tree → a retry replays the same id →
a different key is refused → a read question proposes nothing → a nameless request is refused with the
slot → the probe row was removed again.

**B-3a verified**: `action-planner.spec.ts` 14 (the transaction cues, the amount anchor, and the
`ADD_CATEGORY`-wins-its-own-question precedence), `assistant-actions.spec.ts` 6, `assistant-action.resolver.spec.ts`
7, `assistant-transaction.integration.spec.ts` **10** against a real Postgres — propose writes nothing, the
write goes through `captureCommit` and **reuses the decision it showed** (asserted by counting
`classification_decisions` across propose+execute: one, not two), a repeated idempotency key replays one
row, `MULTIPLE_ROWS` / `NO_AMOUNT` / `AMBIGUOUS_AMOUNT` / `UNRUNNABLE:accountId` are refusals rather than
errors, a stated direction is not flagged `defaulted` while an unstated one is (and stays so after the
toggle, which is what keeps the control on the card), a named account wins over the preselected one, and
an account from another Household is refused before a button is offered. Both integration suites build
the service **from `AssistantModule`**, with only the store overridden, so a missing module import is a
boot failure rather than a surprise.

**B-4a verified**: `action-planner.spec.ts` 16 (the budget cues, and the two-pass rung rule against the
case that motivated it), `assistant-actions.spec.ts` 8, `assistant-budget.integration.spec.ts` **9** against
a real Postgres — the Category resolved through the tree's own vocabulary, the amount as `Money` on the
wire, the row written through the same `upsertBudget` `/budgets` calls, the existing budget **refused and
left untouched**, the three refusals by name, and the replayed idempotency key — plus
`assistant.integration.spec.ts` 26 (a command refused as `ACTION_REQUEST` with no chips, and a question
naming the same Category *not* refused for being a command). API **1101**, web **910**, **2824 total**,
lint 9/9, typecheck 9/9, `api:evals` green (battery 54/58, share 93.10 %), `web:build` + `bundle:budget`
ok. **Live 16/16** (`/tmp/verify-b4a.mjs`): the proposal's shape, the row it writes, the read/write
consistency check (the budget's Category id equals the one the answer names), the refusal to overwrite
with the existing amount unchanged, the three refusals, the rung precedence both ways, and the probe's own
budget removed. **Browser 16/16** (Playwright on `:4200`): the card with its three fields and the limit in
`fm-money`, the Category and period named, nothing flagged as a guess, 0 horizontal overflow at
320/768/1280 px, axe **0 critical / 0 serious**, the confirm landing on `/budgets`, the second ask refused
with the command sentence *and* the exists sentence, no proposal card offered for it, the budget visible on
`/budgets`, no page error. The probe's budget was deleted; the demo's own is untouched.

⚠️ **A second finding from the same pass, and the same class as B-3a's enum:** the card's GraphQL document
never selected `afterMoney`, so the budget card drew the server's **label string** instead of `fm-money`
while every unit test passed — the fixtures supplied the field the real query did not ask for. The field is
selected now, `PROPOSE_ACTION` is exported, and a spec asserts the document asks for **every field the card
reads**, which is the guard a fixture cannot be.

**B-4b verified**: `action-planner.spec.ts` 17, `assistant-actions.spec.ts` 9,
`assistant-goal.integration.spec.ts` **7** against a real Postgres (the name and target out of one text,
the amount as `Money` on the wire, the deadline stated and the monthly requirement consequently absent, a
Cyrillic name kept Cyrillic, the three refusals by name, and the replayed key), plus the client's
`assistant.view.spec.ts` 43 and `assistant.component.spec.ts` 39 (corrected by B-4c — the row said
44/38; see below). API **1110**, web **912**, **2835
total**, lint 9/9, typecheck 9/9, `api:evals` green (54/58, 93.10 %), `web:build` + `bundle:budget` ok.
**Live 15/15** (`/tmp/verify-b4b.mjs`) and **browser 14/14** (Playwright on `:4200`, screenshots in
`.artifacts/visual-audit/b4b-goal-*.png`): the card with its target in `fm-money` and its missing deadline,
0 horizontal overflow at 320/768/1280 px, axe **0 critical / 0 serious**, the confirm landing on `/goals`,
the undo removing it, and the probe's goal deleted so the demo is as it was found.

**B-4c verified**: `action-planner.spec.ts` 18, `assistant-actions.spec.ts` 10,
`assistant-tag.integration.spec.ts` **5** against a real Postgres — one name row and nothing filled, the
row written through the same `TagsService.create` `/tags` calls with no colour, a Cyrillic name kept
Cyrillic **and its Latin spelling refused** (the fold, told apart from `lower`), the nameless request
refused with its slot, and the replayed idempotency key — plus the client's `assistant.view.spec.ts` 43 and
`assistant.component.spec.ts` 41. API **1117**, web **914**, **2844 total**, lint 9/9, typecheck 9/9,
`api:evals` green (54/58, 93.10 %), `web:build` + `bundle:budget` ok. **Live 19/19**
(`/tmp/verify-b4c.mjs`): the card's shape, the sentence in the screen's own vocabulary, the stored row with
no colour, the Cyrillic/Latin pair, the `UNRUNNABLE:name` and `NOT_AN_ACTION` refusals, the replayed key
against a different one, and every probe Tag removed. **Browser 22/22** (Playwright on `:4200`, Serbian
locale, screenshots in `.artifacts/visual-audit/b4c-tag-*.png`): the card with its one row and **no** money
row, picker or guess flag, 0 horizontal overflow at 320/768/1280 px, axe **0 critical / 0 serious**, the
confirm by keyboard alone, the link to `/tags`, the Tag visible on that screen, the duplicate ask rendered
with the noun-free sentence, the undo naming an *oznaka*, the Tag gone from `/tags`, and no uncaught page
error.

⚠️ **Two corrections this task owes the record.** (a) The B-4b row below claimed
`assistant.view.spec.ts` **44** and `assistant.component.spec.ts` **38**; the commit those numbers describe
holds **43** and **39** (they sum to the same 82, which is why nothing caught it). (b) The Serbian card said
`Novi tag` while every Serbian screen calls the entity an **oznaka** (`nav.tags` and `tags.title` are
`Oznake`, the create sheet says `Nova oznaka`) — found by the browser pass, in the same class as B-4a's
unselected `afterMoney`: a unit fixture supplies the sentence, so it can agree with itself while the server
says something else. The cue list keeps `tag` **and** `oznaka`, because that is about what a *question* says.

**B-3b verified**: `assistant.view.spec.ts` 41 and `assistant.component.spec.ts` 33 — `previewLines`
reading `undefined` as none (a proposal stored before the field existed), `accountRow` refusing a row with
no machine value, `dayLabel` shared with the provenance range so one day cannot be formatted two ways, the
rows and their amount through `fm-money`, the review note, the picker offering **live** Accounts only and
re-proposing with the chosen one, no picker — or query — when the question named the account, and the
per-action result half. **Browser 19/19** (Playwright on `:4200`): the card under the refusal with its row
and the amount in the money component, the Category and the day, the picker listing the Household's
Accounts and re-proposing with the chosen one, the confirm writing the row to that Account, the entry
appearing on `/transactions`, the undo removing it and saying which list it left — 0 horizontal overflow
at 320/768/1280 px, axe **0 critical / 0 serious** with the card on screen, and no uncaught page error.

⚠️ **The browser pass found the gap this task existed to close**: the confirmed Transaction offered **no
Undo at all**, because `undoPlan` knew only `SOFT_DELETE` while `ADD_TRANSACTION` declares
`UNDO_CAPTURE` — a control the unit tests could not miss but never asked for. It is fixed here, per
action: `undoCapture(transactionIds: [id])` for a Transaction against `deleteCategory(id)` for a
Category, the sentence naming which list the row left, and the result link going to the
`/transactions/:id` drill-in rather than to a list the reader then has to search.

**B-2b verified**: `assistant.view.spec.ts` 36 and `assistant.component.spec.ts` 28 (the ordering, the
confirm arguments, the key's stability across a repeat and its replacement on a re-propose, the toggle's
absence when the row is not `defaulted`, the undo's mutation and id, the collision copy, a lapsed offer
against a retryable failure). API **1069**, **2776 total**, lint 9/9, typecheck 9/9, `api:evals` green
(battery 54/58 answerable, every gate passed), `web:build` + `bundle:budget` ok. **Live 19/19**
(`/tmp/verify-b2b.mjs`, over HTTP against the real API): the diff's `slot`/`afterValue` reach the wire in
the registry's own vocabulary, a re-propose replaces the id and the card, the confirmed row has the kind
that was *confirmed*, the superseded proposal cannot duplicate the row (`CONFLICT`), the undo removes it,
and the three cue regressions plus the two request shapes that must keep working all behave. **Browser
22/23 + 2/2** (Playwright against `:4200`): the card renders under the refusal with its diff and the
defaulted flag, no horizontal overflow at 320/768/1280 px, axe **0 critical / 0 serious** with the
proposal *and* the result card, the toggle and the confirm both driven **by keyboard**, the write lands in
`/categories`, the undo removes it — and the single failure was the probe's own wrong expectation (the
`/categories` screen opens on the **EXPENSE** tree, so an INCOME category is not in the first list it
renders; the follow-up check found it under the INCOME segment). Screenshots are in
`.artifacts/visual-audit/b2b-*.png` for the human pass.

> **Named, not fixed — and it is an authorisation gap, not an assistant one.** `MemberRole` declares
> `VIEWER`, and **nothing enforces it**: `createCategory` — like every other taxonomy write — carries no
> role guard, so a `VIEWER` can write through the UI today. The assistant refuses one because the
> registry declares a role; the two surfaces therefore disagree, in the safe direction. Closing it means
> a guard on the write mutations and a decision about what a `VIEWER` may do at all, which is its own
> task rather than something to slip into a registry.

---

## 9. REST surface

Deliberately small. Every route below is either binary, third-party, or infrastructure. There is **no**
REST CRUD.

### 9.1 Endpoint summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/files/presign` | Bearer access token, role ≥ `MEMBER` | **Implemented (4.1.1).** Allocate an attachment row + return a presigned `PUT` URL |
| `PUT` | *(presigned URL)* | Presigned signature only | Direct browser/device upload to object storage |
| `GET` | `/v1/files/:id` | Bearer access token, role ≥ `VIEWER`, household match | **Implemented (4.1.1).** `302` to a short-lived presigned `GET` URL; `409` while the row is not linkable (§9.4) |
| `POST` | `/v1/webhooks/ocr` | HMAC-SHA256 signature header | OCR provider completion callback |
| `GET` | `/health` | **None** | Liveness: process is up |
| `GET` | `/health/ready` | **None** (internal network only) | Readiness: Postgres, Redis, migrations current |
| `GET` | `/metrics` | Bearer with `metrics:read` scope, or internal-only basic auth | Prometheus scrape |
| `GET` | `/export/transactions.csv` | Session cookie, role ≥ `VIEWER` | **Implemented.** Filtered Transactions as a CSV download (F-25) |

### 9.2 `POST /v1/files/presign`

```http
POST /v1/files/presign HTTP/1.1
Authorization: Bearer <access-jwt>
Content-Type: application/json

{
  "purpose": "RECEIPT",
  "mimeType": "image/jpeg",
  "byteSize": 2481632,
  "sha256": "9f2c…e41",
  "filename": "lidl-2026-10-10.jpg"
}
```

```json
{
  "attachmentId": "0192f3a1-2b00-7000-8000-0000000000f1",
  "uploadUrl": "https://minio.internal/fm-attachments/…&X-Amz-Signature=…",
  "method": "PUT",
  "headers": { "Content-Type": "image/jpeg", "x-amz-meta-sha256": "9f2c…e41" },
  "expiresAt": "2026-10-10T14:37:31.000Z"
}
```

| Rule | Value |
|---|---|
| Allowed `mimeType` | `image/jpeg`, `image/png`, `image/heic`, `image/webp`, `application/pdf` |
| Max `byteSize` | 12 MiB (phone photos at full resolution; HEIC re-encoded client-side) |
| URL TTL | **15 minutes**, single-use |
| Rate limit | `10/min` per household |
| Idempotency | Idempotent on `(purpose, sha256)` within 24 h — re-uploading the same image returns the existing `attachmentId` |
| Post-upload | The row is `PENDING`; a virus/format scan promotes it to `CLEAN` or `REJECTED`. `Attachment.downloadUrl` is `null` until `CLEAN`. |
| Orphans | Unreferenced attachments are hard-deleted by `files.purge` ([05 §8](05-architecture.md)) |

### 9.3 `PUT` (direct upload)

Issued by object storage, never by the API. The API is not in the data path — bytes never transit it
([05 §1](05-architecture.md)). The client must verify the `ETag` matches the `sha256` it declared, then
call `commitAttachment` (§5) to mark the attachment usable and trigger OCR.

**Implemented deviation (task 4.1.2).** The client does **not** verify the `ETag`, and the API does not
rely on it: MinIO answers an `ETag` that is an MD5 for a single-part upload, not the SHA-256 the client
declared, so comparing them would reject every correct upload. The digest is instead carried in the
object's own metadata (`x-amz-meta-sha256`, signed so it cannot be swapped) and checked by
`commitAttachment`'s `HEAD` against `attachments.sha256` — server-side, where a lying client cannot skip
it. The web client also has to send those headers **verbatim** and uses `XMLHttpRequest` rather than
`fetch`, because only XHR can report upload progress for a 12 MiB photo; a header added or dropped is a
`403` that reads like a permissions problem.

### 9.4 `GET /v1/files/:id`

```http
GET /v1/files/0192f3a1-2b00-7000-8000-0000000000f1 HTTP/1.1
Authorization: Bearer <access-jwt>
```

Responds `302 Found` with `Location: <presigned GET URL>` (TTL 5 minutes). Authorization is enforced
before the redirect: the attachment's `household_id` must equal `TenantContext.householdId`. A
cross-household id returns **`404 NOT_FOUND`**, not `403` — existence is itself information, and leaking
it is an enumeration oracle.

**Implemented in 4.1.1, with one addition and two refinements.** A row of this Household that is not
yet linkable answers **`409 CONFLICT`** rather than `404` (see §5.15). The `Cache-Control: no-store`
the download path requires is set on the redirect. The presigned PUT is signed over `content-type` and
`x-amz-meta-sha256`, and `host` — which is part of `SignedHeaders` but must be **sent by the runtime,
not the client** — is stripped from the response's `headers` before it reaches a browser; a scripted
client gets the same map. No `Content-Disposition`/`nosniff` is applied to the object response yet
(§5.15's "not built").

### 9.5 `POST /v1/webhooks/ocr`

Called by the OCR provider. It has no session and must not be able to read anything.

```http
POST /v1/webhooks/ocr HTTP/1.1
X-OCR-Signature: t=1760104251,v1=6b1f…9ad
X-OCR-Delivery: 0192f3a1-3c00-7000-8000-0000000000aa
Content-Type: application/json

{
  "jobId": "ocr-9f2c1e",
  "attachmentId": "0192f3a1-2b00-7000-8000-0000000000f1",
  "state": "COMPLETE",
  "ocrConfidence": 0.91,
  "merchantName": "LIDL SRBIJA",
  "total": { "amountMinor": "200000", "currency": "RSD" },
  "capturedAt": "2026-10-10T17:41:00.000Z",
  "items": [
    { "lineNo": 1, "rawText": "HLEB 500G",      "amount": { "amountMinor": "8900",  "currency": "RSD" } },
    { "lineNo": 2, "rawText": "MLEKO 2.8%",     "amount": { "amountMinor": "17900", "currency": "RSD" } },
    { "lineNo": 3, "rawText": "MESO MESANO",    "amount": { "amountMinor": "89900", "currency": "RSD" } },
    { "lineNo": 4, "rawText": "SAMPON 400ML",   "amount": { "amountMinor": "45000", "currency": "RSD" } },
    { "lineNo": 5, "rawText": "DETERDZENT 1L",  "amount": { "amountMinor": "38300", "currency": "RSD" } }
  ]
}
```

| Rule | Detail |
|---|---|
| Signature | HMAC-SHA256 over `"{t}.{rawBody}"` with the shared secret, compared in constant time; timestamp window ±5 min to block replay. Invalid ⇒ `401 UNAUTHENTICATED`. |
| Idempotency | Keyed on `X-OCR-Delivery` (provider delivery id) **and** `(attachmentId, state)`. Duplicate deliveries return `200` with `{"ok":true,"duplicate":true}` and mutate nothing. |
| Body limits | 1 MiB; more than 500 items ⇒ the job fails and the receipt is marked for manual itemisation. |
| Ordering | `state` is monotonic per `jobId`; an out-of-order `EXTRACTING` after `COMPLETE` is ignored. |
| Trust | The webhook body is **untrusted input**. Every amount is re-validated as a string-form minor unit, every item is re-classified against the household tree, and the receipt is written `MISMATCH` until `reconcileReceipt` satisfies I-6. A compromised provider can inject bad rows into a review queue; it can never write a `CONFIRMED` transaction. |
| Response | Always `200 {"ok":true}` for accepted-but-unprocessable payloads; non-`2xx` only for auth/signature failure, which is what causes the provider to retry. |

### 9.6 Health and metrics

| Route | Auth | Success | Failure | Notes |
|---|---|---|---|---|
| `GET /health` | none | `200 {"status":"ok","version":"…","commit":"…"}` | — | **Liveness only.** No dependency checks; a liveness probe that fails when Postgres blips restarts a healthy container and turns a degradation into an outage. |
| `GET /health/ready` | none, bound to the internal network | `200 {"status":"ready","checks":{"postgres":"ok","redis":"ok","migrations":"ok"}}` | `503` with the failing check named | Readiness gates traffic. Redis reported `degraded` (not failed) when unreachable, because [05 §11](05-architecture.md) specifies reads fall through to Postgres. |
| `GET /metrics` | `metrics:read` bearer or internal basic auth | Prometheus text format | `401` | Exposes `capture_parse_duration_seconds`, `classification_layer_total`, `classification_confidence_bucket_total`, `correction_rate`, `ai_cost_micros_total`, `sync_pending_age_seconds`, `ledger_balance_drift` ([05 §10](05-architecture.md)). Never exposed publicly. |

### 9.7 `GET /export/transactions.csv` — implemented

The filtered Transaction list as a downloadable CSV. This is a **file download**, which the transport
table in §1.1 already assigns to REST, not a REST mirror of a GraphQL read.

```http
GET /export/transactions.csv?from=2026-09-01&to=2026-09-30&kind=EXPENSE HTTP/1.1
Cookie: fm_session=…
```

Query parameters are exactly the filter names the `transactions` query takes — `accountId`,
`categoryId`, `kind`, `status`, `from`, `to`, `search`, `needsReview` — and resolve through the same
filter builder, so the file contains precisely the rows the screen showed. Paging parameters are not
accepted: an export is the whole filtered set, not one page of it.

```http
HTTP/1.1 200 OK
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="finmate-transactions-2026-09-01_2026-09-30.csv"
x-export-rows: 214
```

- Rows are **oldest first**, the natural reading order of a ledger, unlike the list's newest-first.
- The body is RFC 4180 CSV with a **UTF-8 BOM**, so Excel in a Serbian locale does not mangle `č`/`ć`.
- Money appears twice per row: `amount_minor` (the exact integer, ADR-003) and `amount` (major units,
  dot decimal). A divided Transaction's parts are in the `splits` column as `path:amountMinor` pairs,
  because a Transaction with Splits carries no category of its own and dropping them would make the
  export incomplete in a way the user could not detect.
- An invalid `from`/`to` is `VALIDATION_FAILED` (400), not an `INTERNAL` 500.
- Above **50 000** matching rows the request is refused with `VALIDATION_FAILED` naming the count.
  Truncating would produce a file indistinguishable from a complete one, and every total taken from it
  would be quietly short.

> **Relationship to §5.11 `exportData`.** They are different operations with different jobs.
> `exportData` is the GDPR portability surface: asynchronous, whole-household, every table, CSV **and**
> JSON, delivered by notification and email — it needs the worker and is **not implemented**.
> This route is the everyday "take my filtered view away" action, synchronous and bounded.
> Nothing here should grow into §5.11; that one belongs on the job queue.

> **Implementation deviation.** The route is unprefixed rather than under `/v1`, consistent with the
> auth surface (§2, "Implementation deviation"). Versioning is added when the first third-party
> consumer exists, not before.
>
> Also not yet implemented for this route: the `exports_monthly` quota (§10) and the `EXPORT`
> rate limit. The row cap is what bounds the work today.
---

## 10. Error model

### 10.1 Error codes

```graphql
enum ErrorCode {
  UNAUTHENTICATED
  FORBIDDEN
  NOT_FOUND
  VALIDATION_FAILED
  CONFLICT
  RATE_LIMITED
  AI_UNAVAILABLE
  QUOTA_EXCEEDED
  IDEMPOTENT_REPLAY
  INTERNAL
}
```

### 10.2 Payload shape

Two mechanisms, used for two different things:

**(a) Expected domain outcomes → typed union payloads.** No `errors` array, no string parsing:

```graphql
interface UserError {
  code: ErrorCode!
  message: String!          # user-facing, localised server-side
  field: String
  path: [String!]
}

type ValidationError implements UserError {
  code: ErrorCode!
  message: String!
  field: String
  path: [String!]
  violations: [Violation!]!
  clientMutationId: String
}

type Violation { field: String! message: String! constraint: String! }

type NotFoundError implements UserError {
  code: ErrorCode!
  message: String!
  field: String
  path: [String!]
  entityType: String!
  entityId: UUID
  clientMutationId: String
}

type QuotaExceededError implements UserError {
  code: ErrorCode!
  message: String!
  field: String
  path: [String!]
  quota: String!            # "ai_tokens_daily" | "exports_monthly" | "attachments_bytes"
  limit: String!
  used: String!
  resetsAt: DateTime!
  clientMutationId: String
}
```

**(b) Transport-level failures → a normal GraphQL `errors` entry with `extensions.code`.** Used when the
operation did not run at all:

```json
{
  "errors": [{
    "message": "Invalid or expired access token",
    "path": ["transactions"],
    "extensions": {
      "code": "UNAUTHENTICATED",
      "requestId": "0192f3a1-9f00-7000-8000-0000000000ff",
      "retryable": false,
      "timestamp": "2026-10-10T14:22:31.000Z"
    }
  }],
  "data": null
}
```

Every `extensions` object carries `code`, `requestId` (propagated into logs and every AI call, per
[05 §10](05-architecture.md)), `retryable`, and `timestamp`.

### 10.3 HTTP status mapping and retryability

| ErrorCode | GraphQL `extensions.code` | HTTP | Retryable | Client behaviour |
|---|---|---|---|---|
| `UNAUTHENTICATED` | ✓ | `401` | Yes — once, after `refreshSession` | Refresh; on second failure, sign out. |
| `FORBIDDEN` | ✓ | `403` | No | Role/tenancy denial. Surface as "you don't have permission", never as a retry. |
| `NOT_FOUND` | ✓ | `404` | No | Remove the row from the local cache. |
| `VALIDATION_FAILED` | ✓ | `400` (GraphQL syntax/validation) or `200` with typed payload (domain validation) | No | Show field errors; do not retry. |
| `CONFLICT` | ✓ | `409` | Yes — after a refetch | Fetch current state, show a diff, let the user choose (§1.7). Never auto-merge money. |
| `RATE_LIMITED` | ✓ | `429` + `Retry-After` | Yes — respect `Retry-After` | Queue in the outbox; do not drop. |
| `AI_UNAVAILABLE` | ✓ | `503` | Yes | **Degrade, don't fail**: the write still succeeds via the rules-only path ([04 §9](04-categorization-and-ai-engine.md) degradation ladder). Only AI-*only* operations fail. |
| `QUOTA_EXCEEDED` | ✓ | `402` | No — until `resetsAt` | Show the quota notice from the AI-budget guard ([05 §4](05-architecture.md)). |
| `IDEMPOTENT_REPLAY` | ✓ | `200` | No | **Not an error.** The original result is returned; the client treats it as success and reconciles. |
| `INTERNAL` | ✓ | `500` | Yes — with exponential backoff | Log `requestId`, show a generic message, retry from the outbox. |

Two deliberate choices:

- **GraphQL errors return HTTP 200.** That is correct for GraphQL-over-HTTP, and it is why
  `IDEMPOTENT_REPLAY` can be expressed as a payload outcome rather than a failure. Only transport-level
  failures (bad syntax, auth, throttling) shift the status code.
- **`AI_UNAVAILABLE` is not a failed write.** Per P-7 ([04 §1](04-categorization-and-ai-engine.md)), the
  transaction is saved with `needs_review = true` and the raw input preserved for re-parse. Treating a
  provider outage as a user-visible failure would make the whole capture wedge brittle.

---

## 11. Cross-cutting

### 11.1 Authorization — role matrix

Roles are from [03 §4](03-domain-model.md) (`OWNER`, `ADMIN`, `MEMBER`, `VIEWER`). The household-sharing
**UI** is deferred (F-29, `Won't (v1)`), but the roles and this matrix are enforced from day one because
ADR-008 makes tenancy a foundation, not a retrofit — retrofitting authorization is how cross-tenant bugs
ship.

| Operation class | OWNER | ADMIN | MEMBER | VIEWER |
|---|:--:|:--:|:--:|:--:|
| Read ledger, dashboard, analytics, insights, notifications | ✅ | ✅ | ✅ | ✅ |
| Read taxonomy, rules, audit trail | ✅ | ✅ | ✅ | ✅ |
| Create/update/delete Transaction, Split, Correction | ✅ | ✅ | ✅ | ❌ |
| `captureParse`, `captureCommit` | ✅ | ✅ | ✅ | ❌ |
| Upload attachment, `commitReceipt`, `reconcileReceipt` | ✅ | ✅ | ✅ | ❌ |
| Create/update Category, CategoryKeyword, Merchant, Counterparty, Tag | ✅ | ✅ | ✅ | ❌ |
| Delete Category / Merchant / Counterparty (with reassignment) | ✅ | ✅ | ❌ | ❌ |
| Delete Transaction | ✅ | ✅ | ✅ | ❌ |
| Create/update/delete Budget, SavingGoal, RecurringRule | ✅ | ✅ | ❌ | ❌ |
| `contributeToGoal` | ✅ | ✅ | ✅ | ❌ |
| `createRuleFromCorrection`, `createRule`, `updateRule`, `deleteRule` | ✅ | ✅ | ✅ | ❌ |
| `applyRuleToExisting` (bulk backfill) | ✅ | ✅ | ❌ | ❌ |
| `resolveReviewItem`, `bulkResolveReviewItems` | ✅ | ✅ | ✅ | ❌ |
| Dismiss insights, mark notifications read | ✅ | ✅ | ✅ | ✅ |
| Create/update/delete AlertRule, notification preferences | ✅ | ✅ | ❌ | ❌ |
| Household settings (name, timezone, AI routing, thresholds) | ✅ | ✅ | ❌ | ❌ |
| Change `ledger_currency` | ❌ *(blocked in v1)* | ❌ | ❌ | ❌ |
| Invite / remove Member, change role | ✅ | ✅ | ❌ | ❌ |
| `exportData` | ✅ | ✅ | ✅ | ✅ |
| `requestAccountDeletion` (`USER_ACCOUNT`) | ✅ | ✅ | ✅ | ✅ |
| `requestAccountDeletion` (`HOUSEHOLD`) | ✅ | ❌ | ❌ | ❌ |
| Transfer ownership | ✅ | ❌ | ❌ | ❌ |

Notes:

- `MEMBER` is the default role and is deliberately capable — the product's value collapses if the person
  who actually spends the money cannot record it.
- `VIEWER` exists for the household-sharing case (a child, an accountant) and is read-only everywhere,
  including `dismissInsight`.
- `ledger_currency` is immutable in v1 (ADR-011). The cell is `❌` for **every** role rather than absent,
  so the constraint is visible in the matrix rather than discovered in a mutation.
- The **OWNER of a household is always a `Membership` row**, not a column read directly; `Household.owner_user_id`
  is the bootstrap pointer and the authorization source of truth is the membership role.
- Deletion of a `Category` that has transactions is refused with `VALIDATION_FAILED` and a reassignment
  requirement (I-12), regardless of role.

### 11.2 Rate limits

Per operation class, keyed on `(householdId, class)` with an `ip` fallback for unauthenticated calls. A
per-household key (not per-user) is correct here because a household shares a plan and a quota.

| Class | Operations | Limit | Why |
|---|---|---|---|
| `AUTH_WRITE` | `signUp`, `logIn`, `requestPasswordReset`, `resetPassword` | `10/min` per IP, `60/hour` per email | Credential-stuffing and enumeration defence |
| `TOKEN_REFRESH` | `refreshSession` | `60/hour` per session family | Rotate aggressively, but stop a runaway refresh loop |
| `READ_STANDARD` | list/detail queries | `600/min` | Generous; the dashboard is one query, not ten |
| `READ_ANALYTICS` | `spendByCategory`, `spendOverTime`, `monthComparison`, `cashflow`, `topMerchants` | `120/min` | Expensive aggregates. `spendByCategory` was missing from this row until 3.3.1 — it is the most expensive of the five (a Category read plus the tree), and a limit that skipped it would not limit anything |
| `CAPTURE_PARSE` | `captureParse` | `120/min` burst `10/10s` | Debounced typing; the burst cap stops a paste-loop from being a cost event |
| `WRITE_STANDARD` | CRUD mutations | `300/min` | Offline flush must not be throttled into failure |
| `WRITE_BULK` | `captureCommit`, `bulkUpdateTransactions`, `bulkResolveReviewItems`, `materialiseRecurring` | `30/min`, max 50 rows per call | Bounded write amplification |
| `AI_NARRATE` | `assistantAnswer` | `30/min`, `500/day` per household | The one place a user can trigger unbounded LLM cost |
| `AI_CLASSIFY` | parse/classify escalations inside `captureParse` | governed by the token budget, not by a request count | See §11.4 |
| `EXPORT` | `exportData` | `3/day` per household | Whole-table scans |
| `FILE_UPLOAD` | `POST /files/presign` | `10/min` | |
| `WEBHOOK` | `POST /webhooks/ocr` | `600/min` per provider | Signature-authenticated |

Exceeding a limit returns `RATE_LIMITED` with `Retry-After` (seconds). **The offline outbox never drops
a row on `429`** — it backs off and retries ([05 §7](05-architecture.md): *"never silently dropped"*).

### 11.3 Idempotency semantics

| Field / header | Applies to | Semantics |
|---|---|---|
| `input.idempotencyKey` | `captureCommit` (per row), `contributeToGoal`, `materialiseRecurring`, `commitReceipt` | Unique per household for 24 h. A replay returns the **original result** with `wasReplayed = true` and does not write. |
| `Idempotency-Key` header | `POST /files/presign`, `POST /webhooks/ocr` | REST equivalent; same 24 h window, keyed on `(householdId, route, key)`. |
| `row.clientId` | `captureCommit` | Unique per household, **permanent** (DB index, I-10). Dedupes an offline outbox flushed twice or from two devices. |
| `clientMutationId` | every mutation | Correlation only. **Never** a dedupe key — it is echoed, not enforced. |
| `X-OCR-Delivery` | `POST /webhooks/ocr` | Provider delivery id; duplicate deliveries are acknowledged and ignored. |

Storage: Redis with a 24 h TTL for the fast path, plus the durable unique index
`transactions (household_id, idempotency_key)` in Postgres for the case where Redis has evicted the key.
Redis alone would make a replay possible after a restart, which defeats the purpose.

An `IDEMPOTENT_REPLAY` outcome is returned as a **success-shaped payload** (`replayed: true`), not an
error. The client's outbox treats it as acknowledgement and clears the queue entry.

### 11.4 Cost and quota headers (AI-backed operations)

Every operation that can call a model — `captureParse`, `captureCommit` (when it re-classifies),
`assistantAnswer`, `commitReceipt`, `retryOcr` — returns cost and quota metadata in the GraphQL
`extensions.cost` block **and** as HTTP response headers, so a proxy or the client can observe spend
without parsing the body:

```http
X-FM-Ai-Provider: DEEPSEEK
X-FM-Ai-Model: deepseek-chat
X-FM-Ai-Tokens-In: 812
X-FM-Ai-Tokens-Out: 96
X-FM-Ai-Cost-Micros: 184
X-FM-Ai-Degraded: false
X-FM-Ai-Daily-Budget-Remaining-Micros: 4820000
X-FM-Ai-Daily-Budget-Reset: 2026-10-11T00:00:00Z
X-FM-Quota-Assistant-Remaining: 471
```

```graphql
extend type Query    { _cost: CostInfo }
extend type Mutation { _cost: CostInfo }

type CostInfo {
  aiMicros: String!
  tokensIn: Int!
  tokensOut: Int!
  provider: AiProviderName
  model: String
  degraded: Boolean!          # true ⇒ the deterministic path served this request
  promptTemplateId: UUID
  promptVersion: Int
  dailyBudgetMicros: String!
  dailySpentMicros: String!
  dailyRemainingMicros: String!
}
```

`degraded = true` is the machine-readable form of the degradation ladder in
[04 §9](04-categorization-and-ai-engine.md). It is exposed rather than hidden because the settings page
must be able to tell the user *"we switched to a cheaper model because your monthly AI budget was
reached"* — [04 §12](04-categorization-and-ai-engine.md) requires a user-visible notice rather than a
silent quality drop.

Every AI-backed mutation also records `cost_micros`, `latency_ms`, `ai_provider`, `ai_model`,
`prompt_template_id` and `prompt_version` into `classification_decisions`, which is what makes
per-household unit economics measurable rather than guessed.

### 11.5 Deprecation policy

| Stage | Duration | What happens |
|---|---|---|
| **Announce** | — | Field/enum-value marked `@deprecated(reason: "…, use X. Removal no earlier than <date>.")` in the SDL; listed in `docs/CHANGELOG-api.md`; CI fails if a `@deprecated` marker lacks a removal date. |
| **Dual-serve** | ≥ **2 minor releases or 90 days**, whichever is longer | Old and new coexist. Both are exercised in integration tests. |
| **Usage gate** | — | Removal is blocked while any first-party client version in the last 30 days of telemetry still calls the deprecated field. The server emits `X-FM-Deprecated-Field` response headers and a counter per field. |
| **Remove** | — | Field deleted from the SDL. Clients receive `VALIDATION_FAILED` / `UNKNOWN_FIELD`. |

Additional rules:

- **Enum values are never removed** — clients and stored `JSON` payloads reference them. Enum values are
  only added, and removed values are aliased.
- **Input fields are never repurposed.** A changed meaning requires a new field name.
- **Removing a required argument** follows the same window as removing a field.
- **REST routes** are versioned by path (`/v1` → `/v2`), support both concurrently for ≥ 6 months, and
  `/v1` returns `Deprecation` and `Sunset` headers per RFC 8594.
- **Emergency exception:** a field that is a security or correctness hazard (e.g. leaks another
  household's data, or returns money as a float) may be removed immediately, with the incident recorded
  in [14](14-decisions-and-risks.md).

---

## 12. Worked transcript — offline sync with dedupe and re-classification

Scenario: the user's phone is on the metro with no signal and types `Lidl 2000`. The row is captured
locally with `packages/nlp` in the browser ([05 §5.3](05-architecture.md)), queued in the IndexedDB
outbox, and synced when connectivity returns. Meanwhile the *other* device recorded a similar row and a
rule changed server-side — so the sync also has to surface a re-classification diff and a duplicate
suspect.

### 12.1 Offline capture (device-local, no network)

The client segments and extracts locally and materialises an optimistic row:

```json
{
  "localId": "local-7f31",
  "clientId": "0192f3a1-4a00-7000-8000-0000000000aa",
  "idempotencyKey": "idem-0192f3a1-4a00-0000-0000-0000000000aa",
  "accountId": "0192f3a1-0c00-7000-8000-000000000001",
  "kind": "EXPENSE",
  "amount": { "amountMinor": "200000", "currency": "RSD" },
  "description": "Lidl",
  "occurredOn": "2026-10-10",
  "syncState": "PENDING_SYNC",
  "capturedOfflineAt": "2026-10-10T16:58:02.000Z"
}
```

The row is shown as *"pending sync"* with the ledger figures labelled `as of 16:58`. It does not block
further entries.

### 12.2 Reconnect — establish the sync position

```graphql
query { syncState { serverTime latestCursor serverSchemaVersion minSupportedClientSchema } }
```

```json
{
  "data": {
    "syncState": {
      "serverTime": "2026-10-10T17:12:44.310Z",
      "latestCursor": "Y3Vyc29yOjIwMjYtMTAtMTBUMTc6MTI6NDQuMzEwWg",
      "serverSchemaVersion": "2026.10.1",
      "minSupportedClientSchema": "2026.09.0"
    }
  },
  "extensions": { "requestId": "0192f3a1-9f10-7000-8000-000000000101" }
}
```

The client stores `latestCursor` and then flushes the outbox **before** pulling the delta, because the
delta must include the just-committed row exactly once.

### 12.3 Outbox flush — `captureCommit` with `clientId` + `idempotencyKey`

Request (the queued offline row, unchanged since capture):

```graphql
mutation FlushOutbox($input: CaptureCommitInput!) {
  captureCommit(input: $input) {
    __typename
    ... on CaptureCommitSuccess {
      replayed
      cursor
      committed { clientRowId wasReplayed transaction { id category { id name } confidence needsReview status } }
      duplicateSuspects { clientRowId transactionId existingTransactionId similarity matchedOn }
      dashboardDelta { spentThisMonth safeToSpend { amount asOf } reviewQueueCount }
    }
    ... on CaptureCommitRejected { code message rejected { clientRowId code field } }
  }
}
```

```json
{
  "input": {
    "rows": [{
      "clientRowId": "local-7f31",
      "idempotencyKey": "idem-0192f3a1-4a00-0000-0000-0000000000aa",
      "clientId": "0192f3a1-4a00-7000-8000-0000000000aa",
      "kind": "EXPENSE",
      "amount": { "amountMinor": "200000", "currency": "RSD" },
      "description": "Lidl",
      "occurredOn": "2026-10-10"
    }],
    "clientMutationId": "flush-1"
  }
}
```

Response:

```json
{
  "data": {
    "captureCommit": {
      "__typename": "CaptureCommitSuccess",
      "replayed": false,
      "cursor": "Y3Vyc29yOjIwMjYtMTAtMTBUMTc6MTI6NDUuMDAxWg",
      "committed": [{
        "clientRowId": "local-7f31",
        "wasReplayed": false,
        "transaction": {
          "id": "0192f3a1-5b00-7000-8000-0000000000bb",
          "category": { "id": "0192f3a1-0c01-7000-8000-0000000000c1", "name": "Supermarket" },
          "confidence": 1.0,
          "needsReview": false,
          "status": "CONFIRMED"
        }
      }],
      "duplicateSuspects": [{
        "clientRowId": "local-7f31",
        "transactionId": "0192f3a1-5b00-7000-8000-0000000000bb",
        "existingTransactionId": "0192f3a1-5a99-7000-8000-0000000000b9",
        "similarity": 0.91,
        "matchedOn": ["amount", "merchant", "date"]
      }],
      "dashboardDelta": {
        "spentThisMonth": { "amountMinor": "7120000", "currency": "RSD" },
        "safeToSpend": { "amount": { "amountMinor": "180500", "currency": "RSD" }, "asOf": "2026-10-10T17:12:45.001Z" },
        "reviewQueueCount": 3
      }
    }
  },
  "extensions": {
    "requestId": "0192f3a1-9f11-7000-8000-000000000102",
    "idempotency": { "key": "idem-0192f3a1-4a00-0000-0000-0000000000aa", "outcome": "CREATED" },
    "cost": { "aiMicros": "0", "provider": null, "degraded": false }
  }
}
```

Note `aiMicros: "0"` — the rule `Lidl → Hrana / Supermarket` resolved it with zero AI calls, and
`degraded: false` confirms it was a real decision, not a fallback.

`duplicateSuspects` is populated because the other device already recorded a `Lidl 2000` on the same day
(§5.2.2). The row **was** written; the client shows *"Same as a Lidl 2000 from 17:04 — undo?"* and leaves
the decision to the user.

### 12.4 Retried flush — idempotent replay

The network drops the response, so the outbox retries with the identical body:

```json
{
  "data": {
    "captureCommit": {
      "__typename": "CaptureCommitSuccess",
      "replayed": true,
      "committed": [{
        "clientRowId": "local-7f31",
        "wasReplayed": true,
        "transaction": { "id": "0192f3a1-5b00-7000-8000-0000000000bb", "needsReview": false, "status": "CONFIRMED" }
      }],
      "duplicateSuspects": [],
      "cursor": "Y3Vyc29yOjIwMjYtMTAtMTBUMTc6MTI6NDUuMDAxWg"
    }
  },
  "extensions": {
    "requestId": "0192f3a1-9f12-7000-8000-000000000103",
    "idempotency": { "key": "idem-0192f3a1-4a00-0000-0000-0000000000aa", "outcome": "IDEMPOTENT_REPLAY" }
  }
}
```

Same `transaction.id`, `replayed: true`, **no second transaction created**, and the cursor is unchanged.
This is the durable unique index `(household_id, idempotency_key)` doing its job (I-10) — and the retry
also would have been caught by `(household_id, client_id)` had the key been lost.

### 12.5 Delta pull — re-classification diff

The client pulls everything changed since its stored cursor:

```graphql
query Pull($since: Cursor) {
  syncChanges(since: $since, limit: 500) {
    cursor serverTime hasMore counts { upserted deleted diffs }
    upserts { transactions { id clientId description amount status needsReview confidence category { id name } version updatedAt } }
    deletions { ids }
    reclassificationDiffs { transactionId clientId fromCategoryId toCategoryId toCategory { id name } confidence decidedBy reason requiresUserConfirmation }
  }
}
```

```json
{
  "data": {
    "syncChanges": {
      "cursor": "Y3Vyc29yOjIwMjYtMTAtMTBUMTc6MTM6MDIuNTAwWg",
      "serverTime": "2026-10-10T17:13:02.500Z",
      "hasMore": false,
      "counts": { "upserted": 4, "deleted": 1, "diffs": 1 },
      "upserts": {
        "transactions": [
          {
            "id": "0192f3a1-5b00-7000-8000-0000000000bb",
            "clientId": "0192f3a1-4a00-7000-8000-0000000000aa",
            "description": "Lidl",
            "amount": { "amountMinor": "200000", "currency": "RSD" },
            "status": "CONFIRMED",
            "needsReview": true,
            "confidence": 0.72,
            "category": { "id": "0192f3a1-0c02-7000-8000-0000000000c5", "name": "Restoran" },
            "version": 2,
            "updatedAt": "2026-10-10T17:12:58.140Z"
          }
        ]
      },
      "deletions": { "ids": ["0192f3a1-5a99-7000-8000-0000000000b9"] },
      "reclassificationDiffs": [{
        "transactionId": "0192f3a1-5b00-7000-8000-0000000000bb",
        "clientId": "0192f3a1-4a00-7000-8000-0000000000aa",
        "fromCategoryId": "0192f3a1-0c01-7000-8000-0000000000c1",
        "toCategoryId": "0192f3a1-0c02-7000-8000-0000000000c5",
        "toCategory": { "id": "0192f3a1-0c02-7000-8000-0000000000c5", "name": "Restoran" },
        "confidence": 0.72,
        "decidedBy": "AI",
        "reason": "OFFLINE_RECLASSIFIED",
        "requiresUserConfirmation": true
      }]
    }
  },
  "extensions": { "requestId": "0192f3a1-9f13-7000-8000-000000000104" }
}
```

Reading the transcript:

1. **`deletions.ids`** contains `0192f3a1-5a99-…` — the duplicate-suspect row the user undid in §12.3,
   soft-deleted on the server. The client drops it from the local cache; it never reappears.
2. **`upserts.transactions[0]`** is the same transaction the client just committed, now at `version: 2`
   with `needsReview: true`, `confidence: 0.72`, and a **different category** than the preview showed.
   The rule cache was invalidated by another device's correction, so the server re-classified the row
   after the offline capture had already been shown as `Hrana / Supermarket`.
3. **`reclassificationDiffs[0]`** is the machine-readable explanation:
   `decidedBy: "AI"`, `reason: "OFFLINE_RECLASSIFIED"`, `requiresUserConfirmation: true`. This is
   [05 §7](05-architecture.md)'s requirement made concrete: *"an offline row captured with no AI available
   may be categorised differently once synced, and the user must see that rather than be surprised by a
   changed category."*
4. The client applies the upsert to its normalised Apollo cache, then renders a **diff chip** on the row:
   *"Category changed from Hrana to Restoran after sync — was that right?"* with
   **Accept** (`resolveReviewItem` with `ACCEPT_SUGGESTION`) and **Change** (`resolveReviewItem` with
   `SET_CATEGORY` + `rememberForFuture`) actions. It does **not** silently overwrite the user's mental
   model of the row, and it does not silently revert the server either.
5. `counts.diffs = 1` and `hasMore = false`; the client stores the new `cursor` and considers itself
   consistent as of `serverTime`.

### 12.6 What the client tracks locally

| Key | Value | Purpose |
|---|---|---|
| `cursor` | last `syncChanges.cursor` | Delta position; on 410/`STALE_CURSOR` the client does a full re-pull with `since: null` |
| `syncedAt` | `syncChanges.serverTime` | Renders `as of <time>` on every offline figure |
| `outbox[]` | pending rows with `idempotencyKey` + `clientId` | Flushed in order; never dropped on `429` |
| `diffs[]` | unresolved `ReclassificationDiff`s | Drives the diff chips; cleared by `resolveReviewItem` |
| `schemaVersion` | `syncState.serverSchemaVersion` | Below `minSupportedClientSchema` ⇒ hard "update required" gate |

---

## 13. Traceability — feature to operation

Every MVP feature in [01 §3](01-product-requirements.md) maps to at least one operation in this
specification. This table is the completeness check.

| F-ID | Feature | Operations |
|---|---|---|
| F-01 | Multiple accounts + balances | `accounts`, `accountBalance`, `createAccount`, `updateAccount`, `archiveAccount`, `transferBetweenAccounts` |
| F-02 | Custom categories | `categoryTree`, `categories`, `createCategory`, `updateCategory`, `deleteCategory`, `moveCategory` |
| F-03 | Category keywords (include/exclude) | `categoryKeywords`, `setCategoryKeywords` |
| F-04 | Manual transaction CRUD | `transactions`, `transaction`, `createTransaction`, `updateTransaction`, `deleteTransaction`, `restoreTransaction` |
| F-05 | NL single entry | `captureParse`, `captureCommit` |
| F-06 | NL bulk entry | `captureParse` (fragments), `captureCommit` (atomic multi-row, §5.2) |
| F-07 | Categorization pipeline | `captureParse` (`Proposal.decidedBy`, `confidence`), `classificationDecisions` |
| F-08 | Confidence display + review queue | `Proposal.confidenceBand`, `reviewQueue`, `reviewQueueCount`, `resolveReviewItem`, `bulkResolveReviewItems` |
| F-09 | "Remember this" rule capture | `correctTransaction` (`rememberForFuture`), `createRuleFromCorrection` |
| F-10 | Merchant management | `merchants`, `merchant`, merchant mutations, `mergeMerchants`, `setMerchantAliases` |
| F-11 | Counterparties | `counterparties`, `counterparty`, counterparty mutations, `setCounterpartyAliases` |
| F-12 | Tags | `tags`, `createTag`, `updateTag`, `deleteTag`, `assignTags` |
| F-13 | Onboarding & seeding | `signUp` (seeds tree + merchants), `updateHouseholdSettings`, `createCounterparty`, guided first `captureParse` |
| F-14 | Receipt OCR + itemisation | `POST /files/presign`, `commitReceipt`, `reconcileReceipt`, `updateReceiptItem`, `receiptOcrProgress` |
| F-15 | Transaction splits | `Transaction.splits`, `splitTransaction`, `TransactionSplitInput` |
| F-16 | Recurring & subscriptions | `recurringRules`, `upcomingRecurring`, CRUD, `materialiseRecurring`, `confirmDetectedSubscription` |
| F-17 | Monthly budgets | `budgets`, `budgetStatus`, `createBudget`, `updateBudget`, `deleteBudget` |
| F-18 | Savings goals | `savingGoals`, `savingGoal`, CRUD, `contributeToGoal`, `deleteGoalContribution` |
| F-19 | Safe-to-spend tile | `dashboard.safeToSpend`, `safeToSpend` query with `inputs` (§3.3) |
| F-20 | Analytics | `spendByCategory`, `spendOverTime`, `topMerchants`, `monthComparison`, `cashflow` |
| F-21 | End-of-month prediction | `monthProjection`, `dashboard.monthProjection`, `BudgetStatus.projectedPeriodTotal` |
| F-22 | Alerts & notifications | `createAlertRule`, `notifications`, `markNotificationRead`, `notificationReceived`, `updateNotificationPreferences` |
| F-23 | AI assistant Q&A | `assistantAnswer` with `facts` + `provenance` (§8) |
| F-24 | Search, filter, saved views | `search`, `TransactionFilterInput`, `TransactionSortInput` |
| F-25 | CSV import/export | `exportData`, `ExportFormat.CSV` (import scaffold via `source = IMPORT`) |
| F-26 | Offline capture + multi-device sync | `syncChanges`, `syncState`, `clientId`, `idempotencyKey`, `syncInvalidated` (§12) |
| F-27 | i18n SR/EN | `locale` on auth and `captureParse`; SR+EN `message` strings; trigram/transliterated search |
| F-28 | Auth + account lifecycle | §2 auth mutations, `requestAccountDeletion`, `cancelAccountDeletion` |
| F-30 | "How do I save X?" proposal | `assistantAnswer` with `AssistantIntent.SAVINGS_PROPOSAL` |
| F-31 | Audit trail | `Transaction.decisions`, `classificationDecision(s)`, `correction(s)` |
| F-32 | AI preferences | `updateHouseholdSettings.aiRouting`, `upsertAiProviderConfig` |
| F-34 | Attachments | `POST /files/presign`, `commitAttachment`, `deleteAttachment`, `Attachment` |

---

## 14. Decision traceability — where this API encodes each ADR

ADR numbers are fixed and owned by [14](14-decisions-and-risks.md). This table records where the API
enforces each one, so a future change to a decision has an obvious set of schema changes attached to it.

| ADR | Decision | Encoded in this specification |
|---|---|---|
| ADR-001 | LLM never owns state or arithmetic | §8.4 numeric validator; `AssistantFacts` carries pre-computed money; §5.11 `dismissInsight` never deletes; no mutation accepts a model-authored amount without `Money` re-validation |
| ADR-002 | Rules before AI | §7.1 `Proposal.decidedBy`; §7.2 worked example resolves fragments 0–1 at `cost_micros = 0`; §11.4 `degraded` flag |
| ADR-003 | Money as integer minor units | §1.3 `Money` scalar; `amountMinor` is a **string**; no float accepted or emitted |
| ADR-004 | Nx monorepo modular monolith + NestJS/GraphQL | §1.1 transport decision; §1.2 single `/graphql` endpoint; SDL artifact in `packages/contracts` |
| ADR-005 | Prisma | §2.3 Prisma client extension as the tenancy enforcement layer |
| ADR-006 | Angular SPA + PWA-first, no SSR in v1 | §1.2 persisted queries + `POST`-only GraphQL; §9.3 direct-to-storage upload; no session-in-SSR concerns |
| ADR-007 | Provider-agnostic AI routing | §11.4 `X-FM-Ai-Provider` / `X-FM-Ai-Model`; `AiProviderName` enum; `upsertAiProviderConfig` |
| ADR-008 | Household-scoped tenancy from day one | §2.3 "clients never send `householdId`"; §11.1 role matrix enforced despite F-29 being deferred |
| ADR-009 | Confidence gates 0.90 / 0.60 + review queue | §3.1 `ConfidenceBand`; §5.2.1 gate table; §7.1 `Proposal.confidence` |
| ADR-010 | Learning via rule synthesis, not fine-tuning | §5.3 `RuleProposal`; §5.4 `createRuleFromCorrection`; "never auto-create" rule in §5.3 |
| ADR-011 | Single ledger currency in v1 | §1.3 currency mismatch is `VALIDATION_FAILED`; §11.1 `ledger_currency` immutable for every role including OWNER |
| ADR-012 | Native apps + Open Banking deferred | No vendor-specific auth or bank-import mutation in the schema; §1.1 cookie strategy is browser-shaped |
| ADR-013 | Single-node Docker Compose | §9.6 `/health`, `/health/ready`, `/metrics` as the only operational REST surface |
| ADR-014 | Product name **decided** (`FinMate`, 2026-09-17; screening outstanding, R-28) | The API carries no product-name identifier: no route prefix, no `product` field, no header. The decision changed nothing here, which is the point of the rule |
| ADR-015 | Two-level categorisation: transaction level + receipt-item level, plus splits | §3.2 `TransactionSplit` and `ReceiptItem` as separate types; `Receipt.itemsTotal`/`variance`; §5.9 `commitReceipt` / `reconcileReceipt` |
| ADR-016 | Offline capture via client-generated IDs and an outbox, not a local-first framework | §3.5 `clientId` on `TransactionCreateInput`; §4.6 `syncChanges`; §5.2.2 idempotency/`clientId`/duplicate-suspect table; §12 transcript |
| ADR-017 | Assistant uses a constrained query planner with backend-computed facts | §8.1 closed `AssistantIntent` enum mapped to repository methods; §8.4 numeric validator; `AssistantFacts` + `Provenance` |
| ADR-018 | Self-hosted, S3-compatible object storage for receipts | §9.2 `POST /files/presign` + direct `PUT`; `GET /files/:id` returns a `302` to a presigned URL; `Attachment.storage_key` deliberately not exposed |

---

## 15. Related documents

| Topic | Document |
|---|---|
| Canonical vocabulary, invariants I-1…I-12 | [03 — Domain model](03-domain-model.md) |
| Pipeline stages, confidence gates, learning loop, assistant path | [04 — Categorization & AI engine](04-categorization-and-ai-engine.md) |
| Modules, tenancy, offline model, jobs, failure modes | [05 — Architecture](05-architecture.md) |
| Authn/authz detail, encryption, GDPR, threat model | [08 — Security, privacy & compliance](08-security-privacy-and-compliance.md) |
| PWA, camera, offline UX, push, a11y | [07 — Platform strategy](07-platform-strategy-mobile-desktop.md) |
| Contract, integration and cross-tenant tests, AI evals | [10 — Testing & quality](10-testing-and-quality.md) |
| Environments, migrations, SLOs, metrics | [11 — DevOps & observability](11-devops-and-observability.md) |
| ADR-001…ADR-018 | [14 — Decisions & risks](14-decisions-and-risks.md) |
