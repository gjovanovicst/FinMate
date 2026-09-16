/**
 * The seam between the offline store and whatever holds its data key.
 *
 * The store never generates or persists a key itself; it asks a provider. That is the whole point:
 * without an app lock there is no wrapping secret, so the only honest provider is one whose key lives
 * in memory for the life of the page and is never written anywhere (ADR-025 decision 3). When task
 * 4.2.6 ships, the app lock swaps in {@link WrappedKeyProvider} and persistence turns on with no data
 * migration.
 *
 * See ADR-025, docs/08 §3.9 and docs/05 §7.
 *
 * @module apps/web/src/app/core/offline
 */
import { Injectable, InjectionToken, inject } from '@angular/core';

import { generateDataKey, type EncryptedValue } from './offline-crypto';

/** What the store needs from a key holder: is this key durable, and what is it. */
export interface OfflineKeyProvider {
  /**
   * Whether the data key survives a reload. A non-persistent provider's key exists only in this page,
   * so a store built on it may keep nothing confidential on disk (ADR-025 decision 3).
   */
  readonly persistent: boolean;

  /** The per-install data key, generated once and then reused for the life of the provider. */
  dataKey(): Promise<CryptoKey>;
}

/**
 * The only provider this build may use.
 *
 * One AES-GCM key per page load, generated lazily and never persisted. A reload discards it, which is
 * exactly what ADR-025 decision 3 requires while there is no app lock: the encryption claim in
 * docs/08 §3.9 ("a filesystem dump of the browser profile yields ciphertext") would become false if
 * this key were written beside the data it protects.
 */
@Injectable({ providedIn: 'root' })
export class SessionKeyProvider implements OfflineKeyProvider {
  readonly persistent = false;

  private pending: Promise<CryptoKey> | null = null;

  dataKey(): Promise<CryptoKey> {
    // Cache the *promise*, not the key: two concurrent callers must share one generation, not race
    // and end up encrypting different records under different keys.
    this.pending ??= generateDataKey();
    return this.pending;
  }
}

/** The DI token screens inject. Its default is the session provider — see {@link OFFLINE_KEY_PROVIDER}. */
export const OFFLINE_KEY_PROVIDER = new InjectionToken<OfflineKeyProvider>('OFFLINE_KEY_PROVIDER', {
  providedIn: 'root',
  // ADR-025 decision 3, deliberately the default: with no app lock there is no wrapping secret, so
  // the data key must not be persisted and nothing confidential may be written to disk. Persistence
  // is an explicit opt-in that requires 4.2.6's lock to supply the unwrapper below — never a flag.
  factory: () => inject(SessionKeyProvider),
});

/**
 * The current wrapped data key, as it sits in the `keys` object store.
 *
 * Defined next to the provider rather than in `offline-store.ts` so the store depends on the seam
 * (types only) and not the other way round.
 */
export interface WrappedKeyStore {
  readWrappedKey(id: string): Promise<EncryptedValue | null>;
  writeWrappedKey(id: string, record: EncryptedValue): Promise<void>;
}

/** Turns a stored wrapped key back into a usable data key, using the app lock's secret. */
export type KeyUnwrapper = (record: EncryptedValue) => Promise<CryptoKey>;

/** Raised when persistence is on but no wrapped key has been established yet. */
export class OfflineKeyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfflineKeyUnavailableError';
  }
}

/** The key record id inside the `keys` store. One data key per install. */
export const WRAPPED_DATA_KEY_ID = 'data-key';

/**
 * The provider task 4.2.6 will install.
 *
 * `persistent = true` is the promise the store checks before touching IndexedDB. The unwrapper is
 * supplied by the app lock because only it holds the wrapping secret; this class never sees a PIN.
 */
export class WrappedKeyProvider implements OfflineKeyProvider {
  readonly persistent = true;

  private pending: Promise<CryptoKey> | null = null;

  constructor(
    private readonly store: WrappedKeyStore,
    private readonly unwrap: KeyUnwrapper,
  ) {}

  dataKey(): Promise<CryptoKey> {
    this.pending ??= this.load();
    return this.pending;
  }

  /**
   * Persist a wrapped data key the app lock produced from its own secret, and let the next
   * {@link dataKey} call unwrap it. Used once at lock setup; the lock can also call it to re-key.
   */
  async remember(record: EncryptedValue): Promise<void> {
    await this.store.writeWrappedKey(WRAPPED_DATA_KEY_ID, record);
    this.pending = null;
  }

  private async load(): Promise<CryptoKey> {
    const record = await this.store.readWrappedKey(WRAPPED_DATA_KEY_ID);
    if (!record) {
      throw new OfflineKeyUnavailableError(
        'No wrapped data key is stored, so the offline store cannot persist anything.',
      );
    }
    return this.unwrap(record);
  }
}
