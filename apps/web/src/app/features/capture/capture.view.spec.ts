import { describe, expect, it } from 'vitest';

import type { LocalDate } from '@finmate/domain';

import {
  activeRows,
  ambiguousRows,
  applyFragments,
  blockedRows,
  canCommit,
  chosenAmountMinor,
  confirmableRows,
  directionUnsure,
  laneOf,
  needsAmountChoice,
  parseLocally,
  provenanceOf,
  summariseCommit,
  suspectTransactionIds,
  toCommitRows,
  type CaptureProposal,
  type CaptureRow,
} from './capture.view';

/**
 * The capture preview's decisions, without a component.
 *
 * The two things worth pinning here are the ones a component test would miss because they are about
 * *identity over time*: a row's `idempotencyKey` must not change when the user keeps typing (I-10's
 * retry safety depends on it), and a user's category override must not be marked as a correction when
 * they kept the proposal's own answer (docs/04 §6.4's label).
 */

const TODAY = '2026-09-14' as LocalDate;

function parse(text: string, previous: readonly CaptureRow[] = []): readonly CaptureRow[] {
  return parseLocally(text, { currency: 'RSD', today: TODAY, previous });
}

function proposal(overrides: Partial<CaptureProposal> = {}): CaptureProposal {
  return {
    id: 'proposal-1',
    categoryId: 'cat-food',
    decidedBy: 'KEYWORD',
    confidence: 0.95,
    needsReview: false,
    advisory: false,
    rationale: 'KEYWORD',
    merchantId: null,
    alternatives: [],
    amountMinor: 200000n,
    currency: 'RSD',
    description: 'Lidl',
    needsDirectionConfirmation: false,
    ...overrides,
  };
}

describe('parseLocally', () => {
  it('extracts one row per fragment with the amount in minor units', () => {
    const rows = parse('Lidl 2000, gorivo 3500, plata 150000');

    expect(rows).toHaveLength(3);
    expect(chosenAmountMinor(rows[0]!)).toBe(200000n);
    expect(chosenAmountMinor(rows[1]!)).toBe(350000n);
    // 150 000 RSD is 15 000 000 para: two decimals, not one.
    expect(chosenAmountMinor(rows[2]!)).toBe(15_000_000n);
    expect(rows[2]!.kind).toBe('INCOME');
    // Nothing has been classified yet, so every row is in the awaiting-server state.
    expect(rows.map((row) => laneOf(row))).toEqual(['AWAITING', 'AWAITING', 'AWAITING']);
  });

  it('keeps a row’s identity and edits when the text grows', () => {
    const first = parse('Lidl 2000');
    const second = parse('Lidl 2000, gorivo 3500', first);

    expect(second).toHaveLength(2);
    // The key is what makes a retry idempotent, so it must not be minted afresh per keystroke.
    expect(second[0]!.idempotencyKey).toBe(first[0]!.idempotencyKey);
    expect(second[0]!.clientRowId).toBe(first[0]!.clientRowId);
    // A row that appeared later gets its own identity.
    expect(second[1]!.idempotencyKey).not.toBe(first[0]!.idempotencyKey);
  });

  it('keeps a category choice across a keystroke elsewhere in the field', () => {
    const first = parse('Lidl 2000');
    const edited: CaptureRow[] = [{ ...first[0]!, categoryId: 'cat-fuel' }];
    const second = parse('Lidl 2000, gorivo 3500', edited);

    expect(second[0]!.categoryId).toBe('cat-fuel');
    expect(second[1]!.categoryId).toBeNull();
  });

  it('makes two identical fragments two rows, not one row edited twice', () => {
    const rows = parse('Lidl 2000, Lidl 2000');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.idempotencyKey).not.toBe(rows[1]!.idempotencyKey);
  });

  it('returns no rows for empty or whitespace-only input', () => {
    expect(parse('')).toHaveLength(0);
    expect(parse('   ')).toHaveLength(0);
  });
});

describe('applyFragments', () => {
  it('fills each row’s proposal in order and leaves the rest awaiting', () => {
    const rows = parse('Lidl 2000, gorivo 3500');
    const merged = applyFragments(rows, [proposal()]);

    expect(merged[0]!.proposal?.id).toBe('proposal-1');
    expect(merged[1]!.proposal).toBeNull();
    expect(laneOf(merged[0]!)).toBe('AUTO');
    expect(laneOf(merged[1]!)).toBe('AWAITING');
  });

  it('never overwrites a category the user chose', () => {
    const rows = parse('Lidl 2000');
    const edited: CaptureRow[] = [{ ...rows[0]!, categoryId: 'cat-fuel' }];
    const merged = applyFragments(edited, [proposal()]);

    expect(merged[0]!.categoryId).toBe('cat-fuel');
    expect(merged[0]!.proposal?.categoryId).toBe('cat-food');
  });
});

describe('laneOf', () => {
  it('labels the four states and blocks a null category at any confidence', () => {
    const base = parse('Lidl 2000')[0]!;

    expect(laneOf(base)).toBe('AWAITING');
    expect(laneOf({ ...base, proposal: proposal({ confidence: 0.9 }) })).toBe('AUTO');
    expect(laneOf({ ...base, proposal: proposal({ confidence: 0.6 }) })).toBe('ADVISORY');
    expect(laneOf({ ...base, proposal: proposal({ confidence: 0.89 }) })).toBe('ADVISORY');
    expect(laneOf({ ...base, proposal: proposal({ confidence: 0.59 }) })).toBe('ASK');
    // I-8: a null category is the blocking lane whatever the confidence says.
    expect(laneOf({ ...base, proposal: proposal({ categoryId: null, confidence: 0.99 }) })).toBe('ASK');
  });
});

describe('the batch', () => {
  it('counts the blocking lane for the button and excludes removed rows', () => {
    const rows = parse('Lidl 2000, Dejan 3600, gorivo 3500');
    const merged = applyFragments(rows, [
      proposal({ id: 'p1', confidence: 0.95, categoryId: 'cat-food' }),
      proposal({ id: 'p2', confidence: 0.61, categoryId: 'cat-gift' }),
      proposal({ id: 'p3', confidence: 0.4, categoryId: 'cat-fuel' }),
    ]);

    expect(confirmableRows(merged)).toHaveLength(3);
    expect(blockedRows(merged).map((row) => row.clientRowId)).toEqual([merged[2]!.clientRowId]);
    // A blocked row is still committed (as PENDING) — it must not stop the other two (F-06).
    expect(canCommit(merged)).toBe(true);

    const withRemoved: CaptureRow[] = merged.map((row, index) =>
      index === 2 ? { ...row, removed: true } : row,
    );
    expect(activeRows(withRemoved)).toHaveLength(2);
    expect(blockedRows(withRemoved)).toHaveLength(0);
    expect(confirmableRows(withRemoved)).toHaveLength(2);
  });

  it('refuses the batch while an amount reading is unresolved', () => {
    const rows = parse('Lidl 1.200');
    const row = rows[0]!;
    // `1.200` reads as either 1200 (thousands) or 1.2 — docs/04 §3.1 makes the parser surface both
    // rather than choose, and docs/02 §3 refuses the commit until the user does.
    expect(row.candidates.length).toBeGreaterThan(1);
    expect(needsAmountChoice(row)).toBe(true);
    expect(ambiguousRows(rows)).toHaveLength(1);
    expect(canCommit(rows)).toBe(false);

    const picked: CaptureRow[] = [{ ...row, pickedAmountMinor: 120000n }];
    expect(needsAmountChoice(picked[0]!)).toBe(false);
    expect(chosenAmountMinor(picked[0]!)).toBe(120000n);
    expect(canCommit(picked)).toBe(true);
  });

  it('does not block the batch on a fragment with no amount', () => {
    const rows = parse('Lidl 2000, i jos nesto');
    expect(confirmableRows(rows)).toHaveLength(1);
    expect(canCommit(rows)).toBe(true);
  });

  it('cannot commit an empty or fully-removed batch', () => {
    expect(canCommit([])).toBe(false);
    const rows = parse('Lidl 2000').map((row) => ({ ...row, removed: true }));
    expect(canCommit(rows)).toBe(false);
  });
});

describe('toCommitRows', () => {
  it('sends money as a minimal-unit STRING and no float anywhere', () => {
    const rows = parse('Lidl 2000');
    const payload = toCommitRows(rows);

    expect(payload).toHaveLength(1);
    expect(payload[0]!.amount).toEqual({ amountMinor: '200000', currency: 'RSD' });
    expect(typeof payload[0]!.amount.amountMinor).toBe('string');
  });

  it('echoes the proposal without claiming the user overrode it', () => {
    const rows = applyFragments(parse('Lidl 2000'), [proposal()]);
    const payload = toCommitRows(rows);

    // Sending the proposal's own category would be read server-side as an override and would mark
    // every accepted proposal as a correction — the label docs/04 §6.4's re-fit consumes.
    expect(payload[0]!.categoryId).toBeNull();
    expect(payload[0]!.acceptedProposalId).toBe('proposal-1');
  });

  it('sends the category when the user actually changed it', () => {
    const rows = parse('Lidl 2000').map((row) => ({ ...row, categoryId: 'cat-fuel' }));
    const payload = toCommitRows(applyFragments(rows, [proposal()]));

    expect(payload[0]!.categoryId).toBe('cat-fuel');
    expect(payload[0]!.acceptedProposalId).toBe('proposal-1');
  });

  it('sends a user category for a row the server never classified', () => {
    const rows = parse('nepoznato 500').map((row) => ({ ...row, categoryId: 'cat-other' }));
    expect(toCommitRows(rows)[0]!.categoryId).toBe('cat-other');
    expect(toCommitRows(rows)[0]!.acceptedProposalId).toBeNull();
  });

  it('keeps the row’s own idempotency key so a retry collapses (I-10)', () => {
    const rows = parse('Lidl 2000, gorivo 3500');
    const first = toCommitRows(rows);
    const second = toCommitRows(rows);

    expect(first.map((row) => row.idempotencyKey)).toEqual(second.map((row) => row.idempotencyKey));
    expect(new Set(first.map((row) => row.idempotencyKey)).size).toBe(2);
  });

  it('never force-confirms a low-confidence row as a batch side effect', () => {
    const rows = applyFragments(parse('Dejan 3600'), [proposal({ confidence: 0.4 })]);
    expect(toCommitRows(rows)[0]!.confirmDespiteLowConfidence).toBe(false);
  });

  it('flags a direction the parser was unsure about, and maps UNKNOWN to EXPENSE', () => {
    const rows = parse('vraceno 2000');
    expect(directionUnsure(rows[0]!)).toBe(true);
    // `TransactionKind` has no UNKNOWN arm: the preview must ask rather than commit a guess.
    expect(toCommitRows(rows)[0]!.kind).toBe('EXPENSE');
  });
});

describe('provenanceOf', () => {
  it('reports the deciding layer, and USER only when the user really changed it', () => {
    const rows = parse('Lidl 2000');
    expect(provenanceOf(rows[0]!)).toBe('NONE');

    const classified = applyFragments(rows, [proposal({ decidedBy: 'KEYWORD' })]);
    expect(provenanceOf(classified[0]!)).toBe('KEYWORD');

    const sameChoice: CaptureRow[] = [{ ...classified[0]!, categoryId: 'cat-food' }];
    expect(provenanceOf(sameChoice[0]!)).toBe('KEYWORD');

    const changed: CaptureRow[] = [{ ...classified[0]!, categoryId: 'cat-fuel' }];
    expect(provenanceOf(changed[0]!)).toBe('USER');
  });
});

describe('summariseCommit', () => {
  const existing = {
    id: 'tx-old',
    description: 'Lidl',
    occurredLocalDate: '2026-09-14',
    amount: { amountMinor: '200000', currency: 'RSD' },
  };

  it('joins a suspect back to the row the user typed', () => {
    const rows = parse('Lidl 2000, gorivo 3500');
    const summary = summariseCommit({
      rows,
      committed: [
        { clientRowId: rows[0]!.clientRowId, transaction: { id: 'tx-new' }, wasReplayed: false },
        { clientRowId: rows[1]!.clientRowId, transaction: { id: 'tx-other' }, wasReplayed: false },
      ],
      suspects: [
        {
          clientRowId: rows[0]!.clientRowId,
          transactionId: 'tx-new',
          existingTransaction: existing,
          similarity: 1,
          matchedOn: ['amount', 'description', 'date'],
        },
      ],
      replayed: false,
      reviewCount: 0,
    });

    expect(summary.committedIds).toEqual(['tx-new', 'tx-other']);
    expect(summary.committedCount).toBe(2);
    expect(summary.suspects).toHaveLength(1);
    // The description comes from the ROW, not from the row the user is being warned about — the
    // chip has to name what they just typed or it cannot be acted on.
    expect(summary.suspects[0]!.description).toBe('Lidl 2000');
    expect(summary.suspects[0]!.existing.id).toBe('tx-old');
  });

  it('still reports a suspect whose row cannot be found', () => {
    const summary = summariseCommit({
      rows: [],
      committed: [],
      suspects: [
        {
          clientRowId: 'gone',
          transactionId: 'tx-new',
          existingTransaction: existing,
          similarity: 0.9,
          matchedOn: ['amount', 'date'],
        },
      ],
      replayed: false,
      reviewCount: 0,
    });

    // Dropping it would silently hide a duplicate the API took the trouble to report.
    expect(summary.suspects).toHaveLength(1);
    expect(summary.suspects[0]!.description).toBe('Lidl');
  });

  it('carries the replay flag and the review count through', () => {
    const summary = summariseCommit({
      rows: [],
      committed: [{ clientRowId: 'a', transaction: { id: 'tx-1' }, wasReplayed: true }],
      suspects: [],
      replayed: true,
      reviewCount: 2,
    });

    expect(summary.replayed).toBe(true);
    expect(summary.reviewCount).toBe(2);
    expect(summary.suspects).toEqual([]);
  });
});

describe('suspectTransactionIds', () => {
  it('names the rows just written, never the earlier row they resemble, and never twice', () => {
    const suspects = [
      {
        clientRowId: 'a',
        transactionId: 'tx-1',
        description: 'Lidl 2000',
        existing: {} as never,
        similarity: 1,
        matchedOn: [] as string[],
      },
      // The symmetric second half of an intra-batch duplicate: same pair, other direction.
      {
        clientRowId: 'b',
        transactionId: 'tx-2',
        description: 'Lidl 2000',
        existing: {} as never,
        similarity: 1,
        matchedOn: [] as string[],
      },
    ];

    // Two identical rows in one batch produce two suspects naming the same two ids; an undo that
    // counted them naively would report four.
    expect(suspectTransactionIds(suspects)).toEqual(['tx-1', 'tx-2']);
    expect(suspectTransactionIds([suspects[0]!, suspects[0]!])).toEqual(['tx-1']);
    expect(suspectTransactionIds([])).toEqual([]);
  });
});
