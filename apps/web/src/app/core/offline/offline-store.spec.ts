import 'fake-indexeddb/auto';

import { openDB, type DBSchema } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';

import { generateDataKey } from './offline-crypto';
import type { OfflineKeyProvider } from './offline-key-provider';
import {
  InMemoryOfflineStore,
  IndexedDbOfflineStore,
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_STORES,
  SNAPSHOT_TTL_MS,
  TAXONOMY_TTL_MS,
  createOfflineStore,
  toSnapshotRow,
  type OfflineRecord,
} from './offline-store';

/**
 * The store's two promises, tested against a real IndexedDB implementation (`fake-indexeddb`).
 *
 * ADR-025 made two claims that must not be assumptions: the data key is never on disk (so a profile
 * dump is ciphertext) and nothing confidential is written at all while the key is session-only. The
 * first is asserted by reading the **raw** database, not by trusting the store's own accessor, and
 * the second by opening that same raw database after using the non-persistent backing.
 */
interface RawSchema extends DBSchema {
  outbox: { key: string; value: OfflineRecord };
  snapshot: { key: string; value: OfflineRecord };
  taxonomy: { key: string; value: OfflineRecord };
  keys: { key: string; value: OfflineRecord };
}

/** A test-only key provider. The real session provider is exercised in `offline-key-provider.spec.ts`. */
class TestKeyProvider implements OfflineKeyProvider {
  private pending: Promise<CryptoKey> | null = null;

  constructor(readonly persistent: boolean) {}

  dataKey(): Promise<CryptoKey> {
    this.pending ??= generateDataKey();
    return this.pending;
  }
}

function durableStore(): IndexedDbOfflineStore {
  return new IndexedDbOfflineStore(new TestKeyProvider(true));
}

async function rawDb() {
  return openDB<RawSchema>(OFFLINE_DB_NAME, OFFLINE_DB_VERSION);
}

describe('OfflineStore', () => {
  beforeEach(async () => {
    // Open (which also sweeps) and clear, so each test starts from an empty database. Never
    // `deleteDB`: a connection from an earlier test would block the version change.
    const store = durableStore();
    await store.sweep();
    await store.purge();
  });

  it('round-trips a value through IndexedDB', async () => {
    const store = durableStore();
    await store.put('snapshot', 'row-1', { amountMinor: '200000', kind: 'EXPENSE' }, SNAPSHOT_TTL_MS);

    await expect(store.get('snapshot', 'row-1')).resolves.toEqual({
      amountMinor: '200000',
      kind: 'EXPENSE',
    });
    await expect(store.get('snapshot', 'missing')).resolves.toBeNull();
  });

  it('reads an expired record as null, and sweep removes it', async () => {
    const store = durableStore();
    await store.put('snapshot', 'stale', { amountMinor: '1' }, -1);

    expect(await store.get('snapshot', 'stale')).toBeNull();
    expect(await store.list('snapshot')).toEqual([]);

    // Still present until the sweep, so the read did not quietly mutate the database.
    const before = await rawDb();
    expect(await before.get('snapshot', 'stale')).toBeDefined();
    before.close();

    await store.sweep();

    const after = await rawDb();
    expect(await after.get('snapshot', 'stale')).toBeUndefined();
    after.close();
  });

  it('sweeps expired records when the store opens', async () => {
    const first = durableStore();
    await first.put('snapshot', 'stale', { amountMinor: '1' }, -1);

    // A new instance is what a reload produces: opening is what sweeps, not a timer.
    const second = durableStore();
    await second.get('snapshot', 'anything');

    const db = await rawDb();
    expect(await db.get('snapshot', 'stale')).toBeUndefined();
    db.close();
  });

  it('purge empties every store, including the wrapped key', async () => {
    const store = durableStore();
    await store.put('snapshot', 'a', { value: 1 }, SNAPSHOT_TTL_MS);
    await store.put('taxonomy', 'b', { value: 2 }, TAXONOMY_TTL_MS);
    await store.put('outbox', '1', { value: 3 }, SNAPSHOT_TTL_MS);
    await store.writeWrappedKey('data-key', { iv: 'aXY=', ciphertext: 'Y2lwaGVy' });

    await store.purge();

    expect(await store.list('snapshot')).toEqual([]);
    expect(await store.list('taxonomy')).toEqual([]);
    expect(await store.list('outbox')).toEqual([]);

    const db = await rawDb();
    for (const name of OFFLINE_STORES) {
      expect(await db.count(name)).toBe(0);
    }
    db.close();
  });

  it('writes ciphertext, never the value in the clear', async () => {
    const store = durableStore();
    await store.put(
      'outbox',
      '11111111-1111-4111-8111-111111111111',
      { clientRowId: 'row-1', description: 'LIDL-PLAINTEXT-MARKER' },
      SNAPSHOT_TTL_MS,
    );

    const db = await rawDb();
    const record = await db.get('outbox', '11111111-1111-4111-8111-111111111111');
    db.close();

    expect(record).toBeDefined();
    expect(record?.ciphertext).toBeTruthy();
    expect(record?.iv).toBeTruthy();

    // The whole row as it sits on disk carries no recognisable plaintext. The cleartext `key` is
    // deliberately readable metadata (ADR-025 decision 2) — it is not part of the value.
    const onDisk = JSON.stringify(record);
    expect(onDisk).not.toContain('LIDL-PLAINTEXT-MARKER');
    expect(onDisk).not.toContain('description');
    expect(onDisk).not.toContain('clientRowId');
  });

  it('stores the wrapped key record raw, so it is not encrypted under itself', async () => {
    const store = durableStore();
    await store.writeWrappedKey('data-key', { iv: 'aXYtYmFzZTY0', ciphertext: 'd3JhcHBlZA==' });

    await expect(store.readWrappedKey('data-key')).resolves.toEqual({
      iv: 'aXYtYmFzZTY0',
      ciphertext: 'd3JhcHBlZA==',
    });
    await expect(store.readWrappedKey('missing')).resolves.toBeNull();
  });

  it('the non-persistent store writes nothing to IndexedDB', async () => {
    const store = createOfflineStore(new TestKeyProvider(false));
    expect(store).toBeInstanceOf(InMemoryOfflineStore);
    expect(store.persistent).toBe(false);

    await store.put('outbox', '1', { clientRowId: 'row-1' }, SNAPSHOT_TTL_MS);
    await expect(store.get('outbox', '1')).resolves.toEqual({ clientRowId: 'row-1' });

    const db = await rawDb();
    for (const name of OFFLINE_STORES) {
      expect(await db.count(name)).toBe(0);
    }
    db.close();
  });

  it('builds the durable backing when — and only when — the key is persistent', () => {
    expect(createOfflineStore(new TestKeyProvider(true))).toBeInstanceOf(IndexedDbOfflineStore);
    expect(createOfflineStore(new TestKeyProvider(false))).toBeInstanceOf(InMemoryOfflineStore);
  });
});

describe('toSnapshotRow', () => {
  it('drops every field the snapshot whitelist does not name', () => {
    // A Transaction-shaped row with everything docs/08 §3.9 forbids in a snapshot.
    const wireRow = {
      id: 'txn-1',
      amountMinor: '200000',
      kind: 'EXPENSE',
      occurredLocalDate: '2026-02-01',
      description: 'Lidl',
      note: 'paid with the joint card',
      rawInput: 'Lidl 2000',
      counterparty: { id: 'cp-1', name: 'Marko', note: 'my brother' },
      category: { id: 'cat-food', name: 'Hrana', keywords: ['lidl', 'market'] },
      version: 3,
      householdId: 'hh-1',
    };

    const row = toSnapshotRow(wireRow);

    expect(row).toEqual({
      amountMinor: '200000',
      kind: 'EXPENSE',
      occurredLocalDate: '2026-02-01',
      description: 'Lidl',
      category: { id: 'cat-food', name: 'Hrana' },
    });
    expect(JSON.stringify(row)).not.toContain('joint card');
    expect(JSON.stringify(row)).not.toContain('rawInput');
    expect(JSON.stringify(row)).not.toContain('my brother');
    expect(JSON.stringify(row)).not.toContain('keywords');
  });

  it('keeps a split row categoryless', () => {
    const row = toSnapshotRow({
      amountMinor: '50000',
      kind: 'EXPENSE',
      occurredLocalDate: '2026-02-02',
      description: 'Market',
    });

    expect(row.category).toBeNull();
  });
});
