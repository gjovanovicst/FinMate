// @vitest-environment jsdom
import 'fake-indexeddb/auto';

// FIRST import, deliberately: the JIT compiler must be loaded before the testing module is used.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { LEDGER_SNAPSHOT_MAX_ROWS, selectLedgerRows, type TransactionSnapshotSource } from './offline-store';
import { LedgerCacheService } from './ledger-cache.service';

initAngularTesting();

/**
 * The ledger cache's two promises (task 4.2.8, ADR-025 decision 5).
 *
 * The **window** is the part that is wrong silently: an unbounded list is a phone holding a Household's
 * whole history, and a window that quietly includes a row it cannot date is a window that lies about
 * what it covers. The **round trip** is the other half — a cache nothing can read is not a cache — and
 * the whitelist is asserted through it, so a field added to the row shape has to be added here too.
 */
function row(overrides: Partial<TransactionSnapshotSource> = {}): TransactionSnapshotSource {
  return {
    amountMinor: '200000',
    kind: 'EXPENSE',
    occurredLocalDate: '2026-09-14',
    description: 'Lidl 2000',
    category: { id: 'cat-food', name: 'Hrana' },
    ...overrides,
  };
}

const TODAY = '2026-09-16';

describe('selectLedgerRows', () => {
  it('keeps the window and drops what is older, newest first', () => {
    const rows = selectLedgerRows(
      [
        row({ occurredLocalDate: '2026-09-01', description: 'inside' }),
        row({ occurredLocalDate: '2026-01-01', description: 'long past' }),
        row({ occurredLocalDate: '2026-09-15', description: 'yesterday' }),
      ],
      TODAY,
    );

    expect(rows.map((entry) => entry.description)).toEqual(['yesterday', 'inside']);
  });

  it('drops a row it cannot place in time rather than letting the window lie', () => {
    const rows = selectLedgerRows([row({ occurredLocalDate: 'not-a-date' }), row()], TODAY);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Lidl 2000');
  });

  it('caps the list, keeping the newest', () => {
    const many = Array.from({ length: LEDGER_SNAPSHOT_MAX_ROWS + 25 }, (_unused, index) =>
      row({ occurredLocalDate: '2026-09-01', description: `row-${index}` }),
    );

    const rows = selectLedgerRows(many, TODAY);

    expect(rows).toHaveLength(LEDGER_SNAPSHOT_MAX_ROWS);
  });

  it('keeps only the whitelisted fields, and no row id', () => {
    // The id is absent on purpose: a cached row cannot be drilled into, because docs/08 §3.9's
    // minimisation list has nothing to link to. Adding one is a decision, not a convenience.
    const rows = selectLedgerRows([row()], TODAY);

    expect(Object.keys(rows[0]!).sort()).toEqual([
      'amountMinor',
      'category',
      'description',
      'kind',
      'occurredLocalDate',
    ]);
  });
});

describe('LedgerCacheService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('round-trips rows and reports them live on write, stale on read', async () => {
    TestBed.configureTestingModule({});
    const cache = TestBed.inject(LedgerCacheService);

    await cache.writeRows([row()], TODAY);
    expect(cache.staleAt()).toBeNull();

    const record = await cache.readRows();
    expect(record?.rows).toHaveLength(1);
    expect(record?.syncedAt).toBeTypeOf('string');
    // Reading is what makes them stale, so a screen cannot render them unlabelled.
    expect(cache.staleAt()).toBe(record?.syncedAt);
  });

  it('reports no rows on a fresh install rather than an empty list that looks live', async () => {
    TestBed.configureTestingModule({});
    const cache = TestBed.inject(LedgerCacheService);

    expect(await cache.readRows()).toBeNull();
    expect(cache.staleAt()).toBeNull();
  });

  it('forgets its provenance on reset, so a wiped store cannot keep labelling', async () => {
    TestBed.configureTestingModule({});
    const cache = TestBed.inject(LedgerCacheService);
    await cache.writeRows([row()], TODAY);
    await cache.readRows();
    expect(cache.staleAt()).not.toBeNull();

    cache.reset();

    expect(cache.staleAt()).toBeNull();
  });
});
