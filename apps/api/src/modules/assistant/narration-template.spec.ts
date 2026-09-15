import { describe, expect, it } from 'vitest';

import { ASSISTANT_INTENTS, INTENT_TEMPLATES, type AssistantIntent } from './assistant-intents';
import type { AssistantFactsView, ProvenanceView } from './fact-assembly.service';
import { renderRefusal, renderTemplateAnswer } from './narration-template';
import { validateNarration } from './numeric-validator';

/**
 * The fallback is the answer a user gets whenever a model is unavailable or invents a figure, so it is
 * a *product surface*, not an error path. These tests hold two properties:
 *
 * 1. **It cannot fabricate.** Every rendered sentence is run through `validateNarration`, the same
 *    check the model's output faces (docs/04 §11.2's semantic-preservation and fabricated-numeral
 *    gates, asserted here rather than promised).
 * 2. **It says something true.** One prose test per frame, because a renderer that is numeral-safe
 *    and reads like a database dump is not a fallback anyone wants to ship.
 */
const RS = 'sr-Latn-RS';

function factsOf(overrides: Partial<AssistantFactsView> = {}): AssistantFactsView {
  return {
    template: 'SPEND_TOTAL',
    rows: [],
    totals: [],
    formatted: { headline: '46.650,00 RSD' },
    ...overrides,
  };
}

const provenance: ProvenanceView = {
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  transactionCount: 3,
  sourceQuery: 'spend.total.v1',
  filters: {},
  computedAt: new Date('2026-09-20T10:00:00.000Z'),
  ledgerCurrency: 'RSD',
};

function render(intent: AssistantIntent, facts: AssistantFactsView, count = 3): string {
  return renderTemplateAnswer({
    intent,
    template: INTENT_TEMPLATES[intent],
    facts: { ...facts, template: intent },
    provenance: { ...provenance, transactionCount: count },
  });
}

/** Facts shaped the way the assembler produces them for a given template shape. */
function factsFor(intent: AssistantIntent): AssistantFactsView {
  const shape = INTENT_TEMPLATES[intent].shape;
  const rows = [
    { label: 'Hrana / Supermarket', value: '1745000', formatted: '17.450,00 RSD' },
    { label: 'Gorivo', value: '920000', formatted: '9.200,00 RSD' },
  ];
  const total = {
    label: 'Spending',
    money: { amountMinor: '4665000', currency: 'RSD' },
    formatted: '46.650,00 RSD',
  };

  switch (shape) {
    case 'ROWS':
    case 'LIST':
      return factsOf({ rows, formatted: { headline: '2' } });
    case 'REFUSAL':
      return factsOf({
        rows: [],
        totals: [],
        formatted: {},
      });
    default:
      return factsOf({ rows: [], totals: [total], formatted: { headline: '46.650,00 RSD' } });
  }
}

describe('the template answer for every intent', () => {
  it.each(ASSISTANT_INTENTS)('renders %s without inventing a numeral', (intent) => {
    const facts = factsFor(intent);
    const text = render(intent, facts);

    expect(text.length).toBeGreaterThan(0);
    const validation = validateNarration(text, { ...facts, ...provenance }, RS);
    expect(validation.unaccounted, `${intent}: ${text}`).toEqual([]);
  });

  it('never names a date, because provenance is rendered beside the answer, not inside it', () => {
    for (const intent of ASSISTANT_INTENTS) {
      const facts = factsFor(intent);
      const text = render(intent, facts);
      expect(text, intent).not.toContain('2026-09');
    }
  });
});

describe('how each frame reads', () => {
  it('a spend total', () => {
    expect(render('SPEND_TOTAL', factsFor('SPEND_TOTAL'))).toBe('You spent 46.650,00 RSD.');
  });

  it('an income total, with the verb that belongs to it', () => {
    const facts = factsOf({
      totals: [{ label: 'Income', money: { amountMinor: '15000000', currency: 'RSD' }, formatted: '150.000,00 RSD' }],
      formatted: { headline: '150.000,00 RSD' },
    });
    expect(render('INCOME_TOTAL', facts)).toBe('You received 150.000,00 RSD.');
  });

  it('an average, with the days it was divided by', () => {
    const facts = factsOf({
      totals: [{ label: 'Average per day', money: { amountMinor: '155500', currency: 'RSD' }, formatted: '1.555,00 RSD' }],
      formatted: { headline: '1.555,00 RSD', days: '30', total: '46.650,00 RSD' },
    });
    expect(render('AVERAGE_DAILY_SPEND', facts)).toBe(
      'You spent 1.555,00 RSD a day on average over 30 days, 46.650,00 RSD in total.',
    );
  });

  it('a count, singular and plural', () => {
    const facts = factsOf({ formatted: { headline: '4' } });
    expect(render('TRANSACTION_COUNT', facts, 4)).toBe('You have 4 transactions in that period.');
    expect(render('TRANSACTION_COUNT', factsOf({ formatted: { headline: '1' } }), 1)).toBe(
      'You have 1 transaction in that period.',
    );
  });

  it('net cashflow, all three sides', () => {
    const facts = factsOf({
      totals: [
        { label: 'Income', money: { amountMinor: '15000000', currency: 'RSD' }, formatted: '150.000,00 RSD' },
        { label: 'Spending', money: { amountMinor: '4665000', currency: 'RSD' }, formatted: '46.650,00 RSD' },
        { label: 'Net', money: { amountMinor: '10335000', currency: 'RSD' }, formatted: '103.350,00 RSD' },
      ],
      formatted: {
        headline: '103.350,00 RSD',
        income: '150.000,00 RSD',
        spending: '46.650,00 RSD',
      },
    });
    expect(render('NET_CASHFLOW', facts)).toBe(
      'Income 150.000,00 RSD, spending 46.650,00 RSD, net 103.350,00 RSD.',
    );
  });

  it('a balance, naming the account and the day it is true for', () => {
    const facts = factsOf({
      rows: [{ label: 'Tekući', value: '9335000', formatted: '93.350,00 RSD' }],
      formatted: { headline: '93.350,00 RSD', count: '1', asOf: '2026-09-20' },
    });
    expect(render('ACCOUNT_BALANCE_ALL', facts)).toBe(
      'Your balance on Tekući is 93.350,00 RSD, as of 2026-09-20.',
    );
  });

  it('a budget, with the limit it is out of', () => {
    const facts = factsOf({
      rows: [{ label: 'Hrana', value: '8255000', formatted: '82.550,00 RSD' }],
      totals: [{ label: 'Hrana', money: { amountMinor: '8255000', currency: 'RSD' }, formatted: '82.550,00 RSD' }],
      formatted: {
        headline: '82.550,00 RSD',
        spent: '17.450,00 RSD',
        limit: '100.000,00 RSD',
        asOf: '2026-09-20',
      },
    });
    expect(render('BUDGET_STATUS', facts)).toBe(
      'You have 82.550,00 RSD left of 100.000,00 RSD, with 17.450,00 RSD spent.',
    );
  });

  it('a budget with no limit says less rather than something false', () => {
    const facts = factsOf({
      rows: [{ label: 'Household', value: '5000000', formatted: '50.000,00 RSD' }],
      totals: [{ label: 'Household', money: { amountMinor: '5000000', currency: 'RSD' }, formatted: '50.000,00 RSD' }],
      formatted: { headline: '50.000,00 RSD', spent: '10.000,00 RSD', limit: '', asOf: '2026-09-20' },
    });
    expect(render('BUDGET_STATUS', facts)).toBe('You have 50.000,00 RSD left of that budget after 10.000,00 RSD.');
  });

  it('safe-to-spend', () => {
    const facts = factsOf({
      totals: [{ label: 'Safe to spend today', money: { amountMinor: '200000', currency: 'RSD' }, formatted: '2.000,00 RSD' }],
      formatted: { headline: '2.000,00 RSD', spent: '46.650,00 RSD', asOf: '2026-09-20' },
    });
    expect(render('SAFE_TO_SPEND', facts)).toBe(
      'You can spend 2.000,00 RSD safely today; 46.650,00 RSD is spent this month.',
    );
  });

  it('a projection, and its unreliability when the month is young', () => {
    const facts = factsOf({
      totals: [{ label: 'Projected total', money: { amountMinor: '7000000', currency: 'RSD' }, formatted: '70.000,00 RSD' }],
      formatted: { headline: '70.000,00 RSD', reliable: 'false', asOf: '2026-09-03' },
    });
    expect(render('MONTH_PROJECTION', facts)).toBe(
      'You are on track for 70.000,00 RSD this month. The month is early, so this is a rough figure.',
    );
  });

  it('ranked rows, capped so it stays a sentence', () => {
    const facts = factsOf({
      rows: [
        { label: 'Hrana', value: '1', formatted: '17.450,00 RSD' },
        { label: 'Gorivo', value: '2', formatted: '9.200,00 RSD' },
        { label: 'Zabava', value: '3', formatted: '3.000,00 RSD' },
        { label: 'Kirija', value: '4', formatted: '1.000,00 RSD' },
      ],
      formatted: { headline: '17.450,00 RSD', topLabel: 'Hrana' },
    });
    expect(render('TOP_CATEGORIES', facts)).toBe(
      'Hrana 17.450,00 RSD, then Gorivo 9.200,00 RSD, then Zabava 3.000,00 RSD.',
    );
  });

  it('ranked rows with nothing in them, and no stray zero figure', () => {
    const facts = factsOf({ rows: [], formatted: { headline: '0,00 RSD' } });
    const text = render('BUDGET_PACE_VS_PLAN', facts);
    expect(text).toBe('Nothing stands out in that period.');
    expect(text).not.toMatch(/\p{Nd}/u);
  });

  it('a list, with the count it is based on', () => {
    const facts = factsOf({
      rows: [
        { label: 'Lidl', value: '2245000', formatted: '22.450,00 RSD' },
        { label: 'Kirija', value: '2000000', formatted: '20.000,00 RSD' },
      ],
      formatted: { headline: '2' },
    });
    expect(render('LARGEST_TRANSACTIONS', facts, 2)).toBe(
      '2 transactions: Lidl 22.450,00 RSD, then Kirija 20.000,00 RSD.',
    );
  });

  it('a month against the previous one', () => {
    const facts = factsOf({
      totals: [{ label: 'This period', money: { amountMinor: '4665000', currency: 'RSD' }, formatted: '46.650,00 RSD' }],
      formatted: {
        headline: '36.650,00 RSD',
        current: '46.650,00 RSD',
        previous: '10.000,00 RSD',
        previousPeriod: '2026-08-01 – 2026-08-31',
      },
    });
    expect(render('TREND_VS_LAST_MONTH', facts)).toBe(
      'This period 46.650,00 RSD, against 10.000,00 RSD in the previous period — a change of 36.650,00 RSD.',
    );
  });

  it('a month against the usual one', () => {
    const facts = factsOf({
      totals: [{ label: 'This period', money: { amountMinor: '4665000', currency: 'RSD' }, formatted: '46.650,00 RSD' }],
      formatted: {
        headline: '43.316,67 RSD',
        current: '46.650,00 RSD',
        average: '3.333,33 RSD',
        periodsCompared: '3',
      },
    });
    expect(render('TREND_VS_AVERAGE', facts)).toBe(
      'This period 46.650,00 RSD, against a usual 3.333,33 RSD — a difference of 43.316,67 RSD.',
    );
  });
});

describe('the refusal copy', () => {
  it('names what it could not resolve, without a figure', () => {
    expect(renderRefusal('UNRUNNABLE:categoryId')).toBe('I could not tell which Category you meant. Try naming it.');
    expect(renderRefusal('UNRUNNABLE:goalId')).toBe('I could not tell which goal you meant. Try naming it.');
  });

  it('distinguishes "not built" from "not understood"', () => {
    expect(renderRefusal('NOT_BUILT:goals')).toContain('not part of the ledger yet');
    expect(renderRefusal('NOT_BUILT:recurring')).toContain('not part of the ledger yet');
    expect(renderRefusal('NEEDS_TWO_PERIODS')).toContain('two periods');
    expect(renderRefusal('NO_TEMPLATE_MATCH')).toContain('cannot answer that');
  });

  it('has a fallback for a reason it has never seen, rather than an empty string', () => {
    expect(renderRefusal('SOMETHING_NEW').length).toBeGreaterThan(0);
  });

  it('contains no numerals at all, which is the point of a refusal', () => {
    for (const reason of ['NO_TEMPLATE_MATCH', 'NEEDS_TWO_PERIODS', 'NOT_BUILT:goals', 'UNRUNNABLE:merchantId']) {
      expect(renderRefusal(reason), reason).not.toMatch(/\p{Nd}/u);
    }
  });
});
