# 01 — Product Requirements

**Status:** Baseline for MVP · Supersedes the feature list in the source transcript.

Feature IDs (`F-xx`) are **stable references** used by every other document. Do not renumber.

---

## 1. Target users

### P1 — "Goran", 35–50, primary persona
Busy professional, household of 4, Serbia. Currently tracks money in his head, in a notes app, or not
at all. Tried a spreadsheet once and abandoned it. Uses phone for ~80 % of entries, desktop at home
for reviewing the month. Comfortable with technology but has **zero tolerance for data entry**.
Success for him: *"I don't have to think about logging things, and at the end of the month I actually
know where the money went."*

### P2 — "Jelena", 28–40, the household CFO
Manages the family budget, pays the bills, watches the account. Wants forecasts and warnings — "will
we make it to payday?" She is the one who will configure budgets, categories and goals, and she is
the most likely to become a power user and a Family-plan payer. More willing to invest 20 minutes of
setup than P1, and she values **correctness over convenience**.

### P3 — "Marko", 22–30, cash-light single professional
Mostly card payments, has subscriptions scattered everywhere, wants to know where the money leaks.
Low setup patience, low willingness to pay, but **the most likely to evangelise** if the natural
language input delights him. Important because he is the growth channel.

### Anti-persona (explicitly not served)
Freelancers/sole traders needing invoicing and tax reporting; investors tracking portfolios;
accountants needing double-entry books. These pull the product toward complexity that would kill P1.

---

## 2. Jobs to be done

| JTBD | When… | I want to… | So I can… | Served by |
|---|---|---|---|---|
| JTBD-1 | I just paid for something | record it in under 5 seconds without thinking | keep my records complete | F-05, F-06 |
| JTBD-2 | I dumped a receipt in my pocket | have it read and itemised for me | not itemise anything by hand | F-14 |
| JTBD-3 | I get an ambiguous categorisation | fix it once and never be asked again | trust the system to learn | F-08, F-09 |
| JTBD-4 | Mid-month | know how much I can still safely spend | stop worrying / stop overspending | F-19, F-21 |
| JTBD-5 | Before a big purchase | know the impact on this month and my goal | decide with facts | F-19, F-30 |
| JTBD-6 | End of month | see where the money actually went | adjust next month | F-20 |
| JTBD-7 | A bill/subscription is due | be warned in advance | avoid surprises and fees | F-16, F-22 |
| JTBD-8 | I want to hit a savings target | get a realistic plan and progress | stay motivated | F-18, F-22 |
| JTBD-9 | I'm reviewing the month on desktop | bulk-fix and audit quickly | close the books in minutes | F-04, F-24, F-25 |

---

## 3. Feature catalogue

MoSCoW is scoped to **release 1.0 (public beta)**.

### 3.1 Capture — the core wedge

| ID | Feature | Priority | Notes |
|---|---|---|---|
| F-05 | **Natural-language single entry** | **Must** | One always-visible field. `Lidl 2000` → parsed, categorised, saved. |
| F-06 | **Bulk natural-language entry** | **Must** | `Lidl 2000, gorivo 3500, plata 150000` → 3 transactions, one confirm. The signature feature. |
| F-04 | Manual transaction CRUD | **Must** | The fallback when AI is wrong/absent. Full field control. |
| F-14 | Receipt capture → OCR → itemised categorisation | **Should** | Per-item categories; totals reconciled against the receipt. |
| F-15 | Transaction splits | **Should** | One payment, multiple categories. Also the manual escape hatch for mixed baskets. |
| F-16 | Recurring transactions & subscriptions | **Should** | Auto-materialise; detect probable subscriptions from history. |
| F-25 | CSV import/export | **Should** | Migration path in; data-ownership guarantee out. |
| F-34 | Attachments (receipt photo on a transaction) | **Could** | Useful even without OCR. |

### 3.2 Classification — the moat

| ID | Feature | Priority | Notes |
|---|---|---|---|
| F-07 | **Categorization pipeline** (normalise → resolve → rules → AI) | **Must** | See [04](04-categorization-and-ai-engine.md). |
| F-02 | **Custom categories** (unlimited depth tree, CRUD) | **Must** | User-definable structure is a hard requirement from the source session. |
| F-03 | **Category keywords** with include **and exclude** lists | **Must** | Exclude is non-negotiable (`ulje` must not go to `Gorivo`). |
| F-09 | **"Remember this" rule capture** with plain-language confirmation | **Must** | The learning loop; the compounding moat. |
| F-08 | **Confidence display + review queue** | **Must** | 🟢 auto / 🟡 verify / 🔴 ask. |
| F-10 | Merchant management (aliases, defaults, hints) | **Should** | Default category is optional; receipt items outrank it. |
| F-11 | Counterparties (people/companies) with default category | **Must** | The `Dejan rođa` requirement. |
| F-12 | Tags, orthogonal to categories | **Should** | `#vanredno`, `#dejan`, `#održavanje`. |
| F-32 | AI preferences (per-category AI instruction, model routing prefs) | **Could** | Power-user lever. |
| F-31 | Audit trail: who/what decided each categorisation | **Should** | Trust + debuggability. |

### 3.3 Plan & understand

| ID | Feature | Priority | Notes |
|---|---|---|---|
| F-17 | Monthly budgets (total + per category, rollover optional) | **Must** | |
| F-19 | **"How much can I spend today?"** dashboard tile | **Must** | Deterministic calculation, prominently placed. |
| F-20 | Analytics: category trends, month-over-month, top merchants | **Must** | |
| F-21 | End-of-month prediction | **Must** | Deterministic pace projection. |
| F-18 | Savings goals with monthly required amount and progress | **Should** | |
| F-22 | Alerts & notifications (budget %, pace, bills, unusual spend, **positive** feedback) | **Must** | Positive feedback is explicitly in scope. |
| F-23 | **AI assistant Q&A** over the ledger | **Must** | Answers computed by the backend; AI only narrates. |
| F-30 | "How do I save X this month?" proposal | **Should** | Backend computes; AI explains. |
| F-24 | Search, filter, saved views | **Should** | Desktop power feature. |
| F-01 | Multiple accounts (cash, bank, card) + balances | **Must** | Keep it simple in v1: no reconciliation workflows. |

### 3.4 Platform & account

| ID | Feature | Priority | Notes |
|---|---|---|---|
| F-26 | Offline-capable input + multi-device sync | **Must** | Mobile reality; see [07](07-platform-strategy-mobile-desktop.md). |
| F-28 | Auth (email+password, refresh tokens), account lifecycle | **Must** | Passkeys are Could. |
| F-27 | i18n: Serbian (latin + cyrillic input tolerance) and English | **Must** | Tolerance for both scripts is a *parser* requirement, not just UI. |
| F-13 | **Onboarding & knowledge seeding** | **Must** | Mitigates the cold-start risk — see §5. |
| F-29 | Household sharing (multi-user write access) | **Won't (v1)** | Schema supports it; UI deferred to v2. |
| F-33 | Bank import via Open Banking | **Won't (v1)** | Not practically available in RS yet; revisit in v2. |
| — | Investments, tax, multi-currency ledgers | **Won't (v1)** | Out of scope; single currency (RSD) with EUR display later. |

---

## 4. The MVP boundary, stated bluntly

**Release 1.0 is done when** a Serbian-speaking user can, on a phone *and* a desktop browser:

1. sign up and complete a 3-minute onboarding that leaves them with a usable category tree;
2. type `Lidl 2000` into one field and have it saved as an expense in the right category, in under 5 seconds;
3. type three transactions in one line and confirm them in one action;
4. correct a wrong category in one tap and tick "remember this" so it never recurs;
5. photograph a Lidl receipt and see items land in food *and* hygiene categories;
6. see how much they can still spend this month, and a projection for month end;
7. set a budget and a savings goal and get an alert before breaching either;
8. ask "koliko sam potrošio na hranu ovog meseca?" and get a correct, computed answer;
9. close the month by exporting CSV, and know their data is theirs;
10. do all of the above offline for capture, with sync when connectivity returns.

**Anything not on that list is not MVP**, regardless of how attractive it is.

---

## 5. F-13: Onboarding & knowledge seeding (the cold-start mitigation)

The AI is only impressive once it knows the household. A blank slate produces a disappointing first
session, which is the single biggest retention risk ([00](00-executive-summary.md#honest-assessment-the-three-things-most-likely-to-kill-this)).
Therefore onboarding is a **first-class feature with its own acceptance criteria**:

| Step | Action | Seeded value |
|---|---|---|
| 1 | Pick a starter category tree (or accept the default ~40-node Serbian tree) | Structure exists before the first entry |
| 2 | Confirm currency + which accounts exist | Balances work immediately |
| 3 | "Who do you pay regularly?" — free text, e.g. `Dejan rođa, septička jama` | Creates Counterparty + rule from day one |
| 4 | "Where do you shop?" — multi-select from a shipped list of ~60 local merchants | Merchant aliases pre-loaded |
| 5 | Optional: monthly income + target savings | Enables F-19 and F-21 immediately |
| 6 | First entry is **guided**: user types a real transaction, sees the pipeline explain itself | Teaches the correction affordance before it is needed |

Target: **under 3 minutes**, skippable at every step, and re-enterable later from settings.

---

## 6. Key user stories with acceptance criteria

### F-06 — Bulk natural-language entry

> As P1, I want to type several transactions at once so logging a day's spending takes one action.

```gherkin
Scenario: Multiple transactions in one input
  Given I am on the dashboard
  When I type "Lidl 2000, gorivo 3500, plata 150000"
  Then I see a preview of 3 parsed transactions
  And "Lidl" is categorised as Hrana with confidence >= 0.90
  And "gorivo" is categorised as Auto/Gorivo with confidence >= 0.90
  And "plata" is detected as INCOME (not EXPENSE)
  And confirming saves all 3 in a single atomic operation
  And the dashboard totals update immediately

Scenario: Ambiguous item in a batch
  Given a rules engine has no match for "Dejan"
  When the AI proposes a category with confidence 0.61
  Then that row is marked "needs review" in the preview
  And the other rows can still be confirmed without resolving it
  And confirming a row with confidence < 0.60 is not auto-applied

Scenario: Duplicate protection
  Given I already saved "Lidl 2000" 30 seconds ago
  When I submit the identical input again within the idempotency window
  Then I am warned about a likely duplicate rather than silently creating it
```

### F-09 — Remember this rule

> As P1, I want my correction to stick so I am never asked the same question twice.

```gherkin
Scenario: Learning from a correction
  Given "Dejan rođa 3600" was categorised as Porodica/Pokloni with confidence 0.61
  When I change the category to Kuća/Septička jama
  Then I am offered "Zapamti za ubuduće: Dejan → Kuća/Septička jama"
  And accepting creates a durable rule linked to counterparty "Dejan"
  And the next input "Dejan 2000" resolves via the rules engine with no AI call
  And the correction is recorded as a learning signal in the audit trail

Scenario: Rule is scoped, not global
  Given a rule "Dejan → Kuća/Septička jama" exists
  When the input is "Dejan poklon 2000"
  Then the gift keyword takes precedence over the counterparty default
  And the result is Porodica/Pokloni
```

### F-19 — How much can I spend today

```gherkin
Scenario: Safe-to-spend is deterministic
  Given monthly budget 120000, spent 68450, reserved for recurring 12000, savings target 25000
  And 10 of 30 days elapsed
  When the dashboard loads
  Then the safe-to-spend figure is computed by the backend, not the LLM
  And the figure accounts for remaining recurring obligations in the period
  And the API response includes every input used in the calculation

Scenario: Offline
  Given I am offline with a cached ledger snapshot
  Then safe-to-spend is still shown from the last synced state
  And it is visibly marked as "as of <timestamp>"
```

### F-23 — Assistant answers

```gherkin
Scenario: Question answered from the ledger
  When I ask "koliko sam potrošio na hranu ovog meseca?"
  Then the backend runs a scoped aggregate query over confirmed transactions
  And the AI narrates the result without recomputing or inventing numbers
  And the answer cites the period and the transaction count it is based on

Scenario: Unanswerable question
  When I ask something the ledger cannot answer
  Then the assistant says so explicitly and suggests a related question it can answer
  And it never fabricates a figure
```

### F-14 — Receipt itemisation

```gherkin
Scenario: Mixed basket
  Given I photograph a Lidl receipt totalling 2000 RSD
  When OCR and item classification complete
  Then each line item has its own category (food, hygiene, household)
  And the sum of items equals the receipt total within a 1 RSD tolerance
  And any item whose confidence < 0.60 is flagged for review
  And the transaction is only marked confirmed once the total reconciles
```

### F-26 — Offline capture

```gherkin
Scenario: Capture without connectivity
  Given I am on the metro with no signal
  When I enter "Lidl 2000"
  Then it is stored locally and shown as "pending sync"
  And it does not block further entries
  When connectivity returns
  Then entries sync in order with client-generated IDs
  And the server deduplicates by idempotency key
  And any server-side categorisation change is surfaced as a reviewable diff
```

---

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| **Correctness** | Ledger arithmetic is server-authoritative; balances must be reconstructible from the transaction log at any time. Property-based tests on money maths. |
| **Latency** | p95 API ≤ 300 ms for reads; rule-only categorisation ≤ 100 ms; AI-assisted entry ≤ 2 s p95 (streamed preview allowed). |
| **Availability** | 99.5 % monthly for the API; capture must work offline so the app is never "down" for the user. |
| **Responsiveness** | Fully usable from 320 px to 2560 px. No horizontal scroll, no hover-only affordances on touch. |
| **Accessibility** | WCAG 2.2 AA: keyboard-complete desktop flows, visible focus, ≥ 4.5:1 contrast, screen-reader labels on every money field. |
| **Privacy** | Financial text sent to a third-party model only with explicit per-user consent and provider/region configuration; exportable and hard-deletable in one action. |
| **Portability** | Full data export (CSV + JSON) at any time; no lock-in. |
| **Localisation** | SR (latin + cyrillic) and EN from day one; all strings externalised; number/date formatting per locale. |
| **Auditability** | Every categorisation records which layer decided, the rule/model version, and the confidence. |

---

## 8. Explicit non-goals for 1.0

- Becoming a bank, a payment initiator, or a place money is held.
- Double-entry accounting, invoicing, or tax reporting.
- Investment/portfolio tracking or cryptocurrency.
- Budget *enforcement* (we alert; we never block a payment).
- Social features, leaderboards, or gamification beyond gentle positive feedback.
- Supporting more than one currency in the ledger.

Stating these is as important as stating the features: each one is a plausible "small addition" that
would delay the core wedge.
