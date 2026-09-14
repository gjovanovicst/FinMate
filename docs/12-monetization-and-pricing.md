# 12 — Monetization & Pricing

**Status:** Commercial baseline for release 1.0 · **Currency:** RSD primary, EUR informational.

This document prices the product defined in [01](01-product-requirements.md), against the cost model in
[04 §12](04-categorization-and-ai-engine.md#12-cost-model) and the delivery shape in
[09](09-implementation-plan.md). Where it disagrees with a spine document, the spine wins — flag it
rather than assume.

**Vocabulary** is canonical from [03](03-domain-model.md). A **Household** pays; a **Member** consumes.
*"Seat"* always means **one `household_members` row, i.e. one Member** — a commercial synonym, never a
new entity. *"Logged entry"* means one capture action; the persisted row is a **Transaction**.
*"AI-assisted entry"* means an entry for which an LLM call was actually made — the distinction the whole
quota design in §5 rests on.

**Rates used throughout** (middle rate, 14.09.2026): **1 EUR = 117,32 RSD**, **1 USD = 100,68 RSD**.
Every RSD figure derived from a USD cost shows its arithmetic, so the tables re-base in one pass.

---

## 1. Monetization philosophy

**1. The free tier is a product, not a demo.** This category is defined by abandonment
([00](00-executive-summary.md)). Growth comes from a P1 telling a P2 that logging money finally stopped
being a chore. A crippled Free tier does not convert that person into a payer — it converts them into a
non-recommender. Free must carry a real Household for years: correct ledger, real Budgets, real Alerts,
unlimited manual entry, unlimited history, unlimited export.

**2. The capture loop is never paywalled.** The moment logging costs money the habit breaks, and the moat
breaks with it, because the per-household memory in [00 §3](00-executive-summary.md) only compounds if
entries keep arriving. No plan limit ever stands between a user and recording what they just spent:
quotas degrade *quality of automation*, never *ability to capture*.

**3. We meter the marginal cost, not the value.** The only per-use cost in the system is the LLM call
([04 §12](04-categorization-and-ai-engine.md#12-cost-model)), so the only thing we meter is the LLM call.
The rules engine, keyword scoring and entity resolution cost $0.00 at any volume
([04 §2](04-categorization-and-ai-engine.md#2-the-pipeline)) and are therefore **unmetered and unlimited
on every plan, including Free, forever**. This is not generosity: it is the only design in which the quota
is honest, because users are never charged for compute we did not buy.

**4. We monetize scale, not ownership.** You pay for us to *do more with* your data (more OCR, deeper
analytics, more Members, more AI). You never pay to *keep* it, retrieve it, correct it, or leave with it
(§13).

> Recording your money is free. Understanding it is 599 RSD a month.

---

## 2. Plan structure

Three plans. Two sell at launch; the third requires F-29, which is **Won't (v1)**
([01 §3.4](01-product-requirements.md#34-platform--account)) — so it is *priced* now and *sold* at v2,
exactly as [09](09-implementation-plan.md) sequences it.

| | **Free** | **Pro** | **Family** |
|---|---|---|---|
| Monthly | 0 RSD | **599 RSD** (€5.11) | **999 RSD** (€8.52) |
| Annual | — | **5.990 RSD** (€51.06) | **9.990 RSD** (€85.15) |
| Annual, effective monthly | — | 499 RSD (€4.25) | 832 RSD (€7.10) |
| Annual saving vs. monthly | — | 1.198 RSD = **2 months free (16.67 %)** | 1.998 RSD = **2 months free (16.67 %)** |
| Members included | 1 | 1 | **up to 4** |
| Price per Member | — | 599 RSD | 250 RSD |
| Vendible from | v1.0 | v1.0 | **v2** (needs F-29) |

### 2.1 Recommendation: Pro 599 RSD/month, Family 999 RSD/month

| Why | Detail |
|---|---|
| **Anchored locally, not converted** | The established Serbian digital-content band is **699–720 RSD/month** via telecom bundling (Max via SBB 720; SkyShowtime via A1 699) and **€4.99–9.99** direct (Netflix €4.99/€7.99/€9.99; Max €7.99/€9.99; SkyShowtime €5.99). 599 RSD is *below every bundled video anchor* and below every global tier except Netflix Basic — worth more than the ~40 RSD a 639 test would win. |
| **Top of the committed range** | [04 §12](04-categorization-and-ai-engine.md#12-cost-model) already commits to 399–599 RSD. The top is correct: we sell an assistant, not a tracker, and a 399 launch price is very hard to raise. |
| **Family is 2× Pro, not 4×** | Per-Member cost falls 58 % (599 → 250 RSD). Extra Members add almost nothing to cost (§4) and a great deal to retention (§10); pricing Family as `Members × Pro` would price the retention mechanism away. |
| **Clean numbers** | RSD psychological anchors (x99 monthly, x990 annual) with clean VAT-exclusive values: 599 → **499,17 RSD** net; 999 → **832,50 RSD** net. Annual is exactly 10 × monthly (5.990 = 599 × 10; 9.990 = 999 × 10): two months free, no rounding residue. |

**Rejected: a 399 RSD "Lite" tier** — cannibalises Pro, adds a fourth entitlement surface, and converts a
healthy margin into a thin one. Free *is* our low-price tier. **Rejected: a student tier** — P3 "Marko"
([01 §1](01-product-requirements.md#1-target-users)) is worth evangelism, not revenue; Free serves him.
**Rejected permanently: lifetime deals** — an annuity sold at a loss on a product with a recurring
per-household AI cost. The answer to "we need cash" is annual prepay, never lifetime.

### 2.2 Annual discount rationale (16.67 %, exactly two months)

| Reason | Detail |
|---|---|
| **Pays for CAC on day one** | A Pro annual at 5.990 RSD covers a blended ~1.500 RSD CAC (§11) before the first AI call. Monthly Pro only reaches payback at month 3–4. |
| **Cuts churn ~3–4×** | Annual subscribers churn far less (§11). On a product whose moat compounds monthly, twelve committed months buys memory accrual — the retention curve improves, not just the cash curve. |
| **12 payment events → 1** | Where recurring card mandates are less uniformly reliable than in Western Europe (§9), every renewal is a chance for involuntary churn. |
| **Matches how P2 decides** | A household CFO ([01 §1](01-product-requirements.md#1-target-users)) converts a discretionary monthly decision into a budgeted annual one. |

**Why not deeper (e.g. 30 %)?** A discount that deep on a 599 RSD consumer product reads as a promotion
rather than a commitment, and trains users to wait for the next one. 16.67 % says "one year, two months
free" — legible, repeatable, and it never has to change.

### 2.3 Price presentation rules

| Rule | Detail |
|---|---|
| **RSD is the primary displayed price everywhere** | EUR is parenthetical. The ledger currency is RSD and single ([ADR-011](14-decisions-and-risks.md)); display follows it. |
| **Never convert a price** | An international launch re-anchors (Pro €4.99, Family €9.99) rather than computing from 599 RSD, which yields €5.11 — an anchor that exists in no market. **Never show USD.** |
| **Name-independent** | Nothing on the pricing page may depend on the final product name ([ADR-014](14-decisions-and-risks.md) — FinMate is taken). |

---

## 3. Entitlement matrix

Rows are features with their [01](01-product-requirements.md) IDs. This table is the single source of
truth for gating; anything not listed is available to everyone.

| Feature (ID) | **Free** | **Pro** | **Family** |
|---|---|---|---|
| **Manual transaction entry** (F-04) | **Unlimited** | **Unlimited** | **Unlimited** |
| **Natural-language single entry** (F-05) | **Unlimited** — rules path metered at zero | **Unlimited** | **Unlimited** |
| **Bulk natural-language entry** (F-06) | **Unlimited** — same rule | **Unlimited** | **Unlimited** |
| **AI-assisted entries / month** (visible limit) | **100** | no visible limit | no visible limit |
| **AI fair-use ceiling / month** (internal, not marketed) | 100 | 400 + 400 questions | 800 + 800 questions (pooled) |
| **Receipt capture → OCR → itemisation** (F-14) | **3 / month** | **40 / month** | **120 / month** (pooled) |
| **Custom Categories** (F-02) | **30 nodes**, depth ≤ 3 | Unlimited, depth ≤ 5 | Unlimited, depth ≤ 5 |
| **CategoryKeywords, include + exclude** (F-03) | 5 per Category | Unlimited | Unlimited |
| **Merchants + aliases** (F-10) | Unlimited | Unlimited | Unlimited |
| **Counterparties + aliases** (F-11) | Unlimited | Unlimited | Unlimited |
| **Rules** (F-09, F-07) | **25 active** | Unlimited | Unlimited |
| **Corrections & "Zapamti za ubuduće"** (F-09) | **Unlimited** | Unlimited | Unlimited |
| **Budgets** (F-17) | **3 active** | Unlimited | Unlimited |
| **SavingGoals** (F-18) | **1 active** | Unlimited | Unlimited |
| **Accounts** (F-01) | **2 active** | Unlimited | Unlimited |
| **Safe-to-spend + month-end projection** (F-19, F-21) | Included | Included | Included |
| **Analytics depth** (F-20) | Current month + **3 months** | **Full history**, trends, saved views (F-24) | Full history + **per-Member views** |
| **History retention** | **Unlimited** | **Unlimited** | **Unlimited** |
| **Export CSV + JSON** (F-25) | **Unlimited, no watermark** | Unlimited | Unlimited |
| **Notification channels** (F-22) | `IN_APP` only | `IN_APP` + `WEB_PUSH` + `EMAIL` | Same, + per-Member routing |
| **RecurringRules & subscription detection** (F-16) | **3 active** | Unlimited | Unlimited |
| **Tags** (F-12) | 10 | Unlimited | Unlimited |
| **Audit trail** (F-31) | Last 30 days | Full | Full |
| **AI assistant questions / month** (F-23) | **10** | **300** | **800** (pooled) |
| **Members** (F-29) | 1 | 1 | **4** |
| **Attachments on a Transaction** (F-34) | 20 | Unlimited | Unlimited |
| **Offline capture + multi-device sync** (F-26) | Included | Included | Included |
| **AI preferences / model routing** (F-32) | — | Included | Included |

### 3.1 Why these specific numbers

| Limit | Number | Justification |
|---|---|---|
| Free AI-assisted entries | **100** | Counts *LLM calls*, not entries. At ~70 % rules absorption ([04 §12](04-categorization-and-ai-engine.md#12-cost-model)) 100 calls is worth ~333 logged entries; for a Household with no Rules it is ~1 month of engaged logging, and ~3× the median implied by the ≥8 transactions/week target in [00](00-executive-summary.md#success-metrics). Deliberately generous: the memory that makes the product good is the memory we are paying to create. |
| Pro / Family AI ceiling | **400 / 800 pooled** | At steady state ≈1.300 / ≈2.700 logged entries per month. No real Household reaches it; it bounds abuse and is never surfaced. Family is pooled across 4 Members (200 each) and set below Pro's 400-per-Member on purpose, because Family is 2× Pro for four Members — a cost guard, not a value promise. |
| Assistant questions | **10 / 300 / 800** | Narration is the second-largest AI line ([04 §12](04-categorization-and-ai-engine.md#12-cost-model)). 10 proves the assistant is real and never invents numbers; 300 is ~5× a Pro user's actual usage and is a bound, not a meter. |
| Receipt OCR | **3 / 40 / 120** | Highest cost per unit (§4.1) *and* highest perceived value (§8). ~36 RSD of monthly cost for 40 receipts against 499 RSD net is deliberate: the feature most likely to convert should be affordable. Three free receipts prove the value and never run a household. |
| Categories | **30 nodes, depth ≤ 3** | The F-13 seeded tree is ~40 nodes ([01 §5](01-product-requirements.md#5-f-13-onboarding--knowledge-seeding-the-cold-start-mitigation)) — deliberately larger than the Free cap, so seeded trees always fit and only users building their own deep structure meet the limit. A power-user surface, never a capture surface. |
| Budgets / Goals / Accounts / Recurring | **3 / 1 / 2 / 3** | Enough to run a real household (cash + bank, one total Budget, one savings target). Needing 40 Budgets and 6 Accounts means you are getting real value, and 599 RSD is a trivial ask. |
| Analytics depth | **month + 3 months** | The only place we limit *derived* value rather than capability. Underlying Transactions are never restricted and stay fully exportable on Free. **You always own all your data; you pay for us to analyse all of it.** |
| History retention | **unlimited everywhere** | Deliberately not a lever. Hiding a user's history to force an upgrade is a data-hostage mechanic: it destroys trust in a money app and contradicts the portability requirement in [01 §7](01-product-requirements.md#7-non-functional-requirements). We compete on insight, not custody. |

---

## 4. Unit economics

### 4.1 Cost rate assumptions

| Line | Planning rate | Source |
|---|---|---|
| Logged entry, entry path (blended, ~70 % Rules) | **$0.0003–0.0008** | From the canonical **$0.02–0.05 per active user/month at 60–100 entries** ([04 §12](04-categorization-and-ai-engine.md#12-cost-model)): `$0.02 ÷ 60 = $0.00033`, `$0.05 ÷ 60 = $0.00083`. The conservative 60-entry end is the planning rate. |
| **AI-assisted entry** (an entry that made an LLM call) | **$0.001–0.003** | Same rate rescaled by the ~30 % AI share: `$0.0003 ÷ 0.30 = $0.001`, `$0.0008 ÷ 0.30 = $0.0027`. Consistent with the $0.0002–0.002 per call in [04 §2](04-categorization-and-ai-engine.md#2-the-pipeline). |
| Assistant question (narration) | **$0.0003–0.001** | [04 §12](04-categorization-and-ai-engine.md#12-cost-model): $0.30–1.00 per 1.000 narration calls. |
| Receipt (OCR + item classification) | **$0.002–0.006** | **Assumption — not covered by [04 §12](04-categorization-and-ai-engine.md#12-cost-model).** Validate in Phase 4, task 4.1.3 ([09 §6](09-implementation-plan.md#6-phase-4--receipts--mobile-weeks-1214-28-pd)); a local OCR fallback should drive it below $0.001. |
| Embeddings | ≈ $0.00 | Local model ⇒ effectively zero ([04 §12](04-categorization-and-ai-engine.md#12-cost-model)). |
| Early-phase multiplier | **3–5×** | Canonical: early cost runs 3–5× higher before memory accumulates, and is *"an intentional, budgeted customer-acquisition cost, not a surprise"* ([04 §12](04-categorization-and-ai-engine.md#12-cost-model)). |

Raw per-call arithmetic gives `0.25 × ($0.0002–0.0006) + 0.04 × ($0.0015–0.0030) = $0.00011–0.00027` per
logged entry — *below* the canonical band. **This document uses the canonical band**, which absorbs
retries, escalations and prompt overhead, so every margin below is a floor, not a best case.
**USD → RSD at 100,68:** $0.001 = 0.10 · $0.003 = 0.30 · $0.002 = 0.20 · $0.006 = 0.60 RSD.

### 4.2 AI cost per Household per month — steady state (median usage)

Family rows are the Household's **pooled** totals across Members; nothing is double-counted.

| Line | Free | Pro | Family |
|---|---|---|---|
| AI-assisted entries / month | 18 | 36 | 78 |
| → at $0.001–0.003 | $0.018–0.054 | $0.036–0.108 | $0.078–0.234 |
| → **RSD** (×100,68) | **1.8–5.4** | **3.6–10.9** | **7.9–23.6** |
| Assistant questions / month | 5 | 60 | 150 |
| → at $0.0003–0.001 | $0.0015–0.005 | $0.018–0.060 | $0.045–0.150 |
| → **RSD** | **0.2–0.5** | **1.8–6.0** | **4.5–15.1** |
| Receipts / month | 1 | 8 | 20 |
| → at $0.002–0.006 | $0.002–0.006 | $0.016–0.048 | $0.040–0.120 |
| → **RSD** | **0.2–0.6** | **1.6–4.8** | **4.0–12.1** |
| **Total AI cost / Household / month** | **$0.022–0.065** · **2.2–6.5 RSD** | **$0.070–0.216** · **7.0–21.7 RSD** | **$0.163–0.504** · **16.4–50.8 RSD** |

At Pro's median the AI bill is **7–22 RSD against 499 RSD of net revenue — 1.4–4.3 %**: the canonical cost model holds.

### 4.3 Gross margin per plan after VAT, processor fees and AI

**VAT.** Standard Serbian rate **20 %**; consumer prices are displayed VAT-inclusive, so the figures above
are gross and net revenue = gross ÷ 1,20. *Confirm registration and treatment with an accountant before
launch (§9.6).* **Processor fee.** Planning **2.5 %** of gross for a local acquirer on a recurring card
charge (§9.2). Per Household per month:

| | **Free** | **Pro** | **Family** |
|---|---|---|---|
| Gross | 0 | 599,00 | 999,00 |
| − VAT 20 % | 0 | −99,83 | −166,50 |
| **Net revenue** | **0** | **499,17** | **832,50** |
| − Processor @ 2.5 % of gross | 0 | −14,98 | −24,98 |
| − AI (median) | −2,2 … −6,5 | −7,0 … −21,7 | −16,4 … −50,8 |
| **Contribution / month** | **−2,2 … −6,5** | **462,5 … 477,2** | **757,0 … 791,1** |
| **Gross margin on net revenue** | n/a | **92,7 % … 95,6 %** | **90,9 % … 95,0 %** |
| **Gross margin on gross price** | n/a | **77,2 % … 79,7 %** | **75,8 % … 79,2 %** |

**The Free tier's AI cost is a marketing expense, not a cost of goods.** Tracked as **AI CAC** (§12), it is
the cheapest acquisition channel we have: at 2,2–6,5 RSD per Free Household per month, a Free user can be
carried for a year for under a tenth of the paid-social CAC in §11.

### 4.4 Gross margin at the fair-use ceiling (stress)

Every unit of every ceiling consumed, every month, at the top of the cost band:

| | **Pro** | **Family** |
|---|---|---|
| AI-assisted entries | 400 × $0.003 = $1.20 = **120,8 RSD** | 800 × $0.003 = $2.40 = **241,6 RSD** |
| Assistant questions | 400 × $0.001 = $0.40 = **40,3 RSD** | 800 × $0.001 = $0.80 = **80,5 RSD** |
| Receipts | 40 × $0.006 = $0.24 = **24,2 RSD** | 120 × $0.006 = $0.72 = **72,5 RSD** |
| **Total AI cost** | **185,3 RSD** | **394,6 RSD** |
| Contribution (net − processor − AI) | 484,19 − 185,3 = **298,9 RSD** | 807,52 − 394,6 = **412,9 RSD** |
| **Gross margin on net revenue** | **59,9 %** | **49,6 %** |

A Family Household maxing every quota is still contribution-positive — acceptable because it is a p99.9
scenario, and because metering a family's logging costs more in churn than it saves. The bound is enforced
by the per-household daily token budget and automatic model downgrade already specified in
[04 §12](04-categorization-and-ai-engine.md#12-cost-model) — with a user-visible notice on the settings
page, never a silent quality drop.

### 4.5 Early-phase cost (before memory accumulates)

The canonical 3–5× multiplier applies to the AI lines only.

| | Free | Pro | Family |
|---|---|---|---|
| AI cost, months 1–3 (median usage) | 2,2–6,5 × 3–5 = **6,6–32,5 RSD** | 7,0–21,7 × 3–5 = **21,0–108,5 RSD** | 16,4–50,8 × 3–5 = **49,2–254,0 RSD** |
| Contribution | −6,6 … −32,5 | **375,7 … 463,2 RSD** | **553,5 … 758,3 RSD** |
| Gross margin on net revenue | n/a | **75,3 % … 92,8 %** | **66,5 % … 91,1 %** |

**Reconciling with the launch gate** in [09 §7](09-implementation-plan.md#7-phase-5--hardening--beta-weeks-1516-14-pd)
(*"cost per active household ≤ 60 RSD/month at beta usage"*): the gate is **cohort-level** and it passes,
because beta is Free-dominated.

```text
Beta mix 90 % Free / 10 % Pro, early-phase (3–5×):
  0.90 × (6,6 … 32,5)   =  5,9 … 29,3 RSD
  0.10 × (21,0 … 108,5) =  2,1 … 10,9 RSD
  ──────────────────────────────────────────
  Blended cost / active household = 8,0 … 40,2 RSD   ✓ under 60 RSD
```

The gate fails only if beta skews Pro-heavy *and* usage sits at the 5× end — the signal to act, in this
order: (1) ship F-13 seeding earlier, since the ~60 seeded Merchants are the cheapest possible reduction
in AI share; (2) raise the escalation threshold so fewer low-confidence rows reach the large model;
(3) only then consider quota changes.

### 4.6 Sensitivity: what if AI cost is 2× or 5×?

Contribution per Household per month at median usage, at multiplicities of the §4.1 planning rate.

| | **1×** (plan) | **2×** | **5×** | Break-even multiple¹ |
|---|---|---|---|---|
| **Pro** — AI cost | 7,0 … 21,7 RSD | 14,0 … 43,4 | 35,0 … 108,5 | **48×** |
| **Pro** — contribution | 462,5 … 477,2 | 440,8 … 470,2 | 375,7 … 449,2 | |
| **Pro** — GM on net | 92,7 % … 95,6 % | 88,3 % … 94,2 % | 75,3 % … 90,0 % | |
| **Family** — AI cost | 16,4 … 50,8 RSD | 32,8 … 101,6 | 82,0 … 254,0 | **24×** |
| **Family** — contribution | 757,0 … 791,1 | 705,9 … 774,7 | 553,5 … 725,6 | |
| **Family** — GM on net | 90,9 % … 95,0 % | 84,8 % … 93,1 % | 66,5 % … 87,2 % | |
| **Free** — AI cost (our CAC) | 2,2 … 6,5 RSD | 4,4 … 13,0 | 11,0 … 32,5 | n/a |

¹ The multiple at which contribution reaches zero at median usage (Pro: 484,19 RSD post-processor net ÷
median AI cost; Family: 807,52 RSD likewise).

**The model is robust.** AI cost must inflate **48×** before Pro stops being contribution-positive at
median usage, so pricing here is not sensitive to model prices — only to *churn* and *conversion*, which
is where §8, §11 and §12 put the attention. Even at 5×, Pro still contributes ~376–449 RSD/month.

### 4.7 The v2 native route: app-store fees

[ADR-006](14-decisions-and-risks.md) makes v1 a PWA with no store fee; native shells are deferred by
[ADR-012](14-decisions-and-risks.md). If one ships, the economics change — quantified now so the decision
is made on numbers.

| | **Web (v1, PWA)** | **Native IAP (v2)** |
|---|---|---|
| Gross price | 599,00 | 599,00 |
| Store commission | — | Apple Small Business / Google Play subscription fee, planning **15 %** (30 % above the small-business thresholds) |
| Post-commission | 599,00 | 599,00 × 0.85 = **509,15** |
| VAT | −99,83 (we remit) | Platform typically acts as merchant of record and remits; developer receives ~85 % of the ex-VAT price |
| Post-commission, post-VAT | 499,17 | ≈ 499,17 × 0.85 = **424,29** |
| − Processor fee | −14,98 | included in the commission |
| − AI (median) | −7,0 … −21,7 | −7,0 … −21,7 |
| **Contribution** | **462,5 … 477,2 RSD** | **395,6 … 417,3 RSD** |
| **Revenue haircut vs. web** | — | **−12,4 %** (net of VAT) |

| Consequence | Detail |
|---|---|
| **It is a −12 % revenue decision, not a feature decision** | ~60 RSD per Pro Household per month. A shell must earn its place through retention, push reliability and store discovery — not convenience for us. |
| **A native iOS app cannot avoid IAP** | A budgeting app is not a "reader" app under guideline 3.1.1, and DMA external-purchase entitlements do not apply to Serbian consumers. Web purchase plus an entitlement-bearing companion is an option, but a deliberate, reviewed one. |
| **PWA-first is also the cheapest distribution** | A monetization argument for [ADR-006](14-decisions-and-risks.md) that belongs in [07](07-platform-strategy-mobile-desktop.md) when the native question is revisited. |

---

## 5. Free-tier guardrails

### 5.1 The quota is metered in AI calls, not entries

The counter increments **only** when an LLM call is made; Rules, keywords, Merchant defaults and entity resolution never increment it.

- The quota is exactly proportional to the cost we incur — no cross-subsidy, no resentment.
- A user who has taught the system their household (F-09, F-13) gets *more* free capacity over time,
  because the same 100 calls now cover more entries. **Learning is the reward** — the free tier directly
  incentivises the behaviour that builds the moat.
- Displayed honestly: *"AI-assist: 63 / 100 this month · your Rules handled 41 entries for free."*
  Showing rules-saved beside the quota turns a limit into a progress bar for the moat.

### 5.2 Graceful degradation, never a wall

**At no point can a user fail to record a Transaction, and at no point is typed text lost.**

| Stage | Trigger | What happens |
|---|---|---|
| 1 — Visible | 80 % of quota | Neutral counter in the capture chrome. No modal, no interstitial. |
| 2 — Notified | 100 % of quota | One in-app notice, about capability rather than scarcity: *"AI-assist is used up for September. Your Rules still classify everything they know — new merchants will be saved for review."* The upgrade link lives in **Settings**, per [04 §12](04-categorization-and-ai-engine.md#12-cost-model)'s "user-visible notice on the settings page" principle. |
| 3 — Degrade | Above quota | Capture still works end to end: `packages/nlp` segments and extracts amounts, dates and Merchants locally, and the Rules engine resolves what it can at zero cost. Anything unresolvable saves with `category_id = NULL` and `needs_review = true` — exactly the fail-soft path of [04 P-7](04-categorization-and-ai-engine.md#1-design-principles) and invariant **I-8** ([03 §5](03-domain-model.md#5-invariants-enforced-in-the-service-layer--tests)). Raw input is preserved. |
| 4 — Recover | Next period, or upgrade | Backlogged rows re-classify automatically: *"We sorted 12 of your saved entries."* A **delight moment, not an apology** — the pattern already designed in [04 §8.2](04-categorization-and-ai-engine.md#82-guardrails-the-user-is-not-always-right-and-neither-are-we). |

Manual entry (F-04) is unlimited on Free and untouched by the quota. Offline capture is unaffected
([05 §7](05-architecture.md#7-offline--multi-device-sync-f-26)) — the outbox holds the input until resolved.

### 5.3 Abuse prevention

The free AI quota is the only thing worth abusing, so every defence targets **identity churn, never usage shape**.

| Vector | Defence |
|---|---|
| Extra users for extra quota | Quota is **per Household** ([ADR-008](14-decisions-and-risks.md)), so extra Members share one counter. |
| Extra Households on one device | Velocity check: more than 2 new Households per device per 30 days triggers throttling and review. |
| Disposable-email farming | The **cold-start grant** (§5.4) requires a verified email; the base quota does not, so honest users are never blocked. |
| A user who simply logs a lot | **Not abuse** — a heavy free user is the best possible lead. The daily token budget from [04 §12](04-categorization-and-ai-engine.md#12-cost-model) bounds the worst case; the ceiling bounds the month. |
| Receipt-OCR farming (the costliest unit) | Free OCR is capped at 3/month and a Receipt must reconcile (I-6) before the count is consumed; failed OCR does not consume quota. |

### 5.4 Why the quota is generous enough to prove the product

| Reason | Detail |
|---|---|
| **It covers the proving period** | 100 AI-assisted entries ≈ 333 logged entries at steady state, and ≈ one full month of engaged logging for a Household with no Rules. |
| **Cold-start grant: 50 extra AI calls in the first 30 days** | A direct, budgeted answer to the onboarding cold-start risk named highest in [00](00-executive-summary.md#honest-assessment-the-three-things-most-likely-to-kill-this): it buys entries during exactly the window in which the AI is *worse* than a picker. Gated behind email verification so it cannot be farmed. |
| **F-13 seeding front-loads the rules share** | A meaningful slice of a new Household's entries never reach the model at all. |
| **The strategy requires it** | The moat is accumulated memory. A Free tier too tight to accumulate memory cannot produce the references and acceptance rate the business depends on. |

---

## 6. Paywall placement

### 6.1 Where upgrades are offered

Only after a **successful outcome**, never before or during one.

| # | Placement | Trigger | Mechanics |
|---|---|---|---|
| 1 | **Analytics depth** (F-20) | Scrolling past the 3-month Free window, or opening a year-over-year comparison | The chart renders the real shape: current period unblurred, locked region clearly labelled. Never an empty state, never a fake number. |
| 2 | **Receipt OCR quota** (F-14) | After the 3rd successful Receipt in a month | Inline note *under the last successfully itemised Receipt* — after value is delivered, never during upload or OCR progress. |
| 3 | **Rules ceiling** (F-09) | 25 active Rules reached | Offered in the Rule editor, framed as *"stop the review queue growing"*, not *"you have too many rules."* |
| 4 | **Assistant quota** (F-23) | After the 10th question | The 10th question is **answered in full**; the nudge follows in the same bubble. Never truncate an answer to sell an upgrade. |
| 5 | **Members** (F-29) | A second Member is invited | *"Include your partner in the household budget"* — a household outcome, not a licensing message. Family exists only from v2. |

### 6.2 Where an upsell must NEVER appear

A product constraint, not a style preference: each is a place where an upsell would cost more in trust than it could ever earn.

| # | Never here | Why |
|---|---|---|
| 1 | **During capture** (F-05, F-06) — not the input field, parse preview or confirm step | Capture is sacred (§1.2). Not even a badge. |
| 2 | **During a correction** (F-09) | Never, under any circumstance, when the user is fixing *our* mistake. Monetising our own error is the most destructive placement available to us, and it attacks the learning loop that is the moat. |
| 3 | **Inside an Alert** (F-22) | An Alert is a trust artifact on a channel we asked the user to grant us. A price in it poisons every future Alert, and alerts are a retention mechanic ([05 §9](05-architecture.md#9-notification-pipeline)). |
| 4 | **Inside the review queue's resolution flow** (F-08) | The queue is a consequence of low confidence; its *resolution* is free and unlimited everywhere. Only the *ceiling on Rules* is commercialised, and only outside the queue. |
| 5 | **On the offline / pending-sync tray** (F-26) | A user with unsynced money is anxious. Sell later. |
| 6 | **In the export flow** (F-25) | Export is free forever (§13) and carries no "while you're here" prompt. |
| 7 | **Anywhere in the first session**, including onboarding (F-13) | A seventh, paid step would be the last step a meaningful share of users complete. |

**The general rule:** an upsell may follow a *successful outcome*, and may never interrupt an *incomplete intention*.

---

## 7. Trial design

### 7.1 Recommendation

**14-day Pro trial · full Pro entitlements · no card required · granted once per Household · expiry steps
down to Free with nothing lost.**

| | Decision | Reasoning |
|---|---|---|
| **Length** | **14 days** | Two weekly cycles (~15–30 entries for a median user) is enough to accumulate real memory and see one month-end projection. Longer trials do not raise conversion in low-ARPU consumer products; they only delay revenue. |
| **Included** | Full Pro: unlimited AI-assist, 40 Receipts, full analytics, unlimited Rules | A partial trial cannot demonstrate the product — the thing being sold is the thing that must be experienced. |
| **Card required** | **No** | Serbian consumers are card-cautious online (§9.1). Card-required trials suppress starts by a large factor, and we do not need the card, because expiry is not a cliff. |
| **Expiry behaviour** | Steps down to Free | Nothing is deleted. Transactions, Rules and Budgets persist; only Pro-only surfaces lock. The user loses *capability*, never *data*. |
| **Re-trial** | Not automatic | One trial per Household. A returning user can buy Pro. |

### 7.2 Why "step down" is the whole design

The standard model needs a card because expiry must be a hard stop, and a hard stop needs a conversion
mechanism. **Our Free tier is genuinely useful (§1.1), so expiry can be a step down** — which removes the
card requirement, removes the dark pattern, and turns the end of the trial into a demonstration of the
pricing philosophy:

> *"Your trial ended. Your ledger, your Rules and your Budgets are all still here. AI-assist is now 100
> entries a month — here's what you'd get back with Pro."*

A user who was never going to pay loses nothing and remains a Free user and potential recommender; a user who was going to pay has had 14 days of the real thing and a non-hostile prompt.

### 7.3 Why 14 days and not 30

[00 §Success metrics](00-executive-summary.md#success-metrics) targets **≥85 % AI-parse acceptance by
week 4**. A 30-day trial would end exactly where the product first becomes excellent, pricing it against a
month-1 experience rather than a month-4 one. Fourteen days shows the *trajectory* — acceptance rising, the
review queue shrinking — and trial users also receive the 50-entry cold-start grant (§5.4), so the trial
gets extra AI budget to reach a representative experience faster.

**Also rejected:** a 7-day card-required trial (too short to demonstrate memory, and the card requirement
costs more starts than it gains) and a freemium "AI credits" pack (turns a subscription into a metered
utility, destroying the daily-use habit the product depends on).

---

## 8. Conversion levers, ranked by expected impact

| Rank | Lever | Mechanism | Expected effect | Cost to us |
|---|---|---|---|---|
| **1** | **Habit formation before the paywall** | D30 ≥ 25 % and ≥8 transactions/week ([00](00-executive-summary.md#success-metrics)) are the *preconditions* for conversion. A user who has logged for 30 days converts at a multiple of one who has logged for 3. | The largest single determinant of free→paid; every other lever is a multiplier on this one. | Zero — the Free tier working as designed. |
| **2** | **Receipt OCR** (F-14) | Highest perceived value per RSD of cost: a photographed Lidl basket itemised into Hrana *and* Higijena *and* Kuća is a visible magic trick a manual app cannot imitate. | The strongest single upgrade trigger. Free allows 3/month — enough to prove it, not enough to run on. | 0,20–0,60 RSD per Receipt (§4.1) — our highest unit cost, and worth it. |
| **3** | **Family sharing** (F-29) | 2× ARPU for far less than 2× cost, plus the retention multiplier of a shared ledger (§10). | Highest ARPU lift per unit of engineering, but gated on v2. | Marginal AI cost per added Member is near zero until the pooled ceiling binds. |
| **4** | **Annual plans** | Replaces 12 payment events with 1, prepays CAC, cuts effective churn ~3–4× (§11). | Improves cash flow, LTV and dunning exposure at once. Target ≥40 % annual mix by month 12. | 16.67 % of gross revenue, already priced in. |
| **5** | **Assistant usage** (F-23) | The delight trigger: a user who asks *"koliko sam potrošio na hranu ovog meseca?"* and gets a correct, cited, provably computed answer has experienced the core claim. | Strong on conversion *quality*, weaker on *rate* — Free's 10 questions may already satisfy the curiosity. Watch the data before investing. | 0,03–0,10 RSD per question. |

**Deliberately not on this list:** discounting, countdown timers, artificial scarcity, or any pressure mechanic. In a trust category they convert the few and lose the referrals the acquisition model depends on.

---

## 9. Serbian and regional market specifics

### 9.1 Card penetration and cash habits

Serbia issued a record **13,3 million payment cards** with rising card volume and fewer ATMs — card usage
is growing, but cash remains materially present for small, street and informal purchases.

| Implication | Detail |
|---|---|
| **`CASH` must be a first-class Account kind** | [03 §4](03-domain-model.md#4-schema-postgresql-16), F-01. A material share of Transactions will never appear on a statement — *precisely* why natural-language and manual capture is the wedge, and why the absence of Open Banking ([ADR-012](14-decisions-and-risks.md)) costs us less here than in a card-only market. |
| **Never assume a card statement exists** | Nothing in the billing or analytics flow may depend on card data for a given month. |
| **A cash-heavy user is still a paying user** | The proposition (know where the money went) is *stronger* where no bank app can reconstruct the picture. A pricing tailwind, not a headwind. |

### 9.2 Payment processors

| Option | Availability | Cost | Verdict |
|---|---|---|---|
| **Local acquirer** (NestPay / Banca Intesa, AllSecure, CorvusPay, Monri, PaySpot) | Available to a Serbian entity today | **2,2–3,5 %**; plan at **2,5 %** | **Primary for v1.** RSD cards, recurring mandates, local-language support. |
| **Stripe** | **Not directly available to a Serbia-located business** — evidenced by the prevalence of "open a Stripe account in Serbia via a US LLC" guidance | — | **Not viable without a foreign entity**, which adds tax and compliance complexity a 1–2 engineer team cannot absorb. Re-verify at Phase 5. |
| **Merchant of Record** (Paddle, Lemon Squeezy) | Available to Serbian sellers | **~5 % + $0.50** | **Only if a Western-European launch precedes local scale** — the extra ~2,5 points buy full EU OSS/VAT handling, wasteful before then. |
| **Direct carrier billing** (mts, Yettel, A1) | Available | **15–30 %** | **Not a default.** Viable as an *additional* method for **annual** plans and for users without a usable card; at 599 RSD/month the fee consumes the whole gross margin. |
| **IPS QR** (NBS instant payments) | Available, domestic | Near-zero | **Excellent for annual one-off payments**, unusable for recurring — an annual-payment method, not a subscription rail. |

**Sequencing:** local acquirer at launch → Merchant of Record when EU sales begin → carrier billing and IPS QR as *payment-method* additions for annual plans, evaluated in v2. Never more than one primary rail at a time; every additional rail is reconciliation work.

### 9.3 In-app purchase requirements if a native app ships

If a native iOS/Android build ships, digital subscriptions sold inside the app must use store billing on iOS — guideline 3.1.1, since a budgeting app is not a reader app and DMA external-purchase entitlements do not apply to Serbian consumers — at **15 %** under the small-business programmes and **30 %** above them. §4.7 quantifies the impact at **−12,4 % of net revenue**: a first-class reason to keep
[ADR-006](14-decisions-and-risks.md)'s PWA-first strategy for as long as it is defensible.

### 9.4 Price sensitivity and willingness to pay

| Anchor | Price |
|---|---|
| SkyShowtime via A1 (bundled) | **699 RSD/month** |
| Max via SBB (bundled) | **720 RSD/month** |
| Netflix Serbia — Basic / Standard / Premium | **€4.99 / €7.99 / €9.99** |
| Max — Standard / Premium | **€7.99 / €9.99** |
| SkyShowtime direct | **€5.99** |
| Average Serbian spend on streaming services and apps | **>€784/year across ~7.5 services** |

The Serbian digital-subscription wallet is real, habitually used, and anchored at **699–720 RSD/month**
locally and **€4.99–9.99** globally. **599 RSD is therefore deliberately below the local bundled-video
anchor**: Pro costs less than the Max add-on a household already buys through its telecom — a defensible,
explainable price in a conversation with a P2, and why the recommendation is 599 and not 799.

**Regional pricing: one regional price, not a matrix.** For Bosnia, Montenegro and North Macedonia the
RSD price converts acceptably and BAM/MKD rounding is trivial. Do **not** build a Balkan price matrix in
v1 — it adds billing complexity and arbitrage for a market that is a rounding error against Serbia
(consistent with Q-3 in [14](14-decisions-and-risks.md): regional expansion is a v2 exercise).

### 9.5 How pricing should differ (or not) from Western European norms

**Differ in absolute price; not in structure, and not in discount depth.**

| Dimension | Serbia | Western Europe | Our position |
|---|---|---|---|
| Absolute price | 599 RSD (€5.11) | €5–12 typical | **Lower**, anchored to local purchasing power |
| Annual discount | 16.67 % | 16–20 % | **Identical** — the convention is global |
| Plan structure | Free / Pro / Family | Free / Pro / Family | **Identical** |
| Card-required trial | No | Often yes | **Different, deliberately** (§7) |
| VAT handling | Local acquirer sufficient | OSS required | **Different** — a v1 simplification, not a permanent stance |

The structure is global because it is correct; the price is local because purchasing power is. **Never
convert a price across markets** (§2.3).

### 9.6 VAT and compliance assumptions to verify

Legal positions, not engineering decisions — and not tax advice. Confirm with an accountant before the
pricing page goes live:

1. Standard Serbian VAT **20 %** applies to the subscription, displayed VAT-inclusive.
2. The entity is **VAT-registered from day one** for electronic services — do not assume a small-supplier
   exemption survives contact with B2C digital-services rules.
3. EU consumer sales subsequently run through the **OSS/Union scheme** or a Merchant of Record.
4. Invoicing, refunds (including the statutory distance-selling withdrawal right, which is limited for
   digital services once performance has begun with consent) and dunning follow Serbian
   consumer-protection law.

---

## 10. Family plan mechanics

### 10.1 The mechanics

| | Decision |
|---|---|
| **Price** | 999 RSD/month · 9.990 RSD/year (€8.52 / €85.15) |
| **Seats** | **4 Members** — 1 `OWNER` + up to 3 (`ADMIN`, `MEMBER`, `VIEWER`; the role enum is canonical in [03 §4](03-domain-model.md#4-schema-postgresql-16)) |
| **Who pays** | The `OWNER`. Members never see a paywall, a price, or a request to pay; a Member hitting a household ceiling produces an **Owner-facing** notice. |
| **Billing unit** | The **Household** ([ADR-008](14-decisions-and-risks.md)) — the same boundary that owns the financial data. No per-Member billing, ever. |
| **Quota pooling** | AI-assist, assistant questions and Receipt OCR pool at Household level (400 → 800; 300 → 800; 40 → 120). |
| **Seat changes** | Members may be added or removed freely; price does not change between 1 and 4. A 5th Member needs a conversation, not a checkout. |

### 10.2 Shared versus private transactions — the privacy question

**The question:** can a Member hide a Transaction from the Household? **Recommendation for Family's
first release: no — the household ledger is fully shared.**

| Reason | Detail |
|---|---|
| **It is a structural change, not a toggle** | The tenancy boundary is the Household ([ADR-008](14-decisions-and-risks.md)) and every query is filtered by `household_id` ([05 §6](05-architecture.md#6-multi-tenancy)). Per-Member visibility needs a visibility predicate in the tenancy layer, a new `Transaction` column and — critically — an arithmetic change: invariant **I-5** ([03 §5](03-domain-model.md#5-invariants-enforced-in-the-service-layer--tests)) defines Budget consumption over the Household's Category subtree, so a private Transaction inside that subtree makes the Budget either wrong or unexplainable to the other Members. |
| **The correct design is specified but deferred** | Member-private spending must be excluded from shared Budget consumption and surfaced as an explicit, unattributed reconciliation line (*"Private spending this period: 8.400 RSD"*) so household totals still reconcile. A small product feature and a large invariant change: v2 work with its own test coverage, not something smuggled into v1. |
| **Honesty beats a feature that gets defeated anyway** | Forcing transparency in a household that does not want it does not produce transparency; it produces a second, secret ledger in a notes app, which destroys the data quality that makes the product valuable for *everyone* in the Household. Being explicit that Family is shared is more honest than a half-working privacy mode that silently breaks Budgets. |
| **Practical mitigation now** | A Member who genuinely needs a private ledger can hold their own Household (Free supports one). It costs us nothing and does not compromise the shared arithmetic. |

Recorded as an **open decision for [14](14-decisions-and-risks.md)** — it requires a schema addition, an
invariant amendment and a test suite, and must not be resolved by implication.

### 10.3 Why the Family plan is strategically important

| Reason | Detail |
|---|---|
| **The retention multiplier** | A Household where the P2 household CFO ([01 §1](01-product-requirements.md#1-target-users)) is an active Member is one whose ledger is load-bearing for the family's decisions — and a ledger two people rely on is far harder to churn. |
| **ARPU multiplier at near-zero marginal cost** | ~2× revenue against a marginal AI cost that only matters if the pooled ceiling binds, which it rarely does (§4.4). |
| **It matches how money actually works here** | The source concept's own example — a CFO, a partner and children, shared Budgets with individual spending — is the shape of a Serbian household's finances. Not a Western "family plan" bolt-on, but the primary use case for P2. |
| **The one plan a generic classifier cannot match** | The memory is per-Household and compounds with every Member who corrects and teaches it. |

---

## 11. Retention and churn economics

### 11.1 Churn assumptions

| Plan | Monthly churn (year 1, blended) | Monthly churn (mature) | Basis |
|---|---|---|---|
| **Free** | 12–18 % | 8–12 % | Category norm for a useful free utility; mitigated by the ≥25 % D30 target in [00](00-executive-summary.md#success-metrics). |
| **Pro, monthly billing** | **5.0 %** | **3.0 %** | Low-ARPU consumer subscription, post-habit. Steady state; months 1–3 run higher. |
| **Pro, annual billing** | **1.8 %** | **1.4 %** | Equivalent to ~20 % annual non-renewal. |
| **Family, monthly** | **2.5 %** | **1.5 %** | Two or more active Members. |
| **Family, annual** | **1.0 %** | **0.8 %** | |

Annual billing reduces effective monthly churn **~3–4×** — the mechanical reason annual plans are lever
#4 in §8, not merely a cash-flow trick.

### 11.2 LTV

LTV = contribution per month ÷ monthly churn, using the §4.3 median contribution.

| Plan | Contribution / month | Churn | **LTV** | LTV on annual billing |
|---|---|---|---|---|
| Pro (monthly) | 469,8 RSD (mid of 462,5–477,2) | 5,0 % | **9.396 RSD** (€80) | — |
| Pro (steady state) | 469,8 RSD | 3,0 % | **15.660 RSD** (€133) | **26.100 RSD** at 1,8 % |
| Family (monthly) | 773,9 RSD (mid of 757,0–791,1) | 2,5 % | **30.956 RSD** (€264) | — |
| Family (steady state) | 773,9 RSD | 1,5 % | **51.593 RSD** (€440) | **77.390 RSD** at 1,0 % |

**Blended LTV across a 75/25 Pro/Family paying mix on monthly billing: ≈14.800 RSD (€126).** Family's LTV
is **2–3×** Pro's on a plan priced at 1,7× — the clearest quantitative argument in this document for the
Family plan's strategic weight (§10.3).

### 11.3 CAC by channel

| Channel | Assumed CAC | Notes |
|---|---|---|
| **Word of mouth / referral** | **300–600 RSD** | The primary channel by design. Cost is the referral credit (2 months free on annual), not media. Depends entirely on D30. |
| **Organic content / SEO / community** | **0–400 RSD** | Serbian-language content on household budgeting. Slow, compounding, cheap — and the one channel a generic classifier cannot copy. |
| **Paid social (Meta/Instagram)** | **800–2.000 RSD** | Local CPMs ~€2.50, ~1.2 % CTR, ~12 % landing→trial, ~25 % trial→paid ⇒ ≈€7 ≈ 820 RSD at the efficient end. |
| **App-store discovery** | **400–900 RSD** | Only from v2, and it carries the −12 % haircut of §4.7. |
| **Free-tier AI cost (AI CAC)** | **2,2–6,5 RSD per Free Household per month** | §4.3 — the cheapest per-unit acquisition cost in the table, which is why §5 protects it rather than starves it. |

**Blended CAC target: ≤ 1.500 RSD.**

### 11.4 Target ratios

| Metric | Target | Current model |
|---|---|---|
| **LTV : CAC** | **≥ 3 : 1** | Pro monthly: 9.396 ÷ 1.500 = **6,3 : 1**; at a pessimistic 2.000 RSD CAC = **4,7 : 1** ✓ |
| **CAC payback** | **≤ 6 months** | 1.500 ÷ 469,8 = **3,2 months** ✓ |
| **Annual-plan CAC payback** | **≤ 1 month** | A Pro annual at 5.990 RSD gross covers a 1.500 RSD CAC on day one ✓ |
| **LTV : CAC, Family** | ≥ 5 : 1 | 30.956 ÷ 1.500 = **20,6 : 1** ✓ |
| **Free → paid conversion** | **≥ 4 %** of D30-active Free Households | Established at beta. Below 2 % the Free tier is a charity and the quota must be revisited. |

### 11.5 The retention metric that matters most

[00 §Success metrics](00-executive-summary.md#success-metrics) names **D30 retention (≥ 25 %)** and
**AI-parse acceptance rate (≥ 85 % by week 4)**. These predict revenue better than NPS because:

| Reason | Detail |
|---|---|
| **They measure behaviour, not sentiment** | NPS is a stated preference from a small, self-selected sample. D30 is measured on every Household and acceptance rate on every entry — census data on the exact unit that pays. |
| **Acceptance rate drives the correction burden, which is the tax on the habit** | Every correction is a moment the product asked the user to do work it promised to do. [04 §6.4](04-categorization-and-ai-engine.md#64-confidence-calibration) names a nuisance review queue as a churn driver; acceptance rate *is* the inverse of that queue. |
| **They compound in the right direction** | Acceptance rises as the Household's memory grows, so it predicts *future* LTV, not just current engagement. A high-NPS user with a flat acceptance rate churns when the novelty fades. |
| **They are actionable, and they lead** | A falling acceptance rate points at the pipeline, prompt version, calibration or seeding — all ours. A falling NPS points at nothing. D30 and acceptance lead churn by 1–2 months, and leading indicators are the only ones you can still act on. |

**Operational rule:** any retention review reads **D30, D7, AI-parse acceptance rate, correction rate** —
in that order — and treats NPS as a qualitative input only.

---

## 12. Metrics to instrument from day one

Instrumentation is a launch gate, not a later task; the hooks already exist in
[05 §10](05-architecture.md#10-observability-hooks-built-in-from-day-one).

| # | Metric | Definition | Alert threshold |
|---|---|---|---|
| 1 | **Trial start rate** | Households starting a trial ÷ new Households | < 25 % ⇒ the trial is not being offered, or value is not landing |
| 2 | **Trial → paid conversion** | Trials converting ÷ trials started | < 15 % ⇒ trial length or included features are wrong |
| 3 | **Free → paid conversion, by trigger** | Conversion segmented by the §6.1 placement that preceded it | Any trigger < 1 % ⇒ remove or redesign it |
| 4 | **ARPU** (gross, net, per plan, per Member) | Net revenue ÷ paying Households | Any drop > 10 % MoM |
| 5 | **Expansion revenue** | Family seat additions + Pro→Family upgrades, reported separately from new revenue | < 5 % of new revenue by month 12 ⇒ Family is under-sold |
| 6 | **AI cost per Household as % of revenue** | §4.2 cost ÷ net revenue, per Household and per cohort | Median **> 8 %** ⇒ investigate · p95 **> 20 %** ⇒ act · any Household **> 35 % for 2 consecutive months** ⇒ review · **> 60 %** ⇒ abuse review |
| 7 | **Cohort AI cost / net revenue** | Total AI spend ÷ total net revenue | **> 12 %** ⇒ re-plan quotas |
| 8 | **Free-tier AI CAC** | AI cost per Free Household ÷ Free→paid conversion, as an effective CAC | **> 1.500 RSD** ⇒ Free costs more than paid social and must be tightened |
| 9 | **Quota exhaustion rate** | Free Households hitting 100 AI-assisted entries in a month | **> 15 %** ⇒ too tight, teaching users the product is limited; **< 2 %** ⇒ too loose to convert |
| 10 | **Degradation events** | Households entering rules-only mode (§5.2 stage 3) | Any rise in *mid-capture* degradation is a **P1** |
| 11 | **Annual mix** | Annual ÷ total paying Households | < 25 % by month 6 ⇒ re-work the annual presentation |
| 12 | **Involuntary churn** | Failed-payment cancellations ÷ total cancellations | > 30 % ⇒ dunning is the problem, not the product |
| 13 | **Rules-share of entries** | Entries resolved by Rules/keywords/merchant default ÷ all entries | < 60 % ⇒ memory is not compounding; check F-09 and F-13 |
| 14 | **AI-parse acceptance rate** | Entries needing no correction ÷ AI-assisted entries | < 85 % at week 4 per Household ([00](00-executive-summary.md#success-metrics)) |
| 15 | **Receipt OCR success rate** | Receipts reconciling within 1 minor unit (I-6) ÷ Receipts uploaded | < 85 % ⇒ the marquee paid feature is not delivering, and OCR is lever #2 in §8 |

**Cadence.** #6, #7, #8 and #9 weekly — they are the ones that can invalidate the model inside a quarter.
Everything else monthly.

---

## 13. What stays free forever

Stated as a **public commitment**, publishable verbatim on the pricing page. These are not "free tier
features"; they will never be monetised, on any plan, including Free.

| # | Commitment | Why it is permanent |
|---|---|---|
| 1 | **Manual entry** (F-04) — unlimited, forever | §1.2. Recording a Transaction is the product's most basic promise and cannot be rationed. |
| 2 | **Full export, CSV + JSON** (F-25) — unlimited, no watermark, no trial, no account state required | Required by [01 §7](01-product-requirements.md#7-non-functional-requirements) ("no lock-in") and by GDPR portability ([08](08-security-privacy-and-compliance.md)). Charging for export is data hostage-taking. |
| 3 | **Full history retention** — nothing is ever deleted, hidden or truncated to force an upgrade | A money app that holds your past hostage has forfeited the trust the product depends on. |
| 4 | **Rules-based categorisation** — the deterministic engine, unmetered and unlimited | §1.3. It costs us $0.00; charging for it would be charging for compute we did not buy. |
| 5 | **Corrections and "Zapamti za ubuduće"** (F-09) — unlimited | Fixing our mistake can never be a paid action. It is also the learning loop that builds the moat — paywalling it starves the asset. |
| 6 | **Reading your own ledger** — the Transaction list, search and basic filters (F-24) | You may always see your own money. |
| 7 | **In-app Alerts** (F-22, `IN_APP`) — the safety net | An alert that only fires for payers is not a safety net, and alerts are a retention mechanic ([05 §9](05-architecture.md#9-notification-pipeline)). Paid plans buy *more channels*, never the warning itself. |
| 8 | **Data deletion and GDPR rights** — export, purge, consent withdrawal | Legal obligation and ethical floor. |

**The reasoning, stated once:** trust and data ownership must never be monetised. In a money app, the
user's belief that the product is on their side *is* the product. Every 599 RSD earned by renting back a
user's own data would cost multiples of that in the word-of-mouth channel this business is built on — and
a P1 only refers a P2 ([01 §1](01-product-requirements.md#1-target-users)) if the P1 believes we would
never do it.

---

## 14. Risks to the model

| # | Risk | Signal we would see | Mitigation |
|---|---|---|---|
| 1 | **AI cost inflation** — model prices rise, or usage shifts the rules/AI mix | Metric #6 rising; rules-share (#13) below 60 % | **The model tolerates 48× cost inflation before Pro breaks even** (§4.6) — a margin-quality risk, not an existential one. Structural: [ADR-007](14-decisions-and-risks.md) provider-agnostic routing moves tasks to a cheaper provider or a local model without a rewrite, and `PARSE`/`EMBED` already default to `LOCAL` ([04 §9](04-categorization-and-ai-engine.md#9-ai-provider-abstraction)); the daily token budget and automatic downgrade already exist ([04 §12](04-categorization-and-ai-engine.md#12-cost-model)). Commercial: annual prepay locks revenue against a mid-term cost rise. |
| 2 | **A bank bundles the same capability for free** | Falling trial starts where an incumbent bank is strong; "my bank does this" in feedback | Banks see **one** Account — not the other bank, not the cash, not the informal spending — and have neither the incentive nor the architecture for a per-household memory spanning institutions. Our wedge is multi-Account, cash-inclusive, household-scoped and memory-compounding, and `CASH` matters most in exactly this market (§9.1). Options in order: (a) compete on the cash/multi-account/household axis; (b) white-label the engine to a bank or telecom — a distribution deal, not a defeat; (c) hold price at 599 RSD, since Free is already our price weapon. |
| 3 | **Payment friction** — card-cautious consumers, less reliable mandates, Stripe unavailable | Trial starts healthy but trial→paid (#2) below 15 %; involuntary churn (#12) above 30 % | §9.2: local acquirer as primary rail (2,5 %); annual plans to cut 12 payment events to 1; IPS QR for annual one-off payments; carrier billing only as an annual-plan method. The card-free trial (§7.1) removes the highest-friction step in the funnel entirely. Dunning and card-update flows are part of the Phase 5 launch gate ([09 §7](09-implementation-plan.md#7-phase-5--hardening--beta-weeks-1516-14-pd)). |
| 4 | **Platform fee changes** — Apple/Google raise commissions or tighten external-purchase rules | Announced terms changes; ARPU (#4) stepping down with no pricing change | v1 is a PWA ([ADR-006](14-decisions-and-risks.md)) and pays **zero** platform fee — the best structural defence, at no cost while native stays deferred ([ADR-012](14-decisions-and-risks.md)). If native ships, the −12 % haircut of §4.7 is already quantified. Web purchase plus an entitlement-bearing companion remains the fallback, subject to store review. |
| 5 | **Free-tier AI cost exceeds its conversion value** | Metric #8 above 1.500 RSD while #9 is also above 15 % | The quota is metered in the thing that costs money (§5.1). Levers in order: ship F-13 seeding harder (raises rules-share, §4.5); shorten the cold-start grant from 50 to 25 entries; lower the Free quota from 100 to 75. **Never** throttle capture — every lever acts on AI-assist quality only. |
| 6 | **Adverse FX** — RSD pricing against USD-denominated model costs | Metric #6 drifting with no usage change | At 1 USD = 100,68 RSD, a 20 % RSD depreciation raises Pro's AI cost from 7–22 RSD to 8,4–26 RSD — **~1 % of net revenue**. Immaterial now, but re-base these tables annually and treat a sustained >25 % move as a trigger to re-check §4.6. |
| 7 | **The Free tier cannibalises Pro** | Metric #3 falling across all triggers while D30 stays healthy | The deliberate risk of §1.1, and the correct side to err on: a Free user who never pays but refers two payers is worth more than a coerced subscriber. If it becomes real, deepen **Pro's** value (more OCR, deeper analytics, earlier access to new capability) — never remove Free value already promised in §13. |

**Open decisions for [14](14-decisions-and-risks.md)** (listed without ADR numbers — the ADR log assigns
them): the Member-private Transaction visibility model (§10.2); the primary payment rail and whether a
Merchant of Record is adopted at launch or at EU expansion (§9.2); the VAT registration position (§9.6);
and confirmation of the Receipt OCR unit cost, the one AI line
[04 §12](04-categorization-and-ai-engine.md#12-cost-model) does not cover (§4.1).
