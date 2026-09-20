# 13 — Brand & Naming

**Status:** Proposal under [ADR-014](14-decisions-and-risks.md) (product name undecided) · **Owner:** product lead · **Blocks:** nothing in Phase 0; everything public from Phase 5 onward.

> **Decided 2026-09-17: the product name is `FinMate`** — the owner's decision, recorded in
> [ADR-014](14-decisions-and-risks.md#adr-014--product-name-is-undecided-finmate-is-a-working-title-only)
> and carried as **R-28**. This document's screening still says the opposite, and that is deliberate: the
> analysis below is what the risk is measured against, and **no trademark, domain or app-store check was
> run**. Read the recommendation as advice the owner declined, not as a stale conclusion.
>
> **TL;DR (screening result, unchanged).** The working title **FinMate is unusable** — it is an existing finance product, as are
> **Finora, Finio** and **Monevo** (established in the source conversation). [ADR-014](14-decisions-and-risks.md)
> records the name as *undecided*. This document fixes the weighted criteria, scores the source
> conversation's 20 candidates, adds 20 new ones, and **recommends `Ostava`**, with `Vedro` and
> `Talir` as runners-up. It becomes a decision only after the screening checklist in
> [§6](#6-screening-process-ordered-checklist) passes. The rename is ~4 person-days of mechanical work
> ([§11](#11-rename-execution-plan)) and must land **before the first public PWA install**.

## 1. The naming problem

### 1.1 What is already true

The source concept conversation ([`chatgpt-share-transcript.md`](chatgpt-share-transcript.md),
"Planiranje AI budžetske aplikacije") closed with a naming round in which four candidates were
**knocked out by existing products**, verified by web search inside that session:

| Candidate | Why it is out | Where established |
|---|---|---|
| **FinMate** | Existing finance product; still the repo directory and every doc header | Source conversation, final answer |
| **Finora** | Existing finance product | Source conversation, final answer |
| **Finio** | Existing finance product | Source conversation, final answer |
| **Monevo** | Existing budget/finance app | Source conversation, final answer |

That conversation's own conclusion was to run "30 completely new names + Google/App Store/GitHub/domain
checks", then choose. **That round never happened.** This document is that round.

The name is currently baked in exactly three cosmetic places: the workspace directory `finmate/` and
the monorepo root in [05 §2](05-architecture.md#2-monorepo-layout); the title block of
[README.md](README.md) and the working-title line in [00](00-executive-summary.md#recommendation); and
nothing else. There is no `@finmate/*` scope in code, no deployed environment, no user, no domain, no
trademark.

### 1.2 Why the default fails

Three independent axes, any one disqualifying:

- **Similarity.** It is already a finance app. Even without a registered mark, sharing a name with an
  existing household-finance product means app-store rejection, SEO loss, and a permanent support
  burden ("no, the *other* FinMate").
- **Meaning.** `Fin-` for finance plus `-Mate` for companion is a 2015-era pattern, reading as a helper
  *for* money rather than the Household's own record *of* money — the opposite of [§7](#7-brand-positioning).
- **It does not survive a rename-free future.** The path in
  [00](00-executive-summary.md#what-we-are-building-scope) runs capture → Budgets → SavingGoals →
  Family sharing → v2 native (ADR-012). `-Mate` caps it at "budget buddy".

### 1.3 ADR-014 — the record

> **ADR-014 — Product name is undecided; FinMate is a working title only.**
> **Status:** Open. **Context:** FinMate, Finora, Finio and Monevo are existing finance products; the workspace and doc headers nonetheless use FinMate.
> **Decision:** the product name is *not* FinMate, and stays unresolved until the screening checklist below is executed.
> **Amended 2026-09-17:** the owner decided the name **is** `FinMate` (ADR-014's amendment, R-28) without executing that checklist.
> **Consequences:** (a) no user-facing artefact may ship named FinMate; (b) everything expensive to rename later — the PWA manifest name, the npm scope (ADR-004), the email sending domain, the storage bucket prefix, the legal trading name — is deferred or built behind one constant; (c) the name must be frozen before public beta, at the Phase 5 gate ([09 §7](09-implementation-plan.md#7-phase-5--hardening--beta-weeks-1516-14-pd)).
> A rename is a configuration change, not a refactor ([§11](#11-rename-execution-plan)).

This document does **not** add a new ADR for the chosen name. ADR-014 stays Open until
[§6](#6-screening-process-ordered-checklist) clears one candidate; the recommendation below is what
enters screening.

### 1.4 The cost asymmetry

| When the rename happens | What it costs |
|---|---|
| **Now (Phase 0–1)** | ~4 pd of mechanical work, a domain or two, one email-domain verification. No users, no data migration, no schema change (ADR-005 is unaffected — no table or column contains the product name). |
| **After public beta** | Everything above, **plus** a PWA `name`/`short_name` that does not retroactively relabel installed devices (ADR-006 makes installs the primary mobile channel), store listings and reviews once native shells land (ADR-012), indexed backlinks, press mentions, users' vocabulary, email reputation and DMARC warm-up, and any trademark filing already paid for. |

Roughly **4 person-days now versus a permanently diluted brand later**. That is the whole argument for
two days on this document in Phase 1 rather than two weeks in Phase 6.

## 2. Naming criteria, weighted

Scored 0–10 per criterion; weighted total out of 100. Weights deliberately front-load the criteria that
are **expensive or impossible to fix after launch**.

| # | Criterion | Weight | A 10 looks like | A 2 looks like |
|---|---|---|---|---|
| C1 | **International pronounceability** — Serbian and English speakers both say it correctly, first try | **20** | `Vedro` — both read it identically | `Novčić` — English speakers cannot produce `č`/`ć`, or spell it back |
| C2 | **Short** — ≤ 3 syllables, ≤ 7 letters preferred | **12** | `Talir` — two syllables, five letters | `PametniBudžet` — six syllables, untypeable for half the market |
| C3 | **Brandable, not descriptive** — a metaphor, not a label | **15** | `Ambar` — says nothing about finance, everything about household stores | `BudžetAI` — literally "budget AI" |
| C4 | **Language-neutral** — not tied to one language's word for money | **10** | `Numa` — no meaning in any of our four languages | `Kasa` — a German/Serbian noun for a cash register |
| C5 | **Trademark-screening viability** — thin or empty field in Nice classes 9, 42 (36 if we ever hold money) | **15** | a coined word with no incumbents | `Moneta` — an existing European retail bank |
| C6 | **Domain availability** — `.com`, then `.app`, then `.rs`, then one honest fallback | **12** | a coined word with `.com` at registration price | `Penny` — a pan-European retail chain owns the term |
| C7 | **No unfortunate meaning** in Serbian, English, German or Italian | **8** | `Ostava` — neutral to positive in all four | `Vaga` — "vague" in Italian, the opposite of the promise |
| C8 | **Room to grow** beyond "budget app" — survives Family sharing, SavingGoals, v2 native | **8** | a name about the household, not about spending | `Spendwise` — permanently frames the product as expenditure |

**Two hard disqualifiers, applied before any total is read.** (1) **Already in use** by a finance
product, or by a well-known product in an adjacent tech category (smart-home brand, messaging company,
supermarket chain) — a high total never rescues this. (2) **An unfortunate meaning** in Serbian,
English, German or Italian: C7 at ≤ 4 disqualifies rather than deducts.

**Tiebreak rule.** Totals within **3.0 points** are a tie, broken on the **raw sum of C5 + C6** — the
only two criteria money cannot repair after launch. Applied in [§5](#5-recommendation).

**Score convention.** Tables show raw subscores in the fixed order `C1/C2/C3/C4/C5/C6/C7/C8`, then the
weighted total.

## 3. The source conversation's candidates, scored

### 3.1 Scores

| Candidate | C1/C2/C3/C4/C5/C6/C7/C8 | Total | Verdict |
|---|---|---|---|
| **Spendora** | 9/7/8/8/6/7/9/6 | **75.8** | Reject — `spend-` frames the product as expenditure, the opposite of "know where your money went" |
| **Numa** | 9/10/8/9/4/5/9/7 | **75.8** | Reject — thin but crowded software/telecom field; `.com` unreachable |
| **Nomi** | 9/9/7/8/4/5/9/7 | **72.1** | Reject — existing AI-companion and retail-analytics companies |
| **Monevia** | 9/7/7/7/5/6/9/6 | **70.6** | Reject — `money-` cliché; too close to the existing `Monevo` |
| **Savora** | 9/7/8/8/3/5/9/7 | **69.7** | Reject — **an established European condiment brand**; `save-` also narrows the product |
| **Milo** | 9/9/8/8/2/3/9/6 | **67.4** | Reject — **Milo** is a Nestlé beverage sold in every Serbian supermarket |
| **Monexa** | 8/8/6/6/5/6/9/5 | **66.5** | Reject — `money-` cliché by construction |
| **Finora** | 8/8/8/7/2/4/9/8 | **66.0** | Reject — existing finance product (§1.1) |
| **Finio** | 9/8/7/7/2/4/9/6 | **64.9** | Reject — existing finance product |
| **Monevo** | 9/8/7/8/2/3/9/6 | **64.7** | Reject — existing budget app, confirmed in the source conversation |
| **Spendwise** | 8/6/5/7/5/6/9/5 | **63.6** | Reject — `-wise` compound plus `spend-` framing; no mark strength |
| **Moneta** | 9/8/6/6/2/4/9/6 | **62.4** | Reject — **MONETA Money Bank** is a live European bank; class 36 conflict |
| **Cashly** | 8/6/4/6/4/6/9/4 | **58.8** | Reject — `-ly` cliché; `cash` limits the product to the balance |
| **Spendly** | 8/6/4/6/4/6/9/4 | **58.8** | Reject — `-ly` cliché plus `spend-` framing |
| **FinMate** | 6/9/5/6/2/4/9/6 | **56.1** | Reject — existing finance product; the current working title |
| **Kasa** | 7/9/5/6/2/4/8/4 | **55.7** | Reject — **TP-Link Kasa** is a well-known smart-home brand; also a generic noun |
| **Budgora** | 5/7/4/4/5/7/9/4 | **54.7** | Reject — collides sonically with `Angora`; ugly to say; `budget-` root |
| **Budgely** | 6/6/3/4/4/7/9/4 | **52.5** | Reject — `-ly` cliché plus a spelling trap (one `d` or two?) |
| **Novčić** | 2/7/5/2/4/8/8/4 | **47.1** | Reject — unpronounceable and unspellable outside Serbian; "little coin" is diminishing |
| **BudžetAI** | 3/6/3/2/4/7/9/3 | **43.7** | Reject — descriptive, language-bound; `AI` as a suffix dates instantly |
| *Also mentioned:* `HomeFin`, `FinAI`, `Novčanik`, `Pametni Novčanik`, `MojBudžet`, `PametniBudžet`, `Penny` | 40–63 | — | All rejected: descriptive, language-bound, or collided (`Penny` = a pan-European discount chain) |

### 3.2 The reject list, grouped

| Group | Names | Reason |
|---|---|---|
| **Taken — finance** | FinMate, Finora, Finio, Monevo, Moneta, Savora | Disqualifier 1. Direct category collision; app-store and SEO losses are permanent |
| **Taken — adjacent tech** | Kasa (TP-Link), Nomi (AI companion), Numa (multiple), Milo (Nestlé) | Disqualifier 1. Even outside classes 9/42 these dominate search for the term |
| **`-ly` / `-wise` / `-ora` suffix cliché** | Budgely, Cashly, Spendly, Spendwise, Spendora, Monexa, Monevia, Budgora | C3 ≤ 5. Ten thousand fintech startups; nothing registrable |
| **`money-` / `monet-` root** | Monevo, Monevia, Monexa, Moneta | C4 ≤ 7. Ties the brand to the one word every competitor uses |
| **`spend-` / `budget-` framing** | Spendora, Spendwise, Spendly, BudžetAI, Budgely, Budgora | C8 ≤ 5. Frames us as expenditure tracking — the category [00](00-executive-summary.md#why-this-is-a-real-opportunity) argues we are *not* in |
| **Serbian common nouns, no international life** | Novčić, Novčanik, Pametni Novčanik, Kasa, MojBudžet, PametniBudžet | C1/C2/C4. Unpronounceable for the English-speaking half of the team; unregistrable |
| **Unfortunate connotation** | Penny (trivialising, and a retail chain) | Disqualifier 2 |

**What the reject list teaches.** Every source candidate came from one of two exhausted families: *compound a finance word* (`fin-`, `money-`, `spend-`, `budget-`) or *compound a suffix* (`-ly`, `-wise`, `-ora`, `-eva`). The new shortlist inverts the brief: **no finance word at all, and no productive suffix.**

## 4. A fresh shortlist: 20 new candidates

Every name below is **absent from the source conversation**, avoids the `-ly`, `money-` and `budget-`
clichés, and is read correctly from the same spelling by a Serbian speaker and an English speaker.
Scores in [§4.2](#42-scores).

**Household-as-container metaphors** — the app is where the Household *keeps* things; this cluster maps
onto the moat in [00](00-executive-summary.md#why-this-is-a-real-opportunity).

1. **Ostava** — *pantry, larder; "the place where things are kept".* A real Serbian word, unused as a brand, and the metaphor is exact: the app is where a Household keeps its money history. → *"Where your household keeps its money."*
2. **Ambar** — *granary.* The Household's store of grain — but already a Serbian beer brand and a US restaurant chain, so C5/C6 pay for it. → *"Your household's storeroom."*
3. **Skrinja** — *chest, coffer.* Warm and specific, but the initial `skr-` cluster is a real pronunciation cost in English. → *"The chest the whole household can open."*
4. **Riznica** — *treasury.* On-message, but a common noun used by several regional brands, and three syllables with a soft `-ca`. → *"The household treasury."*
5. **Blago** — *treasure*, and a common endearment. Delightful in Serbian — but English slang *"blag"* means to scrounge or rob, disqualifying for a money app. → *"Blago — your household's treasure."*

**Clarity and calm** — the promise is "I actually know where the money went".

6. **Vedro** — *clear, serene (sky, water); cheerful.* Clarity without one finance cliché, and it sets the tone of [§8](#8-tone-of-voice) before a line of copy exists. → *"Clear money for your household."*
7. **Bistra** — *clear (water).* Same semantic target; weaker phonetics and a crowded regional field. → *"See your money clearly."*
8. **Vidik** — *view, horizon, outlook.* Excellent growth semantics (goals, foresight, planning) with a colder, more corporate sound. → *"See further with your money."*
9. **Izvor** — *spring, source.* Good, but "source" is what every analytics product claims, and the field is not empty. → *"The source of your household's money story."*

**Coin heritage** — a household money app may as well own a coin.

10. **Talir** — *thaler*, the silver coin that circulated in Serbian lands and the ancestor of "dollar". A coin with no coin cliché in the design, and a one-line story. → *"The household ledger, 500 years in the making."*
11. **Kovan** — from *kovanica* (coin); *kovan* alone means "forged, minted". Hard consonants, good wordmark; the deprecated Ethereum testnet of the same name is a minor discoverability tax. → *"Money, minted for your household."*
12. **Denara** — coined from *denar*, the currency of neighbouring North Macedonia, and Latin *denarius*. Clean field, but `-ara` drifts toward the `-ora` cliché. → *"Count what counts."*
13. **Zlatica** — *gold coin*, and also a flower. Warm and local; the `Zl-` cluster and three syllables cost it. → *"Small change, big picture."*

**Objects, tools, places** — neutral, ownable, no baggage.

14. **Sidro** — *anchor.* Trust and stability in two syllables, clean in Serbian — but *sidro* means "cider" in Italian, which is confusing rather than unfortunate. → *"An anchor for the household budget."*
15. **Fener** — *lantern* (a Balkan word via Greek and Turkish). Warm, small, memorable; the Fenerbahçe association is a mild discoverability tax outside Türkiye. → *"A light on the household money."*
16. **Kalem** — *spool;* also the root of Kalemegdan. Nice sound, thin field, opaque metaphor without explanation. → *"Everything your household spends, on one spool."*
17. **Zalog** — *pledge, deposit.* Strong for SavingGoals, reads slightly legal. → *"A pledge your household keeps."*

**Rhythm and routine** — the app is used daily, briefly.

18. **Ritam** — *rhythm.* Right for a daily-use product and for monthly money cycles; somewhat crowded as a regional brand. → *"The rhythm of your household money."*
19. **Sloga** — *concord, harmony* — literally the thing money causes fights about. Warm, but carries dated Yugoslav-era brand associations. → *"Money without the argument."*

**Disqualified inside the shortlist**, kept visible so the screen is honest:

20. **Zora** — *dawn.* The most beautiful name here and the best on language, but **Zora Labs** (a well-funded web3 company, `zora.co`) makes C5/C6 unfixable: a software trademark conflict and an unreachable `.com`. Also disqualified: **Zrno** (*grain*, the `Zr-` cluster) and **Grumen** (*lump of earth*, no metaphor, no warmth).

### 4.2 Scores

| Candidate | C1/C2/C3/C4/C5/C6/C7/C8 | Total |
|---|---|---|
| **Ostava** | 8/7/8/6/9/9/9/9 | **81.1** |
| **Vedro** | 8/10/7/7/8/8/9/8 | **80.7** |
| **Talir** | 8/10/8/7/7/7/8/9 | **79.5** |
| *Zora* — disqualified (Zora Labs, `.com`) | 10/10/9/9/4/4/9/8 | *78.9* |
| **Denara** | 8/7/8/7/8/9/8/7 | **78.2** |
| **Kovan** | 8/10/8/7/7/7/7/8 | **77.9** |
| **Ambar** | 9/10/8/7/5/5/9/9 | **76.9** |
| *Blago* — disqualified (EN slang) | 9/10/8/7/6/7/5/8 | *76.8* |
| **Vidik** | 7/9/7/6/8/8/8/9 | **76.5** |
| **Fener** | 8/9/7/6/7/8/7/7 | **74.6** |
| **Izvor** | 7/9/7/6/8/7/7/8 | **73.7** |
| **Ritam** | 8/9/7/7/6/7/8/7 | **73.7** |
| **Sidro** | 7/9/7/6/7/8/6/8 | **72.6** |
| *Zrno* — disqualified (`Zr-` cluster) | 5/9/7/6/8/9/8/7 | *72.1* |
| **Kalem** | 7/9/7/6/6/8/8/7 | **71.9** |
| **Zalog** | 7/9/6/6/7/8/7/7 | **71.1** |
| **Sloga** | 7/9/6/6/6/8/8/7 | **70.4** |
| **Skrinja** | 5/6/8/5/8/9/8/8 | **69.8** |
| **Bistra** | 7/7/6/5/7/8/8/7 | **68.5** |
| **Riznica** | 6/5/7/5/7/8/9/9 | **68.0** |
| **Zlatica** | 5/5/7/5/8/9/8/8 | **66.4** |
| *Grumen* — disqualified (no metaphor) | 6/7/5/5/8/9/7/6 | *65.7* |

## 5. Recommendation

### 5.1 Top choice — **Ostava**

**Score 81.1**, winning narrowly over `Vedro` (80.7). That 0.4-point gap is inside the 3.0-point tie
window, so the documented tiebreak applies and `Ostava` takes it on C5 + C6 (**18 vs. 16**): a Serbian
common noun that is not a finance word, is in nobody's app portfolio, and leaves `.com`, `.app` and
`.rs` plausibly buyable at registration price.

Why it is right for *this* product:

- **It means the right thing without saying "money".** *Ostava* is the pantry — where a Household keeps what it has; the product's job is to be where a Household keeps what it *knows* about its money.
- **It is household-scoped, not fintech-cold.** ADR-008 makes the Household the tenancy boundary from day one; a name about the household's stores agrees with the architecture.
- **It is clean where it is expensive to fix.** No finance or adjacent-tech incumbent, no unfortunate meaning in SR/EN/DE/IT, no suffix shared with a thousand startups.
- **It says nothing about spending.** The differentiation in [00](00-executive-summary.md#why-this-is-a-real-opportunity) is friction removal plus compounding household memory; a name meaning "spend" fights that forever.
- **It survives the roadmap** — capture → Budgets → Trends → Family → v2 native (ADR-012) — with no re-reading of the name.

The honest costs, recorded rather than hidden:

- **Three syllables** (`os-ta-va`). Users will shorten it; the wordmark must not depend on the full word
  being read.
- **It is a real, slightly old-fashioned Serbian noun.** Some Serbian speakers will hear "pantry" and
  find it rustic. That is a positioning choice: rustic-warm beats fintech-cold for a Household product,
  and it is why the German and Italian checks come back clean.
- **The Cyrillic form `Остава` is unambiguous**, which matters if the UI ever ships in Cyrillic (F-27
  requires Cyrillic *input* tolerance today, and only a Latin UI).

### 5.2 Runner-up 1 — **Vedro** (80.7)

*Clear.* The best name for the clarity story and the best phonetics on the list: two syllables, no
consonant cluster, identical reading in Serbian and English, positive in all four languages. It loses
the tiebreak on trademark breadth (a common adjective is harder to register) and on `.com`
reachability — not on meaning. **It is the fallback if `Ostava` fails C5/C6 in screening:** the same
strategy with a lighter metaphor.

### 5.3 Runner-up 2 — **Talir** (79.5)

*Thaler.* The strongest two-syllable option and the best brand story here ("the coin that became the
dollar"). It loses on C5/C6: *Talir* exists as a regional company name and a surname, so the field is
thinner than `Ostava`'s but not empty. **Choose it over `Vedro` if the wordmark and coin heritage
outweigh the extra trademark work** — the better mark, marginally worse on paper.

### 5.4 Positioning statement

> **Ostava is where your household keeps its money memory: write `Lidl 2000` the way you'd say it, and
> Ostava records it correctly, watches your Budget, and tells you what you can still safely spend today.**

| Locale | Tagline | Use |
|---|---|---|
| EN | *Where your household keeps its money.* | One-liner, store listing, OG card |
| SR | *Mesto gde tvoje domaćinstvo čuva novac.* | Landing, onboarding step 1 |
| EN | *Write it. It's recorded. It's watched.* | Capture-wedge marketing variant |
| SR | *Napiši kako govoriš — Ostava pamti.* | Capture-screen empty state |

### 5.5 What we are **not** naming it

No `fin-`, `money-`, `monet-`, `spend-`, `budget-`, `cash-`, `pay-` or `coin-` root; no `-ly`, `-wise`,
`-ify`, `-ora`, `-eva`, `-ex` or `-eo` suffix; no `AI`/`GPT`/`Neural` in the name (ADR-007 keeps the
*provider* swappable, and [00](00-executive-summary.md#why-this-is-a-real-opportunity) says the model is
a commodity — the brand must not be welded to it); no Serbian common noun for money (`novac`, `para`,
`dinar`, `kasa`); and no name needing a pronunciation guide, a hyphenated domain, or a numeral.

## 6. Screening process (ordered checklist)

Run the cheapest rejections first. Never pay for legal clearance on a list of twenty: this funnel
reduces twenty names to one **before** any money is spent.

| # | Step | Cost | Time | Kill criterion | Left |
|---|---|---|---|---|---|
| 1 | **Say-it-out-loud test.** Two Serbian and two English speakers (add German/Italian if available) read each name cold; a third person must **spell it from hearing it** | €0 | 30 min | Anyone mispronounces or misspells → out (C1) | 20 → 12 |
| 2 | **Serbian connotation review.** Native speakers check slang, dialect, homophones, historical/political baggage | €0 | 30 min | Anything a Serbian user would smirk at → out (C7) | 12 → 10 |
| 3 | **Search-engine collision.** `<name>`, `<name> app`, `<name> finance`, `<name> bank`; Product Hunt, Crunchbase | €0 | 30 min | A funded software company on page 1 → out (C5) | 10 → 7 |
| 4 | **App-store collision.** Apple App Store and Google Play search, including `short_name` candidates | €0 | 20 min | An installable app with the same name or icon idea → out | 7 → 6 |
| 5 | **Domain knock-out.** `.com` → `.app` → `.rs` (RNIDS); record the fallback (`get<name>.com`, `<name>app.com`) | €0 | 20 min | No `.com` **and** no honest fallback → out (C6) | 6 → 4 |
| 6 | **Handle + scope availability.** GitHub org, npm scope (needed by ADR-004), X, Instagram, LinkedIn, YouTube, TikTok, Reddit | €0 | 30 min | Active owners on every channel → deprioritise | 4 → 3 |
| 7 | **Trademark knock-out (free registers).** Serbian Intellectual Property Office (ZIS), EUIPO eSearch, USPTO TESS, WIPO Global Brand Database. Classes **9** (software), **42** (SaaS), **36** only if money ever moves | €0 | 1–2 h | Any live identical or near-identical mark in class 9/42 → **out** (C5) | 3 → 2 |
| 8 | **Domain purchase (defensive).** Buy `.com` + `.rs` for the survivor *before* any public mention, plus the obvious typo. Register the npm scope and GitHub org the same day | €30–90/yr | 1 h | — | 2 → 1 |
| 9 | **Formal clearance + filing.** Attorney-led search and application, Serbia first, EUIPO as the market expands | €300–800/class incl. fees | 2–8 weeks | Examiner objection or a cited prior mark → fall back to the runner-up | 1 |
| 10 | **T-0 re-verification.** Re-run steps 3, 5 and 7 immediately before public beta and before any press | €0 | 1 h | A new collision → escalate before launch | 1 |

Four rules keep this honest. (a) **Two candidates enter step 7, never one** — a dirty search must be a
five-minute pivot, not a full restart. (b) **Never accept a hyphenated `.com`**, and never accept a
parked `.com` at a five-figure price without first checking the runner-up. (c) **Never announce before
step 8** — publicity is what turns a €12 domain into a €12,000 domain. (d) **Do not fall in love during
steps 1–6**; nothing is real until step 7 clears.

### 6.1 What "clean" means at step 7

| Class | Coverage | Expected finding for `Ostava` |
|---|---|---|
| **9** | Downloadable software / mobile applications | No live identical mark |
| **42** | SaaS, hosting, software design and development | No live identical mark; `Ostava`-like marks in unrelated classes (food retail, logistics) do **not** block us |
| **36** | Financial affairs, if we ever hold or move money ([01 §8](01-product-requirements.md#8-explicit-non-goals-for-10) says we do not in v1) | Not filed in v1; revisit only if the product ever holds funds |

Distant marks in classes 29/30/35 (food, retail) are acceptable and expected for a dictionary word:
different channels, different consumers, no likelihood of confusion. **Any** software or SaaS mark is a
stop.

## 7. Brand positioning

### 7.1 The category we compete in

We are **not** competing in "expense trackers" — that category is defined by abandonment
([00](00-executive-summary.md#why-this-is-a-real-opportunity)), and entering it on its own terms loses.

> **Category:** the household's money record — an AI-first system that keeps the ledger itself, is
> taught once and remembers forever, and answers questions about the Household's own money.

The wedge, in the source conversation's own words: *"upiši kako bi rekao čoveku"* — write it like you'd
tell a person.

### 7.2 Pillars

| Pillar | What it means | Where it is enforced |
|---|---|---|
| **Frictionless capture** | One field is the primary input; `Lidl 2000` is a complete Transaction; median time-to-log ≤ 4 s | F-05, F-06, [00](00-executive-summary.md#success-metrics) |
| **Arithmetic you can trust** | The AI never owns state or arithmetic; the backend is the source of truth | ADR-001, ADR-003, [00](00-executive-summary.md#the-thesis-stated-precisely) |
| **It learns your Household** | `Lidl → Hrana`, `Dejan → Kuća/Septička jama`; Corrections become durable Rules, not fine-tuning | ADR-010, F-09, [04](04-categorization-and-ai-engine.md) |
| **Calm, not judgemental** | Money apps moralise; this one informs and offers the next action | [§8](#8-tone-of-voice), F-22 (positive feedback is a Must) |
| **Yours** | Household-scoped data, full export, hard delete in one action, provider and region choice | ADR-008, F-25, [08](08-security-privacy-and-compliance.md) |

### 7.3 Differentiation

| Against | Their promise | Their weakness | Our answer |
|---|---|---|---|
| **Manual budget apps** (spreadsheets, classic trackers) | Structure and reports | Every figure costs a form; week-two churn is structural | The Rules engine resolves most input at zero cost and zero latency (ADR-002); only genuinely ambiguous input reaches a model |
| **Generic "ChatGPT inside a finance app"** | A chat box bolted onto a ledger | The model computes the numbers, so it will eventually be wrong about money; no memory of *your* merchants | ADR-001: AI returns Proposals with confidence and the deterministic core persists facts; ADR-010: learning is rule synthesis; the assistant narrates pre-computed facts and may not introduce a numeral |
| **Bank-aggregator apps** | Automatic import | Unavailable for Serbian retail banking (ADR-012); no cash; no understanding of `Dejan rođa` | Cash-first, household-specific, works offline (F-26) |
| **Local Serbian budget apps** | Local language | Generic English-first classifiers, no memory, thin local Merchant coverage | A shipped seed of local Merchants and a ~40-node Serbian Category tree in onboarding (F-13) |

### 7.4 What the brand must never claim

No "AI-powered" as the headline — the AI is an implementation detail and ADR-007 keeps it swappable. No
"bank-level security" boilerplate. No "we'll save you money" promises. No figure that did not come from
the deterministic core.

## 8. Tone of voice

### 8.1 Principles

1. **Say the number, then the action.** Every message reporting a fact ends with something the user can
   do — or says explicitly that there is nothing to do.
2. **Never invent, never round silently.** Figures come from the deterministic core, quoted with their
   period and the count of Transactions behind them (ADR-001, F-23 acceptance criteria).
3. **Inform, do not judge.** No moralising; positive feedback is a first-class Alert kind (F-22) and
   must be as specific as the negative ones.
4. **Admit uncertainty in one line, then propose.** Confidence is normal, not an apology (ADR-009).
5. **Short sentences. Serbian first, not translated English.** Never port EN copy word-for-word.
6. **Second person singular (`ti`), not `Vi`,** in Serbian — the product belongs to the Household, not
   to a bank. `Vi` reads institutional and contradicts pillar 4 of [§7.2](#72-pillars).
7. **No jargon from this documentation set.** Users never see `ClassificationDecision`, `Proposal`,
   `Split` or `Counterparty`.
8. **No exclamation marks in alerts.** Calm is the brand; `!` is for marketing copy only.
9. **The AI never introduces a numeral.** If it narrates, the numeral must exist in its facts payload
   ([09 §5](09-implementation-plan.md#sprint-32-week-10--assistant-11-pd)).

### 8.2 UI lexicon: canonical term → user-facing word

Canonical vocabulary from [03](03-domain-model.md#1-glossary-canonical-vocabulary) stays in code, prose
and the API. Users see these words instead — and one of them is a trap.

| Canonical term | Serbian UI | English UI | Note |
|---|---|---|---|
| Household, Member, Category, CategoryKeyword, Budget, SavingGoal, RecurringRule | domaćinstvo, član, kategorija, ključna reč, budžet, cilj štednje, redovno plaćanje | household, member, category, keyword, budget, savings goal, recurring | One-to-one; no traps |
| Transaction, Split, Tag, ReceiptItem, Correction, Insight, Alert | transakcija (empty state: "unos"), podela, oznaka, stavka, ispravka, uvid, upozorenje | transaction, split, tag, item, correction, insight, alert | One-to-one; no traps |
| Account | **račun** | account | ⚠️ **`račun` also means "receipt" and "bill"** — never use bare `račun` for a Receipt |
| Merchant | prodavac | merchant | |
| Counterparty | osoba / firma | person / company | `Counterparty` must never appear in UI |
| Rule | pravilo | rule | The "remember this" affordance is *"Zapamti za ubuduće"*, per F-09 |
| Receipt | **slika računa / fiskalni račun** | receipt | Never bare `račun` — it collides with Account |
| ClassificationDecision | *(never shown)* | *(never shown)* | Surfaced as "Zašto?" with the deciding layer in plain words |
| Proposal | predlog | suggestion | The AI always *predlaže*; the user always *potvrđuje* |

### 8.3 Do / Don't

| Do (SR) | Don't (SR) | Do (EN) | Don't (EN) |
|---|---|---|---|
| „Dodao sam 3 transakcije." | „Uspešno ste izvršili unos!" | "Added 3 transactions." | "Success! Transaction created!" |
| „Hrana: 27.450 RSD ovog meseca (42 transakcije)." | „Potrošili ste mnogo na hranu." | "Food: 27,450 RSD this month (42 transactions)." | "You spend a lot on food." |
| „Lidl → Hrana (96%)." | „Greška u kategorizaciji." | "Lidl → Food (96%)." | "Classification error." |
| „Nemaš pravilo za 'Dejan'. Predlog: Kuća/Septička jama." | „Ne mogu da razumem unos." | "No rule for 'Dejan'. Suggestion: Home/Septic tank." | "I couldn't understand that." |
| „Podaci važe od 14:05." | *(stale figure with no timestamp)* | "Figures as of 14:05." | *(stale figure with no timestamp)* |
| „Odličan mesec — 8.200 RSD manje nego prošlog." | „Konačno nešto dobro!" | "Good month — 8,200 RSD less than last month." | "Finally, something right!" |

### 8.4 Hard moment 1 — telling someone they overspent

The user is already stressed. The job is to make the situation legible and give control back.

**Don't:** ⚠️ **Prekoračili ste budžet za hranu!** Trošite previše ovog meseca.

**Do:**

> **Hrana je na 118 % budžeta** — 4.200 RSD više nego što si planirao.
> Do kraja meseca ti ostaje 900 RSD dnevno ako želiš da ostaneš u okviru.
> [Pogledaj transakcije] [Izmeni budžet]

State the fact and its basis (percentage, absolute overrun, period) — never a bare judgement. **No
second-person accusation**: "Prekoračili ste" blames, "Hrana je na 118 %" describes. Always pair it with
the arithmetic of the remaining days (F-19 safe-to-spend, computed by the backend, never narrated into
existence). Offer exactly two actions — look at it, or change the plan; never "budget harder". Never
moralise about categories: food is not a sin, it is a Budget line. And never fire the same condition
twice, which makes `dedupe_key` a tone-of-voice requirement as much as a technical one
([05 §9](05-architecture.md#9-notification-pipeline)).

### 8.5 Hard moment 2 — explaining AI uncertainty

Uncertainty is where trust is won or lost, and a vague apology is worse than a specific question.

**Don't:** Nisam siguran u koju kategoriju ovo spada. 😕

**Do:**

> Za „Dejan" nemam pravilo. Predlažem **Kuća → Septička jama** (sigurnost 61 %).
> [Potvrdi] [Promeni] ☑ *Zapamti za ubuduće*

Name the gap ("nemam pravilo") — that is what makes asking acceptable. Always propose something, because
a question without a Proposal is a dead end. Show confidence as a number *and* a badge that agree (🟡 is
the ADR-009 band 0.60–0.89). Offer the permanent fix in the same breath — "Zapamti za ubuduće" (F-09,
ADR-010) — because uncertainty being a one-time cost is the product's core promise. **For the
assistant, refusing is a feature:**

> To ne mogu da odgovorim iz tvojih podataka. Mogu da ti kažem koliko si potrošio na hranu ovog meseca
> — da li te to zanima?

It suggests a question the ledger *can* answer (F-23) and never fabricates a figure.

### 8.6 Banned constructions

| Banned | Why |
|---|---|
| "Greška" / "Error" as a user-facing noun | The user did nothing wrong; say what happened and what to do |
| "Uspešno!" / "Success!" | Noise; the ledger updating *is* the feedback |
| "Nažalost…" / "Unfortunately…" | Pre-emptive apology; state the fact |
| "AI je zaključio…" | Anthropomorphising a classifier; say "predlog" |
| Any percentage the backend did not compute | ADR-001 |
| Emoji in place of a status token | Confidence badges are token-driven components (ADR-009), not emoji |
| "Pametni/pametno" as a value claim | Every app says it; the product must show it |

## 9. Visual identity direction

### 9.1 The constraint that shapes everything

The app already reserves **green, amber and red as semantic status colours** — `--color-danger` in the
token layer ([05 §5.4](05-architecture.md#54-design-system)) and the 🟢/🟡/🔴 bands of ADR-009 in the
badge component. **The brand palette must not compete with them, and must not reuse them.** Two
non-negotiable rules: **the brand colour may never carry a status meaning** (no good/bad, success,
error, or money direction), and **no status colour may ever be decorative** (red is never a warm accent,
amber never a highlight, green never a gradient stop).

### 9.2 Token inventory

| Token | Role | Reserved for | Never used for |
|---|---|---|---|
| `--color-brand` | primary identity colour | wordmark, primary CTA, active nav, selection | anything semantic |
| `--color-brand-strong` | pressed / high emphasis | dark-mode primary, hover | |
| `--color-brand-subtle` | tinted surface | selected rows, onboarding panels | |
| `--color-danger` | negative status | over-Budget, `CRITICAL` Alert, `VOID`, destructive confirm | ordinary EXPENSE amounts |
| `--color-warning` | attention | 🟡 (0.60–0.89 per ADR-009), `WARNING` Insight, pace risk | brand, INCOME |
| `--color-success` | affirmative | 🟢 (≥ 0.90), `POSITIVE` Insight, SavingGoal reached, INCOME | brand, generic "saved" toasts |
| `--color-info` | neutral system | sync/pending, `as of <time>` offline labels | |
| `--color-ink`, `--color-ink-muted` | text | **every money figure, by default** | |
| `--color-surface-*` | elevation ladder | dark mode, cards, sheets | |

**Colour direction.** Primary **deep indigo-violet** (~`hsl(258 55% 42%)`), a warm **sand/clay** accent
drawn from the pantry metaphor, near-neutral ink. Violet is the last high-trust hue quadrant once red,
amber and green are reserved and blue is staked out by every bank and accounting app; it also reads
"considered consumer" rather than "enterprise ledger", matching [§7](#7-brand-positioning).

**Enforce it in CI.** A unit test asserts that the perceptual distance between `--color-brand` and each
of `--color-danger`/`--color-warning`/`--color-success` exceeds a floor, and that no two semantic tokens
sit closer than that floor to each other. Drift becomes a red pipeline instead of a design review.

### 9.3 Money is ink, not colour

The obvious instinct — colour EXPENSE red and INCOME green — is **forbidden here**, because red and
green already mean *over budget* and *auto-applied with confidence*. Colouring every expense red would
make every screen look like an emergency and would destroy the 🟢 badge's meaning.

- Money renders in `--color-ink` by default; direction is carried by an explicit sign (`−`/`+`), the
  label, and layout position — never by hue.
- `--color-danger` marks a **state**, not a direction: `VOID` Transactions, over-Budget figures,
  `CRITICAL` Alerts.
- Income may use `--color-success` **only** where it is a state worth flagging (goal reached, `POSITIVE`
  Insight), not on every incoming row.
- Every money figure is rendered by `<ui-money>` ([05 §5.4](05-architecture.md#54-design-system)) with
  `Intl.NumberFormat` per locale and minor-unit conversion in exactly one place (ADR-003). Serbian
  formatting: `2.000 RSD` — `.` as the thousands separator, currency after the amount.

### 9.4 Data visualisation

Charts get their own six-tone categorical ramp (violet, teal, magenta, ochre-brown, slate, plum) chosen
to sit **outside** the status triad. Because roughly 8 % of men have a red-green deficiency, every
status or categorical distinction is backed by a **second channel** — a label, shape, pattern, or value
printed on the mark. Colour is never the sole carrier of meaning anywhere in the product.

### 9.5 Typography

| Slot | Direction | Constraint |
|---|---|---|
| **UI text** | `Inter` (or `Roboto Flex`) | Full Latin Extended-A — `č ć ž š đ` are required by F-27, not optional; add a Cyrillic subset only if a Cyrillic UI ever ships |
| **Money / figures** | the same family, with dedicated figure tokens (`--font-size-figure-lg/md/sm`) | **Tabular lining figures mandatory**: `font-variant-numeric: tabular-nums lining-nums`. Columns of amounts must align to the digit |
| **Wordmark** | a geometric grotesk with a distinctive `a`/`o`, licensed for embedding | Must exist in Latin *and* Cyrillic if the wordmark is ever localised (`Остава`) |
| **Serbian specifics** | verify Serbian Cyrillic italic letterforms (`б г д п т` differ from Russian) via the `locl` feature and the `sr` language tag | A typeface rendering Serbian Cyrillic as Russian Cyrillic is a visible, embarrassing defect |

No serif with old-style figures anywhere near money; no proportional figures in tables, receipts,
Budgets or charts. One type scale, with money getting its own sizes rather than borrowed heading sizes.

### 9.6 Logo

- **Wordmark-first.** The name is short and pronounceable; the mark should not need to carry meaning at
  16 px.
- **Monogram concept — the vessel.** Draw the `O` as an open-topped container: a pantry/chest silhouette
  that also reads as a shield. It is the name's meaning, and it avoids the three exhausted fintech
  clichés (piggy bank, coin stack, upward graph line).
- **Constraints:** legible as a favicon at 16 px; single-colour-capable; no gradients below 32 px; no
  red/amber/green in any state; works reversed on the dark surface ladder; maskable app icon with an
  80 % safe zone for Android adaptive shapes and iOS.
- **Deliverables:** wordmark (light/dark/mono), monogram, favicon set, maskable 192/512 icons, an OG
  share card, and an email-header lockup.

### 9.7 Iconography

Line style on a 24 px grid, 1.5–2 px stroke, rounded caps and joins — the visual equivalent of the calm
tone in [§8](#8-tone-of-voice). No solid/filled mixing within one context, and no multi-colour icons
outside empty states. Category icons are a **curated, versioned set referenced by stable name** in the
`categories.icon` column ([03](03-domain-model.md#4-schema-postgresql-16)), so the set can be restyled
without a data migration — and users can still pick an icon per Category node (F-02). Money direction
uses `↑`/`↓` glyphs plus sign and label, **never** red/green arrows. Confidence badges are token-driven
components (`confidence-badge` in `shared/ui`), not emoji: a colour dot plus a text label plus an
`aria-label`, so they are themeable, localisable and screen-reader-legible.

### 9.8 Dark-mode-first, and why

Ship both modes, default to `prefers-color-scheme`, and **design dark first**, for five reasons. Money is
checked at the edges of the day — the morning glance ("how much can I spend today?", F-19) and the
pre-sleep review — both dark-environment moments. The PWA *is* the mobile channel (ADR-006), and OLED
phones reward dark surfaces. It is nearly free, because [05 §5.4](05-architecture.md#54-design-system)
already mandates semantic roles over raw values, making dark mode a token remap rather than a second
stylesheet. Tabular money figures and chart lines hold up better on a dark surface ladder than on white.
And dark-first reads as considered and premium, supporting a paid tier
([12](12-monetization-and-pricing.md)) without shouting.

Caveats to check in both modes: **never pure black** (`#000`) — use a near-black surface ladder so
elevation is expressible; **desaturate brand hues ~8–12 % on dark** to avoid halation; **`--color-danger`
on dark is the classic failure** (red on near-black routinely misses the 4.5:1 floor required by
[01 §7](01-product-requirements.md#7-non-functional-requirements)), so verify every semantic token
against every surface it can appear on; and **dark-first is not dark-only** — long-form text, receipt
inspection and CSV review happen in daylight, so both modes are first-class and both pass WCAG 2.2 AA.

## 10. Naming risk register

| Risk | Likelihood | Impact | Mitigation | Trigger |
|---|---|---|---|---|
| **Pronunciation** — Serbian and English speakers say it differently, or cannot spell it after hearing it | Medium for `Ostava` (3 syllables), low for `Vedro`/`Talir` | Medium — every referral degrades; support cost forever | Step 1 of [§6](#6-screening-process-ordered-checklist) is a dictation test, not an opinion poll; ship an audio clip on the landing page; PWA `short_name` stays `Ostava` (7 chars, fits) | Any English speaker misspells it twice in one session |
| **Discoverability** — the name is unsearchable or buried under unrelated results | Low for `Ostava` (thin field), high for `Vedro` (common adjective) | Medium — paid acquisition costs more; organic referral weakens | Verify page 1 is empty at step 3; own `<name>.com` + `<name>.rs` and the store listing before launch; do not rely on search for six months — the wedge is word of mouth (P3 in [01](01-product-requirements.md#p3--marko-2230-cash-light-single-professional)) | An unrelated product on page 1 after step 3 |
| **Similarity to an existing product** — users confuse us with another app, or a reviewer does | Low for `Ostava` (no finance incumbent), **high** for every name in [§3.2](#32-the-reject-list-grouped) | High — store rejection, mistaken-identity support load, SEO dilution | Steps 3, 4 and 7 before any spend; a distinctive monogram and palette so the *icon* is unmistakable even if the name is close; `Vedro` and `Talir` kept warm | Any same-category app within edit distance 2, or a shared icon silhouette |
| **Legal** — a live trademark, an opposition, or a domain squatter | Low for `Ostava`, medium for `Talir` (existing company/surname) | High — forced rename after launch, plus costs | Free knock-out (step 7) → **two** survivors → attorney clearance and filing (step 9) in classes 9 and 42; domains bought the same day as the decision (step 8); never announce before step 8 | Any live class 9/42 mark, or a domain quote above registration price |
| **Rename fatigue** — the team keeps the working title because it is "just a folder" | **High** — this is how ADR-014 stays open for a year | High — the cost in [§1.4](#14-the-cost-asymmetry) doubles every phase | [§11](#11-rename-execution-plan) sets a hard gate at the end of Phase 1 and a Phase 5 backstop | The name is still FinMate at the Phase 1 exit review |

## 11. Rename execution plan

Everything below assumes ADR-014 resolves to a name other than FinMate. The claim in
[README.md](README.md) — *"it is a rename, not a refactor"* — is verified by the "deliberately not
changed" list below: nothing in the domain model, schema or AI pipeline is affected.

### 11.1 What actually has to change

| # | Artefact | Change | Effort |
|---|---|---|---|
| 1 | Repo directory + remote | `finmate/` → `<name>/`; Nx project names and `nx.json` references | 0.5 pd |
| 2 | npm package scope | introduce `@<name>/*` for `packages/*` (ADR-004), rewrite imports, claim the scope on npm before publishing | 0.5 pd |
| 3 | Angular app titles | `index.html` `<title>`, route titles, `apple-mobile-web-app-title`, splash and loading copy | 0.25 pd |
| 4 | PWA manifest (ADR-006) | `name`, `short_name`, `description`, `theme_color`, `background_color`, `start_url`, `scope`, icon set incl. maskable 192/512, screenshots. **Changing `name` after install does not reliably relabel installed icons** — the single strongest reason to rename before beta | 0.5 pd |
| 5 | Email sender | `noreply@<domain>` from-name, transactional templates, SPF/DKIM/DMARC records, Mailhog fixtures, and a fresh deliverability warm-up | 0.5 pd |
| 6 | Domains and DNS | register `.com` + `.rs` (and `.app` if cheap), TLS, apex/`www` redirects, OG and share-card images | 0.5 pd |
| 7 | Docs headers | [README.md](README.md) title and caveat block, the [00](00-executive-summary.md) recommendation line, this document, and the working-title line in every header carrying it | 0.25 pd |
| 8 | Infrastructure names | Docker Compose service names (ADR-013), container names, Sentry project/DSN, log service labels, storage bucket prefix — **free only before the first Receipt upload**; renaming a populated bucket is a copy, not a rename | 0.25 pd |
| 9 | Legal and ops | privacy policy, ToS, GDPR records ([08](08-security-privacy-and-compliance.md)), invoice and company trading name, store listings once native ships (ADR-012) | 0.5 pd |
| 10 | Verification | repo-wide grep for the old name returns zero hits outside the ADR log; CI green; manifest validated; PWA install tested on iOS Safari and Android Chrome; test email passes SPF/DKIM/DMARC | 0.5 pd |
| | **Total (mechanical)** | | **≈ 4.0 pd** |

External waiting time is separate from effort: DNS propagation 1–24 h, email authentication and
reputation warm-up days, trademark examination months, app-store review 1–7 days once applicable.

**Deliberately not changed:** the PostgreSQL database name, table names, object *keys* in storage,
`client_id`/`idempotency_key` semantics, migrations (ADR-005 — no table or column contains the product
name, so this is not a schema change), and any `ClassificationDecision` audit data. There is **no data
migration**.

### 11.2 Timing

| Gate | Deadline | Why |
|---|---|---|
| **Recommended** | **End of Phase 1 (week 5)** — before the design-system and copy pass hardens strings and tokens | Strings, tokens and the manifest are cheapest to change before Phase 2 writes the capture copy |
| **Latest safe** | **Phase 5, weeks 15–16** — before task 5.7 (beta ops: invite flow, support runbook) and after 5.4 (i18n extraction, so strings are extracted once) | No invite may go out, and no user may install, under a name we are about to change |
| **Hard stop** | **Before the first public install or press mention** | An installed PWA keeps the old label; a press mention is a permanent backlink |

**Decision owner:** product lead. **Escalation:** if ADR-014 is still open at the Phase 1 exit review,
the recommendation in [§5](#5-recommendation) is adopted and executed — an unremarkable name chosen on
schedule beats a perfect name chosen in Phase 6.

### 11.3 Definition of done for the rename

1. A repo-wide `grep -ri` for the old name returns only the ADR-014 entry in the decision log.
2. `pnpm dev` boots, CI is green, and no import path references the old scope.
3. The PWA installs on iOS Safari and Android Chrome with the new `name` and `short_name`, and the icon
   is maskable-safe.
4. A test email is delivered and passes SPF, DKIM and DMARC.
5. `.com` and `.rs` resolve to the app with TLS, and the apex redirects correctly.
6. [README.md](README.md) and [00](00-executive-summary.md) carry the final name, and the naming-caveat
   block is removed.
7. The domain and the npm scope are owned by the project, not by an individual.
8. The trademark application is filed (step 9 of [§6](#6-screening-process-ordered-checklist)) and the
   ADR-014 entry is updated from "Open" to the chosen name plus its filing reference.

## 12. Open questions this document hands to [14](14-decisions-and-risks.md)

1. **Ratify the weights in [§2](#2-naming-criteria-weighted)** — they encode a judgement (domain and trademark viability outrank short-term appeal).
2. **Confirm `Ostava` as the screening candidate**, with `Vedro` and `Talir` the two survivors into step 7.
3. **Budget for step 9:** €300–800 per class, classes 9 and 42, Serbia first, EUIPO deferred until the market expands.
4. **Confirm the deadline** — end of Phase 1 recommended, Phase 5 a hard stop.
5. **Confirm the Serbian tone choice (`ti`, not `Vi`)** in [§8.1](#81-principles) — a brand decision, not a translation one, and expensive to reverse once copy and notifications are built on it.

**See also:** [00](00-executive-summary.md) · [01](01-product-requirements.md) · [03](03-domain-model.md) ·
[04](04-categorization-and-ai-engine.md) · [05](05-architecture.md) · [09](09-implementation-plan.md) ·
[12](12-monetization-and-pricing.md) · [14](14-decisions-and-risks.md) ·
[`chatgpt-share-transcript.md`](chatgpt-share-transcript.md)
