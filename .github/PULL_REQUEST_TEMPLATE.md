<!--
Thanks for contributing. Keep the sections below — a reviewer needs the evidence, not just the diff.
Replace the HTML comments with your answers, and delete sections that genuinely do not apply.
-->

## What this changes

<!-- One or two sentences. If it fixes something, say what the failure looked like. -->

## Why

<!-- The reason, not the mechanism. Link the task id, ADR, F-xx or I-x this belongs to. -->

Closes #

## How it was verified

State plainly which of these are true — "assumed" and "measured" are different claims here.

- [ ] **Tests** added or updated (`pnpm test`)
- [ ] **Verified live** — describe the exact steps and what you saw:
- [ ] **Verified at 320 / 768 / 1280 px**, and operable by keyboard alone _(UI changes)_
- [ ] **Not verified beyond automated tests** — explain what a reviewer should check:

Commands run:

```

```

## Definition of Done

See [`CONTRIBUTING.md`](https://github.com/gjovanovicst/FinMate/blob/main/CONTRIBUTING.md) for the full list.

- [ ] Error, empty, loading and **offline** states handled, not just the happy path
- [ ] No hardcoded user-facing strings — everything through `I18nService.t()` (English + Serbian)
- [ ] Money stays `BIGINT` minor units + ISO-4217 — no float anywhere in the path
- [ ] Household-scoped queries filter by `household_id` from the session, never from client input
- [ ] No new dependency, datastore or service without an ADR
- [ ] `docs/` updated if a canonical decision changed, plus an ADR if it is architectural
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test` green; `nx run web:build` green if `apps/web` changed

## Known gaps or follow-ups

<!--
Anything deliberately left unbuilt, or anything you found and did not fix. This project records gaps
honestly rather than leaving them silent — see the "Known gap" rows in AGENTS.md. Write "none" if none.
-->

none

## Checklist

- [ ] One logical change; no unrelated reformatting
- [ ] Commits signed off (`git commit -s`) per the DCO
- [ ] I have read [`CONTRIBUTING.md`](https://github.com/gjovanovicst/FinMate/blob/main/CONTRIBUTING.md) and the [Code of Conduct](https://github.com/gjovanovicst/FinMate/blob/main/CODE_OF_CONDUCT.md)
