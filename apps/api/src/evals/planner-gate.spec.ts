import { describe, expect, it } from 'vitest';

import { isRunnable, planQuestion } from '../modules/assistant/query-planner';
import { findWorkspaceRoot, loadAssistantBattery } from './dataset';
import { evaluatePlannerGates, plannerGaps, plannerMismatches, type PlannerOutcome } from './scoring';

/**
 * The assistant battery and its gates — docs/06 §8.11, docs/10 §5.6.
 *
 * Two things are tested here, and the second is the one that matters:
 *
 *  1. **The shipped fixture is true.** Every declaration is run through the real planner, in the unit
 *     suite as well as in `pnpm test:evals` — the planner is pure, so this needs no database and a
 *     change that invalidates a declaration fails the fast suite rather than a separate CI step.
 *  2. **The gate fails when it should.** A gate nobody has watched fail is decoration, so the failure
 *     direction of each one is asserted with a deliberately wrong declaration.
 */

const root = findWorkspaceRoot();
const battery = loadAssistantBattery(root);

const run = (): readonly PlannerOutcome[] =>
  battery.questions.map((declared) => {
    const plan = planQuestion(declared.question, battery.context);
    return {
      question: declared.question,
      declaredIntent: declared.intent,
      declaredRunnable: declared.runnable ?? true,
      observedIntent: plan.intent,
      runnable: isRunnable(plan),
      ...(declared.why === undefined ? {} : { why: declared.why }),
    };
  });

describe('the assistant battery fixture', () => {
  it('declares what the planner actually does, for every question', () => {
    const mismatches = plannerMismatches(run());
    expect(
      mismatches.map((mismatch) => `${mismatch.question}: ${mismatch.declaredIntent} → ${mismatch.observedIntent}`),
    ).toEqual([]);
  });

  it('passes both gates as shipped', () => {
    const gates = evaluatePlannerGates(run());
    expect(gates.map((gate) => gate.passed)).toEqual([true, true]);
  });

  it('records a reason for every question it declares unanswerable', () => {
    // The loader enforces this too; asserting it here means the rule cannot be relaxed by accident in
    // the loader alone. A gap with no reason is a gap nobody can schedule.
    const gaps = plannerGaps(run());
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) {
      expect(gap.why, gap.question).toBeDefined();
      expect((gap.why ?? '').length).toBeGreaterThan(10);
    }
  });

  it('carries a frozen context, so a gate failure is about the planner and not about a seed', () => {
    // The properties the battery's scope questions depend on, asserted so a context edit that breaks
    // them fails here rather than as a mysterious routing change.
    expect(battery.context.categories.map((category) => category.name)).toContain('Gorivo');
    expect(battery.context.merchants.map((merchant) => merchant.name)).toContain('Apoteka Benu');
    expect(battery.context.today).toBe('2026-09-17');
  });
});

describe('what a refusal offers', () => {
  it('only ever suggests a question this Household can actually have answered', () => {
    // The contract that makes a suggestion more than decoration: a chip that leads to a second refusal
    // is worse than no chip. Asserted over the battery's own context, for every declared refusal.
    const refusals = run().filter(
      (outcome) => outcome.observedIntent === 'NO_TEMPLATE_MATCH' || !outcome.runnable,
    );
    expect(refusals.length).toBeGreaterThan(0);
    for (const refusal of refusals) {
      const { suggestions = [] } = planQuestion(refusal.question, battery.context);
      expect(suggestions.length, refusal.question).toBeGreaterThan(0);
      for (const suggestion of suggestions) {
        const plan = planQuestion(suggestion, battery.context);
        expect(plan.intent, `${refusal.question} → ${suggestion}`).not.toBe('NO_TEMPLATE_MATCH');
        expect(isRunnable(plan), `${refusal.question} → ${suggestion}`).toBe(true);
      }
    }
  });

  it('offers what the ledger can say about the entity the question named', () => {
    // `kolika mi je penzija` resolves the Penzija Category and no template matches, so the first chip
    // is about that Category — the question the assistant *can* answer.
    const { suggestions = [] } = planQuestion('kolika mi je penzija', battery.context);
    expect(suggestions[0]).toContain('Penzija');
  });

  it('drops a canonical question this Household cannot have answered', () => {
    // A Household whose tree has nothing named `hrana` (and no path mentioning it either — deleting the
    // parent is not enough, because its child's path still reads `Hrana / Supermarket`) gets no chip
    // about hranu, because that chip would refuse too.
    const withoutFood = {
      ...battery.context,
      categories: [{ id: 'cat-gorivo', name: 'Gorivo', path: 'Gorivo' }],
    };
    const { suggestions = [] } = planQuestion('kakvo je vreme sutra', withoutFood);
    expect(suggestions.some((suggestion) => suggestion.includes('hranu'))).toBe(false);
    // …and the ones it can answer are still offered.
    expect(suggestions.length).toBeGreaterThan(0);
    for (const suggestion of suggestions) {
      expect(isRunnable(planQuestion(suggestion, withoutFood))).toBe(true);
    }
  });
});

describe('the planner gates, in the failure direction', () => {
  const good: PlannerOutcome = {
    question: 'Koliko sam potrošio ovog meseca?',
    declaredIntent: 'SPEND_TOTAL',
    declaredRunnable: true,
    observedIntent: 'SPEND_TOTAL',
    runnable: true,
  };

  it('fails when a declared question routes somewhere else', () => {
    const misrouted: PlannerOutcome = { ...good, observedIntent: 'INCOME_TOTAL' };
    const gates = evaluatePlannerGates([good, misrouted]);
    expect(gates[0]?.passed).toBe(false);
    expect(gates[0]?.value).toBe(1);
    expect(plannerMismatches([good, misrouted])).toEqual([misrouted]);
  });

  it('fails when a question declared answerable turns out unrunnable', () => {
    // The near-miss case: the template matched, the required slot did not resolve.
    const unrunnable: PlannerOutcome = { ...good, runnable: false };
    expect(evaluatePlannerGates([unrunnable])[0]?.passed).toBe(false);
  });

  it('fails when a question declared unanswerable starts answering', () => {
    // The reverse direction, and the one a "coverage" metric alone would never catch: a gap that got
    // closed has to be **declared** closed, because the declaration is what the team reviews.
    const closedGap: PlannerOutcome = {
      question: 'kolika mi je penzija',
      declaredIntent: 'NO_TEMPLATE_MATCH',
      declaredRunnable: true,
      observedIntent: 'INCOME_TOTAL',
      runnable: true,
      why: 'no template aggregates income by Category',
    };
    const gates = evaluatePlannerGates([closedGap]);
    expect(gates[0]?.passed).toBe(false);
  });

  it('falls below the coverage floor when too few questions are answerable', () => {
    const rows: readonly PlannerOutcome[] = [
      good,
      {
        question: 'kolika mi je penzija',
        declaredIntent: 'NO_TEMPLATE_MATCH',
        declaredRunnable: true,
        observedIntent: 'NO_TEMPLATE_MATCH',
        runnable: false,
        why: 'recorded',
      },
    ];
    // One of two answerable is 50 %, under the 85 % floor, and the floor is a gate rather than advice.
    expect(evaluatePlannerGates(rows)[1]?.passed).toBe(false);
  });

  it('is a floor rather than a target: the shipped battery has headroom', () => {
    const gates = evaluatePlannerGates(run());
    expect(gates[1]?.value).toBeGreaterThan(0.85);
  });
});
