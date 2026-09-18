import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { RouteAnswer } from '@finmate/ai';

import { ACTION_NAME_MAX_LENGTH, actionSlot } from '../modules/assistant/action-planner';
import { ASSISTANT_ACTIONS } from '../modules/assistant/assistant-actions';
import { ASSISTANT_INTENTS } from '../modules/assistant/assistant-intents';
import { validateRouteAnswer } from '../modules/assistant/route-answer';
import { planAction } from '../modules/assistant/action-planner';
import { planQuestion, type PlannerContext } from '../modules/assistant/query-planner';
import { findWorkspaceRoot } from './dataset';

/**
 * The multilingual routing battery's **shape**, deterministically and with no provider.
 *
 * ## What this can and cannot prove
 *
 * It cannot measure the model — that is what the live run behind docs/06 §8.16 is for, and pretending
 * otherwise would be the worst kind of green test. What it *can* prove is everything that has to be true
 * **before** a live number means anything:
 *
 * 1. every member a fixture expects **exists** in the compiled-in registry, so the fixture set cannot
 *    quietly grade a capability nobody wrote;
 * 2. every expected answer survives the caller's own validator — an action's text lands in the slot the
 *    cue path would have filled, and is within the bound the builders enforce;
 * 3. every language in the file is **declared**, a declared language has fixtures, and the declared
 *    *guarantee* matches the recommendation Q-16 is waiting on — so a language cannot be claimed without
 *    questions to measure it with.
 *
 * Together those make the fixture set a measuring instrument rather than a list of hopes, which is the
 * only part of C-3 a provider-free gate can honestly own.
 */
interface FixtureLanguage {
  readonly code: string;
  readonly guaranteed: boolean;
  readonly note?: string;
}

interface RouteFixture {
  readonly locale: string;
  readonly question: string;
  /**
   * `CUE` marks a fixture the **deterministic** vocabulary is expected to catch, so a live run grades it
   * as "the cues still win" rather than as a routed answer. Without it, a correct cue route whose *data*
   * refuses (the demo already has a budget, so `SET_BUDGET` answers `ALREADY_SET` and reports no action)
   * reads as a routing miss — which is how the first live run graded this file wrong.
   */
  readonly path?: 'CUE' | 'ROUTE';
  readonly expect:
    | { readonly kind: 'INTENT'; readonly intent: string; readonly alternatives?: readonly string[] }
    | { readonly kind: 'ACTION'; readonly action: string; readonly text?: string }
    | { readonly kind: 'NONE' };
  readonly note?: string;
}

interface RouteBattery {
  readonly languages: readonly FixtureLanguage[];
  readonly questions: readonly RouteFixture[];
}

function loadBattery(): RouteBattery {
  const path = join(findWorkspaceRoot(), 'apps/api/src/evals/fixtures/route-questions.json');
  return JSON.parse(readFileSync(path, 'utf8')) as RouteBattery;
}

const battery = loadBattery();

/**
 * The vocabulary the live run measures against, mirroring the battery fixture's context: the cue path is
 * the thing being *avoided*, so what matters here is only that it matches at all.
 */
const CUE_CONTEXT: PlannerContext = {
  today: '2026-09-17' as PlannerContext['today'],
  currency: 'RSD' as PlannerContext['currency'],
  categories: [
    { id: 'cat-hrana', name: 'Hrana', path: 'Hrana', owned: true, keywords: ['hrana', 'namirnice'], kind: 'EXPENSE' },
  ],
  merchants: [],
  accounts: [],
  tags: [],
  goals: [],
  recurringRules: [],
};

describe('the multilingual routing battery (ADR-036 C-3)', () => {
  it('expects only members the compiled-in registry actually has', () => {
    for (const fixture of battery.questions) {
      if (fixture.expect.kind === 'INTENT') {
        expect(ASSISTANT_INTENTS, fixture.question).toContain(fixture.expect.intent);
        // A fixture that accepts an alternative is recording a **measurement disagreement**, not a
        // capability: the alternative must still be a real member, and each one is named where the live
        // run's numbers are recorded so the concession is reviewable.
        for (const alternative of fixture.expect.alternatives ?? []) {
          expect(ASSISTANT_INTENTS, `${fixture.question} → ${alternative}`).toContain(alternative);
        }
      } else if (fixture.expect.kind === 'ACTION') {
        expect(ASSISTANT_ACTIONS, fixture.question).toContain(fixture.expect.action);
      }
      // `NONE` needs nothing: it is the assertion that *no* member fits, which is the trap's whole point.
    }
  });

  it('declares an answer the caller\'s validator would keep, exactly as the rung must produce it', () => {
    for (const fixture of battery.questions) {
      if (fixture.expect.kind === 'NONE') {
        // A trap fixture is graded by what the model must *not* answer, so there is nothing to validate
        // beyond the declaration itself.
        continue;
      }
      const answer: RouteAnswer =
        fixture.expect.kind === 'INTENT'
          ? { route: fixture.expect.intent, text: null }
          : { route: fixture.expect.action, text: fixture.expect.text ?? null };

      const decision = validateRouteAnswer(answer);
      expect(decision, fixture.question).not.toBeNull();
      if (fixture.expect.kind === 'INTENT') {
        expect(decision).toEqual({ kind: 'INTENT', intent: fixture.expect.intent });
      } else {
        expect(decision).toMatchObject({ kind: 'ACTION', action: fixture.expect.action });
        // The text has to survive the bound the builder enforces, or the plan it produces would be
        // refused three layers down and the fixture would be measuring a failure it caused itself.
        const text = fixture.expect.text;
        if (text !== undefined) {
          expect(text.length, fixture.question).toBeLessThanOrEqual(ACTION_NAME_MAX_LENGTH);
          // …and it lands in the slot the **cue** path fills for that action, which is what makes a
          // routed write an ordinary write.
          const slot: ActionSlotName = actionSlot(fixture.expect.action as never);
          expect(['name', 'text']).toContain(slot);
        }
      }
    }
  });

  it('declares every language it uses, and gives every declared language questions', () => {
    const declared = new Set(battery.languages.map((language) => language.code));
    for (const fixture of battery.questions) {
      expect(declared, fixture.question).toContain(fixture.locale);
    }
    for (const language of battery.languages) {
      expect(
        battery.questions.some((fixture) => fixture.locale === language.code),
        `no questions for ${language.code}`,
      ).toBe(true);
    }
  });

  it('claims only the languages the product already speaks, until Q-16 says otherwise', () => {
    // ⚠️ This is Q-16's *recommendation* written as a test: Serbian and English are guaranteed because
    // the app already ships them and the deterministic vocabulary covers them; anything else is
    // exercised without a claim. Widening this list is a product decision, and the fixtures have to
    // exist first — which the previous assertion enforces.
    const guaranteed = battery.languages.filter((language) => language.guaranteed).map((l) => l.code);
    expect([...guaranteed].sort()).toEqual(['en', 'sr-Latn']);
  });

  it('marks the fixtures the cue vocabulary must keep catching, and they really are caught', () => {
    // The other half of ADR-036 decision 1: a language the cues already handle must not become a paid
    // call. These are asserted **deterministically** — through the real planners, with no provider — so
    // the claim survives a deployment that routes nothing.
    const cueFixtures = battery.questions.filter((fixture) => fixture.path === 'CUE');
    expect(cueFixtures.length).toBeGreaterThanOrEqual(2);

    for (const fixture of cueFixtures) {
      // A command is caught by the write planner, a question by the read planner; either way the cue
      // vocabulary must match *something*, which is exactly what "not the rung's job" means.
      const caughtByCues = planAction(fixture.question) !== null;
      const plan = caughtByCues ? null : planQuestion(fixture.question, CUE_CONTEXT);
      expect(caughtByCues || (plan !== null && plan.intent !== 'NO_TEMPLATE_MATCH'), fixture.question).toBe(true);
    }
  });

  it('carries the traps that make a precision floor meaningful', () => {
    // A coverage-only set cannot fail on a model that over-answers, and over-answering is R-30's failure
    // mode. Every unclaimed language needs at least one, so a model that invents a capability in that
    // language is visible in the live run rather than only in the one we happened to test.
    const none = battery.questions.filter((fixture) => fixture.expect.kind === 'NONE');
    expect(none.length).toBeGreaterThanOrEqual(3);
    for (const language of battery.languages.filter((l) => !l.guaranteed)) {
      // German, Spanish and Croatian each need one, because a non-Serbian/English model is only
      // trustworthy if it *declines* things too.
      expect(
        none.some((fixture) => fixture.locale === language.code),
        `no trap fixture for ${language.code}`,
      ).toBe(true);
    }
    // …and one of them is in the language whose cues are partial but not absent.
    expect(none.some((fixture) => fixture.locale === 'en')).toBe(true);
  });

  it('lists the two kinds of fixture separately, so a live run can report them apart', () => {
    // Coverage and precision are different numbers and must be readable apart: a set that is all
    // positive cases can be 100 % covered by a model that answers everything, which is exactly the
    // failure R-30 names. This asserts both kinds exist in the set, in more than one language.
    const positives = battery.questions.filter((fixture) => fixture.expect.kind !== 'NONE');
    const negatives = battery.questions.filter((fixture) => fixture.expect.kind === 'NONE');
    expect(positives.length).toBeGreaterThanOrEqual(12);
    expect(negatives.length).toBeGreaterThanOrEqual(3);
    expect(new Set(positives.map((fixture) => fixture.locale)).size).toBeGreaterThanOrEqual(4);
  });
});
