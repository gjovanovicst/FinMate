# 16 — Making the assistant answer more, and act

> **Status (2026-09-17).** **Part A** (read coverage) is inside [ADR-017](14-decisions-and-risks.md)'s
> existing envelope and needs no new decision; **A-1, A-2, A-3, A-4a, A-4c, A-5, A-9, A-10, A-12 and
> A-13a have shipped**, A-4b was measured and rejected, and A-6/A-7/A-8/A-11/A-13b remain. **Part B**
> (write actions) needed a decision and now has one: the owner answered **Q-11** on 2026-09-17, and
> **[ADR-035](14-decisions-and-risks.md#adr-035--the-assistant-may-propose-a-write-only-a-humans-click-executes-it)
> records it** — the assistant may *propose* a write, only a human's click executes it, no
> confidence-based fast path, and pending proposals live in Redis with a short TTL. B-1 is that ADR;
> **B-2a built the server half** (registry, `text` slot, proposal store, propose/execute, `ADD_CATEGORY`
> — docs/06 §8.16), and **B-2b built the proposal card** that makes it reachable by a person: offered
> only when the ledger **refused** the question, it renders the backend sentence and diff, offers the
> `kind` toggle the server marked `defaulted`, confirms with the proposal id plus one idempotency key,
> and undoes through the same mutation `/categories` calls. Building it found and fixed two defects in
> its own foundation — the action planner read attributive adjectives as imperatives, and a string enum
> reaches a client by its member *key*, not its value (docs/15).
>
> **B-3a added `ADD_TRANSACTION`**, the action that inherits the capture path instead of re-implementing
> it: `ClassificationService.parse` at propose time and `TransactionsService.captureCommit` at execute
> time, with the decision the card showed as the row's accepted proposal — so the pipeline runs once and
> the Category the human approved is the Category stored. Its proposal carries structured rows (the
> amount as `Money`, the Category, the day, whether the gate will file it for review), fills the account
> and — only when the text states no direction — the kind, and refuses rather than guesses on an
> ambiguous amount, a text that reads as several entries, or a Household with no account. Proposing
> therefore became a **`Mutation`**: it runs the classifier, and a Query that spends money is a lie
> about itself (docs/06 §8.16). **B-3b is the card half** — the rows, the amounts through `fm-money`,
> and the account picker.
>
> [14 §Part 3](14-decisions-and-risks.md) also carries **Q-12** (refusal telemetry), which A-8 needs.

The request behind this document, verbatim:

> *"How to make our assistant smarter to answer on all questions related to our context app and even do
> actions in app — let's say to configure or add records, let's say add category name something and it
> does it."*

That is two different problems wearing one sentence, and they have very different risk profiles:

| | Part A — answer more questions | Part B — do things |
|---|---|---|
| Worst realistic outcome | a wrong or refused answer | a wrong **write** in the ledger |
| Does ADR-017 already cover it | **yes** — it is a finite template set by design | **no** — ADR-017 is silent on writes |
| Cost to start | hours | an ADR, a registry, a confirmation protocol, a UI |
| Blocks on the owner | nothing (except Q-12) | **Q-11** |

---

## Part A — Answering more of what the app already knows

### A.1 What actually causes the refusals

A 37-question battery run against the dev API answered **25 and refused 12** (nine
`NO_TEMPLATE_MATCH`, two `NOT_BUILT`, one error). The twelve are not twelve instances of one defect —
they are five different things, and only two of them are "the assistant is not smart enough":

| # | Cause | Count | What it is |
|---|---|---|---|
| 1 | **Cue coverage** | 9 | The planner's cue vocabulary is a hand-written, **Serbian-only**, ordered phrase list (`query-planner.ts`). A question the template set *could* answer falls through to `NO_TEMPLATE_MATCH` because no listed phrase occurs in it |
| 2 | **Unbuilt builders** | 2 (+2 unseen) | **Four** declared intents route correctly and then answer `NOT_BUILT`: `GOAL_PROGRESS`, `GOAL_REQUIRED_MONTHLY`, `RECURRING_UPCOMING`, `RECURRING_LIST` |
| 3 | **A defect** | 1 | `MONTH_PROJECTION` throws a 500 (a **signed** `projectedOverrun` is handed to a money type that requires non-negative minor units) — recorded in [06 §8.8](06-api-specification.md), not fixed |
| 4 | **Structural gaps** | rest | Question *shapes* with no template at all: entity/state questions, why-questions, follow-ups, meta questions |
| 5 | **Copy** | — | The fallback and refusal sentences are English while the figures and names are in the Household's locale ([06 §5.14](06-api-specification.md)'s no-catalogue breach) |

**Cause 2 is the cheapest work in this document and it is not a small amount of it.** Both services the
four intents need already exist and are already exported:

- `GoalsService.list(householdId, statuses)` returns `GoalView`, which **already carries**
  `targetMinor`, `contributedMinor`, `remainingMinor`, `progress`,
  `requiredPerMonthMinor`, `monthsRemaining` — every field `GOAL_PROGRESS` and
  `GOAL_REQUIRED_MONTHLY` need, all of them computed by `@finmate/domain` already.
- `RecurringService.list(householdId, activeOnly)`, `occurrencesBetween(...)` and `dueSoon(...)` cover
  `RECURRING_LIST` and `RECURRING_UPCOMING` (the latter is exactly `dueSoon`).

So why do they answer `NOT_BUILT`? Two reasons, and the second is the one that is easy to miss:

1. No fact builder was written (four `unavailableBuilt` stubs).
2. **The planner cannot resolve their slots.** `SlotName` declares `goalId` and `recurringRuleId`, but
   `PlannerContext` carries only `categories`, `merchants`, `accounts` and `tags` — so there is no name
   list to match a goal or a subscription against, and the plan dies at `UNRUNNABLE:goalId` *before* it
   ever reaches the `NOT_BUILT` branch.

Widening `PlannerContext` with `goals` and `recurringRules` is therefore part of the same slice, and it
is where `PLANNER_PAGE_SIZE`'s existing cap has to be considered for two more lists.

### A.2 The moves, each with its cost and its non-goals

**A-1 · Fix the `MONTH_PROJECTION` 500 — and it was not one line (2026-09-17).** Reported as a sign
bug on a declared, routed intent; it was a **class**. Every assistant total is derived, so eight call
sites handed a signed `Balance` to a formatter that refuses a negative — a month that spent less than the
last one, an overspent budget, an overdrawn account. See [06 §8.9](06-api-specification.md).

**A-2 · Finish the declared registry.** Four fact builders + `goals`/`recurringRules` in
`PlannerContext` + the two slot resolutions. No ADR: [06 §8.1](06-api-specification.md) already declares
these intents, and ADR-017 already fixes the mechanism. This turns four "I cannot answer that" into four
answers using methods that exist today.

**A-3 · Widen the cue vocabulary, including English (2026-09-17).** The product's primary locale is English
([ADR-019](14-decisions-and-risks.md)) and the planner's cue table is Serbian-only, so *"how much did I
spend on groceries this month"* is refused by an English-primary product. Two shapes are possible:
per-locale cue tables, or one **ordered** rule list where each rule carries a phrase set per locale. The
second is safer — the rules are order-sensitive (`budžet` must beat `koliko`, a trend cue must beat a
plain spend cue), and a duplicated rule list is how the two locales stop agreeing. Whatever is chosen,
the test is the same: **every locale the catalogue ships must route the battery** — an English-primary
product whose planner only reads Serbian is a defect, not a missing feature.

**A-4 · A fuzzy second planner rung — closed set, no AI. BUILT, MEASURED, REJECTED (2026-09-17).**

~~When no cue fires, score the folded question against the registry's own corpus … and route only when the
winner clears a threshold *and* is clearly ahead of the runner-up.~~ The idea was implemented as a
nearest-exemplar scorer over the 57-question battery (token trigrams, cosine) and measured against twelve
**held-out** colloquial Serbian questions — deliberately held out, because tuning against the examples you
invented proves nothing:

> **3 of 12 correct. The other 9 were wrong answers**, with margins between the winner and the runner-up
> of 0.006–0.083 — i.e. the ranking is noise at those similarities.

| Question | The rung said | The truth | Why |
|---|---|---|---|
| `koliko mi je ostalo para na kartici` | `BUDGET_STATUS` (0.594) | `ACCOUNT_BALANCE_ALL` | it shares `koliko mi je ostalo` with the budget question — and that is roughly all it shares |
| `koliko sam u minusu` | `SPEND_TOTAL` (0.564) | `NET_CASHFLOW` | `koliko sam` is boilerplate; `minusu` is the question |
| `kolika je šteta ovog meseca` | `INCOME_TOTAL` (0.573) | `SPEND_TOTAL` | `ovog meseca` is boilerplate; `šteta` is the question |

**The failure generalises, and that is the finding:** a lexical score is dominated by the words two
questions *share*, and in a question about money those are the least informative ones — `koliko`, `mi`,
`je`, `ostalo`, `ovog meseca`. The words that decide the intent are precisely the words the exemplar does
**not** share (`kartici` versus `budžeta`; `minusu`; `šteta`). The cue router already works the other way
round: it keys on the discriminating noun **and** on which entity that noun resolved to. A second rung
would throw that away and answer a *plausible* question instead of the one that was asked — the single
outcome ADR-017 exists to prevent, and worse than the refusal it replaces.

What this rung deliberately is **not**: an LLM choosing the intent. That is a classification with an
unbounded answer space, it needs egress and therefore ADR-032 consent, it is non-deterministic across
calls, and — decisively — the failure mode is different. A wrong cue match refuses; a wrong model match
answers a *different question confidently*. The embedding rung ADR-021 built and left inert is the same
idea with a model behind it, and it can be switched on later without changing this design.

**A-5 · Make the planner read the taxonomy it is handed (DONE, 2026-09-17).** A Category now resolves
through its **`INCLUDE` keywords** as well as its name — `benzin` is a seeded keyword of `Gorivo`, so the
capture path already classified a typed `benzin 5000` while a *question* about it could not resolve the
Category. Names outrank keywords (four score tiers), `EXCLUDE` keywords are never passed (they mean *this
word does not belong here*, docs/04 §5.4), and a spend question scoped to an **INCOME** Category now
**refuses** instead of answering a confident `0,00 RSD` — the capture path has reconciled direction since
2.2.7 and the planner had no equivalent. [06 §8.11](06-api-specification.md) records the decisions and the
measured effect (battery 51 → 52 of 58).

**A-6 · Follow-ups, without a conversation store.** A large share of "it doesn't understand me" is not a
missing template — it is *"a prošli mesec?"* asked after a question that already resolved a period.
`conversationId` is deliberately unbuilt (no conversation store, [06 §8.4](06-api-specification.md)). It
does not need to be built: **the client already holds the transcript**, so `assistantAnswer` can take
`previousIntent` and `previousPeriod` and inherit them when the new question sets neither. The server
stays stateless, tenancy still comes from the session, and rule 9's "a new datastore needs an ADR" never
comes up.

One guard, because it is the obvious way this goes wrong: **inherit the intent and the period only —
never a previously resolved entity id.** An entity the user has since deleted or merged would produce an
answer about a row that no longer exists; if the follow-up needs an entity and does not name one, the
honest outcome is a refusal that says which entity is missing.

**A-7 · A refusal that is useful. DONE for the suggestions (A-4c, 2026-09-17); the copy is still its own.**

ADR-017 already says the limitation *"must be messaged well ('I can't answer that yet, but I can tell
you…')"*. The suggestions are no longer six static strings, and — given A-4's measurement — **not**
ranked by a similarity scorer. They are built structurally instead:

1. **what the ledger can say about the entity the question named** — `kolika mi je penzija` resolves the
   `Penzija` Category, so the first chip is *"Koliko sam potrošio na kategoriji „Penzija" ovog meseca?"*;
2. **the canonical questions, filtered to the ones this Household can actually have answered** — a chip
   that leads to a second refusal is worse than no chip.

The second half is a checked contract rather than a comment: `planner-gate.spec.ts` asserts that **every**
suggestion a refusal offers routes to a runnable plan in the context that produced it. Names are quoted
and introduced by a noun rather than inflected into the sentence, because generating the accusative of an
arbitrary Household name is how a suggestion ends up reading like `na odeća i obuću`.

Still A-7's: the refusal **copy** is English-only while the suggestions are Serbian (§5.14's breach). And when the intent *matched* but a required slot did not, say exactly that
in the Household's own vocabulary (*"Nisam našao kategoriju „X"…"*), not the generic sentence. Also
translate the refusal and template fallback copy — the money is already formatted in the Household's
locale and the connectives around it are not.

**A-8 · Measure coverage as a gate, not as an impression.** Phase 2's exit criteria are measured numbers;
the assistant's are not. Add the question battery to `pnpm test:evals` as a **planner gate**: each
question with an expected intent, a bar on the routed share, and — more important than the bar — an
assertion that **every unrouted question is unrouted deliberately**, with the reason named. That
distinction is the whole point: "12 of 37 refused" is not a metric until each refusal is either a
recorded product limitation or a bug.

### A.3 The one thing Part A cannot decide for itself

A-8's honest version wants real questions. A question is user text about their finances, so recording
it is personal data with a **new purpose** ([08](08-security-privacy-and-compliance.md)) — and one of the
three options is not a technical choice:

| Option | What it stores | Cost |
|---|---|---|
| (a) Nothing | only the hand-written battery | zero privacy risk, **blind to real usage** |
| (b) Unmatched token set | folded tokens that matched nothing, with numerals and entity ids stripped | small, arguably still personal data; catches vocabulary gaps, not shape gaps |
| (c) Raw question + purpose, retention, toggle | everything | best signal; needs a purpose, a retention rule, a consent story and a settings surface |

**Recommendation: (b) now, (c) only if beta shows (b) is insufficient.** This is **Q-12**.

---

## Part B — Doing things

### B.1 The one-line architecture

> The assistant may **propose** a write. Only a human's click **executes** it. The model never names a
> method, never supplies a number, and never narrates a write as done.

Everything below is that sentence made structural, and it is the same shape the codebase already uses
three times: `captureParse` → `captureCommit`, `detectSubscriptions` → `confirmDetectedSubscription`,
and [`ADR-010`](14-decisions-and-risks.md)'s correction → rule. This is not a new invention; it is the
fourth instance of a proven pattern, generalised.

### B.2 A closed action registry, mirroring the intent registry

`INTENT_TEMPLATES` is a `Record<AssistantIntent, IntentTemplate>`, so "every intent has exactly one
template and every template names a repository method" is a **compile-time** property — there is no
`default:` arm to fall into. The action side gets the same treatment:

```
export const ASSISTANT_ACTIONS = [
  'ADD_CATEGORY', 'ADD_TRANSACTION', 'ADD_TAG', 'ADD_GOAL',
  'SET_BUDGET', 'ADD_RECURRING_RULE', 'CREATE_RULE_FROM_CORRECTION',
] as const;

interface ActionTemplate {
  readonly mutation: string;               // names an EXISTING service method. Never SQL, never a vendor call
  readonly requiredSlots: readonly ActionSlotName[];
  readonly role: 'OWNER' | 'ADMIN' | 'MEMBER';   // docs/06 §11.1's matrix, reused rather than reinvented
  readonly defaulted: readonly ActionSlotName[]; // emitted in the preview when the question omits them
  readonly undo: 'SOFT_DELETE' | 'UNDO_CAPTURE' | 'NONE';
  readonly destroys: boolean;              // true ⇒ out of scope for v1
}
```

The two properties that make this safe are both structural, not procedural:

- **`mutation` names a method that the UI's own GraphQL mutation already calls.** The assistant gets *no*
  privilege the UI does not have — same service, same `TenantContext`, same validation, same audit.
- **`ASSISTANT_ACTIONS` is closed.** There is no generic `runGraphql` / `callTool` member and no
  `default:` arm, so "the model decided to call something nobody wrote" fails `tsc` rather than reaching
  production. This is ADR-017's `Record` argument, applied to writes.

### B.3 Slots: the shape needs one new kind, and that is a real change

`SlotName` today is `period | targetMinor | categoryId | merchantId | accountId | tagId | goalId |
recurringRuleId | limit` — every one of them either a **comparison period**, an **id resolved from the
database**, or a **count**. *"add category Putovanja"* has no id to resolve: `Putovanja` is text the
user invented in the same breath. So the action registry needs a `text` slot kind with:

- a length bound (the service already caps a category name at 80 chars and refuses an empty one),
- a **collision check in the preview** against the Household's own names, because `createCategory`
  refuses a duplicate and the button must not be offered for a write that will fail, and
- the same rule as every other slot: **ids come from the database, never from the model.**

Two more slot realities worth naming now, because both would otherwise be discovered as bugs:

- **`createCategory` requires `kind` (`EXPENSE`/`INCOME`).** Nobody says *"add an income category"* when
  they mean *"add a category"*. So the action declares `kind` as **defaulted** — the preview says
  *"Nova kategorija „Putovanja" (rashod)"* and the confirmation card lets the user flip it. Guessing
  silently is not an option; guessing *visibly* is.
- **`ADD_TRANSACTION` inherits the whole capture path**, including the amount parser
  (`packages/nlp`'s `parseAmount`, ADR-003) and the date parser. Relative dates (*"sledeći petak"*) have
  **no parser** today — the capture path takes what it takes — so the action either declares a
  restricted date vocabulary or asks. Recorded as a gap, not assumed away.

### B.4 Propose → Confirm → Execute

**1 · Propose (a read).** The planner selects an action and resolves slots with the same matcher it
already uses for entities. The server calls the write service's validate/dry-run path and stores a
`PendingAction`: the action, the resolved args, a **backend-rendered preview sentence**, the diff, the
required role, and a `proposalId` with a TTL.

Where the proposal lives is a genuine sub-decision with three options:
(i) nothing stored — the client echoes the args back, which re-opens the "the args changed between
preview and execute" class of bug, so **no**;
(ii) a short-TTL entry in **Redis**, which is already running ([ADR-004](14-decisions-and-risks.md)) and
therefore needs no new dependency under rule 9 — **decided in [ADR-035](14-decisions-and-risks.md#adr-035--the-assistant-may-propose-a-write-only-a-humans-click-executes-it)**;
(iii) a table, which survives a deploy but needs a migration and a purge job — the trigger to move there is
ADR-035 decision 6.
The honest constraint on (ii): **if the API ever runs more than one instance, this moves to (iii) or to a
shared Redis** — an in-process map would silently fail to find a proposal confirmed against the other
instance. Recording that constraint now is cheaper than discovering it later.

**2 · Confirm (the human).** The confirmation carries **only the `proposalId`** plus an
`idempotencyKey` — not the args, not the question. This is the single most important line in the design:
the executed action is byte-for-byte the action the human saw, because the server re-reads its own
proposal rather than trusting a client round trip. It is also why the narrator can be involved in step 1
and *not* in steps 2–3.

**3 · Execute (one mutation).** `assistantExecuteAction(proposalId, idempotencyKey)` dispatches through
the registry to the same service method the UI calls, returns the created row plus an undo affordance,
and consumes the proposal so a replay cannot create two rows. The success sentence is a **template with
the returned values substituted** — a write's confirmation is a numeral-bearing statement, so ADR-017's
rule applies to it exactly as it applies to an answer.

**Undo is not an afterthought here.** `undoCapture` exists for the capture path; `deleteCategory`,
`deleteTag`, `deleteSavingGoal` and friends are soft deletes. The action registry names which undo each
action has, and `destroys: true` actions (delete, and **merge — which is not reversible in the current
implementation**) are out of scope for v1 precisely because their undo does not exist.

### B.5 The hard constraints

| Never | Why |
|---|---|
| Free-form tool/function calling; a model-chosen method name | ADR-017's closed registry; rule 10's no-vendor-SDK rule |
| A model-supplied **number** | ADR-001/ADR-017 — amounts come from `parseAmount`, dates from a parser, ids from the database |
| Auto-apply, at any confidence | ADR-009's gates classify a *categorisation*; a write is not a classification, and "the assistant changed my budget by itself" is unrecoverable trust damage |
| Destructive actions in v1 | no undo for merge; delete needs its own policy |
| A conversation/proposal **table** before the ADR | rule 9 |
| Assistant actions **offline** | a proposal needs a server round trip; the offline route stays `captureCommit`, which already queues |
| The narrator describing a write as done before the backend returned | the sentence must come from the returned row |
| An action that takes a `householdId` | tenancy comes from the session, always (ADR-008); the registry should make this unrepresentable |

### B.6 The UI (mobile + desktop)

The answer card grows a **proposal card**: the rendered preview, the diff, and two real buttons —
*Uradi* and *Otkaži*. Obligations that follow from the existing Definition of Done rather than from
taste:

- the confirm is a `<button>` (not a div), focus moves to it when a proposal arrives, **Escape cancels**,
  and the pending state is announced (`aria-live`) — the keyboard-only requirement;
- at 320 px the diff collapses to one summary line plus a disclosure, and both controls meet the
  `--control-size` floor that 4.3.1e established;
- the transcript keeps the proposal *and* its outcome, because the client's transcript is the only
  history there is (`conversationId` is still not built);
- the composer must not become a second capture screen — [02 §4.16](02-ux-flows-and-screens.md)'s
  deliberate choice of a question composer over `CaptureField` stands.

### B.7 Sequencing

One commit per row, per the working agreement. Part A rows are independent of Part B and of each other;
**B-1 gates every other B row.**

| # | Slice | Needs | What it buys |
|---|---|---|---|
| A-1 | `MONTH_PROJECTION` sign fix | nothing | a routed question stops 500-ing |
| A-2 | four fact builders + `goals`/`recurringRules` in `PlannerContext` + slot resolution | nothing | four intents answer from services that already exist |
| A-3 | cue widening, incl. English; locale-aware ordered rules | nothing decision-wise | the largest single refusal bucket |
| A-4a | the battery as an eval gate (`test:evals` + the fast suite) | A-1..A-3 to have something to measure | coverage becomes a number with a bar — **done** |
| A-4b | the fuzzy second rung | the measurement above | **rejected**: 3/12 right on held-out questions, 9 wrong answers |
| A-4c | refusal suggestions built structurally | A-4a | a refusal names what the ledger *can* say about the entity asked about — **done** |
| A-5 | the planner matches `INCLUDE` `CategoryKeyword`s below names, and a spend question scoped to an INCOME Category refuses | A-4a | scope resolves the way the capture path already classifies, and a wrong-direction answer becomes a refusal — **done** |
| A-9 | `INCOME_BY_CATEGORY`: income scoped by a Category, so *"kolika mi je penzija"* answers | A-4a | the last measured registry gap — battery 52 → 53 of 58 — **done** |
| A-6 | follow-up context (`previousIntent` + `previousPeriod`) | a [06 §8](06-api-specification.md) contract extension | *"a prošli mesec?"* works |
| A-7 | useful refusal + i18n of refusal/fallback copy | catalogue entries | ADR-017's "message it well" |
| A-8 | refusal telemetry | **Q-12** | the gap list becomes data |
| A-10 | the `x`↔`ks` fold (`Maxi`/`Maksiju`) in `packages/nlp` | nothing decision-wise, and the re-fold this row expected turned out to be **unnecessary** (docs/04 §8.1.7) | the battery's last *vocabulary* gap, and the classifier's too — *"koliko sam potrošio u Maksiju"* answers — **done** |
| A-11 | income *schedule* questions — `RecurringService.dueSoon` filters `kind: 'EXPENSE'` | a `RecurringService` read and `/recurring`'s own reading | *"kada mi sledeća plata dolazi"* answers instead of refusing |
| A-12 | the keyword **exact** tier is `folded.includes(keyword)`, not a whole word — A-9's docs call it "whole word only" | the measurement in [06 §8.13](06-api-specification.md) | a keyword stops matching *inside* an inflected word, so `maxi` no longer hijacks `Maksiju` — **done** |
| A-13a | `scopePhrase` preferred the Merchant while the router preferred the Category, so a figure could wear another scope's label | A-12 (removes the keyword-driven case) | the label names the scope `spend()` aggregated by, so the claim matches the figure — **done** |
| A-13b | which scope a question that names **both** a Category and a Merchant *means* (*"na hranu u Lidlu"*) | **a product decision** — the label is honest since A-13a, so this is now only about the answer | the intersection, the Merchant, or an ambiguity refusal — the owner's call |
| **B-1** | **ADR-035: propose writes, never execute them** | **Q-11** — answered 2026-09-17 | the architectural gate — **done** ([ADR-035](14-decisions-and-risks.md#adr-035--the-assistant-may-propose-a-write-only-a-humans-click-executes-it)) |
| B-2a | action registry + `text` slot + Redis proposals + `assistantProposeAction`/`assistantExecuteAction` + `ADD_CATEGORY` | B-1 | the first action, server-side and live-verifiable — **done** ([06 §8.16](06-api-specification.md)) |
| B-2b | the proposal card on `/assistant` (preview, diff, **confirm**, the `kind` toggle, the undo affordance) | B-2a | the same action, reachable by a person — the half B-2a deliberately leaves — **done** ([06 §8.16](06-api-specification.md), [02 §4.16](02-ux-flows-and-screens.md)) |
| B-3a | `ADD_TRANSACTION` server-side: the registry entry, the transaction cues, propose-via-`parse`, execute-via-`captureCommit`, the structured preview lines, `assistantProposeAction` becomes a `Mutation` | B-2 | the highest-value action, on the method `/capture` already calls — **done**, live 18/18 ([06 §8.16](06-api-specification.md)) |
| B-3b | the transaction card: the preview rows with their amounts through `fm-money`, the Category and day, the review note, and the **account picker** | B-3a | the same action, reachable and correctable by a person |
| B-4 | `SET_BUDGET`, `ADD_GOAL`, `ADD_TAG` | B-2 | "configure", as asked |
| B-5 | `CREATE_RULE_FROM_CORRECTION` | B-2 | ADR-010's confirmation, reached by question |

**The A-series is nearly done: A-1, A-2, A-3, A-4a, A-4c, A-5, A-9, A-10, A-12 and A-13a have shipped**
(A-4b was measured and rejected). What remains of Part A is A-6, A-7 and A-8 — the last needs **Q-12** —
plus A-11 and **A-13b**. **A-13b is the one that needs you**: A-13a made the label honest, so a question
naming both a Category and a Merchant no longer prints one scope's figure under the other's name — but
what such a question should *answer* (the intersection, the Merchant, or an ambiguity refusal) is a
product decision, not a matcher fix. The other open rows need no decision: **A-6/A-7** are a contract
extension and catalogue entries, **A-11** a `RecurringService` read. The remaining battery gaps that are
**not** A-rows are seed content for `kirija`/English (docs/04). **Part B is no longer gated**: Q-11 was
answered, [ADR-035](14-decisions-and-risks.md) records it, and B-1/B-2a/B-2b shipped the first action end
to end. What B-3–B-5 need is not a decision but the next executor and its own card affordances.

### B.8 What this deliberately does not build

Text-to-SQL or a generic "run this query" escape hatch · vendor function-calling (rule 10) ·
model-named methods · model-computed money · auto-apply without a confirmation · destructive actions ·
a conversation store · LLM narration of a *write* · the *Primeni* button on F-30's savings proposal by
this route (it is its own unmade product decision, [06 §8.8](06-api-specification.md)).

---

## Open decisions

| # | Question | Who | Recommendation |
|---|---|---|---|
| **Q-11** | **May the assistant propose writes, and is every write confirmed?** | Product owner | Yes to proposing; **every** write confirmed in v1, with no confidence-based fast path |
| **Q-12** | **May the API record anything about a question it could not answer?** | Product owner + legal | Option (b) — the unmatched folded token set, amounts and ids stripped |
| Q-13 | Is the coverage bar a gate, or a trend? | Product owner | Both: a hard bar on the battery (no regressions, zero 500s), a trend on real questions |
| Q-14 | Is `ADD_CATEGORY` the right first action? | Product owner | Yes — no money, no ledger effect, soft-delete undo |
| Q-15 | Is there any confirmation-free fast path? | Product owner | No in v1; revisit only with usage data |

## Related documents

- [06 §8](06-api-specification.md) — the assistant contract and its known gaps
- [14](14-decisions-and-risks.md) — ADR-017 (the constrained planner), ADR-009 (gates), ADR-010
  (corrections→rules), ADR-019 (i18n), ADR-021 (the inert embedding rung), ADR-032 (consent), and Q-11/Q-12
- [02 §4.16](02-ux-flows-and-screens.md) — the `/assistant` screen
- [04](04-categorization-and-ai-engine.md) — the pipeline the `ADD_TRANSACTION` action reuses
- [15](15-implementation-gotchas.md) — read before touching any of it
