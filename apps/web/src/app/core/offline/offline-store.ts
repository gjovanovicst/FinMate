/**
 * The offline repository: encrypted records over `idb`, with two interchangeable backings.
 *
 * ADR-025 fixes the boundary and this file enforces it. Every value is one AES-GCM message under the
 * provider's data key; the only clear-text field is the lookup `key`, because IndexedDB cannot index
 * ciphertext. Expiry is filtered on every read and swept when the store opens — never by a timer,
 * because a background timer in a PWA is a promise iOS does not keep. When the key provider is not
 * persistent the whole thing runs in memory instead, so nothing confidential reaches disk.
 *
 * See ADR-025 decisions 2, 3, 5, 6, docs/08 §3.9 and docs/05 §7.
 *
 * @module apps/web/src/app/core/offline
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import { decryptValue, encryptValue, type EncryptedValue } from './offline-crypto';
import type {
  OfflineKeyProvider,
  WrappedKeyStore,
} from './offline-key-provider';

/** One database, versioned as a whole so an upgrade cannot half-migrate. */
export const OFFLINE_DB_NAME = 'finmate-offline';
export const OFFLINE_DB_VERSION = 1;

/** The object stores ADR-025 decision 1 names. `keys` holds the wrapped data key, not user data. */
export const OFFLINE_STORES = ['outbox', 'snapshot', 'taxonomy', 'keys'] as const;
export type OfflineStoreName = (typeof OFFLINE_STORES)[number];

/** The stores whose values are encrypted under the data key. `keys` cannot be — see below. */
export type EncryptedStoreName = Exclude<OfflineStoreName, 'keys'>;

/** TTLs from ADR-025 decision 6 (and docs/08 §3.9). */
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const TAXONOMY_TTL_MS = 24 * 60 * 60 * 1000;
export const PENDING_CAPTURE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A row exactly as it sits on disk. `iv`/`ciphertext` are base64; `key` is deliberately readable. */
export interface OfflineRecord extends EncryptedValue {
  readonly key: string;
  /** Epoch ms after which the record is dead, or `null` for a record that never expires. */
  readonly expiresAt: number | null;
}

/**
 * What the outbox, the snapshot cache and the taxonomy cache are written through.
 *
 * `keys` is absent on purpose: its record *is* a wrapped data key, so encrypting it under the data
 * key would be circular. {@link WrappedKeyStore} is that store's interface.
 */
export interface OfflineRepository {
  readonly persistent: boolean;
  put(store: EncryptedStoreName, key: string, value: unknown, ttlMs: number): Promise<void>;
  get<T>(store: EncryptedStoreName, key: string): Promise<T | null>;
  list<T>(store: EncryptedStoreName): Promise<T[]>;
  remove(store: EncryptedStoreName, key: string): Promise<void>;
  sweep(): Promise<void>;
  purge(): Promise<void>;
}

interface OfflineDbSchema extends DBSchema {
  outbox: { key: string; value: OfflineRecord };
  snapshot: { key: string; value: OfflineRecord };
  taxonomy: { key: string; value: OfflineRecord };
  keys: { key: string; value: OfflineRecord };
}

/** True once a record's TTL has passed. `null` never expires, which is only the wrapped key. */
export function isExpired(record: { expiresAt: number | null }, now = Date.now()): boolean {
  return record.expiresAt !== null && record.expiresAt <= now;
}

/** Pick the backing the key provider's durability allows. Never persist under a session-only key. */
export function createOfflineStore(keyProvider: OfflineKeyProvider): OfflineRepository {
  return keyProvider.persistent
    ? new IndexedDbOfflineStore(keyProvider)
    : new InMemoryOfflineStore();
}

/** The durable backing: an encrypted `idb` repository. */
export class IndexedDbOfflineStore implements OfflineRepository, WrappedKeyStore {
  readonly persistent = true;

  private connection: Promise<IDBPDatabase<OfflineDbSchema>> | null = null;

  constructor(private readonly keyProvider: OfflineKeyProvider) {}

  async put(
    store: EncryptedStoreName,
    key: string,
    value: unknown,
    ttlMs: number,
  ): Promise<void> {
    const db = await this.connect();
    const sealed = await encryptValue(await this.keyProvider.dataKey(), value);
    await db.put(store, toRecord(key, sealed, Date.now() + ttlMs));
  }

  async get<T>(store: EncryptedStoreName, key: string): Promise<T | null> {
    const db = await this.connect();
    const record = await db.get(store, key);
    // An expired record is invisible, but it is `sweep()` that reclaims it — a read must not delete,
    // because a read happens on the render path and a write there is a surprising cost.
    if (!record || isExpired(record)) return null;
    return decryptValue<T>(await this.keyProvider.dataKey(), record);
  }

  async list<T>(store: EncryptedStoreName): Promise<T[]> {
    const db = await this.connect();
    const live = (await db.getAll(store)).filter((record) => !isExpired(record));
    const dataKey = await this.keyProvider.dataKey();
    return Promise.all(live.map((record) => decryptValue<T>(dataKey, record)));
  }

  async remove(store: EncryptedStoreName, key: string): Promise<void> {
    const db = await this.connect();
    await db.delete(store, key);
  }

  /** Delete every expired record. Called on open, never on a timer. */
  async sweep(): Promise<void> {
    await deleteExpired(await this.connect(), Date.now());
  }

  /** Wipe everything — logout, a `401` (remote revoke), Household deletion, or the manual control. */
  async purge(): Promise<void> {
    const db = await this.connect();
    await Promise.all(OFFLINE_STORES.map((store) => db.clear(store)));
  }

  async readWrappedKey(id: string): Promise<EncryptedValue | null> {
    const db = await this.connect();
    const record = await db.get('keys', id);
    if (!record || isExpired(record)) return null;
    return { iv: record.iv, ciphertext: record.ciphertext };
  }

  async writeWrappedKey(id: string, record: EncryptedValue): Promise<void> {
    const db = await this.connect();
    // Stored unencrypted *by the store*, because it is already wrapped by the app lock and encrypting
    // it under the key it contains is impossible. It never expires: it is the install's data key.
    await db.put('keys', { key: id, iv: record.iv, ciphertext: record.ciphertext, expiresAt: null });
  }

  private connect(): Promise<IDBPDatabase<OfflineDbSchema>> {
    // Memoized so one connection serves the page, but a failed open must not be memoized too: a
    // transient failure would otherwise disable the offline store until the tab is reloaded.
    this.connection ??= this.openAndSweep().catch((error: unknown) => {
      this.connection = null;
      throw error;
    });
    return this.connection;
  }

  private async openAndSweep(): Promise<IDBPDatabase<OfflineDbSchema>> {
    const db = await openDB<OfflineDbSchema>(OFFLINE_DB_NAME, OFFLINE_DB_VERSION, {
      upgrade(database) {
        for (const store of OFFLINE_STORES) {
          if (!database.objectStoreNames.contains(store)) {
            database.createObjectStore(store, { keyPath: 'key' });
          }
        }
      },
    });
    await deleteExpired(db, Date.now());
    return db;
  }
}

interface InMemoryEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/**
 * The backing used while the key provider is session-only (ADR-025 decision 3).
 *
 * A separate class, not a flag inside the IndexedDB code: the two have different failure modes and
 * different security properties, and a branch would make "is anything on disk?" a question you answer
 * by reading rather than by the type. Values are kept as they were handed in — there is no disk here
 * to protect, so encrypting a map that dies with the tab would be ceremony.
 */
export class InMemoryOfflineStore implements OfflineRepository {
  readonly persistent = false;

  private readonly stores: Record<EncryptedStoreName, Map<string, InMemoryEntry>> = {
    outbox: new Map(),
    snapshot: new Map(),
    taxonomy: new Map(),
  };

  async put(store: EncryptedStoreName, key: string, value: unknown, ttlMs: number): Promise<void> {
    this.stores[store].set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  async get<T>(store: EncryptedStoreName, key: string): Promise<T | null> {
    const entry = this.stores[store].get(key);
    if (!entry || isExpired(entry)) return null;
    return entry.value as T;
  }

  async list<T>(store: EncryptedStoreName): Promise<T[]> {
    return [...this.stores[store].values()]
      .filter((entry) => !isExpired(entry))
      .map((entry) => entry.value as T);
  }

  async remove(store: EncryptedStoreName, key: string): Promise<void> {
    this.stores[store].delete(key);
  }

  async sweep(): Promise<void> {
    const now = Date.now();
    for (const store of Object.values(this.stores)) {
      for (const [key, entry] of store) {
        if (isExpired(entry, now)) store.delete(key);
      }
    }
  }

  async purge(): Promise<void> {
    for (const store of Object.values(this.stores)) store.clear();
  }
}

/**
 * A Transaction reduced to the fields docs/08 §3.9 allows in the snapshot.
 *
 * Extra properties are accepted on purpose: callers pass a wire row straight in, and the mapper —
 * not the caller — is what drops `note`, `rawInput`, counterparty notes and unbounded history.
 */
export interface TransactionSnapshotSource {
  readonly amountMinor: string;
  readonly kind: string;
  readonly occurredLocalDate: string;
  readonly description: string;
  readonly category?: { readonly id: string; readonly name: string } | null;
}

/** One snapshot row: nothing here is not on the whitelist. */
export interface SnapshotRow {
  readonly amountMinor: string;
  readonly kind: string;
  readonly occurredLocalDate: string;
  readonly description: string;
  readonly category: { readonly id: string; readonly name: string } | null;
}

/**
 * Build a snapshot row, keeping only the five whitelisted fields and a category's id and name.
 *
 * The whitelist is a data-minimisation control, not a formatting preference (docs/08 §3.9): a free-
 * text `note` or a counterparty's note must never be the thing that makes a lost phone a disclosure.
 */
export function toSnapshotRow(source: TransactionSnapshotSource): SnapshotRow {
  return {
    amountMinor: source.amountMinor,
    kind: source.kind,
    occurredLocalDate: source.occurredLocalDate,
    description: source.description,
    category: source.category ? { id: source.category.id, name: source.category.name } : null,
  };
}

function toRecord(key: string, sealed: EncryptedValue, expiresAt: number): OfflineRecord {
  return { key, iv: sealed.iv, ciphertext: sealed.ciphertext, expiresAt };
}

async function deleteExpired(db: IDBPDatabase<OfflineDbSchema>, now: number): Promise<void> {
  for (const store of OFFLINE_STORES) {
    const records = await db.getAll(store);
    await Promise.all(
      records.filter((record) => isExpired(record, now)).map((record) => db.delete(store, record.key)),
    );
  }
}
