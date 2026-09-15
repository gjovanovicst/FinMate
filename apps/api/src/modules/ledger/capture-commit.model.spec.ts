import { describe, expect, it } from 'vitest';

import { toCommitRow } from './capture-commit.model';

/**
 * The one thing the resolver must not normalise.
 *
 * `toCommitRow` is the only place an **absent** optional field stays absent. Coalescing it with
 * `?? null` — which the resolver used to do inline — made absent and explicit `null` identical, and
 * for `merchantId`/`counterpartyId` those are different instructions:
 *
 *  - absent: "this client did not preview", so the ledger fills in whatever the classification it
 *    already ran resolved (a live check caught a Merchant being dropped here);
 *  - `null`: "there is no entity on this row", which the pipeline must not overrule.
 *
 * Cheap to test, invisible otherwise, and only expressible because GraphQL preserves the difference.
 */
function input(overrides: Record<string, unknown> = {}) {
  return {
    clientRowId: 'row-1',
    idempotencyKey: 'key-1',
    kind: 'EXPENSE' as const,
    amount: { amountMinor: '200000', currency: 'RSD' },
    confirmDespiteLowConfidence: false,
    ...overrides,
  } as Parameters<typeof toCommitRow>[0];
}

describe('toCommitRow', () => {
  it('leaves an ABSENT entity absent, so the ledger can fill it from the classification', () => {
    const row = toCommitRow(input());
    expect('merchantId' in row).toBe(false);
    expect('counterpartyId' in row).toBe(false);
  });

  it('keeps an explicit null, so a deliberate clear is not overruled', () => {
    const row = toCommitRow(input({ merchantId: null, counterpartyId: null }));
    expect(row.merchantId).toBeNull();
    expect(row.counterpartyId).toBeNull();
  });

  it('carries an echoed entity through unchanged', () => {
    const row = toCommitRow(input({ merchantId: 'm-1', counterpartyId: 'cp-1' }));
    expect(row.merchantId).toBe('m-1');
    expect(row.counterpartyId).toBe('cp-1');
  });

  it('coalesces the fields where absent and null really do mean the same thing', () => {
    // `categoryId` is the contrast: `null` and absent both mean "no override", and the ledger then
    // takes the proposal's category or classifies the row.
    const row = toCommitRow(input());
    expect(row.categoryId).toBeNull();
    expect(row.clientId).toBeNull();
    expect(row.note).toBeNull();
    expect(row.tagIds).toEqual([]);
    expect(row.confirmDespiteLowConfidence).toBe(false);
  });

  it('widens the wire amount without ever touching a Number', () => {
    // `Money.amountMinor` is a string on the wire so a large balance cannot be rounded in transit
    // (ADR-003); the `BigInt` here is a widening, and a value beyond `Number.MAX_SAFE_INTEGER` is the
    // proof that nothing went through a float.
    const row = toCommitRow(input({ amount: { amountMinor: '9007199254740993', currency: 'RSD' } }));
    expect(row.amount.amountMinor).toBe(9_007_199_254_740_993n);
  });
});
