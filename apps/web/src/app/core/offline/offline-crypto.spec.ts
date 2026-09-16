import { describe, expect, it } from 'vitest';

import {
  OfflineDecryptError,
  decryptValue,
  deriveWrappingKey,
  encryptValue,
  generateDataKey,
  generateDataKeyMaterial,
  importDataKey,
  unwrapDataKey,
  wrapDataKey,
} from './offline-crypto';

/**
 * The crypto boundary is asserted, not assumed.
 *
 * ADR-025 decision 2 promises that a profile dump yields ciphertext, and docs/08 §3.9 scores T-03's
 * mitigation against exactly that. These tests are what keeps the promise honest: a value round-trips,
 * a tampered one is refused by name, a foreign key cannot read it, and the app lock's wrap/unwrap path
 * reproduces the very key that encrypted the data.
 */
describe('offline-crypto', () => {
  it('round-trips a value through AES-GCM', async () => {
    const key = await generateDataKey();
    const record = await encryptValue(key, { clientRowId: 'row-1', amountMinor: '200000' });

    await expect(decryptValue(key, record)).resolves.toEqual({
      clientRowId: 'row-1',
      amountMinor: '200000',
    });
  });

  it('uses a fresh IV and produces different ciphertext for identical input', async () => {
    const key = await generateDataKey();
    const first = await encryptValue(key, 'same value');
    const second = await encryptValue(key, 'same value');

    expect(first.iv).not.toEqual(second.iv);
    expect(first.ciphertext).not.toEqual(second.ciphertext);
  });

  it('throws a named OfflineDecryptError for a tampered record', async () => {
    const key = await generateDataKey();
    const record = await encryptValue(key, { description: 'Lidl' });
    // Flip the first base64 character, which changes real ciphertext bits (not just padding).
    const tampered = {
      ...record,
      ciphertext: (record.ciphertext[0] === 'A' ? 'B' : 'A') + record.ciphertext.slice(1),
    };

    await expect(decryptValue(key, tampered)).rejects.toBeInstanceOf(OfflineDecryptError);
  });

  it('throws OfflineDecryptError when a record is read with a different key', async () => {
    const writer = await generateDataKey();
    const other = await generateDataKey();
    const record = await encryptValue(writer, { description: 'Lidl' });

    await expect(decryptValue(other, record)).rejects.toBeInstanceOf(OfflineDecryptError);
  });

  it(
    'wraps a data key so the unwrapped key decrypts what the original encrypted',
    async () => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const material = generateDataKeyMaterial();
      const original = await importDataKey(material);
      const sealed = await encryptValue(original, { hello: 'world' });

      const wrappingKey = await deriveWrappingKey('123456', salt);
      const wrapped = await wrapDataKey(material, wrappingKey);
      const restored = await unwrapDataKey(wrapped, await deriveWrappingKey('123456', salt));

      await expect(decryptValue(restored, sealed)).resolves.toEqual({ hello: 'world' });
    },
    20_000,
  );

  it(
    'derives the same key for the same PIN and salt, and a different key for a different salt',
    async () => {
      const salt = new Uint8Array(16).fill(7);
      const otherSalt = new Uint8Array(16).fill(8);
      const first = await deriveWrappingKey('123456', salt);
      const same = await deriveWrappingKey('123456', salt);
      const different = await deriveWrappingKey('123456', otherSalt);

      const record = await encryptValue(first, 'payload');
      await expect(decryptValue(same, record)).resolves.toBe('payload');
      await expect(decryptValue(different, record)).rejects.toBeInstanceOf(OfflineDecryptError);
    },
    30_000,
  );
});
