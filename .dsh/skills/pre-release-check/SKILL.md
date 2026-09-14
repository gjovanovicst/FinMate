---
name: pre-release-check
description: "Run the release gate before shipping: eval gates, invariant tests, cross-tenant security, performance, accessibility, i18n and backup restore."
whenToUse: "Use before any release, public beta, or staging promotion — and before declaring a milestone complete."
metadata:
  owner: finmate
  area: release
  reads: [09-implementation-plan.md, 10-testing-and-quality.md, 08-security-privacy-and-compliance.md]
---

# Pre-release check

Every box below is a **gate**, not a suggestion. If one fails, the release does not ship — the answer
is to fix it or to consciously downgrade scope, not to waive the check silently.

Sources: `docs/09-implementation-plan.md` §7 (launch gates), `docs/10-testing-and-quality.md`
(pipeline + release criteria), `docs/08-security-privacy-and-compliance.md` §13.

## 1. Automated gates

```bash
pnpm lint
pnpm typecheck
pnpm test              # unit + integration (Testcontainers Postgres + Redis)
pnpm test:evals        # golden dataset — blocking
pnpm test:e2e          # the ten MVP journeys, mobile + desktop viewports
pnpm build
```

- [ ] All green, **on the frozen commit**, with no skipped or quarantined test hiding a failure.
- [ ] Flake policy respected: nothing in quarantine past its 14-day expiry (doc 10 §12.3).

## 2. AI evaluation gates — must all hold

- [ ] Top-1 accuracy (calibrated ≥ 0.90 bucket) **≥ 96 %**
- [ ] Top-3 accuracy **≥ 99 %**
- [ ] **Overconfident-wrong ≤ 1.5 %** ← the one that matters most
- [ ] Should-ask recall **≥ 90 %**
- [ ] Semantic preservation in narration **100 %**
- [ ] **Fabricated numerals = 0**
- [ ] p95 parse+classify **≤ 1.5 s**; cost **≤ $0.002** per classified transaction
- [ ] Golden dataset at full composition (1,300 cases) before a **public beta** gate
- [ ] Regression slice: no case lost that previously passed

## 3. Money and data integrity

- [ ] Invariant property tests pass (I-1 … I-12).
- [ ] `ledger.reconcile` reports **zero drift** — a non-zero result is a P1, not a warning.
- [ ] Migrations applied to staging with **measured duration** recorded.
- [ ] **Backup restore rehearsed and timed** — this is a launch gate, not an aspiration. A backup that
      has never been restored is not a backup.

## 4. Security and privacy

- [ ] Cross-tenant suite passes: no Household can read or write another's data by any route.
- [ ] Authorization matrix tested per role (`OWNER`/`ADMIN`/`MEMBER`/`VIEWER`); AI consent and provider
      config are `OWNER`-only.
- [ ] **No AI call reaches a non-EEA endpoint** unless the Household granted recorded consent
      (ADR-007). Spot-check the routing config, do not assume.
- [ ] No secret in an image, a log, or a client bundle. Rotate anything that leaked.
- [ ] Dependency and secret scanning clean; no unreviewed high-severity advisory.
- [ ] GDPR paths exercised end-to-end: export works, hard delete works, consent is recorded.

## 5. Performance

- [ ] p95 API reads ≤ 300 ms on the beta dataset size.
- [ ] Dashboard aggregate within budget; no N+1 introduced (check query counts).
- [ ] Bundle budgets met per route (doc 07 §11).
- [ ] Load test at 10× expected beta volume; no timeout or connection-pool exhaustion.
- [ ] Cost per active Household within the plan's margin (doc 12 §4).

## 6. Accessibility and i18n

- [ ] axe clean on every screen; no new violations.
- [ ] **Keyboard-only** pass on desktop flows; focus visible and correctly ordered.
- [ ] Money fields have proper screen-reader labels; charts have text alternatives.
- [ ] Verified at **320 / 768 / 1280 px** (and one real mid-range Android device).
- [ ] Both latin and cyrillic Serbian render; no string concatenation; no missing keys.
      Remember `račun` means both *Account* and *receipt* — never use it bare for a Receipt.

## 7. Product readiness

- [ ] The `AGENTS.md` Definition of Done is ticked for everything in the release.
- [ ] `docs/` reflects reality; **every architectural change has an ADR**; no doc contradicts code.
- [ ] Telemetry in place for every success metric in `docs/00-executive-summary.md`.
- [ ] Rollback path verified — and actually exercised on staging, not just documented.
- [ ] Support runbook and incident checklist current.

## 8. Report

State in the release notes: the commit, the eval numbers, anything **waived and why**, and any
known-broken behaviour. A gate that was knowingly skipped is recorded, never quietly omitted —
the next person to read these notes is deciding whether to trust the release.
