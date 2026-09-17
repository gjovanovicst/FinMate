# 00 — Executive Summary

## The idea in one paragraph

A household finance app where the primary input is **natural language** — `Lidl 2000`, `Dejan rođa 3600`,
`plata 145.000` — and where an AI layer parses, categorises and enriches that input while a
deterministic backend keeps the ledger, budgets and alerts correct. The user gets a "smart money
assistant" on desktop and mobile instead of yet another form-driven expense tracker.

---

## Why this is a real opportunity

The original concept session identified the right wedge, and it survives scrutiny:

**1. The category is defined by abandonment, and the cause is input friction.**
Budgeting apps do not fail on features; they fail on the second week. Logging a coffee becomes:
open app → tap add → enter amount → pick category → pick account → pick date → save. Manual entry is
the single largest predictor of churn in personal finance tooling. Removing that friction is not a
feature — it is the whole product thesis.

**2. LLMs are finally good at exactly this parsing job.**
`Lidl 2000` → `{amount: 2000, currency: RSD, merchant: "Lidl", direction: EXPENSE}` is a task where
modern small/cheap models are ≥95 % accurate, and where the failure mode (a wrong default category)
is cheap to correct with one tap. This was not economically viable in 2019. It is in 2026.

**3. The moat is not the model — it is the accumulated personal memory.**
The model is a commodity available to every competitor. What compounds is the per-household
knowledge: `Lidl → Hrana`, `Dejan → Kuća/Septička jama`, `Shell → Gorivo`, plus the correction
history. That memory is what makes month 6 dramatically better than month 1, and it is what makes
switching costs real. **This is the asset the plan is organised around protecting and growing.**

**4. The Serbian/Balkan market is genuinely underserved.**
Local merchants, local language, latin/cyrillic mixing, RSD, cash-heavy habits, family/household
money management, and no serious local AI-first player. A beachhead where the incumbents' generic
English-first classifiers perform badly.

---

## The thesis, stated precisely

> **AI proposes, the backend disposes.**

Every design decision in this plan follows from one architectural commitment:

| Layer | Owns | Never does |
|---|---|---|
| **AI layer** | Interpretation of messy human input; category *proposals*; narrative insights; explanations | Writes to the ledger; computes balances, totals, budget remaining, or savings projections |
| **Deterministic core** | The ledger, all arithmetic, budget limits, recurring materialisation, alerts, permissions | Guesses; silently resolves ambiguity |

This is not defensive engineering for its own sake. It is what makes the product *trustworthy* with
money, and it is what makes the AI layer safely swappable and cheap to run. If a model is
hallucinating, the worst outcome is a mis-categorised row that the user fixes in one tap — never a
wrong balance.

---

## What we are building (scope)

**MVP (release 1.0)** — a single user can:

- enter transactions by **natural language, in bulk, in one field** (`Lidl 2000, gorivo 3500, plata 150000`);
- get them auto-categorised via **rules first, AI second**, with a visible confidence signal;
- correct any field, with a **"remember this"** action that writes a durable rule;
- photograph a receipt and get **per-item** categorisation;
- define custom categories, keywords, merchants and people;
- set monthly budgets and savings goals;
- receive **alerts and end-of-month predictions** computed deterministically;
- ask the assistant questions in natural language and get answers computed from the ledger;
- use it comfortably on **phone, tablet and desktop** — installable PWA, offline-capable input.

**Deliberately deferred:** bank API integrations (Open Banking in Serbia is not yet practically
available), multi-currency ledgers, investment tracking, tax reporting, native app-store builds,
shared household write access (V2 — though the schema supports it from day one).

---

## Honest assessment: the three things most likely to kill this

The concept is sound but not low-risk. Ranked by expected damage:

**1. Onboarding cold-start (highest risk).**
The magic depends on accumulated memory, but a new user has none. For the first ~50 transactions the
AI is *worse* than a picker, because it has no idea that `Dejan` is a plumber and not a nephew.
→ **Mitigation:** the plan front-loads a 3-minute onboarding that seeds real knowledge (a starter
category tree, 20 local merchants, and one "teach me about your people" step), plus a review queue
that makes correcting fast and satisfying rather than punishing. This is treated as a *feature*, not
a chore — see [01](01-product-requirements.md#5-f-13-onboarding--knowledge-seeding-the-cold-start-mitigation).

**2. Trust in AI touching money (high).**
Users will forgive a wrong category, not a wrong balance. A single "the app said I had 40.000 and I
didn't" incident is fatal and viral.
→ **Mitigation:** the AI/deterministic split above, confidence gates, an always-visible audit trail
of *why* a category was chosen, and an AI-evaluation harness in CI with a hard accuracy floor
([10](10-testing-and-quality.md)).

**3. Category design collapsing under real life (high).**
The transcript's own example is the warning: a Lidl receipt is not "Hrana" — it can be food,
hygiene and cleaning supplies in one basket. If the system insists on one category per merchant, the
user's analytics become garbage and the product loses its value.
→ **Mitigation:** two-level categorisation (transaction-level *and* receipt-item-level),
transaction splits, tags orthogonal to categories, and exclude-keywords. Designed in
[03](03-domain-model.md) and [04](04-categorization-and-ai-engine.md).

Two further risks worth naming: **LLM cost per user** (mitigated by routing ~70–85 % of inputs through
the rules engine — the steady-state planning figure is 70 %, per
[04 §12](04-categorization-and-ai-engine.md#12-cost-model) — and using small models for parsing; see
the unit economics in [12](12-monetization-and-pricing.md)), and **privacy perception** around sending financial text to
third-party models (mitigated by per-household redaction, provider choice including EU regions and
local models, and a documented data-flow — see [08](08-security-privacy-and-compliance.md)).

---

## Success metrics

Instrument from day one; these are the release gates, not vanity numbers.

| Metric | Target @ 90 days post-launch | Why this one |
|---|---|---|
| **D7 / D30 retention** | ≥ 45 % / ≥ 25 % | The only metric that proves friction was actually removed |
| **Median transactions logged per week (active user)** | ≥ 8 | Proves the input model replaced the old habit |
| **AI-parse acceptance rate** (no correction needed) | ≥ 85 % by week 4 per user | Proves the memory/learning loop compounds |
| **Time to log one transaction (median)** | ≤ 4 s | The core promise, measured |
| **Natural-language share of entries** | ≥ 60 % | Proves AI input won over the manual form |
| **Categorisation correction rate** | declining month over month | The compounding-moat signal |
| **Crash-free sessions / p95 API latency** | ≥ 99.5 % / ≤ 300 ms | Table stakes for a money app |

Full instrumentation plan and the eval harness live in [10](10-testing-and-quality.md).

---

## Delivery shape

A 16-week path to a hardened public beta, in five phases, sized for **1–2 engineers** with AI
assistance — see [09](09-implementation-plan.md) for the week-by-week breakdown:

| Phase | Weeks | Outcome |
|---|---|---|
| 0 — Foundations | 1–2 | Monorepo, CI, auth, schema, design system |
| 1 — Manual core | 3–5 | Accounts, categories, transactions, budgets, dashboard — **usable without any AI** |
| 2 — AI input | 6–8 | Natural-language entry, pipeline, rules, confidence UX, review queue |
| 3 — Intelligence | 9–11 | Insights, predictions, alerts, notifications, savings goals |
| 4 — Receipts & mobile | 12–14 | OCR, itemised receipts, offline PWA, push |
| 5 — Hardening & beta | 15–16 | Security review, performance, i18n, onboarding, launch |

The phase order is deliberate: **Phase 1 ships a correct, boring, fully usable manual app.** If the
AI layer slips, the product is still a working budget app — the AI is an accelerator, not a
dependency. This inverts the usual failure mode of AI-first products that have no floor.

---

## Recommendation

**Build it, in the order above, with the AI/deterministic split treated as non-negotiable.**

The concept is differentiated in a crowded category for a defensible reason (memory + friction), the
technology is finally cheap enough, and the beachhead market is real. The dominant risk is not
technical feasibility — it is onboarding cold-start and retention, which is why the plan spends
disproportionate effort on knowledge seeding, correction UX, and measurement rather than on model
choice.

The product name was decided on 2026-09-17 — **`FinMate`**, the placeholder, against the screening advice
in [13](13-brand-and-naming.md), with the skipped checks carried as **R-28**. One decision still needs a
human: the **mobile delivery route** (PWA-first vs. native shell, with a recommendation in
[07](07-platform-strategy-mobile-desktop.md)). It does not block Phase 0.
