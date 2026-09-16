/**
 * The app lock: it owns the data key's wrapping, the lock state, and the wipe.
 *
 * docs/08 §3.9 and ADR-025 decision 3 between them fix the contract:
 *
 * - The lock is **opt-in**. Without it the store runs on a session key and nothing confidential reaches
 *   disk; enabling it is what turns persistence on, and that is the only reason to enable it.
 * - With it, the data key exists on disk **only wrapped** by a WebAuthn PRF secret or a 6-digit PIN
 *   (ADR-029, ADR-025 decision 4), and the app re-asks for that secret on cold start and after five
 *   minutes idle.
 * - `purge()` is the wipe: turning the lock off, logout, a `401`/remote revoke, or household deletion.
 *   It is one call on one database because the snapshot and the queue are the same record set
 *   (ADR-027 decision 6), and it removes the wrapped key **first** (ADR-025 decision 2). A wipe
 *   therefore also removes the lock configuration — the doc's own order — so a sign-out on a shared
 *   device leaves nothing behind and the next sign-in sets the lock up again.
 *
 * ## Why this class is also the key provider
 *
 * `OFFLINE_KEY_PROVIDER` resolves to this service, so `persistent` is exactly "a lock is configured and
 * we are through it". That is what `createOfflineStore` branches on: locked (or no lock) means the
 * in-memory backing, unlocked means IndexedDB. The consequence is deliberate — **while locked the store
 * is empty and in memory**, so nothing behind the lock screen can read or leak what it protects, and
 * every transition is announced: {@link durability} is a signal, and `OfflineStoreHolder` watches it and
 * invalidates its backing. **The holder watches rather than being called** on purpose (R-27(a)): the
 * state has four exits — an armed install's unlock, `lock()`, `purge()`, and a failed install read — and
 * a transition a caller forgets is a store that silently stops persisting, which is what the queue did
 * for two releases.
 *
 * ## Why it builds its own `keys` connection instead of injecting the holder
 *
 * The holder injects *this* service (as the key provider), so injecting the holder here would be a DI
 * cycle. The lock only ever needs the `keys` store — its own record — so it constructs the durable store
 * directly and touches nothing else. No data key is needed to read a wrapped key or its metadata, which
 * is why that call cannot recurse.
 *
 * See ADR-029, ADR-025 decisions 2–4 and 6, docs/08 §3.9 and T-03.
 *
 * @module apps/web/src/app/core/app-lock
 */
import { Injectable, computed, inject, signal, type Signal } from '@angular/core';

import {
  WRAPPED_DATA_KEY_ID,
  OfflineKeyUnavailableError,
  SessionKeyProvider,
  type OfflineKeyProvider,
} from '../offline/offline-key-provider';
import {
  generateDataKeyMaterial,
  importDataKey,
  toBase64,
  unwrapDataKey,
  wrapDataKey,
} from '../offline/offline-crypto';
import { IndexedDbOfflineStore } from '../offline/offline-store';
import {
  createWebAuthnSecret,
  deriveWebAuthnSecret,
  pinWrappingKey,
  randomLockSalt,
  type WebAuthnScope,
} from './lock.crypto';
import {
  IDLE_LOCK_MS,
  LOCK_META_ID,
  isValidPin,
  lockState,
  shouldLockOnIdle,
  webauthnAvailable,
  type LockFailure,
  type LockMetadata,
  type LockState,
} from './lock.view';

/** The lock's own view of the `keys` store: its wrapped key, its metadata, and the wipe. */
interface LockKeyStore {
  readWrappedKey(id: string): Promise<{ iv: string; ciphertext: string } | null>;
  writeWrappedKey(id: string, record: { iv: string; ciphertext: string }): Promise<void>;
  readKeyMeta<T>(id: string): Promise<T | null>;
  writeKeyMeta(id: string, value: unknown): Promise<void>;
  deleteKeyMeta(id: string): Promise<void>;
  purge(): Promise<void>;
}

@Injectable({ providedIn: 'root' })
export class AppLockService implements OfflineKeyProvider {
  private readonly session = inject(SessionKeyProvider);

  /** The durable `keys` store. See the module doc for why this is constructed, not injected. */
  private readonly keys: LockKeyStore = new IndexedDbOfflineStore(this);

  private readonly stateSignal = signal<LockState>('OFF');
  private readonly busySignal = signal(false);
  private readonly failureSignal = signal<LockFailure | null>(null);
  private readonly methodSignal = signal<LockMetadata['method'] | null>(null);
  private readonly idleSignal = signal<number | null>(null);

  /** Current lock state. `LOCKED` is what gates the app (4.2.6b's lock screen). */
  readonly state = this.stateSignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();
  readonly failure = this.failureSignal.asReadonly();
  readonly method = this.methodSignal.asReadonly();

  /** `true` when this browser can offer the WebAuthn path at all; the PIN is always offered. */
  readonly webauthnPossible = webauthnAvailable({
    credentials: globalThis.navigator?.credentials,
    publicKeyCredential: globalThis.PublicKeyCredential,
  });

  /** Whether the offline store may persist: the store backing is chosen from this (ADR-025 decision 3). */
  get persistent(): boolean {
    return this.stateSignal() === 'UNLOCKED';
  }

  /**
   * {@link persistent} as a signal, so the offline store can **react** to a lock state change.
   *
   * Derived rather than a second `signal` set beside the state: two writable copies of one fact is how
   * they end up disagreeing. `OfflineStoreHolder` is the consumer (R-27(a)).
   */
  readonly durability: Signal<boolean> = computed(() => this.persistent);

  private unlockedKey: CryptoKey | null = null;
  private metadata: LockMetadata | null = null;
  private stateRead: Promise<void> | null = null;

  /**
   * The install's lock state, read at most once.
   *
   * **Lazy and memoized rather than a promise resolved by a bootstrap call.** A `ready()` that only
   * settles once something else calls `refresh()` is an unbounded wait: a screen or a spec that builds
   * a store without the bootstrap step would hang with no error, which is the worst failure mode this
   * class could have. So the first caller performs the read, and `app.config.ts` merely warms it.
   */
  ready(): Promise<void> {
    this.stateRead ??= this.readInstall();
    return this.stateRead;
  }

  /** Re-read the install's lock state. Used by the bootstrap call and by the settings pane. */
  refresh(): Promise<void> {
    this.stateRead = this.readInstall();
    return this.stateRead;
  }

  /**
   * What this install has: metadata, wrapped key, and therefore the state.
   *
   * A failure is reported as `OFF` — an install whose `keys` store cannot be read has no usable lock, and
   * claiming otherwise would gate the user behind a secret nothing can verify.
   */
  private async readInstall(): Promise<void> {
    try {
      const [metadata, wrapped] = await Promise.all([
        this.keys.readKeyMeta<LockMetadata>(LOCK_META_ID),
        this.keys.readWrappedKey(WRAPPED_DATA_KEY_ID),
      ]);
      this.metadata = metadata;
      this.methodSignal.set(metadata?.method ?? null);
      this.stateSignal.set(
        lockState({
          hasMetadata: metadata !== null,
          hasWrappedKey: wrapped !== null,
          unlocked: this.unlockedKey !== null,
        }),
      );
    } catch {
      this.metadata = null;
      this.methodSignal.set(null);
      this.stateSignal.set('OFF');
    }
  }

  /**
   * Turn the lock on with a 6-digit PIN.
   *
   * Refuses while the queue is not empty: the entries already in the in-memory store are encrypted under
   * the session key, and moving them into a store under a new key is a migration whose failure mode is a
   * lost confirmed capture. Draining first is a step the user can see; a silent migration is not.
   */
  async enableWithPin(pin: string, pendingCount: number): Promise<boolean> {
    if (!isValidPin(pin)) {
      this.failureSignal.set('WRONG_SECRET');
      return false;
    }
    if (pendingCount > 0) {
      this.failureSignal.set('QUEUE_NOT_EMPTY');
      return false;
    }

    this.busySignal.set(true);
    this.failureSignal.set(null);
    try {
      const saltBase64 = toBase64(randomLockSalt());
      const wrappingKey = await pinWrappingKey(pin, saltBase64);
      await this.install({ method: 'PIN', salt: saltBase64 }, wrappingKey);
      return true;
    } catch {
      this.failureSignal.set('UNSUPPORTED');
      return false;
    } finally {
      this.busySignal.set(false);
    }
  }

  /**
   * Turn the lock on with the platform authenticator.
   *
   * Returns `false` with `WEBAUTHN_UNAVAILABLE` when the authenticator cannot do PRF — the caller then
   * offers the PIN. It never stores an unwrapped key: that is the single thing ADR-025 rejected.
   */
  async enableWithWebAuthn(pendingCount: number): Promise<boolean> {
    if (pendingCount > 0) {
      this.failureSignal.set('QUEUE_NOT_EMPTY');
      return false;
    }
    const scope = this.webauthnScope();
    if (scope === null) {
      this.failureSignal.set('WEBAUTHN_UNAVAILABLE');
      return false;
    }

    this.busySignal.set(true);
    this.failureSignal.set(null);
    try {
      const saltBase64 = toBase64(randomLockSalt());
      const secret = await createWebAuthnSecret(scope, saltBase64);
      if (secret === null) {
        this.failureSignal.set('WEBAUTHN_UNAVAILABLE');
        return false;
      }
      await this.install(
        { method: 'WEBAUTHN', salt: saltBase64, credentialId: secret.credentialId },
        secret.wrappingKey,
      );
      return true;
    } catch {
      // A cancelled prompt and a broken authenticator are the same failure to a caller that must offer
      // the PIN either way.
      this.failureSignal.set('WEBAUTHN_CANCELLED');
      return false;
    } finally {
      this.busySignal.set(false);
    }
  }

  /** Unlock with the PIN. A wrong PIN is `WRONG_SECRET` — the GCM tag not verifying, never a stored hash. */
  async unlockWithPin(pin: string): Promise<boolean> {
    if (this.metadata === null) {
      this.failureSignal.set('NOT_CONFIGURED');
      return false;
    }
    this.busySignal.set(true);
    this.failureSignal.set(null);
    try {
      const wrappingKey = await pinWrappingKey(pin, this.metadata.salt);
      await this.unwrapWith(wrappingKey);
      return this.stateSignal() === 'UNLOCKED';
    } catch {
      this.failureSignal.set('WRONG_SECRET');
      return false;
    } finally {
      this.busySignal.set(false);
    }
  }

  /** Unlock with the platform authenticator. */
  async unlockWithWebAuthn(): Promise<boolean> {
    if (this.metadata?.credentialId === undefined) {
      this.failureSignal.set('NOT_CONFIGURED');
      return false;
    }
    const scope = this.webauthnScope();
    if (scope === null) {
      this.failureSignal.set('WEBAUTHN_UNAVAILABLE');
      return false;
    }

    this.busySignal.set(true);
    this.failureSignal.set(null);
    try {
      const wrappingKey = await deriveWebAuthnSecret(
        scope,
        this.metadata.salt,
        this.metadata.credentialId,
      );
      if (wrappingKey === null) {
        this.failureSignal.set('WEBAUTHN_UNAVAILABLE');
        return false;
      }
      await this.unwrapWith(wrappingKey);
      return this.stateSignal() === 'UNLOCKED';
    } catch {
      this.failureSignal.set('WEBAUTHN_CANCELLED');
      return false;
    } finally {
      this.busySignal.set(false);
    }
  }

  /**
   * Lock now: drop the key from memory and forget it.
   *
   * The wrapped record stays on disk — that is the point — and the store backing falls back to memory,
   * so nothing behind the lock can be read. Called on idle (docs/08 §3.9's five minutes) and by the lock
   * screen's own control.
   */
  lock(): void {
    this.unlockedKey = null;
    this.idleSignal.set(null);
    if (this.stateSignal() !== 'OFF') this.stateSignal.set('LOCKED');
  }

  /** Note activity, so the idle rule has a moment to measure from. */
  noteActivity(now = Date.now()): void {
    if (this.stateSignal() === 'UNLOCKED') this.idleSignal.set(now);
  }

  /** Whether the idle rule says to lock now. The caller decides *how* it is polled (4.2.6b). */
  isIdle(now = Date.now(), idleMs = IDLE_LOCK_MS): boolean {
    return this.stateSignal() === 'UNLOCKED' && shouldLockOnIdle(this.idleSignal(), now, idleMs);
  }

  /**
   * Wipe: turn the lock off, sign out, a `401`/remote revoke, or household deletion.
   *
   * One method because it is one operation — ADR-025 decision 2 makes the wrapped key the first thing
   * `purge()` removes, so a wipe cannot leave a lock configuration behind that nothing can open. The
   * state returns to `OFF`, the key leaves memory, and the store backing falls back to memory on the
   * next use.
   */
  async purge(): Promise<void> {
    this.busySignal.set(true);
    try {
      this.metadata = null;
      this.methodSignal.set(null);
      // Deleting the metadata first is belt-and-braces on top of the database wipe below: a `purge()`
      // that failed half-way must not leave a lock that cannot be opened.
      await this.keys.deleteKeyMeta(LOCK_META_ID);
      await this.keys.deleteKeyMeta(WRAPPED_DATA_KEY_ID);
      await this.keys.purge();
    } catch {
      // A wipe that could not reach IndexedDB must still leave the app with no key in memory and no
      // lock claimed. Nothing else here can be recovered, and saying so is worse than a clean state.
    } finally {
      this.unlockedKey = null;
      this.idleSignal.set(null);
      this.stateSignal.set('OFF');
      this.busySignal.set(false);
    }
  }

  /** The key the store encrypts under: the unwrapped data key, or the session key when there is no lock. */
  async dataKey(): Promise<CryptoKey> {
    if (this.stateSignal() === 'OFF') return this.session.dataKey();
    if (this.unlockedKey === null) {
      throw new OfflineKeyUnavailableError(
        'The app is locked, so there is no data key in memory and nothing may be persisted.',
      );
    }
    return this.unlockedKey;
  }

  /** Install a fresh wrapped key from a wrapping key, then become the unlocked provider. */
  private async install(metadata: LockMetadata, wrappingKey: CryptoKey): Promise<void> {
    const material = generateDataKeyMaterial();
    const wrapped = await wrapDataKey(material, wrappingKey);
    // The wrapped record and its metadata are written together: a lone wrapped key cannot be unwrapped
    // (no salt, no method) and a lone metadata record guards nothing, and `lockState` treats a
    // half-written pair as `OFF` rather than as a lock that cannot open.
    await this.keys.writeWrappedKey(WRAPPED_DATA_KEY_ID, wrapped);
    await this.keys.writeKeyMeta(LOCK_META_ID, metadata);
    this.metadata = metadata;
    this.methodSignal.set(metadata.method);
    this.unlockedKey = await importDataKey(material);
    this.idleSignal.set(Date.now());
    this.stateSignal.set('UNLOCKED');
  }

  private async unwrapWith(wrappingKey: CryptoKey): Promise<void> {
    const wrapped = await this.keys.readWrappedKey(WRAPPED_DATA_KEY_ID);
    if (wrapped === null) {
      this.failureSignal.set('NOT_CONFIGURED');
      return;
    }
    this.unlockedKey = await unwrapDataKey(wrapped, wrappingKey);
    this.idleSignal.set(Date.now());
    this.stateSignal.set('UNLOCKED');
  }

  /** The real WebAuthn scope, or `null` when the browser has no credential API at all. */
  private webauthnScope(): WebAuthnScope | null {
    const navigator = globalThis.navigator as unknown as Record<string, unknown> | undefined;
    if (navigator === undefined) return null;
    if (
      !webauthnAvailable({
        credentials: navigator['credentials'],
        publicKeyCredential: globalThis.PublicKeyCredential,
      })
    ) {
      return null;
    }
    return {
      credentials: navigator['credentials'] as WebAuthnScope['credentials'],
      // The Relying Party is this origin: a credential is bound to it, which is what stops another
      // origin from asking for the same PRF output.
      rpId: globalThis.location?.hostname ?? 'localhost',
      rpName: 'FinMate',
    };
  }
}
