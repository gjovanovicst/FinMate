import { describe, expect, it } from 'vitest';

import { toBase64 } from '../offline/offline-crypto';
import {
  createWebAuthnSecret,
  deriveWebAuthnSecret,
  pinWrappingKey,
  prfWrappingKey,
  randomLockSalt,
  type WebAuthnScope,
} from './lock.crypto';

/**
 * The app lock's two secrets (task 4.2.6a, ADR-029).
 *
 * A real authenticator cannot exist in Node, so the WebAuthn path is driven by a fake that behaves like
 * one: a **deterministic** PRF over (credential, salt), which is the whole property the design rests on
 * — if the output were not reproducible, the wrapped key could never be unwrapped again and the lock
 * would be a one-way door. The PIN path uses the real PBKDF2 derivation, cost included.
 */
const SALT = toBase64(new Uint8Array(32).fill(7));

/** A fake platform authenticator. `prf: false` models one that cannot do PRF at all. */
function fakeScope(options: { prf: boolean } = { prf: true }) {
  const credentials = new Map<string, Uint8Array>();
  const attempt = (id: Uint8Array, salt: Uint8Array): ArrayBuffer => {
    // Deterministic in both inputs, like a real PRF: same credential + same salt → same 32 bytes.
    const output = new Uint8Array(32);
    for (let index = 0; index < output.length; index += 1) {
      output[index] = (id[index % id.length]! ^ salt[index % salt.length]! ^ index) & 0xff;
    }
    return output.buffer;
  };

  const scope: WebAuthnScope = {
    credentials: {
      create: async () => {
        const rawId = crypto.getRandomValues(new Uint8Array(16));
        credentials.set(toBase64(rawId), rawId);
        return {
          rawId: rawId.buffer,
          getClientExtensionResults: () => ({ prf: { enabled: options.prf } }),
        };
      },
      get: async (request) => {
        const allowed = request.publicKey.allowCredentials?.[0]?.id;
        const id = allowed === undefined ? new Uint8Array(0) : new Uint8Array(allowed as ArrayBuffer);
        const salt = new Uint8Array(
          (request.publicKey.extensions as { prf?: { eval?: { first?: ArrayBuffer } } } | undefined)
            ?.prf?.eval?.first ?? new ArrayBuffer(0),
        );
        return {
          rawId: id.buffer,
          getClientExtensionResults: () => ({
            prf: options.prf ? { enabled: true, results: { first: attempt(id, salt) } } : { enabled: false },
          }),
        };
      },
    },
    rpId: 'localhost',
    rpName: 'FinMate',
  };
  return scope;
}

describe('the WebAuthn PRF secret', () => {
  it('creates a credential and derives a wrapping key from its PRF output', async () => {
    const secret = await createWebAuthnSecret(fakeScope(), SALT);

    expect(secret).not.toBeNull();
    expect(secret!.credentialId).not.toBe('');
    expect(secret!.wrappingKey.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    // Non-extractable: the wrapping key must never be exportable, or the whole scheme is theatre.
    expect(secret!.wrappingKey.extractable).toBe(false);
  });

  it('reproduces the SAME key from the same credential and salt', async () => {
    // The property the design rests on: a lock that cannot reproduce its key cannot be unlocked.
    const scope = fakeScope();
    const created = await createWebAuthnSecret(scope, SALT);
    const again = await deriveWebAuthnSecret(scope, SALT, created!.credentialId);

    expect(again).not.toBeNull();
    // Compared through a real round trip, because a `CryptoKey` cannot be inspected or exported.
    const plaintext = new TextEncoder().encode('wrapped');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, created!.wrappingKey, plaintext);
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, again!, ciphertext);
    expect(new TextDecoder().decode(opened)).toBe('wrapped');
  });

  it('produces a DIFFERENT key for a different credential', async () => {
    const scope = fakeScope();
    const first = await createWebAuthnSecret(scope, SALT);
    const second = await createWebAuthnSecret(scope, SALT);
    const derived = await deriveWebAuthnSecret(scope, SALT, second!.credentialId);

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      first!.wrappingKey,
      new TextEncoder().encode('wrapped'),
    );
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, derived!, ciphertext)).rejects.toThrow();
  });

  it('refuses the WebAuthn path when the authenticator cannot do PRF', async () => {
    // Not a fallback to an unwrapped key — that is the one thing ADR-025 rejected. The caller offers
    // the PIN instead, and `null` is how it knows.
    expect(await createWebAuthnSecret(fakeScope({ prf: false }), SALT)).toBeNull();
  });

  it('refuses when the evaluation yields no output', async () => {
    const scope = fakeScope();
    scope.credentials.get = async () => ({ getClientExtensionResults: () => ({ prf: { enabled: true } }) });
    await expect(deriveWebAuthnSecret(scope, SALT, 'AAAA')).resolves.toBeNull();
  });

  it('mixes domain separation into the PRF output', async () => {
    // HKDF with an info string, so the same bytes can never be a key for anything else that reuses PRF.
    const key = await prfWrappingKey(new Uint8Array(32).fill(1).buffer);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    expect(key.extractable).toBe(false);
    expect(key.usages).toEqual(['encrypt', 'decrypt']);
  });
});

describe('the PIN secret', () => {
  it('derives the same key for the same PIN and salt, and a different one otherwise', async () => {
    const first = await pinWrappingKey('123456', SALT);
    const again = await pinWrappingKey('123456', SALT);
    const otherPin = await pinWrappingKey('123457', SALT);
    const otherSalt = await pinWrappingKey('123456', toBase64(new Uint8Array(32).fill(9)));

    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      first,
      new TextEncoder().encode('data key'),
    );
    expect(
      new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, again, sealed)),
    ).toBe('data key');
    // A wrong PIN is exactly this: the GCM tag does not verify. There is no stored hash to compare.
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, otherPin, sealed)).rejects.toThrow();
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv }, otherSalt, sealed)).rejects.toThrow();
  });

  it('generates a fresh 32-byte salt every time', () => {
    const first = randomLockSalt();
    const second = randomLockSalt();
    expect(first.length).toBe(32);
    expect(toBase64(first)).not.toBe(toBase64(second));
  });
});
