/**
 * The app lock's decisions, as pure functions.
 *
 * docs/08 §3.9 fixes the policy — *"Re-auth on cold start and after **5 minutes** idle. Preferred:
 * WebAuthn platform authenticator. Fallback: 6-digit app PIN"* — and ADR-025 decision 3 makes the lock
 * **opt-in**: the app works without it, and while there is no lock nothing confidential is written to
 * disk. What lives here is the arithmetic and the precedence, because every one of these is wrong
 * **silently**: a PIN rule that accepts five digits, an idle timer that never fires, or a lock that
 * reports itself armed while the key it wrapped is gone.
 *
 * See ADR-029 (the WebAuthn PRF decision), ADR-025, docs/08 §3.9.
 *
 * @module apps/web/src/app/core/app-lock
 */
import type { TranslationKey } from '../i18n/translations';

/** Which secret the user chose to wrap the data key with. */
export type LockMethod = 'WEBAUTHN' | 'PIN';

/** The lock as the rest of the app sees it. */
export type LockState =
  /** No lock is configured. The store runs on a session key and persists nothing (ADR-025 decision 3). */
  | 'OFF'
  /** A wrapped data key exists and is not in memory. The app is gated until the user unlocks it. */
  | 'LOCKED'
  /** The data key is in memory: the offline store may persist. */
  | 'UNLOCKED';

/** The install metadata that has to survive a reload for the wrapped key to be usable again. */
export interface LockMetadata {
  readonly method: LockMethod;
  /** Base64 KDF salt for the PIN path; also the PRF evaluation input for the WebAuthn path. */
  readonly salt: string;
  /** Present for `WEBAUTHN`: which credential to ask for. */
  readonly credentialId?: string;
}

/** The `keys` store ids the lock owns. One data key and one metadata record per install. */
export const LOCK_META_ID = 'lock-meta';

/** docs/08 §3.9: re-auth after five minutes idle. Not a preference, a policy. */
export const IDLE_LOCK_MS = 5 * 60 * 1000;

/** A PIN is exactly six digits (docs/08 §3.9). */
export const PIN_LENGTH = 6;

/** `true` when the value is a six-digit PIN. The pattern is the whole rule — no leading-zero exceptions. */
export function isValidPin(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/**
 * The state implied by what is on disk and what is in memory.
 *
 * A metadata record without a wrapped key, or a wrapped key without metadata, is **not** a lock: the
 * two are written together, so a half-written pair means the write was interrupted and there is nothing
 * that can be unwrapped. Reporting `LOCKED` there would gate the user behind a secret that cannot work.
 */
export function lockState(input: {
  readonly hasMetadata: boolean;
  readonly hasWrappedKey: boolean;
  readonly unlocked: boolean;
}): LockState {
  if (!input.hasMetadata || !input.hasWrappedKey) return 'OFF';
  return input.unlocked ? 'UNLOCKED' : 'LOCKED';
}

/**
 * Whether an idle session must lock.
 *
 * `lastActivityAt === null` means the app has never been touched since it was unlocked, which is not
 * idleness — it is a lock that has just been opened, and locking it immediately would be a loop.
 */
export function shouldLockOnIdle(
  lastActivityAt: number | null,
  now: number,
  idleMs = IDLE_LOCK_MS,
): boolean {
  if (lastActivityAt === null) return false;
  return now - lastActivityAt >= idleMs;
}

/** Whether a navigation is allowed to render while the app is locked. */
export function isGated(state: LockState): boolean {
  return state === 'LOCKED';
}

/** The one sentence each state needs, so a screen cannot render a blank lock. */
export function lockMessageKey(state: LockState): TranslationKey {
  switch (state) {
    case 'OFF':
      return 'lock.state.off';
    case 'LOCKED':
      return 'lock.state.locked';
    case 'UNLOCKED':
      return 'lock.state.unlocked';
  }
}

/**
 * Whether the browser can offer the WebAuthn path **at all**.
 *
 * `PublicKeyCredential` and `navigator.credentials` are the two globals involved; a browser with one and
 * not the other is not a browser that can create a credential. Whether the *authenticator* supports the
 * PRF extension is a separate question and is only answered by a real `create()` — see
 * `app-lock.crypto.ts`.
 */
export function webauthnAvailable(scope: {
  readonly credentials?: unknown;
  readonly publicKeyCredential?: unknown;
}): boolean {
  return scope.credentials !== undefined && scope.publicKeyCredential !== undefined;
}

/** What failed, in words a screen can show without inventing a reason. */
export type LockFailure =
  | 'WRONG_SECRET'
  | 'WEBAUTHN_UNAVAILABLE'
  | 'WEBAUTHN_CANCELLED'
  | 'NOT_CONFIGURED'
  | 'QUEUE_NOT_EMPTY'
  | 'UNSUPPORTED';

/** The message for a failure. Kept here so the tray, the lock screen and the settings pane agree. */
export function lockFailureKey(failure: LockFailure): TranslationKey {
  switch (failure) {
    case 'WRONG_SECRET':
      return 'lock.error.wrongSecret';
    case 'WEBAUTHN_UNAVAILABLE':
      return 'lock.error.webauthnUnavailable';
    case 'WEBAUTHN_CANCELLED':
      return 'lock.error.webauthnCancelled';
    case 'NOT_CONFIGURED':
      return 'lock.error.notConfigured';
    case 'QUEUE_NOT_EMPTY':
      return 'lock.error.queueNotEmpty';
    case 'UNSUPPORTED':
      return 'lock.error.unsupported';
  }
}
