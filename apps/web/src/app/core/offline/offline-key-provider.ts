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
import { Injectable, InjectionToken, inject, type Signal } from '@angular/core';

import { AppLockService } from '../app-lock/app-lock.service';
import { generateDataKey, type EncryptedValue } from './offline-crypto';

/** What the store needs from a key holder: is this key durable, and what is it. */
export interface OfflineKeyProvider {
  /**
   * Whether the data key survives a reload. A non-persistent provider's key exists only in this page,
   * so a store built on it may keep nothing confidential on disk (ADR-025 decision 3).
   */
  readonly persistent: boolean;

  /**
   * The same fact as a **signal**, for a consumer that has to react to it rather than re-ask.
   *
   * Optional because a session-only provider never changes: its answer is `false` for the life of the
   * page. The app lock implements it, and `OfflineStoreHolder` watches it — which is what makes the
   * backing follow the lock state *by construction* instead of by luck. Before R-27(a) it followed only
   * if some data consumer happened to call `repository()` after the unlock, and the queue's own consumer
   * caches its outbox, so the two could disagree for the life of the page.
   */
  readonly durability?: Signal<boolean>;

  /** The per-install data key, generated once and then reused for the life of the provider. */
  dataKey(): Promise<CryptoKey>;

  /**
   * Resolves once the provider knows whether this install is persistent.
   *
   * Optional because a session-only provider has nothing to read; the app lock needs one IndexedDB
   * read before it can answer `persistent`, and the store must not be built before it has.
   */
  ready?(): Promise<void>;
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
  // The app lock decides which of the two providers this install gets: it reports `persistent` only
  // while it is unlocked, and delegates to the session provider when no lock is configured. So
  // ADR-025 decision 3 still holds by construction — with no lock there is no wrapping secret, the key
  // is never persisted, and nothing confidential is written to disk.
  factory: () => inject(AppLockService),
});

/**
 * The `keys` object store, as the app lock uses it.
 *
 * Defined next to the provider rather than in `offline-store.ts` so the store depends on the seam
 * (types only) and not the other way round.
 */
export interface WrappedKeyStore {
  readWrappedKey(id: string): Promise<EncryptedValue | null>;
  writeWrappedKey(id: string, record: EncryptedValue): Promise<void>;
  /**
   * The app lock's install metadata — its method, its KDF salt, a WebAuthn credential id.
   *
   * Not secret (a salt is not a secret and a credential id is public), but it must survive a reload or
   * the wrapped key can never be unwrapped again. The only plaintext this database holds.
   */
  readKeyMeta<T>(id: string): Promise<T | null>;
  writeKeyMeta(id: string, value: unknown): Promise<void>;
  deleteKeyMeta(id: string): Promise<void>;
  /** Wipe the whole database: what disabling the lock, a sign-out and a revoke all do. */
  purge(): Promise<void>;
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
