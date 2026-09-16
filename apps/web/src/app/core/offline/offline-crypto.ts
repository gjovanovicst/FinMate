/**
 * The WebCrypto primitives the offline store is built out of — nothing else.
 *
 * Every record the client persists is one AES-GCM-256 message under a per-install data key, and the
 * data key itself is stored only wrapped by an app-lock secret (ADR-025 decisions 2–4). This module
 * owns both halves and deliberately has no dependency beyond `crypto.subtle`, so the store, the
 * outbox and the future app lock share one implementation instead of three private ones.
 *
 * See ADR-025, docs/08 §3.9 (client-side posture, threat T-03) and docs/05 §7.
 *
 * @module apps/web/src/app/core/offline
 */

/** AES-256 wants 32 bytes; GCM's recommended nonce is 96 bits (NIST SP 800-38D). */
const DATA_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;

/**
 * PBKDF2 work factor for the app-lock PIN (ADR-025 decision 4).
 *
 * High on purpose even though the brief's secret is only six digits: a 6-digit PIN is ~20 bits and
 * offline-brute-forceable whatever the KDF, so WebAuthn is the control and this is the speed bump.
 * It is not lowered to make tests fast — the spec pays the real cost.
 */
const WRAPPING_KEY_ITERATIONS = 600_000;

/** `{ iv, ciphertext }`, both base64. The shape every stored record carries. */
export interface EncryptedValue {
  readonly iv: string;
  readonly ciphertext: string;
}

/**
 * Bytes backed by a plain `ArrayBuffer`, which is what WebCrypto's `BufferSource` accepts.
 *
 * Spelled out rather than left as `Uint8Array` because TypeScript's default for that type is
 * `Uint8Array<ArrayBufferLike>` (it may be a `SharedArrayBuffer`), which `crypto.subtle` refuses.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * Raised when a stored value cannot be authenticated or decoded.
 *
 * A tampered record and a record written under a different key are the same event from here: the GCM
 * tag does not verify. It is a named error, never swallowed, so a caller cannot mistake a decryption
 * failure for "no data" and quietly serve a wrong figure (docs/08 §3.9).
 */
export class OfflineDecryptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OfflineDecryptError';
  }
}

/**
 * Raw key material from the platform CSPRNG.
 *
 * Separate from {@link generateDataKey} because the app lock (task 4.2.6) has to wrap the material
 * under its own secret *before* importing it: a non-extractable `CryptoKey` cannot be exported, so
 * the bytes that are wrapped and the key that encrypts records are created in that order.
 */
export function generateDataKeyMaterial(): Bytes {
  return crypto.getRandomValues(new Uint8Array(DATA_KEY_BYTES));
}

/** Import key material as a **non-extractable** AES-GCM key — the only form the store ever holds. */
export async function importDataKey(material: Bytes): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

/** A fresh per-install data key. Non-extractable, so it cannot be written in the clear by accident. */
export async function generateDataKey(): Promise<CryptoKey> {
  return importDataKey(generateDataKeyMaterial());
}

/** JSON → UTF-8 → AES-GCM under a fresh 96-bit IV. */
export async function encryptValue(key: CryptoKey, value: unknown): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

/** Reverse of {@link encryptValue}. Throws {@link OfflineDecryptError}; it never returns `null`. */
export async function decryptValue<T>(key: CryptoKey, record: EncryptedValue): Promise<T> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) },
      key,
      fromBase64(record.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch (cause) {
    throw new OfflineDecryptError('The offline record could not be decrypted.', { cause });
  }
}

/**
 * Derive the app lock's key-wrapping key from a PIN and a per-install salt.
 *
 * PBKDF2-SHA-256, 600 000 iterations, WebCrypto only (ADR-025 decision 4 rejects Argon2-wasm). The
 * returned key is non-extractable and used only to wrap and unwrap the data key.
 */
export async function deriveWrappingKey(pin: string, salt: Bytes): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pin),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: WRAPPING_KEY_ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wrap the raw data key under the app lock's key. The wrapped bytes are what may touch disk. */
export async function wrapDataKey(
  material: Bytes,
  wrappingKey: CryptoKey,
): Promise<EncryptedValue> {
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, material);
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

/** Unwrap into a non-extractable data key, or throw {@link OfflineDecryptError} (wrong PIN, tamper). */
export async function unwrapDataKey(
  wrapped: EncryptedValue,
  wrappingKey: CryptoKey,
): Promise<CryptoKey> {
  let material: ArrayBuffer;
  try {
    material = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(wrapped.iv) },
      wrappingKey,
      fromBase64(wrapped.ciphertext),
    );
  } catch (cause) {
    throw new OfflineDecryptError('The wrapped data key could not be unwrapped.', { cause });
  }
  return importDataKey(new Uint8Array(material));
}

function toBase64(bytes: Bytes): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
