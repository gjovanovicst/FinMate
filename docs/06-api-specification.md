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
*"when?"* is an instant question. `Transaction.occurredOn` is a `Date`; `Transaction.occurredAt` is a
`DateTime`; `createdAt`/`updatedAt` are `DateTime`. Period boundaries (`periodStart`, `periodEnd`) are
`Date`. Conflating them breaks month boundaries across timezones and DST.

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
> GraphQL response where every operation shares one envelope; and scoping the refresh cookie to
> `/auth` keeps it off ordinary data requests. GraphQL remains the transport for all domain
> operations. Recorded here rather than left as a silent divergence.


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
Set-Cookie: fm_rt=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/graphql; Max-Age=2592000
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
  occurredOn: Date!                 # the local calendar day the user means

  status: TransactionStatus!
  source: TransactionSource!
  categorySource: CategorySource

  confidence: Float
  needsReview: Boolean!
  reviewReason: ReviewReason

  tags: [Tag!]!
  receipt: Receipt
  attachment: Attachment              # transactions.attachment_id is a single FK ([03 §4])
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
  purpose: AttachmentPurpose!        # additive to [03 §4]; see note below
  mimeType: String!
  byteSize: Int!
  sha256: String!
  downloadUrl: String                # short-lived presigned GET; null while scanning
  scanState: FileScanState!          # additive to [03 §4]; see note below
  createdAt: DateTime!
}

enum FileScanState { PENDING CLEAN REJECTED }
```

> **Two columns promoted to canonical.** [03 §4](03-domain-model.md) now defines `attachments` with
> both `purpose` (so an upload can be routed to receipt-OCR versus a plain transaction photo) and
> `scan_state` (so `downloadUrl` can be withheld until the virus/format scan promotes the row, §9.2).
> They were originally flagged here as additive and have since been folded into the canonical DDL, so
> there is no divergence to track. `storage_key` is deliberately **not** exposed on the GraphQL type:
> raw object paths are an internal detail, and clients receive presigned URLs instead.

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
  targetDate: Date
  accountId: UUID
  account: Account
  status: GoalStatus!
  contributed: Money!                # Σ contributions, computed
  remaining: Money!
  progress: Float!                   # 0..1, capped at 1 for display
  requiredPerMonth: Money            # computed, null when no targetDate
  monthsRemaining: Int
  contributions: [GoalContribution!]!
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
}

type GoalContribution {
  id: UUID!
  goalId: UUID!
  amount: Money!
  contributedOn: Date!
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
  rrule: String!                     # RFC 5545
  nextOccurrenceOn: Date!
  endsOn: Date
  autoConfirm: Boolean!
  isDetected: Boolean!
  isActive: Boolean!
  generatedCount: Int!
  upcomingOccurrences: [Date!]!      # next 6, expanded server-side
  version: Int!
  createdAt: DateTime!
  updatedAt: DateTime!
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
  occurredOn: Date                   # one of occurredAt/occurredOn required
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
  occurredOn: Date
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

  # ---- analytics
  spendByCategory(range: DateRangeInput!, accountIds: [UUID!], includeSubcategories: Boolean = true): [CategorySpend!]!                 # CP
  spendOverTime(range: DateRangeInput!, bucket: TimeBucket!, categoryIds: [UUID!]): [SpendBucket!]!
  topMerchants(range: DateRangeInput!, limit: Int = 10): [MerchantSpend!]!
  monthComparison(period: String!, compareTo: String): MonthComparison!
  cashflow(range: DateRangeInput!, bucket: TimeBucket!): [CashflowBucket!]!
  safeToSpend(asOf: Date): SafeToSpend!                 # CP
  monthProjection(period: String, asOf: Date): MonthProjection!                 # CP

  # ---- assistant
  assistantAnswer(question: String!, locale: String, conversationId: UUID): AssistantAnswer!

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

### 4.3 Analytics

```graphql
input DateRangeInput { start: Date! end: Date! }     # inclusive, household-local

enum TimeBucket { DAY WEEK MONTH QUARTER }

type SpendBucket {
  bucketStart: Date!
  bucketEnd: Date!
  expenseTotal: Money!
  incomeTotal: Money!
  transactionCount: Int!
}

type CashflowBucket {
  bucketStart: Date!
  income: Money!
  expense: Money!
  net: Money!
}

type MerchantSpend {
  merchantId: UUID
  displayName: String!               # merchant name, or the raw description when unresolved
  total: Money!
  transactionCount: Int!
}

type MonthComparison {
  period: String!
  compareTo: String!
  total: Money!
  compareTotal: Money!
  delta: Money!
  deltaRatio: Float
  categories: [CategorySpend!]!       # each with priorPeriodTotal + changeRatio populated
}
```

Aggregations run over `CONFIRMED`, non-deleted transactions only (I-7). Every response includes the
range it was computed over; there is no "guess what period this is" behaviour anywhere in the schema.

### 4.4 Assistant

```graphql
type AssistantAnswer {
  id: UUID!
  question: String!
  intent: AssistantIntent!
  answered: Boolean!
  answerText: String!                # narrated, or template-rendered on fallback
  facts: AssistantFacts!             # the ONLY numbers the answer may contain
  provenance: Provenance!
  drillThrough: DrillThrough
  suggestions: [String!]!            # answerable alternatives when answered = false
  narrationMode: NarrationMode!      # LLM | TEMPLATE_FALLBACK
  latencyMs: Int!
  costMicros: String
}

enum NarrationMode { LLM TEMPLATE_FALLBACK }

type AssistantFacts {
  template: AssistantIntent!
  rows: [AssistantFactRow!]!
  totals: [AssistantFactTotal!]!
  formatted: JSON!                   # locale+currency pre-formatted strings (see §8)
}

type AssistantFactRow { label: String! value: String! categoryId: UUID merchantId: UUID }
type AssistantFactTotal { label: String! money: Money! formatted: String! }

type Provenance {
  periodStart: Date!
  periodEnd: Date!
  transactionCount: Int!
  sourceQuery: String!
  filters: JSON
  computedAt: DateTime!
  ledgerCurrency: String!
}

type DrillThrough {
  route: String!                     # Angular route with query params pre-filled
  transactionIds: [UUID!]!
  filter: TransactionFilterInput
}
```

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

  # ---------- intelligence (F-22)
  dismissInsight(id: UUID!): InsightPayload!
  markNotificationRead(id: UUID!): NotificationPayload!
  markAllNotificationsRead(): BulkPayload!
  createAlertRule(input: AlertRuleInput!): AlertRulePayload!
  updateAlertRule(input: AlertRuleUpdateInput!): AlertRulePayload!
  deleteAlertRule(id: UUID!): AlertRulePayload!
  updateNotificationPreferences(input: NotificationPreferencesInput!): SimplePayload!

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

The one deliberate exception is the low-confidence case, which is **not** a validation failure:

| Row state | Behaviour |
|---|---|
| `confidence >= 0.90` | Written `CONFIRMED`, `needs_review = false` |
| `0.60 <= confidence < 0.90` | Written `CONFIRMED`, `needs_review = true` (ADR-009) — the batch is **not** blocked |
| `confidence < 0.60` | Written **`PENDING`**, `needs_review = true`; requires `confirmDespiteLowConfidence` to be written `CONFIRMED` |
| `categoryId` unresolved | Written `PENDING`, uncategorised, enters the review queue |
| `amount` unparseable / missing | **Row rejected ⇒ whole request rejected** |

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
existing `CONFIRMED`, non-deleted transaction:

1. same `household_id` (implicit) and same `account_id`;
2. same `kind` and identical `amount_minor`;
3. `occurred_local_date` within ±2 days;
4. normalised `description` trigram similarity ≥ 0.85 **or** identical resolved `merchant_id`.

Behaviour on a suspect: the row **is written** (the user may legitimately buy the same thing twice), the
payload lists it in `duplicateSuspects`, and the UI offers a one-tap undo. It is never a hard rejection:
blocking a legitimate second purchase is a worse failure than showing an unnecessary "same as 30 seconds
ago — undo?" chip, and [01 §6](01-product-requirements.md) says *"I am warned … rather than silently
creating it"*, not *"I am prevented"*.

```graphql
type DuplicateSuspect {
  clientRowId: String!
  transactionId: UUID!               # the row just written
  existingTransactionId: UUID!
  existingTransaction: Transaction!
  similarity: Float!
  matchedOn: [String!]!              # ["amount","merchant","date"]
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

### 5.8 `materialiseRecurring`

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

If `transactionCount = 0`, `answerText` must say so plainly and `answered` may still be `true` — "you
spent nothing on that" is a correct answer, and the F-23 acceptance criterion forbids fabricating a
figure, not reporting a zero.

### 8.4 The numeric-validator guarantee

**Guarantee:** an `AssistantAnswer` returned with `narrationMode = "LLM"` contains **no numeral that is
not present in its own `facts` payload**.

The enforcement path, applied on every narrated answer:

```text
1. Extract every numeral token from answerText (Unicode decimal digits, grouped and ungrouped).
2. Normalise each: strip group separators for the household locale, resolve "," decimal marker.
3. Assert each normalised token matches, within the payload:
     - a facts.formatted string, or
     - a rows[].value / totals[].money.amountMinor (after locale formatting), or
     - a provenance count (transactionCount) or a date/year component (periodStart/periodEnd).
4. On any unaccounted numeral: regenerate ONCE with a stricter instruction.
5. On a second failure: return the TEMPLATE_FALLBACK rendering with narrationMode = "TEMPLATE_FALLBACK".
   The user still gets the correct answer — it is simply rendered by a deterministic formatter.
```

Consequences that are part of the contract:

- `narrationMode` is always populated and the UI is expected to make template fallback invisible (it is
  never framed as an error — a correct answer delivered without an LLM is not a degraded experience).
- `NO_TEMPLATE_MATCH` ⇒ `answered = false`, `answerText` says the ledger cannot answer it, and
  `suggestions` lists the nearest answerable questions. **No figure is ever produced.**
- This is the same guarantee as the CI gate *"fabricated-numeral rate in narration: 0"*
  ([04 §11.2](04-categorization-and-ai-engine.md)) and the test in [09](09-implementation-plan.md)
  §5 — it is asserted, not aspirational.

---

## 9. REST surface

Deliberately small. Every route below is either binary, third-party, or infrastructure. There is **no**
REST CRUD.

### 9.1 Endpoint summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/v1/files/presign` | Bearer access token, role ≥ `MEMBER` | Allocate an attachment row + return a presigned `PUT` URL |
| `PUT` | *(presigned URL)* | Presigned signature only | Direct browser/device upload to object storage |
| `GET` | `/v1/files/:id` | Bearer access token, role ≥ `VIEWER`, household match | `302` to a short-lived presigned `GET` URL |
| `POST` | `/v1/webhooks/ocr` | HMAC-SHA256 signature header | OCR provider completion callback |
| `GET` | `/health` | **None** | Liveness: process is up |
| `GET` | `/health/ready` | **None** (internal network only) | Readiness: Postgres, Redis, migrations current |
| `GET` | `/metrics` | Bearer with `metrics:read` scope, or internal-only basic auth | Prometheus scrape |

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

### 9.4 `GET /v1/files/:id`

```http
GET /v1/files/0192f3a1-2b00-7000-8000-0000000000f1 HTTP/1.1
Authorization: Bearer <access-jwt>
```

Responds `302 Found` with `Location: <presigned GET URL>` (TTL 5 minutes). Authorization is enforced
before the redirect: the attachment's `household_id` must equal `TenantContext.householdId`. A
cross-household id returns **`404 NOT_FOUND`**, not `403` — existence is itself information, and leaking
it is an enumeration oracle.

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
| `READ_ANALYTICS` | `spendOverTime`, `monthComparison`, `cashflow`, `topMerchants` | `120/min` | Expensive aggregates |
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
| ADR-014 | Product name undecided | The API carries no product-name identifier: no route prefix, no `product` field, no header |
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
