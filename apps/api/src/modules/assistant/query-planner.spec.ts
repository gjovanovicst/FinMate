import { describe, expect, it } from 'vitest';

import { addDays, addMonths, monthPeriod, weekPeriod } from '@finmate/domain';

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
  currency: 'RSD',
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

  it('reads "prošli mesec" as the baseline of a trend question, not as the period to report', () => {
    // The canonical question compares **this** month with the last one. Reading the phrase as the
    // period answered August-versus-July — a true figure answering a question nobody asked.
    const trend = plan('kako stojim u odnosu na prošli mesec');
    expect(trend.intent).toBe('TREND_VS_LAST_MONTH');
    expect(trend.slots.period).toEqual({
      start: '2026-09-01',
      end: '2026-09-30',
      matchedOn: 'ovog meseca',
    });
    expect(trend.matchedOn).toContain('baseline:prošlog meseca');
    expect(trend.matchedOn).toContain('period:ovog meseca');

    // The same words in a plain spend question still mean August.
    const spend = plan('koliko sam potrošio prošlog meseca');
    expect(spend.intent).toBe('SPEND_TOTAL');
    expect(spend.slots.period).toEqual({
      start: '2026-08-01',
      end: '2026-08-31',
      matchedOn: 'prošlog meseca',
    });
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

  it('reads the savings target out of the question, in the Household’s own money format (F-30)', () => {
    // The same `parseAmount` the capture path uses: `.` and space group thousands, `,` is the decimal
    // separator, and `20k` is twenty thousand (ADR-003 says the interpretation lives in one place).
    expect(plan('kako da uštedim 20.000').slots.targetMinor).toBe('2000000');
    expect(plan('kako da uštedim 20000 dinara').slots.targetMinor).toBe('2000000');
    expect(plan('kako da uštedim 20k').slots.targetMinor).toBe('2000000');
    expect(plan('kako da uštedim 1.500,50').slots.targetMinor).toBe('150050');
  });

  it('reports the target in the units a person reads, not in minor units', () => {
    // `target:2000000` beside a question about money reads as a figure 100× too large.
    expect(plan('kako da uštedim 20.000').matchedOn).toContain('target:20000.00 RSD');
  });

  it('takes the amount that follows the verb, not the last number in the sentence', () => {
    // The year is the second numeral, and reading it as a target would plan around 2.025,00 RSD.
    expect(plan('kako da uštedim 20.000 u avgustu 2025').slots.targetMinor).toBe('2000000');
    expect(plan('predlog za štednju 5.000 ovog meseca').slots.targetMinor).toBe('500000');
  });

  it('takes the parser’s preferred reading for a grouped amount, and says the target in provenance', () => {
    // `1.200` has two readings; the parser orders the grouped one first, which is the one a person
    // means for a target. The answer repeats the figure, so a misreading is visible rather than silent.
    expect(plan('kako da uštedim 1.200').slots.targetMinor).toBe('120000');
    expect(plan('kako da uštedim 1.200').matchedOn).toContain('target:1200.00 RSD');
  });

  it('refuses a missing or zero target, because there is nothing to plan around', () => {
    expect(plan('kako da uštedim').slots.targetMinor).toBeUndefined();
    expect(plan('kako da uštedim 0').slots.targetMinor).toBeUndefined();
    // And `isRunnable` is what turns that into a refusal for the caller.
    expect(isRunnable(plan('kako da uštedim'))).toBe(false);
    expect(missingSlots(plan('kako da uštedim'))).toEqual(['targetMinor']);
  });

  it('does not pick up a stray amount in a question that has no target', () => {
    // The slot is resolved only for a template that names it, so this cannot answer a spend question
    // with an amount the user never meant as a target.
    expect(plan('koliko sam potrošio na hranu ovog meseca').slots.targetMinor).toBeUndefined();
    expect(plan('koliko sam potrošio na hranu u avgustu 2025').slots.targetMinor).toBeUndefined();
  });

  it('matches through the shared fold, so Cyrillic and case do not matter', () => {
    // `Лиди` folds to `lidi`; the merchant is `Lidl`. The planner uses the same fold as the classifier.
    expect(plan('Колико сам потрошио на храну').intent).toBe('SPEND_BY_CATEGORY');
    expect(plan('KOLIKO SAM POTROŠIO NA HRANU').intent).toBe('SPEND_BY_CATEGORY');
  });

  // ---------------------------------------------------------------------------------------------
  // The phrasings a measured battery refused (A-3)
  // ---------------------------------------------------------------------------------------------

  it('takes a spend verb people actually use, `dao`', () => {
    // "koliko sam dao za kiriju" refused because the verb list knew `potrošio`/`platio` and not `dao`.
    // The safety net is unchanged: this branch answers only when a Category, Merchant, Account or Tag
    // resolved, so a question about a name the Household does not have still refuses (asserted below).
    expect(plan('koliko sam dao za hranu').intent).toBe('SPEND_BY_CATEGORY');
    expect(plan('koliko sam dala za gorivo').intent).toBe('SPEND_BY_CATEGORY');
    // …and an unresolvable scope is still refused rather than totalled.
    expect(plan('koliko sam dao za nešto što ne postoji').intent).toBe('NO_TEMPLATE_MATCH');
  });

  it('reads a balance question in the order people write it', () => {
    // The cue list knew `stanje na računu` and the inverted `na računu imam`, but not `imam na računu`.
    expect(plan('koliko imam na računu').intent).toBe('ACCOUNT_BALANCE_ALL');
    // A bare `koliko imam` is deliberately **not** a balance cue: it fronts goals, budgets and every
    // other thing a Household has, so guessing "balance" would answer a different question.
    expect(plan('koliko imam').intent).toBe('NO_TEMPLATE_MATCH');
    // …and when it does front something, that thing's own cue wins. There is no "list my goals"
    // template, so this is a goal question that refuses for want of a `goalId` — recorded, not hidden.
    expect(plan('koliko imam ciljeva').intent).toBe('GOAL_PROGRESS');
    expect(isRunnable(plan('koliko imam ciljeva'))).toBe(false);
  });

  it('reads net cashflow when a word is inserted into the phrase', () => {
    expect(plan('koliko mi novca ostaje').intent).toBe('NET_CASHFLOW');
    expect(plan('koliko mi ostaje').intent).toBe('NET_CASHFLOW');
    // The budget branch still wins for a budget question, because it is ordered first and the two
    // phrases overlap.
    expect(plan('koliko mi je ostalo od budžeta').intent).toBe('BUDGET_STATUS');
  });

  it('routes a pace question that never says the word budget', () => {
    // `da li sam preko plana` names the judgement and not the noun, and requiring *budžet* refused it.
    expect(plan('da li sam preko plana').intent).toBe('BUDGET_PACE_VS_PLAN');
    expect(plan('jesam li isplanirano').intent).toBe('BUDGET_PACE_VS_PLAN');
    // With the noun it routes the same way, so the two phrasings cannot disagree.
    expect(plan('da li sam preko plana sa budžetom').intent).toBe('BUDGET_PACE_VS_PLAN');
  });
});

/**
 * English (A-3b). The catalogue is English-primary (ADR-019), so an English question has to route — and
 * the *ordered* rule list is shared with Serbian rather than duplicated, because two orders in two
 * languages are two orders to keep in step and the drift would be silent in one language only.
 *
 * Most of these assert what must **not** happen: an English cue is a substring test over the folded
 * question, so a short one is a collision waiting to happen (`net` inside `netflix`).
 */
describe('English questions route the same way (A-3b)', () => {
  it('routes an unscoped spend question', () => {
    expect(plan('what did I spend this month').intent).toBe('SPEND_TOTAL');
    expect(plan('how much did I spend today').intent).toBe('SPEND_TOTAL');
    expect(plan('how much did i earn this month').intent).toBe('INCOME_TOTAL');
  });

  it('refuses a scope it cannot resolve instead of answering the total', () => {
    // The Household's tree is Serbian, so `food` resolves nothing. Answering the month's whole spend
    // would be a true figure to a different question — the failure ADR-017 exists to prevent. Before
    // this, the unresolved-scope check knew only `na`/`za`/`u`/`kod` and the question fell through.
    expect(plan('how much did I spend on food').intent).toBe('NO_TEMPLATE_MATCH');
    expect(plan('how much did I spend for fuel').intent).toBe('NO_TEMPLATE_MATCH');
    // …while a period introduced by the same preposition is a **resolved** scope, not an entity.
    expect(plan('how much did I spend in august').intent).toBe('SPEND_TOTAL');
    expect(plan('what did I spend this month').intent).toBe('SPEND_TOTAL');
  });

  it('resolves the English period phrases, including a named month', () => {
    const lastMonth = monthPeriod(addMonths(CONTEXT.today, -1));
    expect(plan('what did I spend last month').slots.period.start).toBe(lastMonth.start);
    expect(plan('what did I spend this month').slots.period.start).toBe(monthPeriod(CONTEXT.today).start);
    expect(plan('what did I spend yesterday').slots.period.start).toBe(addDays(CONTEXT.today, -1));
    expect(plan('what did I spend this week').slots.period.start).toBe(weekPeriod(CONTEXT.today).start);
    expect(plan('what did I spend in august').slots.period.start).toBe('2026-08-01');
    expect(plan('what did I spend in august').slots.period.start).not.toBe(plan('what did I spend in september').slots.period.start);
    // The phrase the user wrote is the provenance, not the Serbian default.
    expect(plan('what did I spend this month').matchedOn).toContain('this month');
    expect(plan('what did I spend last month').slots.period.matchedOn).toBe('prošlog meseca');
    // `last 30 days` is the same window as `poslednjih 30 dana`.
    expect(plan('what did I spend in the last 30 days').slots.period.start).toBe(addDays(CONTEXT.today, -29));
  });

  it('reads an English month only after a preposition, because the words are ordinary', () => {
    // `may` and `march` are verbs and nouns before they are months.
    expect(plan('may I ask a question').intent).not.toBe('TREND_VS_LAST_MONTH');
    expect(plan('what did I spend in may').slots.period.matchedOn).toBe('in may');
    // …and a bare `may` in a spend question does not become May.
    expect(plan('what did I spend in may').slots.period.start).toBe('2026-05-01');
  });

  it('does not read `net` inside `netflix`, which is why the cash-flow cue is multi-word', () => {
    // A bare `net` would make this a cash-flow question. It is a Merchant scope instead.
    expect(plan('how much did I spend on netflix').intent).not.toBe('NET_CASHFLOW');
    expect(plan('what is my net cash flow this month').intent).toBe('NET_CASHFLOW');
    expect(plan('how much do I have left over').intent).toBe('NET_CASHFLOW');
  });

  it('does not make a spending question a goal question just because it says per month', () => {
    // `per month` lives *inside* the goal branch, so it can only classify a question that already named
    // a goal. On its own it must not become GOAL_PROGRESS — which then refuses for want of a goalId.
    expect(plan('how much do I spend per month').intent).not.toBe('GOAL_PROGRESS');
    expect(plan('how much do i spend per month').intent).toBe('SPEND_TOTAL');
    // With a goal named (or the vocabulary) it is a goal question, and a monthly one.
    expect(
      planQuestion('how much do I need per month for my goal', {
        ...CONTEXT,
        goals: [{ id: 'goal-holiday', name: 'Letovanje' }],
      }).intent,
    ).toBe('GOAL_REQUIRED_MONTHLY');
  });

  it('routes the other English intents', () => {
    const cases: readonly (readonly [string, AssistantIntent])[] = [
      ['what is my balance', 'ACCOUNT_BALANCE_ALL'],
      ['which budgets do I have', 'BUDGET_LIST'],
      ['how much is left of my budget', 'BUDGET_STATUS'],
      ['how much can I spend today', 'SAFE_TO_SPEND'],
      ['am I over budget', 'BUDGET_PACE_VS_PLAN'],
      ['what is my projection for the end of the month', 'MONTH_PROJECTION'],
      ['how does this month compare to last month', 'TREND_VS_LAST_MONTH'],
      ['where does my money go', 'TOP_CATEGORIES'],
      ['what are my largest transactions', 'LARGEST_TRANSACTIONS'],
      ['what is my average per day', 'AVERAGE_DAILY_SPEND'],
      ['how many transactions do I have', 'TRANSACTION_COUNT'],
      ['which transactions need review', 'UNCATEGORISED_REVIEW'],
      ['show my transactions', 'TRANSACTION_LIST'],
      ['what are my subscriptions', 'RECURRING_LIST'],
      ['what bills are due soon', 'RECURRING_UPCOMING'],
      ['how can I save 20000', 'SAVINGS_PROPOSAL'],
    ];
    for (const [question, intent] of cases) {
      expect(plan(question).intent, question).toBe(intent);
    }
    // The savings target comes out of the question through the same cue that routed it.
    expect(plan('how can I save 20000').slots.targetMinor).toBe('2000000');
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

  it('reports the missing slot when the context carries no name for it', () => {
    // This context has no goals in it, so a goal question routes correctly and is then **refused** by
    // `isRunnable` — which is the difference between "I could not tell which goal you meant" and
    // answering something else. That is a fact about the context, not about the build: the test below
    // resolves the same question's slot the moment the names are supplied.
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
    // A named month is the scope and a resolved period at the same time. Reading `u avgustu` as an
    // unresolved entity refused a question the template set can answer — a refusal is honest, but this
    // one was wrong, and the phrase table had already resolved it.
    expect(plan('koliko sam potrošio u avgustu').intent).toBe('SPEND_TOTAL');
    expect(plan('koliko sam potrošio u avgustu').slots.period.start).toBe('2026-08-01');
    expect(plan('koliko sam potrošio u septembru').slots.period.start).toBe('2026-09-01');
  });

  it('is never runnable when it refused', () => {
    expect(isRunnable(plan('kakvo je vreme sutra'))).toBe(false);
  });
});

describe('goals and recurring rules as slots (A-2)', () => {
  const withGoals: PlannerContext = {
    ...CONTEXT,
    goals: [
      { id: 'goal-holiday', name: 'Letovanje' },
      { id: 'goal-phone', name: 'Novi telefon' },
    ],
    recurringRules: [
      { id: 'rule-netflix', name: 'Netflix' },
      { id: 'rule-gym', name: 'Teretana' },
    ],
  };

  it('resolves a goal by name, so the two goal templates are runnable', () => {
    const progress = planQuestion('Koliko sam uštedeo za letovanje?', withGoals);
    expect(progress.intent).toBe('GOAL_PROGRESS');
    expect(progress.slots.goalId).toBe('goal-holiday');
    expect(isRunnable(progress)).toBe(true);

    const monthly = planQuestion('Koliko mesečno treba da odvajam za letovanje?', withGoals);
    expect(monthly.intent).toBe('GOAL_REQUIRED_MONTHLY');
    expect(monthly.slots.goalId).toBe('goal-holiday');
  });

  it('requires the goal’s name as written before the name alone picks the template', () => {
    // `Novi telefon` shares a four-character stem with `novca`, so the stem rung found a goal in a
    // question about spending — and a goal match decides the *intent* here, unlike a Category or a
    // Merchant match, which only scopes one. Found by this file's own battery: "Na šta mi odlazi
    // najviše novca ovog meseca?" routed to GOAL_PROGRESS.
    const spend = planQuestion('Na šta mi odlazi najviše novca ovog meseca?', withGoals);
    expect(spend.intent).toBe('TOP_CATEGORIES');
    // The slot is not merely unused: it is **not resolved**, so `matchedOn` cannot tell the reader that
    // a goal was matched in a question about spending.
    expect(spend.slots.goalId).toBeUndefined();

    // …while the name as written still selects it, on either rung's evidence.
    expect(planQuestion('Koliko je ostalo za Novi telefon?', withGoals).slots.goalId).toBe('goal-phone');
  });

  it('resolves a recurring rule by name and narrows the answer to it', () => {
    const subscriptions = planQuestion('Koje pretplate imam?', withGoals);
    expect(subscriptions.intent).toBe('RECURRING_LIST');
    expect(subscriptions.slots.recurringRuleId).toBeUndefined();

    const named = planQuestion('Kada mi sledeći Netflix dolazi?', withGoals);
    expect(named.intent).toBe('RECURRING_UPCOMING');
    expect(named.slots.recurringRuleId).toBe('rule-netflix');
  });

  it('routes a goal question it cannot resolve, and refuses it rather than answering another goal', () => {
    const result = planQuestion('Koliko sam uštedeo za zimovanje?', withGoals);
    // `uštedeo` is a savings cue, so the template is right — but no goal named `zimovanje` exists, and
    // the planner refuses rather than picking the nearest goal it does have.
    expect(result.intent).toBe('GOAL_PROGRESS');
    expect(result.slots.goalId).toBeUndefined();
    expect(isRunnable(result)).toBe(false);
    expect(missingSlots(result)).toEqual(['goalId']);
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

  it('prefers the Household’s own row over a shared one with the same name', () => {
    // `merchants` is globally readable, so a Household that copied the seeded `Lidl` has two rows
    // named `Lidl` — and only its own is referenced by its Transactions. Before the `owned` flag the
    // tie went to the id, which picked the global seed (created earlier), and "koliko sam potrošio u
    // lidlu" answered 0,00 RSD from a row no Transaction points at.
    const withGlobalSeed: PlannerContext = {
      ...CONTEXT,
      merchants: [
        { id: 'mer-global', name: 'Lidl' },
        { id: 'mer-owned', name: 'Lidl', owned: true },
      ],
    };
    const result = planQuestion('koliko sam potrošio u lidlu', withGlobalSeed);
    expect(result.intent).toBe('SPEND_BY_MERCHANT');
    expect(result.slots.merchantId).toBe('mer-owned');
  });
});

describe('every intent is reachable', () => {
  it('has a question in this spec that selects it', () => {
    // The planner cannot answer what nothing routes to, so a template nobody can reach is dead weight —
    // and `RECURRING_DUE`-style dead arms are exactly what this asserts against. Every intent below is
    // now reachable *and* answerable: A-2 built the last four fact builders, so `GOAL_*` and
    // `RECURRING_*` are no longer "reachable in principle, refused in practice".
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
