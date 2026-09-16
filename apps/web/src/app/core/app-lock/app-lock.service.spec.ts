// @vitest-environment jsdom
import 'fake-indexeddb/auto';

// FIRST import, deliberately — the JIT compiler must be loaded before the testing module is used.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { openDB, type DBSchema } from 'idb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OfflineKeyUnavailableError } from '../offline/offline-key-provider';
import {
  OFFLINE_DB_NAME,
  OFFLINE_DB_VERSION,
  OFFLINE_STORES,
  type OfflineRecord,
} from '../offline/offline-store';
import { AppLockService } from './app-lock.service';
import { IDLE_LOCK_MS, LOCK_META_ID } from './lock.view';

initAngularTesting();

/**
 * The app lock's state machine, against a real IndexedDB (`fake-indexeddb`) (task 4.2.6a).
 *
 * The three claims this file exists to hold:
 *
 * 1. **A cold start is locked.** A reload is modelled as a *second service instance* over the same
 *    database, which is exactly what a reload is; if the data key were recoverable without the secret,
 *    the lock would be decoration.
 * 2. **The same data key comes back.** The wrap/unwrap round trip is asserted by encrypting before the
 *    "reload" and decrypting after it, because a `CryptoKey` cannot be compared or exported.
 * 3. **A wipe removes the wrapped key first.** Read from the raw database, not through the service's own
 *    accessor, so a broken `purge` cannot pass by agreeing with itself.
 */
interface RawSchema extends DBSchema {
  outbox: { key: string; value: OfflineRecord };
  snapshot: { key: string; value: OfflineRecord };
  taxonomy: { key: string; value: OfflineRecord };
  keys: { key: string; value: OfflineRecord };
}

const PIN = '123456';

function mount(): AppLockService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [AppLockService] });
  return TestBed.inject(AppLockService);
}

/**
 * Open the raw database the way an attacker with the profile dump would.
 *
 * The upgrade callback mirrors the store's own (ADR-025 decision 1), so the database is created with
 * its four stores on the first call instead of coming back empty with a `NotFoundError`.
 */
async function rawDb() {
  return openDB<RawSchema>(OFFLINE_DB_NAME, OFFLINE_DB_VERSION, {
    upgrade(database) {
      for (const store of OFFLINE_STORES) {
        if (!database.objectStoreNames.contains(store)) {
          database.createObjectStore(store, { keyPath: 'key' });
        }
      }
    },
  });
}

/** Read the database the way an attacker with the profile would: raw records, no service involved. */
async function rawRecords(): Promise<OfflineRecord[]> {
  const db = await rawDb();
  const records: OfflineRecord[] = [];
  for (const store of OFFLINE_STORES) {
    records.push(...(await db.getAll(store)));
  }
  db.close();
  return records;
}

beforeEach(async () => {
  // Every test starts from an install with nothing on it.
  const db = await rawDb();
  for (const store of OFFLINE_STORES) await db.clear(store);
  db.close();
});

afterEach(() => {
  delete (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
});

describe('AppLockService', () => {
  it('is OFF with no lock configured, and never persists', async () => {
    const lock = mount();
    await lock.refresh();

    expect(lock.state()).toBe('OFF');
    expect(lock.persistent).toBe(false);
    // No lock means no wrapping secret, so the key is the session's and nothing is on disk.
    expect((await lock.dataKey()).algorithm).toMatchObject({ name: 'AES-GCM' });
    expect(await rawRecords()).toHaveLength(0);
  });

  it('arms with a PIN, becomes the persistent provider, and writes only a wrapped key', async () => {
    const lock = mount();
    await lock.refresh();

    expect(await lock.enableWithPin(PIN, 0)).toBe(true);
    expect(lock.state()).toBe('UNLOCKED');
    expect(lock.persistent).toBe(true);
    expect(lock.method()).toBe('PIN');
    expect(lock.failure()).toBeNull();

    const records = await rawRecords();
    expect(records).toHaveLength(2);
    const wrapped = records.find((record) => record.key !== LOCK_META_ID);
    expect(wrapped?.ciphertext).not.toBe('');
    // The metadata is the one documented plaintext record, and it holds no key material.
    const meta = records.find((record) => record.key === LOCK_META_ID);
    expect(JSON.parse(meta!.plain!)).toEqual({ method: 'PIN', salt: expect.any(String) });
  });

  it('is LOCKED after a reload, and the same data key comes back with the right PIN', async () => {
    const first = mount();
    await first.refresh();
    await first.enableWithPin(PIN, 0);

    // What a reload is: a new instance over the same database.
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await first.dataKey(),
      new TextEncoder().encode('a pending capture'),
    );

    const reloaded = mount();
    await reloaded.refresh();
    expect(reloaded.state()).toBe('LOCKED');
    expect(reloaded.persistent).toBe(false);
    // Locked means no key: a read must fail loudly rather than fall back to the session key and write
    // records under the wrong one.
    await expect(reloaded.dataKey()).rejects.toBeInstanceOf(OfflineKeyUnavailableError);

    expect(await reloaded.unlockWithPin(PIN)).toBe(true);
    expect(reloaded.state()).toBe('UNLOCKED');
    expect(
      new TextDecoder().decode(
        await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await reloaded.dataKey(), sealed),
      ),
    ).toBe('a pending capture');
  });

  it('refuses a wrong PIN without leaking whether it was close', async () => {
    const lock = mount();
    await lock.refresh();
    await lock.enableWithPin(PIN, 0);

    const reloaded = mount();
    await reloaded.refresh();

    expect(await reloaded.unlockWithPin('654321')).toBe(false);
    expect(reloaded.state()).toBe('LOCKED');
    expect(reloaded.failure()).toBe('WRONG_SECRET');
    expect(await reloaded.unlockWithPin(PIN)).toBe(true);
  });

  it('refuses to arm while captures are queued, because that migration can lose them', async () => {
    const lock = mount();
    await lock.refresh();

    expect(await lock.enableWithPin(PIN, 3)).toBe(false);
    expect(lock.failure()).toBe('QUEUE_NOT_EMPTY');
    expect(lock.state()).toBe('OFF');
    // Nothing was written: a refusal must not leave half a lock behind.
    expect(await rawRecords()).toHaveLength(0);
  });

  it('refuses a PIN that is not six digits before doing any work', async () => {
    const lock = mount();
    await lock.refresh();

    expect(await lock.enableWithPin('12345', 0)).toBe(false);
    expect(lock.failure()).toBe('WRONG_SECRET');
    expect(await rawRecords()).toHaveLength(0);
  });

  it('drops the key on lock() and stops persisting', async () => {
    const lock = mount();
    await lock.refresh();
    await lock.enableWithPin(PIN, 0);

    lock.lock();

    expect(lock.state()).toBe('LOCKED');
    expect(lock.persistent).toBe(false);
    await expect(lock.dataKey()).rejects.toBeInstanceOf(OfflineKeyUnavailableError);
  });

  it('locks only after five idle minutes, measured from the last activity', async () => {
    const lock = mount();
    await lock.refresh();
    await lock.enableWithPin(PIN, 0);

    const shown = 1_000_000;
    lock.noteActivity(shown);
    expect(lock.isIdle(shown + IDLE_LOCK_MS - 1)).toBe(false);
    expect(lock.isIdle(shown + IDLE_LOCK_MS)).toBe(true);
  });

  it('does not report idleness when no lock is armed', async () => {
    const lock = mount();
    await lock.refresh();

    lock.noteActivity(1);
    expect(lock.isIdle(999_999_999)).toBe(false);
  });

  it('wipes the wrapped key and every record on purge, and reports OFF', async () => {
    const lock = mount();
    await lock.refresh();
    await lock.enableWithPin(PIN, 0);
    expect(await rawRecords()).toHaveLength(2);

    await lock.purge();

    expect(lock.state()).toBe('OFF');
    expect(lock.persistent).toBe(false);
    expect(lock.method()).toBeNull();
    // The wrapped key is gone, so the data it protected can never be decrypted again — which is the
    // point of ADR-025 decision 2's "the first thing purge() removes".
    expect(await rawRecords()).toHaveLength(0);

    // And it stays gone: a reload finds no lock at all rather than a locked one.
    const reloaded = mount();
    await reloaded.refresh();
    expect(reloaded.state()).toBe('OFF');
  });

  it('arms with the platform authenticator when it can do PRF, and unlocks with it', async () => {
    installFakeAuthenticator({ prf: true });
    const lock = mount();
    await lock.refresh();

    expect(await lock.enableWithWebAuthn(0)).toBe(true);
    expect(lock.state()).toBe('UNLOCKED');
    expect(lock.method()).toBe('WEBAUTHN');

    const reloaded = mount();
    await reloaded.refresh();
    expect(reloaded.state()).toBe('LOCKED');
    expect(await reloaded.unlockWithWebAuthn()).toBe(true);
    expect(await reloaded.dataKey()).toBeDefined();
  });

  it('refuses the WebAuthn path, and says so, when the authenticator cannot do PRF', async () => {
    installFakeAuthenticator({ prf: false });
    const lock = mount();
    await lock.refresh();

    expect(await lock.enableWithWebAuthn(0)).toBe(false);
    expect(lock.failure()).toBe('WEBAUTHN_UNAVAILABLE');
    // No lock was written, so the caller can offer the PIN without cleaning up first.
    expect(lock.state()).toBe('OFF');
    expect(await rawRecords()).toHaveLength(0);
  });

  it('reports NOT_CONFIGURED rather than hanging when asked to unlock with nothing armed', async () => {
    const lock = mount();
    await lock.refresh();

    expect(await lock.unlockWithWebAuthn()).toBe(false);
    expect(lock.failure()).toBe('NOT_CONFIGURED');
    expect(await lock.unlockWithPin(PIN)).toBe(false);
    expect(lock.failure()).toBe('NOT_CONFIGURED');
  });
});

/**
 * A platform authenticator with a deterministic PRF, exactly like the one in `lock.crypto.spec.ts` —
 * duplicated rather than shared because this file needs the *service* to reach it through the real
 * globals, which is the wiring under test.
 */
function installFakeAuthenticator(options: { prf: boolean }): void {
  const attempt = (id: Uint8Array, salt: Uint8Array): ArrayBuffer => {
    const output = new Uint8Array(32);
    for (let index = 0; index < output.length; index += 1) {
      output[index] = (id[index % id.length]! ^ salt[index % salt.length]! ^ index) & 0xff;
    }
    return output.buffer;
  };

  (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential = class {};
  Object.defineProperty(globalThis.navigator, 'credentials', {
    configurable: true,
    value: {
      create: async () => {
        const rawId = crypto.getRandomValues(new Uint8Array(16));
        return {
          rawId: rawId.buffer,
          getClientExtensionResults: () => ({ prf: { enabled: options.prf } }),
        };
      },
      get: async (request: { publicKey: PublicKeyCredentialRequestOptions }) => {
        const allowed = request.publicKey.allowCredentials?.[0]?.id as ArrayBuffer | undefined;
        const id = allowed === undefined ? new Uint8Array(0) : new Uint8Array(allowed);
        const salt = new Uint8Array(
          (request.publicKey.extensions as { prf?: { eval?: { first?: ArrayBuffer } } } | undefined)
            ?.prf?.eval?.first ?? new ArrayBuffer(0),
        );
        return {
          rawId: id.buffer,
          getClientExtensionResults: () => ({
            prf: options.prf
              ? { enabled: true, results: { first: attempt(id, salt) } }
              : { enabled: false },
          }),
        };
      },
    },
  });
}
