# FinMate

**AI-first household budgeting for mobile and desktop.** The product promise, in one line:

> Type **`Lidl 2000`** and get a correctly categorised, budget-aware transaction in under five seconds.

[![CI](https://github.com/gjovanovicst/FinMate/actions/workflows/ci.yml/badge.svg)](https://github.com/gjovanovicst/FinMate/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Contributor%20Covenant-2.1-4baaaa.svg)](CODE_OF_CONDUCT.md)

---

## What this is

Budgeting apps do not fail on features; they fail on the second week. Logging a coffee becomes
_open app → tap add → enter amount → pick category → pick account → pick date → save_, and that
friction is the single largest predictor of churn in personal finance tooling. FinMate's whole thesis
is removing it: you type or say a fragment — `Lidl 2000`, `Dejan rođa 3600`, `plata 145.000` — and a
deterministic backend turns it into a correct ledger entry.

The project is built for the Serbian/Balkan market first: latin/cyrillic mixing, RSD, cash-heavy
household habits and local merchants that generic English-first classifiers handle badly. The UI ships
English (primary) and Serbian (latin + cyrillic).

> **A note on the name.** `FinMate` is a **working title**, confirmed by the product owner but never
> screened against trademarks, domains or the app stores — that gap is risk **R-28** in
> [`docs/14-decisions-and-risks.md`](docs/14-decisions-and-risks.md), and it is deliberately left open
> until launch. Nothing in the code hardcodes the brand: it reads `APP_NAME` from config, so a rename
> stays one commit plus a manifest. If you intend to deploy this publicly under a name of your own,
> do the screening we have not.

## The architectural commitment

> **AI proposes, the backend disposes.**

| Layer                  | Owns                                                                                        | Never does                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **AI layer**           | Interpretation of messy human input; category _proposals_; narrative insights; explanations | Write to the ledger; compute balances, totals, budget remaining or savings projections |
| **Deterministic core** | The ledger, all arithmetic, budget limits, recurring materialisation, alerts, permissions   | Guess; silently resolve ambiguity                                                      |

Every design decision follows from that. If a model hallucinates, the worst outcome is a
mis-categorised row the user fixes in one tap — never a wrong balance. It is also what makes the AI
layer safely swappable and cheap to run.

The non-negotiables, in short:

1. **The LLM never owns state or computes money.** It returns proposals with a confidence; only the
   backend validates and persists. _(ADR-001)_
2. **Rules before AI.** normalize → resolve → rules → keywords → **then** AI. AI is the exception
   path, not the default. _(ADR-002)_
3. **Money is `BIGINT` minor units + ISO-4217 code — never a float, anywhere.** `2.000 RSD` is
   `200000n`. _(ADR-003)_
4. **Every household-scoped query filters by `household_id` resolved from the session**, never from
   client input. _(ADR-008)_
5. **AI egress is EEA-only or local**, with an explicit hostname rather than a naming convention, and
   anything else requires recorded per-household consent. _(ADR-007, ADR-031)_
6. **The assistant never invents a number.** A constrained query planner computes facts server-side;
   the model only narrates them. _(ADR-017)_
7. **Confidence gates:** ≥0.90 auto-apply · 0.60–0.89 verify · <0.60 ask. _(ADR-009)_

The full ADR log and risk register live in [`docs/14-decisions-and-risks.md`](docs/14-decisions-and-risks.md).

## Monorepo layout

Nine Nx projects. Dependencies flow one way, and `@nx/enforce-module-boundaries` fails the lint if a
forbidden edge appears.

| Path                    | What it is                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/api`              | NestJS modular monolith — GraphQL (code-first) + REST auth/AI/ingest, Prisma 7, tenancy guard           |
| `apps/worker`           | BullMQ background jobs, booting the API's own services (ADR-022)                                        |
| `apps/web`              | Angular 22 zoneless SPA with signals, a service worker and an encrypted offline store                   |
| `packages/domain`       | Dates, money allocation, Serbian amount parsing, category tree, budget calculators, invariants          |
| `packages/nlp`          | Transliteration, folding, segmentation, fragment extraction, the entity-resolution ladder               |
| `packages/rules-engine` | Pure conflict resolution and keyword scoring — no I/O                                                   |
| `packages/ai`           | Provider adapters, fail-closed residency routing, circuit breaker, redaction, telemetry — no vendor SDK |
| `packages/contracts`    | Shared transport types                                                                                  |
| `packages/config`       | Typed configuration schema shared by the apps                                                           |

## Tech stack

- **Runtime:** Node 24 · pnpm 11 · TypeScript 6
- **API:** NestJS 12 · Prisma 7 (hand-written SQL migrations) · PostgreSQL 16 + `pgvector` · Redis + BullMQ
- **Web:** Angular 22 (zoneless, signals) · service worker (`ngsw`) · IndexedDB via `idb` for the offline store
- **AI:** OpenAI-compatible adapters written in-repo, local-first via Ollama, no vendor SDK in a feature module
- **Dev infrastructure:** Docker Compose — Postgres + pgvector, Redis, MinIO (S3-compatible), Mailhog
- **Tests:** Vitest everywhere; 3,100+ unit and integration specs, plus deterministic AI evaluation gates

## Quickstart

**Prerequisites:** Node 24 (`nvm use`), pnpm 11.7+, Docker with Compose.

```bash
git clone https://github.com/gjovanovicst/FinMate.git
cd FinMate

pnpm install
cp .env.example .env        # dev defaults match the Compose file; no real secrets are needed

pnpm dev:infra              # Postgres + Redis + MinIO + Mailhog
pnpm db:migrate             # apply migrations
pnpm db:seed                # starter categories, keywords and merchants
pnpm storage:init           # create the attachments bucket in MinIO

nx run api:serve            # API on :3001
nx run web:serve            # SPA on :4200, proxying /api and /graphql to the API
```

Then open <http://localhost:4200> and sign up.

A few things that will save you an afternoon:

- **The dev API is pinned to `:3001`** and the web proxy targets `:3001`, while `.env` says `3000`.
  Change one and you must change the other, or every request through the SPA fails as a proxy error.
- **`.env.example` has a port-conflict note** for Postgres: Docker Desktop shares localhost with
  Windows, and a native PostgreSQL already holding 5432 makes the container come up healthy with no
  host port bound.
- **Never run `prisma migrate dev`** — it drops the CHECK constraints and partial indexes the domain
  depends on. Migrations are forward-only SQL; `pnpm db:pull` re-derives the Prisma schema.
- The Prisma client is generated into `apps/api/src/generated/prisma` and is gitignored, so
  `pnpm db:generate` (or migrate) must run before typecheck.
- AI is **inert by default**. With no provider configured the classifier is rules-only, which is a
  supported and tested degraded mode — no API key is required to run the stack.

## Commands

```bash
pnpm dev              # infra, then all apps in parallel
pnpm dev:infra        # Postgres + Redis + MinIO + Mailhog only
pnpm dev:ai           # opt-in local vision sidecar + model (docs/11 §2.5)

pnpm lint             # includes the dependency-boundary rule
pnpm typecheck
pnpm test             # unit + integration (needs the dev database)
pnpm test:evals       # the deterministic Phase 2 evaluation gates
pnpm bundle:budget    # per-route web bundle budgets

pnpm db:migrate       # forward-only, expand/contract
pnpm db:pull          # re-derive schema.prisma after a migration
pnpm db:seed          # starter categories, keywords and merchants
pnpm storage:init     # create the attachments bucket in MinIO

nx run web:build      # production bundle
```

## Project status

Built in phases, and the docs record the state honestly rather than the aspiration.

- **Phase 0 (foundation)** — complete
- **Phase 1 (manual core)** — complete: accounts, transactions with splits, budgets, categories,
  merchants, counterparties, tags, CSV export
- **Phase 2 (AI input)** — complete: the six-stage pipeline, the correction/learning loop, the review
  queue, onboarding. Measured exit criteria: rule-hit ratio **73.8 %** (bar 50 %), overconfident-wrong
  **0.28 %** (bar 1.5 %), top-1 **100 %**, should-ask recall **98.8 %**
- **Phase 3 (intelligence)** — complete: insights, notifications across in-app/email/push, analytics,
  goals, recurring rules, subscription detection, the assistant
- **Phase 4 (receipts & mobile)** — in progress: receipts, offline & sync, push, installable PWA, the
  app lock, i18n, accessibility and bundle budgets are done; the rest is tracked in `docs/09`

Known gaps and deliberate non-features are documented, not hidden. [`AGENTS.md`](AGENTS.md) carries
the current machine-readable state; [`docs/15-implementation-gotchas.md`](docs/15-implementation-gotchas.md)
carries 200+ accumulated traps.

## Documentation

`docs/` is the specification and it is canonical — code comments link to it rather than restating it.
Start with [`docs/README.md`](docs/README.md) for the index.

| If you are…                          | Read first                                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deciding whether to build it         | [`docs/00`](docs/00-executive-summary.md) → [`docs/01`](docs/01-product-requirements.md) → [`docs/12`](docs/12-monetization-and-pricing.md)                                      |
| Building it                          | [`docs/03`](docs/03-domain-model.md) → [`docs/04`](docs/04-categorization-and-ai-engine.md) → [`docs/05`](docs/05-architecture.md) → [`docs/09`](docs/09-implementation-plan.md) |
| Debugging something that should work | [`docs/15`](docs/15-implementation-gotchas.md)                                                                                                                                   |
| Contributing code                    | [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md)                                                                                                                |

## Contributing

Contributions are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow, the Definition
of Done and the commit conventions. Participation is covered by our
[Code of Conduct](CODE_OF_CONDUCT.md). Please report vulnerabilities privately per
[`SECURITY.md`](SECURITY.md) rather than in a public issue.

## License

Copyright (C) 2026 Goran Jovanovic.

FinMate is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero
General Public License**, either version 3 of the License, or (at your option) any later version. It is
distributed in the hope that it will be useful, but **without any warranty**; without even the implied
warranty of merchantability or fitness for a particular purpose. See [`LICENSE`](LICENSE) for the full
text.

> Note the _Affero_ clause (§13): if you run a modified version of FinMate as a network service, you
> must offer your users the Corresponding Source of your version.
