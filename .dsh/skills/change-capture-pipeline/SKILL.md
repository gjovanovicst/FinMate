---
name: change-capture-pipeline
description: "Change the categorization pipeline (normalization, rules, keywords, prompts, model routing) without regressing accuracy or leaking data."
whenToUse: "Use for any change to packages/nlp, packages/rules-engine, packages/ai, prompt templates, confidence gating, or the categorization pipeline order."
metadata:
  owner: finmate
  area: ai
  risk: high
  reads: [04-categorization-and-ai-engine.md, 10-testing-and-quality.md, 08-security-privacy-and-compliance.md]
---

# Change the capture / categorization pipeline

**This is the highest-risk area in the codebase.** It is the product's differentiator, its main cost
centre, and the only place where a wrong answer is user-visible money data. Doc 04 owns the design;
doc 10 owns the gates. Do not treat either as advisory.

## Look before you touch

Establish which stage you are changing, because the blast radius differs sharply:

| Stage | File area | Risk |
|---|---|---|
| 1–2 Normalise / extract | `packages/nlp` | Runs on **client and server** — a change affects both. Serbian edge cases live here. |
| 3 Entity resolution | `packages/nlp` + embeddings | Household-local vectors; must never egress. |
| 4 Rules / keywords | `packages/rules-engine` | **Pure and deterministic.** Change here before reaching for a model. |
| 5 AI classify | `packages/ai`, prompt templates | Costs money, needs an EEA/local endpoint, needs prompt versioning. |
| 6 Confidence gate | classification module | Changes what users are asked to review. |

**First question: can this be solved at stage 4 instead of stage 5?** A rules or keyword change is
free, instant, explainable and testable. Prefer it (ADR-002).

## Non-negotiables

- **Never break the ordering.** normalize → resolve → rules → keywords → AI. If your change makes the
  model run earlier or more often, justify it against the cost model in doc 04 §12.
- **The model still never computes money and never persists** (ADR-001). It returns a `Proposal`; the
  backend validates and writes.
- **Closed category list.** The model may only return a `categoryId` from the list it was given.
  Anything else is rejected by validation and treated as `null` + low confidence. Never relax this.
- **EEA-only egress** (ADR-007). If you add or change a provider, the endpoint must be `LOCAL` or carry
  an explicit `_EU` suffix. This is a compliance constraint, not a preference — a non-EEA default is a
  GDPR Chapter V transfer.
- **Prompt changes are versioned.** Bump `prompt_templates.version` and reference it on every call, so
  an accuracy regression can be attributed to a prompt change rather than guessed at.
- **Do not touch calibration by hand.** If confidences feel wrong, refit the isotonic mapping from
  data; never hand-tune the gate thresholds to make a test pass.

## Before you claim it works

Run the evaluation harness and paste the numbers:

```bash
pnpm test:evals          # golden dataset, doc 10 §5.5
```

Every gate must hold, and these two are the ones people break:

- **Overconfident-wrong rate ≤ 1.5 %** — confidence ≥ 0.90 *and* the answer is wrong. The single most
  important number in the product. A confident wrong answer about money destroys trust permanently.
- **Fabricated-numeral rate in narration = 0** — every numeral in generated text must exist in the
  facts payload.

Also confirm:
- Should-ask recall ≥ 90 % on the adversarial slice — the system must still say "I don't know".
- p95 parse+classify ≤ 1.5 s, cost ≤ $0.002 per classified transaction.
- The **regression slice** did not lose cases it previously passed. It is built from real corrections,
  so a regression there is a regression on real user pain.

## Serbian specifics that are easy to break

- Cyrillic ↔ latin transliteration, and diacritic folding (`septička` ≡ `septicka`).
- `.` and space are **thousands** separators; `,` is the **decimal** separator. `2.000` is 2000, not 2.
- `plata`, `penzija`, `uplata`, `povraćaj` indicate **INCOME**, not expense.
- Ambiguous amounts must return **both** candidates rather than silently picking one.
- `EXCLUDE` keywords must hard-block a category — `ulje` must never route to `Auto/Gorivo`.

## If you add a new category signal or prompt field

1. Add fixtures to the golden dataset **first** (they are the spec for the change).
2. Verify no household data can leak into the prompt: only the fragment, a pre-filtered category list
   (top ~25, not the whole tree), and household few-shot examples.
3. Confirm the change is measurable: if it cannot move a metric in doc 10 §5.5, it is not worth the
   added prompt size or cost.
4. Update `docs/04-categorization-and-ai-engine.md` in the same change.

## Rollback plan

State it in the PR. Prompts and routing are config, so the expected answer is "revert the prompt
version / routing entry" — no deploy. If your change requires a deploy to undo, say so explicitly and
explain why.
