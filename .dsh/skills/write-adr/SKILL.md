---
name: write-adr
description: "Record an architectural decision in the ADR log so it is not relitigated or silently reversed later."
whenToUse: "Use when choosing a technology, changing a canonical rule, reversing an existing decision, or whenever you find yourself thinking 'we decided this somewhere'."
metadata:
  owner: finmate
  area: documentation
  reads: [14-decisions-and-risks.md]
---

# Write an ADR

The ADR log lives in **`docs/14-decisions-and-risks.md` Part 1** and currently holds ADR-001 … ADR-019.
Do not renumber, and do not reuse a number. New decisions append with the next free number.

**An unrecorded decision is a future bug.** Six weeks from now nobody remembers why the routing table
requires an `_EU` suffix, and someone "simplifies" it — that is how the GDPR transfer defect got in the
first place.

## When an ADR is required

- Choosing or replacing a library, datastore, service, or deployment shape.
- Changing anything in the **non-negotiable rules** list in `AGENTS.md`.
- Reversing or amending an existing ADR.
- Any decision a reasonable engineer would question in review ("why not just…?").
- Any change to money handling, tenancy, or AI data flow. **Always.**

## When one is not

- Following an existing ADR. That is just doing the work.
- A local implementation detail with no cross-cutting consequence.
- Anything already listed as deliberately deferred — reference the deferral instead.

## Format

Match the existing entries exactly:

```markdown
### ADR-0NN — Short imperative title
**Status:** Accepted | Open | Superseded by ADR-0MM · **Supersedes:** ADR-0XX (if applicable)

**Context.** What forced a decision. Concrete: the constraint, the failure, the cost, the compliance
requirement. Reference the document or incident that surfaced it.

**Decision.** What we will do, in the active voice, unambiguously. If it is a constraint rather than a
preference, say so explicitly — those are the ones people erode.

**Consequences.**
- ✅ what this buys us
- ✅ what it makes possible
- ⚠️ what it costs, what it forbids, what we now cannot easily do
Be honest in the ⚠️ list. An ADR with no downsides is marketing, not engineering, and nobody trusts it.

**Alternatives rejected.** Each option considered and the specific reason it lost. This is the section
that stops the decision being relitigated in three months.
```

## Rules

1. **One decision per ADR.** If you are writing "and also", split it.
2. **Record the constraint, not just the choice.** "EEA-only egress" as a hard constraint is more
   durable than "we currently use an EU endpoint".
3. **State the reversal cost.** If undoing it later would be expensive, say so — that is what makes
   the decision worth respecting.
4. **Link from the docs it affects.** If doc 04 §9 implements your decision, add a link there in the
   same change, so the two cannot drift.
5. **Update, never delete.** A superseded ADR keeps its text with `Status: Superseded by ADR-0MM`.
   The history of why something was tried is valuable.
6. **If you are reversing a decision, move it to the top of the risk register** if it invalidates a
   mitigation. A reversal that quietly removes a safety net is the worst kind.

## Then

- Add a one-line entry to the **risk register** if the decision introduces a new risk, with likelihood,
  impact, and mitigation.
- Add to **Part 3 (open questions)** only if it needs a *human* decision — an ADR you can write
  yourself is not an open question.
- If the decision came from a question in Part 3, close that question with `**RESOLVED**` and point at
  the new ADR, the way Q-3 (AI provider residency) and Q-10 (identity tables) were closed.
