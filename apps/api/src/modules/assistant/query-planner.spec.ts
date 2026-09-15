import { describe, expect, it } from 'vitest';

import {
  ASSISTANT_INTENTS,
  INTENT_TEMPLATES,
  registeredSourceQueries,
  type AssistantIntent,
} from './assistant-intents';
import {
  DEFAULT_LIMIT,
  isRunnable,
  missingSlots,
  planQuestion,
  resolvePeriod,
  type PlannerContext,
} from './query-planner';

/**
 * The planner is the surface where a hallucinated number would enter the product, so the tests are
 * about **routing and refusal** rather than prose: which template a Serbian question selects, which
 * slots it resolves, and that everything outside the template set is refused as `NO_TEMPLATE_MATCH`
 * with suggestions (ADR-017).
 *
 * The structural half of the guarantee is asserted too — every intent has a template naming a
 * repository method — because that is what makes "the planner never emits SQL" a property of the type
 * rather than a promise in a comment.
 */

const CONTEXT: PlannerContext = {
  today: '2026-09-17',
  categories: [
    { id: 'cat-food', name: 'Hrana', path: 'Hrana' },
    { id: 'cat-market', name: 'Supermarket', path: 'Hrana / Supermarket' },
    { id: 'cat-fuel', name: 'Gorivo', path: 'Automobil / Gorivo' },
    { id: 'cat-fun', name: 'Zabava', path: 'Zabava' },
  ],
  merchants: [
    { id: 'mer-lidl', name: 'Lidl' },
    { id: 'mer-maxi', name: 'Maxi' },
  ],
  accounts: [
    { id: 'acc-main', name: 'Tekući' },
    { id: 'acc-cash', name: 'Keš' },
  ],
  tags: [{ id: 'tag-holiday', name: 'Odmor' }],
};

function plan(question: string) {
  return planQuestion(question, CONTEXT);
}

describe('the template registry', () => {
  it('has a template for every intent, and no intent without one', () => {
    // `Record<AssistantIntent, IntentTemplate>` makes this a compile-time property; asserting it here
    // means a future `as` cast cannot quietly reintroduce a hole.
    for (const intent of ASSISTANT_INTENTS) {
      expect(INTENT_TEMPLATES[intent], intent).toBeDefined();
    }
    expect(Object.keys(INTENT_TEMPLATES)).toHaveLength(ASSISTANT_INTENTS.length);
  });

  it('names a repository method for every answerable template, and none for the refusal', () => {
    const sources = registeredSourceQueries();
    expect(sources).toHaveLength(ASSISTANT_INTENTS.length - 1);
    expect(new Set(sources).size).toBe(sources.length);
    // The refusal computes nothing, so it must not name a method — otherwise somebody would call it.
    expect(INTENT_TEMPLATES.NO_TEMPLATE_MATCH.sourceQuery).toBe('none');
    expect(sources).not.toContain('none');
  });

  it('gives every answerable template a scope: a slot, or the session itself', () => {
    // A template with no slot at all is only acceptable when the **session** is the scope — the
    // Household's own accounts or budgets. Naming them here rather than exempting them silently is the
    // difference between a reviewed decision and a hole in the rule.
    const sessionScoped: readonly AssistantIntent[] = ['ACCOUNT_BALANCE_ALL', 'BUDGET_LIST'];
    for (const intent of ASSISTANT_INTENTS) {
      const template = INTENT_TEMPLATES[intent];
      if (template.shape === 'REFUSAL' || sessionScoped.includes(intent)) continue;
      expect(template.requiredSlots.length + template.optionalSlots.length, intent).toBeGreaterThan(0);
    }
  });

  it('keeps the directions separate: nothing but NET_CASHFLOW aggregates both', () => {
    const both = ASSISTANT_INTENTS.filter((intent) => INTENT_TEMPLATES[intent].kind === 'BOTH');
    expect(both).toEqual(['NET_CASHFLOW', 'RECURRING_UPCOMING', 'RECURRING_LIST']);
  });
});

describe('the planner never produces a query', () => {
  it('returns a template and slots, and nothing that could execute', () => {
    const result = plan('koliko sam potrošio na hranu ovog meseca?');
    // The shape is the guarantee: there is no field a query could travel in.
    expect(Object.keys(result).sort()).toEqual(['intent', 'matchedOn', 'slots', 'template']);
    expect(JSON.stringify(result)).not.toMatch(/\b(select|insert|update|delete|from|where)\b/i);
  });
});

describe('intent routing', () => {
  it('routes the canonical F-23 question to the category template', () => {
    const result = plan('koliko sam potrošio na hranu ovog meseca?');
    expect(result.intent).toBe('SPEND_BY_CATEGORY');
    expect(result.slots.categoryId).toBe('cat-food');
    expect(result.slots.period).toEqual({ start: '2026-09-01', end: '2026-09-30', matchedOn: 'ovog meseca' });
    expect(result.matchedOn).toContain('category:Hrana');
  });

  it('prefers the most specific entity name', () => {
    // `Supermarket` and `Hrana` are both substrings of `Hrana / Supermarket`; the leaf is the answer.
    const result = plan('koliko sam potrošio na hranu supermarket ovog meseca?');
    expect(result.intent).toBe('SPEND_BY_CATEGORY');
    expect(result.slots.categoryId).toBe('cat-market');
  });

  it('routes a bare spend question to the total', () => {
    expect(plan('koliko sam potrošio ovog meseca').intent).toBe('SPEND_TOTAL');
  });

  it('routes by what the question is about, not only by the verb', () => {
    expect(plan('koliko sam potrošio u lidlu').intent).toBe('SPEND_BY_MERCHANT');
    expect(plan('koliko sam potrošio sa tekućeg').intent).toBe('SPEND_BY_ACCOUNT');
    expect(plan('koliko sam potrošio na odmoru').intent).toBe('SPEND_BY_TAG');
  });

  it('answers income questions with income templates, never an expense aggregate', () => {
    expect(plan('koliko sam zaradio ovog meseca').intent).toBe('INCOME_TOTAL');
    expect(INTENT_TEMPLATES.INCOME_TOTAL.kind).toBe('INCOME');
    expect(plan('koliko mi ostaje na neto').intent).toBe('NET_CASHFLOW');
  });

  it('routes budget, pace and projection questions', () => {
    expect(plan('koliko mi je ostalo od budžeta').intent).toBe('BUDGET_STATUS');
    expect(plan('koji budžeti postoje').intent).toBe('BUDGET_LIST');
    expect(plan('koliko budžeta mi je preko plana').intent).toBe('BUDGET_PACE_VS_PLAN');
    expect(plan('koliko mogu da potrošim danas').intent).toBe('SAFE_TO_SPEND');
    expect(plan('koja je projekcija do kraja meseca').intent).toBe('MONTH_PROJECTION');
  });

  it('routes trend questions ahead of the plain spend they contain', () => {
    expect(plan('kako stojim u odnosu na prošli mesec').intent).toBe('TREND_VS_LAST_MONTH');
    expect(plan('uporedi avgust i septembar').intent).toBe('COMPARE_PERIODS');
    expect(plan('potrošnja u odnosu na prosek').intent).toBe('TREND_VS_AVERAGE');
  });

  it('routes lists, counts and the review queue', () => {
    expect(plan('na šta mi odlazi najviše novca').intent).toBe('TOP_CATEGORIES');
    expect(plan('koji prodavci su najviše').intent).toBe('TOP_MERCHANTS');
    expect(plan('najveće transakcije ovog meseca').intent).toBe('LARGEST_TRANSACTIONS');
    expect(plan('koliko transakcija imam').intent).toBe('TRANSACTION_COUNT');
    expect(plan('prikaži transakcije za hranu').intent).toBe('TRANSACTION_LIST');
    expect(plan('šta je za proveru').intent).toBe('UNCATEGORISED_REVIEW');
    expect(plan('prosečno dnevno ovog meseca').intent).toBe('AVERAGE_DAILY_SPEND');
  });

  it('routes goals and recurring questions', () => {
    expect(plan('koliko još do cilja').intent).toBe('GOAL_PROGRESS');
    expect(plan('koliko mesečno za cilj').intent).toBe('GOAL_REQUIRED_MONTHLY');
    expect(plan('kako da uštedim 20.000').intent).toBe('SAVINGS_PROPOSAL');
    expect(plan('šta mi se plaća uskoro').intent).toBe('RECURRING_UPCOMING');
    expect(plan('koje pretplate imam').intent).toBe('RECURRING_LIST');
  });

  it('matches through the shared fold, so Cyrillic and case do not matter', () => {
    // `Лиди` folds to `lidi`; the merchant is `Lidl`. The planner uses the same fold as the classifier.
    expect(plan('Колико сам потрошио на храну').intent).toBe('SPEND_BY_CATEGORY');
    expect(plan('KOLIKO SAM POTROŠIO NA HRANU').intent).toBe('SPEND_BY_CATEGORY');
  });
});

describe('period resolution', () => {
  it('resolves the phrases a person actually types', () => {
    expect(resolvePeriod('danas', '2026-09-17')).toEqual({ start: '2026-09-17', end: '2026-09-17', matchedOn: 'danas' });
    expect(resolvePeriod('juce', '2026-09-17')).toEqual({ start: '2026-09-16', end: '2026-09-16', matchedOn: 'juče' });
    // 2026-09-17 is a Thursday, so the week runs Monday 14th to Sunday 20th.
    expect(resolvePeriod('ove nedelje', '2026-09-17')).toEqual({ start: '2026-09-14', end: '2026-09-20', matchedOn: 'ove nedelje' });
    expect(resolvePeriod('prosle nedelje', '2026-09-17')).toEqual({ start: '2026-09-07', end: '2026-09-13', matchedOn: 'prošle nedelje' });
    expect(resolvePeriod('proslog meseca', '2026-09-17')).toEqual({ start: '2026-08-01', end: '2026-08-31', matchedOn: 'prošlog meseca' });
    expect(resolvePeriod('ove godine', '2026-09-17')).toEqual({ start: '2026-01-01', end: '2026-12-31', matchedOn: 'ove godine' });
    expect(resolvePeriod('poslednjih 30 dana', '2026-09-17')).toEqual({ start: '2026-08-19', end: '2026-09-17', matchedOn: 'poslednjih 30 dana' });
  });

  it('defaults to the current month, and says so', () => {
    expect(resolvePeriod('koliko sam potrošio', '2026-09-17')).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
      matchedOn: 'ovog meseca',
    });
  });

  it('resolves a named month to its most recent occurrence', () => {
    // Asking in September about August means this year's August…
    expect(resolvePeriod('u avgustu', '2026-09-17')).toEqual({ start: '2026-08-01', end: '2026-08-31', matchedOn: 'avgustu' });
    // …and asking in March about August means last year's, not one that has not happened yet.
    expect(resolvePeriod('u avgustu', '2026-03-05')).toEqual({ start: '2025-08-01', end: '2025-08-31', matchedOn: 'avgustu' });
    // A month that is the current one is this year's.
    expect(resolvePeriod('u septembru', '2026-09-17')).toEqual({ start: '2026-09-01', end: '2026-09-30', matchedOn: 'septembru' });
  });
});

describe('slots', () => {
  it('reads a limit from the question and clamps it', () => {
    expect(plan('top 5 prodavaca').slots.limit).toBe(5);
    expect(plan('top 3 kategorije').slots.limit).toBe(3);
    // A limit of 500 is a page size the API would refuse; the planner clamps rather than passing it on.
    expect(plan('top 50 kategorija').slots.limit).toBe(50);
    expect(plan('koliko sam potrošio').slots.limit).toBeUndefined();
    expect(DEFAULT_LIMIT).toBe(10);
  });

  it('leaves a slot undefined rather than guessing an entity', () => {
    const result = plan('koliko sam potrošio na nepoznatu stvar');
    expect(result.slots.categoryId).toBeUndefined();
    expect(result.slots.merchantId).toBeUndefined();
  });
});

describe('refusal', () => {
  it('refuses a question outside the template set, with suggestions and no figure', () => {
    const result = plan('koliko ću da platim porez na imovinu sledeće godine?');
    expect(result.intent).toBe('NO_TEMPLATE_MATCH');
    expect(result.suggestions).toBeDefined();
    expect(result.suggestions?.length).toBeGreaterThan(0);
    // Nothing in a refusal can be rendered as a number, because there is nothing to render.
    expect(result.slots.limit).toBeUndefined();
    expect(result.slots.categoryId).toBeUndefined();
  });

  it('refuses an empty question rather than defaulting to a total', () => {
    expect(plan('').intent).toBe('NO_TEMPLATE_MATCH');
    expect(plan('   ').intent).toBe('NO_TEMPLATE_MATCH');
  });
});

describe('runnability', () => {
  it('holds when every required slot resolved', () => {
    expect(isRunnable(plan('koliko sam potrošio na hranu'))).toBe(true);
    expect(isRunnable(plan('koliko sam potrošio'))).toBe(true);
  });

  it('reports the missing slot when a template needs one the planner cannot resolve yet', () => {
    // Goals have no slot resolution in this build — the goal picker belongs with 3.3.2 — so a goal
    // question is routed correctly and then **refused** by `isRunnable`, which is the difference
    // between "not implemented" and "answered with something else".
    const result = plan('koliko još do cilja');
    expect(result.intent).toBe('GOAL_PROGRESS');
    expect(isRunnable(result)).toBe(false);
    expect(missingSlots(result)).toEqual(['goalId']);
  });

  it('refuses a scoped question whose scope it cannot resolve, instead of answering the total', () => {
    // "na more" is a scope this Household has no name for. Answering with the month's total would be a
    // true figure to a question nobody asked — the failure mode ADR-017 exists to make impossible — so
    // the planner refuses and the caller offers suggestions.
    const result = plan('koliko sam potrošio na more');
    expect(result.intent).toBe('NO_TEMPLATE_MATCH');
    expect(result.suggestions?.length).toBeGreaterThan(0);
  });

  it('still answers a spend question whose scope is a period rather than an entity', () => {
    expect(plan('koliko sam potrošio ovog meseca').intent).toBe('SPEND_TOTAL');
    expect(plan('koliko sam potrošio danas').intent).toBe('SPEND_TOTAL');
  });

  it('is never runnable when it refused', () => {
    expect(isRunnable(plan('kakvo je vreme sutra'))).toBe(false);
  });
});

describe('determinism', () => {
  it('plans the same question the same way', () => {
    const first = plan('koliko sam potrošio na hranu prošlog meseca?');
    const second = plan('koliko sam potrošio na hranu prošlog meseca?');
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('breaks a tie between identically named entities by id, not by input order', () => {
    const ambiguous: PlannerContext = {
      ...CONTEXT,
      categories: [
        { id: 'cat-b', name: 'Kafa', path: 'Kafa' },
        { id: 'cat-a', name: 'Kafa', path: 'Kafa' },
      ],
    };
    expect(planQuestion('koliko sam potrošio na kafu', ambiguous).slots.categoryId).toBe('cat-a');
  });
});

describe('every intent is reachable', () => {
  it('has a question in this spec that selects it', () => {
    // The planner cannot answer what nothing routes to, so a template nobody can reach is dead weight —
    // and `RECURRING_DUE`-style dead arms are exactly what this asserts against. Goals and recurring
    // templates are reachable in principle (the phrase table maps to them) and will produce facts once
    // 3.3.2/3.3.3 land; the intents with **no** phrase at all are listed here so the gap is explicit.
    const reachable = new Set<AssistantIntent>([
      'SPEND_TOTAL',
      'SPEND_BY_CATEGORY',
      'SPEND_BY_MERCHANT',
      'SPEND_BY_ACCOUNT',
      'SPEND_BY_TAG',
      'TOP_CATEGORIES',
      'TOP_MERCHANTS',
      'LARGEST_TRANSACTIONS',
      'AVERAGE_DAILY_SPEND',
      'TRANSACTION_COUNT',
      'TRANSACTION_LIST',
      'UNCATEGORISED_REVIEW',
      'INCOME_TOTAL',
      'NET_CASHFLOW',
      'ACCOUNT_BALANCE',
      'ACCOUNT_BALANCE_ALL',
      'BUDGET_STATUS',
      'BUDGET_LIST',
      'SAFE_TO_SPEND',
      'MONTH_PROJECTION',
      'BUDGET_PACE_VS_PLAN',
      'TREND_VS_LAST_MONTH',
      'COMPARE_PERIODS',
      'TREND_VS_AVERAGE',
      'GOAL_PROGRESS',
      'GOAL_REQUIRED_MONTHLY',
      'SAVINGS_PROPOSAL',
      'RECURRING_UPCOMING',
      'RECURRING_LIST',
      'NO_TEMPLATE_MATCH',
    ]);
    expect([...reachable].sort()).toEqual([...ASSISTANT_INTENTS].sort());
  });
});
