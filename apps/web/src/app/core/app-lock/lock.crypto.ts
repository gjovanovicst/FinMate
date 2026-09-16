/**
 * The app lock's two secrets, and nothing else.
 *
 * The data key must be **wrapped** by something a phone thief does not have (ADR-025 decisions 2–3).
 * There are exactly two such things here:
 *
 * - **WebAuthn's PRF extension.** A platform authenticator that supports `prf` evaluates a
 *   pseudo-random function over a per-install salt and returns 32 stable bytes; only that authenticator
 *   can reproduce them. This is the *only* way a WebAuthn credential can contribute a real secret —
 *   a credential id and a signature are public and must not be mistaken for key material. It is
 *   therefore a decision in its own right (**ADR-029**), and the reason the WebAuthn path is probed
 *   rather than assumed.
 * - **A six-digit PIN**, stretched with PBKDF2-SHA-256 at 600 000 iterations (`offline-crypto`), exactly
 *   as ADR-025 decision 4 fixed it. ~20 bits of entropy, so it is a speed bump and the UI says so.
 *
 * Everything here is a pure function over an injected scope so it can be tested without a browser: the
 * real `navigator.credentials` is passed in by the service.
 *
 * See ADR-029, ADR-025 decisions 2–4, docs/08 §3.9.
 *
 * @module apps/web/src/app/core/app-lock
 */
import {
  deriveWrappingKey,
  fromBase64,
  toBase64,
  type Bytes,
} from '../offline/offline-crypto';

/** The PRF input. 32 bytes, per install, stored beside the wrapped key (a salt is not a secret). */
const SALT_BYTES = 32;

/** Domain separation for the PRF output, so these bytes can never be a key for anything else. */
const HKDF_INFO = 'finmate-app-lock-v1';

/** A fresh per-install salt. `crypto.getRandomValues` is the platform CSPRNG, as everywhere else. */
export function randomLockSalt(): Bytes {
  return crypto.getRandomValues(new Uint8Array(SALT_BYTES));
}

/** The PIN path: the same PBKDF2 derivation the store's tests already pay for. */
export async function pinWrappingKey(pin: string, saltBase64: string): Promise<CryptoKey> {
  return deriveWrappingKey(pin, fromBase64(saltBase64));
}

/**
 * Turn PRF output into a key-wrapping key.
 *
 * HKDF-SHA-256 rather than using the bytes directly: the PRF output is already uniform, so it needs no
 * stretching, but it *does* need domain separation — the same authenticator and salt will be used for
 * nothing else here, and `info` makes that structural rather than a comment.
 */
export async function prfWrappingKey(output: ArrayBuffer): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', output, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** The PRF extension's output, as `getClientExtensionResults()` reports it. */
interface PrfExtensionResults {
  readonly prf?: {
    readonly enabled?: boolean;
    readonly results?: { readonly first?: ArrayBuffer | null };
  };
}

/**
 * The slice of `navigator` this module needs.
 *
 * Injected so a spec can drive the whole WebAuthn path with a fake — a real authenticator cannot exist
 * in Node, and "we never tested it" is how a lock ships that cannot unlock.
 */
export interface WebAuthnScope {
  readonly credentials: {
    create(options: { publicKey: PublicKeyCredentialCreationOptions }): Promise<unknown>;
    get(options: { publicKey: PublicKeyCredentialRequestOptions }): Promise<unknown>;
  };
  readonly rpId: string;
  readonly rpName: string;
}

/** What a successful `create()` gives back: the credential to ask for, and the key it can reproduce. */
export interface WebAuthnSecret {
  readonly credentialId: string;
  readonly wrappingKey: CryptoKey;
}

function extensionsOf(credential: unknown): PrfExtensionResults {
  const holder = credential as { getClientExtensionResults?: () => PrfExtensionResults };
  return holder.getClientExtensionResults?.() ?? {};
}

/**
 * Create a platform credential whose PRF output wraps the data key.
 *
 * Two steps on purpose: `create()` with an **empty** `prf` input asks the authenticator whether it can
 * do PRF at all (`prf.enabled`), and only then is the salt evaluated (step two, `get()`), because a
 * `create()` that asked for an evaluation some authenticators ignore would return no output and look
 * like a bug instead of a capability answer.
 *
 * Returns `null` when the authenticator cannot do PRF. The caller must then offer the PIN — **never**
 * fall back to storing an unwrapped key, which is the one thing ADR-025 rejected outright.
 */
export async function createWebAuthnSecret(
  scope: WebAuthnScope,
  saltBase64: string,
): Promise<WebAuthnSecret | null> {
  const salt = fromBase64(saltBase64);
  const created = await scope.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { id: scope.rpId, name: scope.rpName },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'app-lock',
        displayName: 'App lock',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'preferred',
      },
      timeout: 60_000,
      attestation: 'none',
      // Capability probe only: no `eval`, so an authenticator that cannot do PRF answers honestly
      // instead of failing the whole registration.
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  });

  if (created === null || extensionsOf(created).prf?.enabled !== true) return null;

  const credentialId = credentialIdOf(created);
  if (credentialId === null) return null;

  const wrappingKey = await evaluatePrf(scope, credentialId, salt);
  return wrappingKey === null ? null : { credentialId, wrappingKey };
}

/**
 * Reproduce the wrapping key from an existing credential.
 *
 * The browser will ask for the platform authenticator (Face ID, fingerprint, Windows Hello); a user
 * cancellation rejects and is the caller's `WEBAUTHN_CANCELLED`, not a wrong secret.
 */
export async function deriveWebAuthnSecret(
  scope: WebAuthnScope,
  saltBase64: string,
  credentialId: string,
): Promise<CryptoKey | null> {
  return evaluatePrf(scope, credentialId, fromBase64(saltBase64));
}

async function evaluatePrf(
  scope: WebAuthnScope,
  credentialId: string,
  salt: Bytes,
): Promise<CryptoKey | null> {
  const assertion = await scope.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: scope.rpId,
      allowCredentials: [{ type: 'public-key', id: fromBase64(credentialId) }],
      userVerification: 'required',
      timeout: 60_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  });

  const first = assertion === null ? undefined : extensionsOf(assertion).prf?.results?.first;
  if (first === undefined || first === null) return null;
  return prfWrappingKey(first);
}

function credentialIdOf(credential: unknown): string | null {
  const rawId = (credential as { rawId?: ArrayBuffer }).rawId;
  return rawId === undefined ? null : toBase64(new Uint8Array(rawId));
}
