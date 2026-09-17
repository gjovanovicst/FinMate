import { describe, expect, it } from 'vitest';

import {
  actionDiffRows,
  actionRefusalKey,
  canExpand,
  drillThroughLabelKey,
  drillThroughTarget,
  factRows,
  factTotals,
  fallbackNoteKey,
  isProposal,
  expiryTime,
  kindChoice,
  narrationKey,
  narrationReasonKey,
  moneyRow,
  periodLabel,
  phaseOf,
  proposalLabelKey,
  proposalSummary,
  provenanceKey,
  renderableProposal,
  suggestionChips,
  undoPlan,
  type ActionPreview,
  type ActionProposal,
  type ActionResult,
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

describe('how the answer was put into words', () => {
  it('names the path that produced the sentence, in both directions', () => {
    // docs/06 §8.5 said the fallback stays invisible; 4.3.7b reversed that once narration became
    // routable, because the mode is the only *statement* of which path produced the words.
    expect(narrationKey('LLM')).toBe('assistant.narration.llm');
    expect(narrationKey('TEMPLATE_FALLBACK')).toBe('assistant.narration.template');
  });

  it('explains a fallback by the prefix of a diagnostic reason, and invents nothing otherwise', () => {
    // `reason` is a machine string (`CONSENT_DECLINED:CONSENT_DECLINED`,
    // `UNACCOUNTED_NUMERALS:99.000,00`, …), so only the prefix is read.
    expect(narrationReasonKey('CONSENT_DECLINED:CONSENT_DECLINED')).toBe('assistant.narration.why.consent');
    expect(narrationReasonKey('CONSENT_DECLINED')).toBe('assistant.narration.why.consent');
    expect(narrationReasonKey('AI_UNAVAILABLE:no-provider-configured')).toBe('assistant.narration.why.none');
    expect(narrationReasonKey('PROVIDER_UNAVAILABLE:TASK_NOT_SUPPORTED')).toBe(
      'assistant.narration.why.unreachable',
    );
    expect(narrationReasonKey('CIRCUIT_OPEN:x')).toBe('assistant.narration.why.unreachable');
    expect(narrationReasonKey('UNACCOUNTED_NUMERALS:99.000,00')).toBe('assistant.narration.why.unaccounted');
    expect(narrationReasonKey('EMPTY_NARRATION')).toBe('assistant.narration.why.unaccounted');
    // A reason this build does not know gets no sentence: an invented explanation is worse than none.
    expect(narrationReasonKey('SOMETHING_NEW:42')).toBeNull();
    expect(narrationReasonKey(null)).toBeNull();
  });

  it('puts the visible note on consent alone, because it is the only reason with an action', () => {
    expect(
      fallbackNoteKey(answer({ narrationMode: 'TEMPLATE_FALLBACK', reason: 'CONSENT_DECLINED:CONSENT_DECLINED' })),
    ).toBe('assistant.narration.consentNote');

    // A deployment that configured no model is not something the reader can change from here.
    expect(
      fallbackNoteKey(answer({ narrationMode: 'TEMPLATE_FALLBACK', reason: 'AI_UNAVAILABLE:no-provider-configured' })),
    ).toBeNull();
    // A narrated answer says nothing on the card whatever its reason (there is none).
    expect(fallbackNoteKey(answer({ narrationMode: 'LLM', reason: null }))).toBeNull();
    // A refusal is not narrated at all: the narrator is never called (`answered: false`).
    expect(
      fallbackNoteKey(
        answer({ answered: false, narrationMode: 'TEMPLATE_FALLBACK', reason: 'CONSENT_DECLINED:x' }),
      ),
    ).toBeNull();
  });
});

/**
 * The write path's decisions — B-2b.
 *
 * These are the ones that go wrong **quietly**: a card drawn for a proposal the server refused, a kind
 * toggle attached to a row the user stated rather than the server defaulted, an Undo button whose
 * mutation belongs to a different action. Each is a possibility of a wrong *write*, which is why the
 * helpers are pure and tested apart from the component (R-29).
 */
describe('the assistant write path (docs/06 §8.16)', () => {
  const preview = (diff: ActionPreview['diff']): ActionPreview => ({
    sentence: 'Nova kategorija „Putovanja” (rashod, bez nadređene)',
    diff,
  });

  const KIND_ROW = {
    slot: 'kind' as const,
    field: 'vrsta',
    before: null,
    after: 'rashod',
    afterValue: 'EXPENSE',
    defaulted: true,
  };

  const proposal = (over: Partial<ActionProposal> = {}): ActionProposal => ({
    proposed: true,
    reason: null,
    proposalId: 'p1',
    action: 'ADD_CATEGORY',
    preview: preview([KIND_ROW]),
    expiresAt: '2026-09-20T10:10:00.000Z',
    ...over,
  });

  const result = (over: Partial<ActionResult> = {}): ActionResult => ({
    action: 'ADD_CATEGORY',
    createdId: 'c1',
    createdLabel: 'Putovanja',
    undo: 'SOFT_DELETE',
    sentence: 'Nova kategorija „Putovanja” (rashod, bez nadređene)',
    replayed: false,
    ...over,
  });

  it('renders a proposal only when the server proposed one and identified it', () => {
    expect(renderableProposal(proposal())).not.toBeNull();
    // A refusal, whatever its reason, is not a card.
    expect(renderableProposal(proposal({ proposed: false, reason: 'NOT_AN_ACTION' }))).toBeNull();
    // A proposal with no id could not be confirmed, so offering it would offer a button that cannot work.
    expect(renderableProposal(proposal({ proposalId: null }))).toBeNull();
    expect(renderableProposal(proposal({ preview: null }))).toBeNull();
    expect(renderableProposal(null)).toBeNull();
  });

  it('says nothing about a question that is simply not an action', () => {
    // Most questions land here: the read planner refused them and no action was named. Copy about the
    // assistant's own vocabulary on every unanswerable question is exactly what §8.5's instinct was
    // protecting against.
    expect(actionRefusalKey('NOT_AN_ACTION')).toBeNull();
    expect(actionRefusalKey(null)).toBeNull();
    expect(actionRefusalKey('SOMETHING_NEW:x')).toBeNull();
  });

  it('asks for the missing detail when the request was unmistakable', () => {
    expect(actionRefusalKey('UNRUNNABLE:name')).toBe('assistant.action.needName');
    // An unrecognised slot still says the request cannot be built, rather than inventing which part.
    expect(actionRefusalKey('UNRUNNABLE:kind')).toBe('assistant.action.notRunnable');
    expect(actionRefusalKey('UNRUNNABLE:name,kind')).toBe('assistant.action.needName');
  });

  it('drops a diff row that becomes nothing, instead of printing an empty field', () => {
    const rows = actionDiffRows(
      preview([
        { slot: 'name', field: 'naziv', before: null, after: 'Putovanja', defaulted: false },
        { slot: 'parentId', field: 'nadređena', before: null, after: null, defaulted: false },
      ]),
    );

    expect(rows.map((row) => row.field)).toEqual(['naziv']);
    expect(actionDiffRows(null)).toEqual([]);
  });

  it('offers the kind toggle only for a row the server defaulted and gave a machine value', () => {
    expect(kindChoice(preview([KIND_ROW]))).toEqual({ current: 'EXPENSE', other: 'INCOME' });
    // The other direction, which is what a second click must produce.
    expect(kindChoice(preview([{ ...KIND_ROW, after: 'prihod', afterValue: 'INCOME' }]))).toEqual({
      current: 'INCOME',
      other: 'EXPENSE',
    });
  });

  it('refuses the toggle when the question stated the kind, or the value is only a label', () => {
    // `defaulted: false` means the user said it — a kind that was asked for is not a suggestion.
    expect(kindChoice(preview([{ ...KIND_ROW, defaulted: false }]))).toBeNull();
    // A label with no machine value would force the client to keep its own copy of the API's words.
    expect(kindChoice(preview([{ ...KIND_ROW, afterValue: null }]))).toBeNull();
    expect(kindChoice(preview([]))).toBeNull();
    expect(kindChoice(null)).toBeNull();
  });

  it('offers an undo only where the server says one exists and this client knows how', () => {
    expect(undoPlan(result())).toEqual({ action: 'ADD_CATEGORY', id: 'c1' });
    // The server never offers a `NONE` action, so this is a belt-and-braces gate rather than a path.
    expect(undoPlan(result({ undo: 'NONE' }))).toBeNull();
    // A client one release behind a server that added an action: no control, rather than a call to
    // whatever the fall-through happened to name.
    expect(undoPlan(result({ action: 'ADD_TAG' }))).toBeNull();
  });

  it('renders the expiry as a clock time, and nothing at all when it cannot read one', () => {
    expect(expiryTime('2026-09-20T10:10:00.000Z', 'en-GB')).toMatch(/\d{1,2}:\d{2}/);
    expect(expiryTime(null, 'en-GB')).toBeNull();
    expect(expiryTime('not a date', 'en-GB')).toBeNull();
    // A locale the runtime does not know must not take the card down with it.
    expect(expiryTime('2026-09-20T10:10:00.000Z', 'not a locale')).toBeNull();
  });
});
