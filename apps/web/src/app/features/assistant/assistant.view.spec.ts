import { describe, expect, it } from 'vitest';

import {
  canExpand,
  drillThroughLabelKey,
  drillThroughTarget,
  factRows,
  factTotals,
  isProposal,
  moneyRow,
  periodLabel,
  phaseOf,
  proposalLabelKey,
  proposalSummary,
  provenanceKey,
  suggestionChips,
  type AssistantAnswer,
  type AssistantFacts,
  type Provenance,
  type Turn,
} from './assistant.view';

/**
 * The assistant screen's decisions, without a DOM.
 *
 * The three that are silent when wrong: a refusal rendered as an answer, a count rendered as money,
 * and a drill-through link that points at rows the answer did not come from.
 */
const provenance: Provenance = {
  periodStart: '2026-09-01',
  periodEnd: '2026-09-30',
  transactionCount: 3,
  sourceQuery: 'spend.total.v1',
  filters: {},
  computedAt: '2026-09-20T10:00:00.000Z',
  ledgerCurrency: 'RSD',
};

function facts(overrides: Partial<AssistantFacts> = {}): AssistantFacts {
  return {
    template: 'SPEND_TOTAL',
    rows: [],
    totals: [
      { label: 'Spending', money: { amountMinor: '4665000', currency: 'RSD' }, formatted: '46.650,00 RSD' },
    ],
    formatted: { headline: '46.650,00 RSD' },
    ...overrides,
  };
}

function answer(overrides: Partial<AssistantAnswer> = {}): AssistantAnswer {
  return {
    id: 'a1',
    question: 'koliko sam potrošio ovog meseca',
    intent: 'SPEND_TOTAL',
    answered: true,
    answerText: 'You spent 46.650,00 RSD.',
    facts: facts(),
    provenance,
    drillThrough: { route: '/transactions', transactionIds: [], filter: { from: '2026-09-01', to: '2026-09-30' } },
    suggestions: [],
    narrationMode: 'TEMPLATE_FALLBACK',
    latencyMs: 20,
    costMicros: null,
    reason: null,
    ...overrides,
  };
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return { id: 'turn-1', question: 'koliko sam potrošio ovog meseca', answer: answer(), failed: false, ...overrides };
}

describe('the answer phase', () => {
  it('is idle before anything is asked, and asking while a request is in flight', () => {
    expect(phaseOf(null, false)).toBe('idle');
    expect(phaseOf(null, true)).toBe('asking');
    expect(phaseOf(turn(), true)).toBe('asking');
  });

  it('separates a refusal from an answer, because the user does something different', () => {
    expect(phaseOf(turn(), false)).toBe('answered');
    expect(phaseOf(turn({ answer: answer({ answered: false }) }), false)).toBe('refused');
  });

  it('separates a failed request from a refusal, because a refusal is not an error', () => {
    // A refusal came *from* the ledger and its suggestions are useful; a failure never reached it.
    expect(phaseOf(turn({ answer: null, failed: true }), false)).toBe('failed');
  });
});

describe('the figures the card shows', () => {
  it('renders a row as money when its value is minor units', () => {
    expect(
      moneyRow({ label: 'Hrana', value: '1745000', formatted: '17.450,00 RSD' }, 'RSD'),
    ).toEqual({ amountMinor: '1745000', currency: 'RSD' });
  });

  it('refuses to dress a count as money, which would print 3,00 RSD for three transactions', () => {
    expect(moneyRow({ label: 'Transactions', value: '3', formatted: '3' }, 'RSD')).toBeNull();
    expect(moneyRow({ label: 'Broken', value: '1.5', formatted: '1,5' }, 'RSD')).toBeNull();
  });

  it('takes the currency from the totals, so a row and its total cannot disagree', () => {
    const rows = factRows(
      facts({ rows: [{ label: 'Hrana', value: '1745000', formatted: '17.450,00 RSD' }] }),
    );
    expect(rows).toEqual([{ label: 'Hrana', money: { amountMinor: '1745000', currency: 'RSD' } }]);
  });

  it('drops a non-money row from the money list rather than rendering it as an amount', () => {
    const rows = factRows(
      facts({
        rows: [
          { label: 'Hrana', value: '1745000', formatted: '17.450,00 RSD' },
          { label: 'Count', value: '3', formatted: '3' },
        ],
      }),
    );
    expect(rows.map((row) => row.label)).toEqual(['Hrana']);
  });

  it('passes totals through, because totals are money by construction', () => {
    expect(factTotals(facts())[0]?.money.amountMinor).toBe('4665000');
  });

  it('expands only when there is something inside', () => {
    expect(canExpand(facts())).toBe(true);
    expect(canExpand(facts({ totals: [] }))).toBe(false);
    expect(canExpand(facts({ totals: [], rows: [{ label: 'Hrana', value: '1', formatted: '1' }] }))).toBe(true);
  });
});

describe('the F-30 proposal', () => {
  const proposal: AssistantFacts = {
    template: 'SAVINGS_PROPOSAL',
    rows: [
      { label: 'Hrana / Supermarket', value: '349000', formatted: '3.490,00 RSD' },
      { label: 'Gorivo', value: '151000', formatted: '1.510,00 RSD' },
    ],
    totals: [
      { label: 'Target', money: { amountMinor: '500000', currency: 'RSD' }, formatted: '5.000,00 RSD' },
      { label: 'Proposed', money: { amountMinor: '500000', currency: 'RSD' }, formatted: '5.000,00 RSD' },
      { label: 'Shortfall', money: { amountMinor: '0', currency: 'RSD' }, formatted: '0,00 RSD' },
    ],
    formatted: { headline: '5.000,00 RSD', meetsTarget: 'true' },
  };

  it('is recognised by its template, because it is a plan and not a report of what happened', () => {
    expect(isProposal(proposal)).toBe(true);
    expect(isProposal(facts())).toBe(false);
  });

  it('reads the three headline figures, and drops a shortfall of zero as noise', () => {
    const summary = proposalSummary(proposal);

    expect(summary.target?.amountMinor).toBe('500000');
    expect(summary.proposed?.amountMinor).toBe('500000');
    expect(summary.shortfall).toBeNull();
    expect(summary.lines.map((line) => line.money.amountMinor)).toEqual(['349000', '151000']);
  });

  it('keeps a shortfall when there is one, because it is the honest half of the answer', () => {
    const short = proposalSummary({
      ...proposal,
      totals: [
        ...proposal.totals.slice(0, 2),
        { label: 'Shortfall', money: { amountMinor: '100000', currency: 'RSD' }, formatted: '1.000,00 RSD' },
      ],
    });

    expect(short.shortfall?.amountMinor).toBe('100000');
  });

  it('localises the server’s labels, and keeps an unknown one rather than showing a key', () => {
    expect(proposalLabelKey('Target')).toBe('assistant.proposalTarget');
    expect(proposalLabelKey('Proposed')).toBe('assistant.proposalProposed');
    expect(proposalLabelKey('Shortfall')).toBe('assistant.proposalShortfall');
    // A future server label must render as itself, not as `assistant.proposalSomething`.
    expect(proposalLabelKey('Something new')).toBeNull();
  });
});

describe('the drill-through link', () => {
  it('carries the filter the answer was computed with', () => {
    expect(
      drillThroughTarget({ route: '/transactions', transactionIds: [], filter: { from: '2026-09-01', to: '2026-09-30', kind: 'EXPENSE' } }),
    ).toEqual({
      route: '/transactions',
      queryParams: { from: '2026-09-01', to: '2026-09-30', kind: 'EXPENSE' },
    });
  });

  it('keeps the route and its parameters separate, because routerLink takes them separately', () => {
    // One string containing `?from=…` makes Angular treat it as a single path segment and encode the
    // question mark: the link pointed at `/transactions%3Ffrom%3D…` until this test existed.
    const target = drillThroughTarget({ route: '/transactions', transactionIds: [], filter: { from: '2026-09-01' } });
    expect(target?.route).not.toContain('?');
    expect(target?.route).not.toContain('from=');
  });

  it('is nothing when the API offered nothing', () => {
    // A merchant-scoped answer has no route that can reproduce its scope yet (docs/06 §8.8), and a
    // link to an unfiltered list would show rows the answer did not aggregate.
    expect(drillThroughTarget(null)).toBeNull();
  });

  it('drops filter keys the transactions screen cannot apply', () => {
    // The bag names the `transactions` arguments; anything else would be a claim the screen ignores.
    expect(
      drillThroughTarget({ route: '/transactions', transactionIds: [], filter: { merchantId: 'm1', from: '2026-09-01' } }),
    ).toEqual({ route: '/transactions', queryParams: { from: '2026-09-01' } });
  });

  it('links to the route alone when the filter is empty', () => {
    expect(drillThroughTarget({ route: '/budgets', transactionIds: [], filter: {} })).toEqual({
      route: '/budgets',
      queryParams: {},
    });
    expect(drillThroughTarget({ route: '/accounts', transactionIds: [] })?.queryParams).toEqual({});
  });

  it('labels the link for the screen it opens, not for the list it usually opens', () => {
    expect(drillThroughLabelKey({ route: '/transactions', transactionIds: [] })).toBe('assistant.openList');
    expect(drillThroughLabelKey({ route: '/review', transactionIds: [] })).toBe('assistant.openReview');
    expect(drillThroughLabelKey({ route: '/budgets', transactionIds: [] })).toBe('assistant.openBudgets');
    expect(drillThroughLabelKey({ route: '/accounts', transactionIds: [] })).toBe('assistant.openAccounts');
    expect(drillThroughLabelKey(null)).toBe('assistant.openList');
  });
});

describe('the suggestion chips', () => {
  it('offers the refusal’s questions and nothing when the ledger answered', () => {
    const refused = turn({ answer: answer({ answered: false, suggestions: ['Koliko sam potrošio?', '  '] }) });
    expect(suggestionChips(refused)).toEqual(['Koliko sam potrošio?']);
    expect(suggestionChips(turn())).toEqual([]);
  });

  it('says nothing while a question is still in flight', () => {
    expect(suggestionChips(turn({ answer: null }))).toEqual([]);
    expect(suggestionChips(null)).toEqual([]);
  });
});

describe('the provenance line', () => {
  it('picks the one/many wording in code, because the catalogue has no plural machinery', () => {
    expect(provenanceKey(1)).toBe('assistant.provenanceOne');
    expect(provenanceKey(0)).toBe('assistant.provenanceMany');
    expect(provenanceKey(3)).toBe('assistant.provenanceMany');
  });

  it('formats the range in the reader’s language', () => {
    const label = periodLabel(provenance, 'en');
    expect(label).toContain('2026');
    expect(label).toContain('1');
    expect(label).toContain('30');
    expect(label).toContain('–');
  });

  it('shows a single day once when both ends are the same day', () => {
    // A balance is true "as of" one day; rendering "20 Sep 2026 – 20 Sep 2026" would be noise.
    expect(periodLabel({ ...provenance, periodStart: '2026-09-20', periodEnd: '2026-09-20' }, 'en')).toBe(
      periodLabel({ ...provenance, periodStart: '2026-09-20', periodEnd: '2026-09-20' }, 'en'),
    );
    expect(
      periodLabel({ ...provenance, periodStart: '2026-09-20', periodEnd: '2026-09-20' }, 'en'),
    ).not.toContain('–');
  });

  it('falls back to the raw day rather than throwing on a value it cannot read', () => {
    expect(periodLabel({ ...provenance, periodStart: 'not-a-day', periodEnd: 'not-a-day' }, 'en')).toBe('not-a-day');
  });
});
