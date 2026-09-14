# FinMate — Documentation Index

**Working title:** FinMate · **Status:** Pre-implementation (concept → plan) · **Last updated:** planning round 1

> ⚠️ **Naming caveat:** the name `FinMate` is the *working* directory/title only. The source planning
> conversation established that **FinMate, Finora, Finio and Monevo already exist as finance products**.
> See [`13-brand-and-naming.md`](13-brand-and-naming.md) for the naming decision and shortlist.
> Nothing in the technical plan depends on the final name — it is a rename, not a refactor.

---

## What this is

A complete product, architecture and delivery plan for an **AI-first household budgeting app** for
**desktop and mobile**, derived from the original concept session
([`../chatgpt-share-transcript.md`](../chatgpt-share-transcript.md)) and turned into an engineering plan
that can be executed.

The core thesis, in one line:

> The user should be able to type **`Lidl 2000`** and get a correctly categorised, budget-aware
> transaction — with a **deterministic backend as the source of truth** and the LLM as a
> *proposal* layer that never does money arithmetic.

---

## How to read this

| If you are… | Read in this order |
|---|---|
| Deciding whether to build it | [00](00-executive-summary.md) → [01](01-product-requirements.md) → [12](12-monetization-and-pricing.md) → [14](14-decisions-and-risks.md) |
| Building it | [03](03-domain-model.md) → [04](04-categorization-and-ai-engine.md) → [05](05-architecture.md) → [09](09-implementation-plan.md) |
| Designing UI/UX | [01](01-product-requirements.md) → [02](02-ux-flows-and-screens.md) → [07](07-platform-strategy-mobile-desktop.md) |
| Integrating / testing | [06](06-api-specification.md) → [10](10-testing-and-quality.md) |
| Operating it | [11](11-devops-and-observability.md) → [08](08-security-privacy-and-compliance.md) |
| Reviewing scope disputes | [14](14-decisions-and-risks.md) (ADR log) |

---

## Document map

### Product
| # | Document | Contents |
|---|---|---|
| 00 | [Executive summary](00-executive-summary.md) | Vision, thesis, differentiation, what we are *not* building, success metrics |
| 01 | [Product requirements](01-product-requirements.md) | Personas, jobs-to-be-done, feature catalogue with MoSCoW, MVP boundary, user stories, acceptance criteria |
| 02 | [UX flows and screens](02-ux-flows-and-screens.md) | Information architecture, navigation, screen specs, wireframes, the "input-first" interaction model |
| 07 | [Platform strategy: mobile & desktop](07-platform-strategy-mobile-desktop.md) | PWA-first, responsive breakpoints, offline, camera/OCR, push, desktop power features, a11y, i18n |
| 12 | [Monetization and pricing](12-monetization-and-pricing.md) | Plans, entitlements, paywall placement, Serbian market economics, unit costs |
| 13 | [Brand and naming](13-brand-and-naming.md) | Why the original names fail, shortlist, screening process, recommendation |

### Engineering
| # | Document | Contents |
|---|---|---|
| 03 | [Domain model](03-domain-model.md) | **Canonical glossary**, ERD, PostgreSQL DDL, invariants, money/currency rules |
| 04 | [Categorization & AI engine](04-categorization-and-ai-engine.md) | 6-stage pipeline, rules engine, confidence gates, learning loop, provider abstraction, prompts, evals, cost |
| 05 | [Architecture](05-architecture.md) | System components, monorepo layout, module boundaries, sync, jobs, notifications, tenancy |
| 06 | [API specification](06-api-specification.md) | GraphQL schema, REST endpoints for AI/ingest, auth flows, realtime, error model |
| 08 | [Security, privacy & compliance](08-security-privacy-and-compliance.md) | Authn/authz, encryption, GDPR, AI data handling, audit, threat model |

### Delivery
| # | Document | Contents |
|---|---|---|
| 09 | [Implementation plan](09-implementation-plan.md) | Phases, sprints, deliverables, definition of done, critical path, estimates, staffing |
| 10 | [Testing & quality](10-testing-and-quality.md) | Test pyramid, AI evaluation harness, golden dataset, CI gates, release criteria |
| 11 | [DevOps & observability](11-devops-and-observability.md) | Environments, Docker, CI/CD, migrations, monitoring, SLOs, cost controls |
| 14 | [Decisions & risks](14-decisions-and-risks.md) | ADR log, risk register, open questions needing a human decision |

---

## Canonical decisions (short form)

These are fixed for the plan; each has an ADR in [`14-decisions-and-risks.md`](14-decisions-and-risks.md)
(19 ADRs total, plus a 20-risk register and the open questions that need a human decision).

1. **LLM never owns state or arithmetic.** The backend is the source of truth; AI returns structured proposals with confidence. ([ADR-001](14-decisions-and-risks.md))
2. **Deterministic rules run before AI.** Keywords/merchants/entities resolve most inputs at zero cost and zero latency — ~70 % steady state. ([ADR-002](14-decisions-and-risks.md))
3. **Money is integer minor units + ISO-4217 currency.** No floats, ever, anywhere in the stack. ([ADR-003](14-decisions-and-risks.md))
4. **Single codebase, responsive-first.** One Angular application serves desktop and mobile; native shells come later if measured triggers fire. ([ADR-006](14-decisions-and-risks.md), [07](07-platform-strategy-mobile-desktop.md))
5. **Everything is household-scoped** from day one, even before Family sharing ships (`householdId` on every row, enforced in three layers). ([ADR-008](14-decisions-and-risks.md))
6. **Provider-agnostic AI — and EEA-only by default.** `PARSE`/`CLASSIFY`/`NARRATE`/`OCR` may only reach a local model or an EEA-hosted endpoint; anything else is a consent-gated exception. ([ADR-007](14-decisions-and-risks.md), [04 §9](04-categorization-and-ai-engine.md))
7. **PostgreSQL + Redis only.** No extra datastore until there is a measured reason. ([ADR-004](14-decisions-and-risks.md), [ADR-013](14-decisions-and-risks.md))
8. **Two-level categorisation.** Transaction-level, plus splits and independently categorised receipt items — because a Lidl basket is not one category. ([ADR-015](14-decisions-and-risks.md))
9. **The assistant cannot invent a number.** A constrained query planner computes facts in the backend; the LLM only narrates them, validated by a numeric checker. ([ADR-017](14-decisions-and-risks.md))

---

## Status of this documentation set

| | |
|---|---|
| Documents | 16 (this index + 15 numbered) |
| ADRs | 19, with 2 closed questions recorded inline |
| Feature IDs | 34 (`F-01`–`F-34`), all traceable to code and tests |
| Invariants | 12 (`I-1`–`I-12`) |
| Verified | All cross-document links and heading anchors resolve; every `F-xx`/`ADR-xxx`/`I-x` reference resolves; code fences balanced |

**Two decisions still need a human** — see [Part 3 of the decision log](14-decisions-and-risks.md):
the **product name** (ADR-014; `Ostava` is the recommendation, `FinMate` is taken) and the
**mobile delivery route** (PWA-first is recommended, with measurable Capacitor triggers defined in
[07](07-platform-strategy-mobile-desktop.md)). Neither blocks Phase 0.

---

## Source material

The plan is a continuation of, and supersedes, the original concept conversation:
[`../chatgpt-share-transcript.md`](../chatgpt-share-transcript.md) — *"Planiranje AI budžetske aplikacije"*.
Where this plan disagrees with that transcript, **this plan wins**; deviations are recorded in the ADR log.
