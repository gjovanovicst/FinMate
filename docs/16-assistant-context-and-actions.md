# 16 — Making the assistant answer more, and act

> **Status: proposal. Nothing in this document is implemented, and nothing here is decided.**
> Part A (read coverage) is completion work inside [ADR-017](14-decisions-and-risks.md)'s existing
> envelope and needs no new decision. Part B (write actions) needs an **ADR-035 first**, because "may the
> assistant write to the ledger, and under what confirmation policy" is an architectural decision — and
> [the house rule](../AGENTS.md) is that architectural decisions are recorded, never taken silently.
>
> Two rows were added to [14 §Part 3](14-decisions-and-risks.md) for the owner: **Q-11** (write
> authority) and **Q-12** (refusal telemetry).

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

### A.2 The six moves, each with its cost and its non-goals

**A-1 · Finish the declared registry.** Four fact builders + `goals`/`recurringRules` in
`PlannerContext` + the two slot resolutions. No ADR: [06 §8.1](06-api-specification.md) already declares
these intents, and ADR-017 already fixes the mechanism. This turns four "I cannot answer that" into four
answers using methods that exist today.

**A-2 · Widen the cue vocabulary, including English.** The product's primary locale is English
([ADR-019](14-decisions-and-risks.md)) and the planner's cue table is Serbian-only, so *"how much did I
spend on groceries this month"* is refused by an English-primary product. Two shapes are possible:
per-locale cue tables, or one **ordered** rule list where each rule carries a phrase set per locale. The
second is safer — the rules are order-sensitive (`budžet` must beat `koliko`, a trend cue must beat a
plain spend cue), and a duplicated rule list is how the two locales stop agreeing. Whatever is chosen,
the test is the same: **every locale the catalogue ships must route the battery** — an English-primary
product whose planner only reads Serbian is a defect, not a missing feature.

**A-3 · Fix the `MONTH_PROJECTION` 500.** A one-line sign bug on a declared, routed intent.

**A-4 · A fuzzy second planner rung — closed set, no AI.** When no cue fires, score the folded question
against the registry's own corpus (each intent's cues + its suggested question) with the fold and trigram
machinery that already exists in `packages/nlp`, and route only when the winner clears a threshold *and*
is clearly ahead of the runner-up. This stays inside ADR-017 because the rung's output is still a
**template name**, never a query.

What this rung deliberately is **not**: an LLM choosing the intent. That is a classification with an
unbounded answer space, it needs egress and therefore ADR-032 consent, it is non-deterministic across
calls, and — decisively — the failure mode is different. A wrong cue match refuses; a wrong model match
answers a *different question confidently*. The embedding rung ADR-021 built and left inert is the same
idea with a model behind it, and it can be switched on later without changing this design.

**A-5 · Follow-ups, without a conversation store.** A large share of "it doesn't understand me" is not a
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

**A-6 · A refusal that is useful.** ADR-017 already says the limitation *"must be messaged well ('I can't
answer that yet, but I can tell you…')"* — and today the refusal carries six static suggestions rather
than the closest ones. Build them from the registry: the nearest answerable templates, ranked by the
same scorer A-4 introduces. And when the intent *matched* but a required slot did not, say exactly that
in the Household's own vocabulary (*"Nisam našao kategoriju „X"…"*), not the generic sentence. Also
translate the refusal and template fallback copy — the money is already formatted in the Household's
locale and the connectives around it are not.

**A-7 · Measure coverage as a gate, not as an impression.** Phase 2's exit criteria are measured numbers;
the assistant's are not. Add the question battery to `pnpm test:evals` as a **planner gate**: each
question with an expected intent, a bar on the routed share, and — more important than the bar — an
assertion that **every unrouted question is unrouted deliberately**, with the reason named. That
distinction is the whole point: "12 of 37 refused" is not a metric until each refusal is either a
recorded product limitation or a bug.

### A.3 The one thing Part A cannot decide for itself

A-7's honest version wants real questions. A question is user text about their finances, so recording
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
therefore needs no new dependency under rule 9 — **recommended for v1**;
(iii) a table, which survives a deploy but needs a migration and a purge job.
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
| A-4 | fuzzy second rung + the battery as an eval gate | A-1..A-3 to have something to measure | coverage becomes a number with a bar |
| A-5 | follow-up context (`previousIntent` + `previousPeriod`) | a [06 §8](06-api-specification.md) contract extension | *"a prošli mesec?"* works |
| A-6 | useful refusal + i18n of refusal/fallback copy | catalogue entries | ADR-017's "message it well" |
| A-7 | refusal telemetry | **Q-12** | the gap list becomes data |
| **B-1** | **ADR-035: propose writes, never execute them** | **Q-11** | the architectural gate |
| B-2 | action registry + `ADD_CATEGORY` end to end | B-1 | the first action, no money, trivially undoable |
| B-3 | `ADD_TRANSACTION` through the existing capture preview | B-2 | highest-value action, ~90 % already built |
| B-4 | `SET_BUDGET`, `ADD_GOAL`, `ADD_TAG` | B-2 | "configure", as asked |
| B-5 | `CREATE_RULE_FROM_CORRECTION` | B-2 | ADR-010's confirmation, reached by question |

**Recommended first slice: A-1 + A-2 together** — no decision needed, an existing service behind each,
and it converts four refusals into answers before anything architectural is agreed.

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
