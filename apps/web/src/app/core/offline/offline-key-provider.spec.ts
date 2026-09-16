// @vitest-environment jsdom
// The DI-token test uses `TestBed.inject`, and the app's Angular packages are partially compiled, so
// the JIT compiler has to be loaded before them (docs/15 §9). The pragma must be the first line.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  OfflineDecryptError,
  decryptValue,
  deriveWrappingKey,
  encryptValue,
  generateDataKeyMaterial,
  importDataKey,
  unwrapDataKey,
  wrapDataKey,
  type Bytes,
  type EncryptedValue,
} from './offline-crypto';
import {
  OFFLINE_KEY_PROVIDER,
  OfflineKeyUnavailableError,
  SessionKeyProvider,
  WrappedKeyProvider,
  WRAPPED_DATA_KEY_ID,
  type WrappedKeyStore,
} from './offline-key-provider';

initAngularTesting();

/**
 * The key seam.
 *
 * ADR-025 decision 3 makes the default provider the *only* safe one in this build: no app lock means
 * no wrapping secret, so the data key is memory-only and nothing confidential is persisted. The
 * wrapped provider is what task 4.2.6 will install; here it is driven with a test-only unwrapper that
 * runs the real PBKDF2 → unwrap path under a fixed PIN, so the seam cannot drift from offline-crypto.
 */
const PIN = '123456';
const SALT = new Uint8Array(16).fill(3);

/** A test-only `WrappedKeyStore`, mirroring what the `keys` object store holds. */
class FakeWrappedKeyStore implements WrappedKeyStore {
  private readonly records = new Map<string, EncryptedValue>();

  async readWrappedKey(id: string): Promise<EncryptedValue | null> {
    return this.records.get(id) ?? null;
  }

  async writeWrappedKey(id: string, record: EncryptedValue): Promise<void> {
    this.records.set(id, record);
  }
}

/** The seam the app lock (4.2.6) supplies: derive the wrapping key from the PIN and unwrap. */
async function appLockUnwrapper(record: EncryptedValue): Promise<CryptoKey> {
  return unwrapDataKey(record, await deriveWrappingKey(PIN, SALT));
}

/** Material plus the record the app lock would store for it. */
async function wrappedDataKey(): Promise<{ material: Bytes; record: EncryptedValue }> {
  const material = generateDataKeyMaterial();
  return { material, record: await wrapDataKey(material, await deriveWrappingKey(PIN, SALT)) };
}

describe('SessionKeyProvider', () => {
  it('keeps one non-persistent key for the life of the page', async () => {
    const provider = new SessionKeyProvider();
    expect(provider.persistent).toBe(false);

    const key = await provider.dataKey();
    expect(await provider.dataKey()).toBe(key);
  });

  it('gives a fresh page load a different key', async () => {
    const first = await new SessionKeyProvider().dataKey();
    const second = await new SessionKeyProvider().dataKey();

    const record = await encryptValue(first, 'pending capture');
    await expect(decryptValue(second, record)).rejects.toBeInstanceOf(OfflineDecryptError);
  });

  it('is what the DI token resolves to by default', () => {
    TestBed.resetTestingModule();
    const provider = TestBed.inject(OFFLINE_KEY_PROVIDER);

    expect(provider).toBeInstanceOf(SessionKeyProvider);
    expect(provider.persistent).toBe(false);
  });
});

describe('WrappedKeyProvider', () => {
  let store: FakeWrappedKeyStore;

  beforeEach(() => {
    store = new FakeWrappedKeyStore();
  });

  it('reads the wrapped key through the store and unwraps it with the app-lock seam', async () => {
    const { material, record } = await wrappedDataKey();
    await store.writeWrappedKey(WRAPPED_DATA_KEY_ID, record);

    const provider = new WrappedKeyProvider(store, appLockUnwrapper);
    expect(provider.persistent).toBe(true);

    const sealed = await encryptValue(await importDataKey(material), { hello: 'lock' });
    await expect(decryptValue(await provider.dataKey(), sealed)).resolves.toEqual({ hello: 'lock' });
  });

  it('remembers a wrapped key the app lock just produced', async () => {
    const { material, record } = await wrappedDataKey();
    const provider = new WrappedKeyProvider(store, appLockUnwrapper);

    await provider.remember(record);

    const sealed = await encryptValue(await importDataKey(material), { after: 'setup' });
    await expect(decryptValue(await provider.dataKey(), sealed)).resolves.toEqual({
      after: 'setup',
    });
  });

  it('refuses rather than inventing a key when none is stored', async () => {
    const provider = new WrappedKeyProvider(store, appLockUnwrapper);
    await expect(provider.dataKey()).rejects.toBeInstanceOf(OfflineKeyUnavailableError);
  });

  it('surfaces a wrong PIN as OfflineDecryptError, never as a usable key', async () => {
    const { record } = await wrappedDataKey();
    await store.writeWrappedKey(WRAPPED_DATA_KEY_ID, record);

    const wrongPin = async (wrapped: EncryptedValue): Promise<CryptoKey> =>
      unwrapDataKey(wrapped, await deriveWrappingKey('000000', SALT));
    const provider = new WrappedKeyProvider(store, wrongPin);

    await expect(provider.dataKey()).rejects.toBeInstanceOf(OfflineDecryptError);
  });

  it(
    'caches the unwrapped key so the PIN is stretched once',
    async () => {
      const { record } = await wrappedDataKey();
      await store.writeWrappedKey(WRAPPED_DATA_KEY_ID, record);

      const provider = new WrappedKeyProvider(store, appLockUnwrapper);
      expect(await provider.dataKey()).toBe(await provider.dataKey());
    },
    20_000,
  );
});
