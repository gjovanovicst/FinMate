import { describe, expect, it } from 'vitest';

import {
  IDLE_LOCK_DEVICE_MS,
  IDLE_LOCK_MS,
  idleLockMs,
  isValidPin,
  isGated,
  lockFailureKey,
  lockMessageKey,
  lockState,
  pendingDurabilityKey,
  shouldLockOnIdle,
  unlockOffers,
  webauthnAvailable,
  type LockState,
} from './lock.view';

/**
 * The app lock's policy (task 4.2.6a, docs/08 §3.9).
 *
 * Every case here fails *silently* when it is wrong: a five-digit PIN accepted, an idle rule that never
 * fires, a half-written lock reported as armed — which is a user gated behind a secret nothing can
 * unwrap. None of them are visible in a screen that looks fine.
 */
describe('app lock policy', () => {
  it('accepts exactly six digits and nothing else', () => {
    expect(isValidPin('123456')).toBe(true);
    expect(isValidPin('000000')).toBe(true);
    // Five digits, seven, letters, whitespace, and a full-width digit are all out.
    expect(isValidPin('12345')).toBe(false);
    expect(isValidPin('1234567')).toBe(false);
    expect(isValidPin('12345a')).toBe(false);
    expect(isValidPin(' 12345')).toBe(false);
    expect(isValidPin('')).toBe(false);
  });

  it('reports OFF unless BOTH the metadata and the wrapped key are there', () => {
    // Written together, so a half-written pair means an interrupted write, not a lock: reporting
    // LOCKED would gate the user behind a secret that cannot be unwrapped.
    expect(lockState({ hasMetadata: true, hasWrappedKey: false, unlocked: false })).toBe('OFF');
    expect(lockState({ hasMetadata: false, hasWrappedKey: true, unlocked: false })).toBe('OFF');
    expect(lockState({ hasMetadata: false, hasWrappedKey: false, unlocked: false })).toBe('OFF');
    expect(lockState({ hasMetadata: true, hasWrappedKey: true, unlocked: false })).toBe('LOCKED');
    expect(lockState({ hasMetadata: true, hasWrappedKey: true, unlocked: true })).toBe('UNLOCKED');
  });

  it('gates the app only while locked, never when the lock is off', () => {
    // ADR-025 rejected requiring a lock to use the app: OFF must stay usable.
    expect(isGated('LOCKED')).toBe(true);
    expect(isGated('OFF')).toBe(false);
    expect(isGated('UNLOCKED')).toBe(false);
  });

  it('locks after five minutes of no activity', () => {
    const opened = 1_000_000;
    expect(IDLE_LOCK_MS).toBe(5 * 60 * 1000);
    expect(shouldLockOnIdle(opened, opened + IDLE_LOCK_MS - 1)).toBe(false);
    expect(shouldLockOnIdle(opened, opened + IDLE_LOCK_MS)).toBe(true);
    expect(shouldLockOnIdle(opened, opened + IDLE_LOCK_MS * 3)).toBe(true);
  });

  it('does not lock an app that has not been touched since it was opened', () => {
    // `null` is "just unlocked", which is not idleness: locking immediately would be a loop.
    expect(shouldLockOnIdle(null, 9_999_999)).toBe(false);
  });

  it('gives the device-armed lock a longer idle window than the PIN one', () => {
    // ADR-029's amendment: the idle rule protects an unattended session, and a platform authenticator
    // already refuses the next person to pick the device up. Five minutes of reading a page re-prompting
    // is what made people turn the lock off — which loses the durability the queue needs.
    expect(idleLockMs('PIN')).toBe(IDLE_LOCK_MS);
    expect(idleLockMs('WEBAUTHN')).toBe(IDLE_LOCK_DEVICE_MS);
    expect(IDLE_LOCK_DEVICE_MS).toBeGreaterThan(IDLE_LOCK_MS);
    // No lock configured: the strict window is the safe default, and it is never consulted in this state.
    expect(idleLockMs(null)).toBe(IDLE_LOCK_MS);
  });

  it('gives every state and every failure a sentence', () => {
    const states: readonly LockState[] = ['OFF', 'LOCKED', 'UNLOCKED'];
    for (const state of states) {
      expect(lockMessageKey(state)).toMatch(/^lock\.state\./);
    }
    for (const failure of [
      'WRONG_SECRET',
      'WEBAUTHN_UNAVAILABLE',
      'WEBAUTHN_CANCELLED',
      'NOT_CONFIGURED',
      'QUEUE_NOT_EMPTY',
      'UNSUPPORTED',
    ] as const) {
      expect(lockFailureKey(failure)).toMatch(/^lock\.error\./);
    }
  });

  it('requires both globals before offering the WebAuthn path', () => {
    expect(webauthnAvailable({ credentials: {}, publicKeyCredential: class {} })).toBe(true);
    // One without the other cannot create a credential, which is exactly how Safari in a tab looks.
    expect(webauthnAvailable({ credentials: {}, publicKeyCredential: undefined })).toBe(false);
    expect(webauthnAvailable({ credentials: undefined, publicKeyCredential: class {} })).toBe(false);
    expect(webauthnAvailable({})).toBe(false);
  });

  it('asks for the secret the lock actually has, and never for one it does not', () => {
    // A credential was never created for a PIN-armed lock, and no PIN was chosen for a WebAuthn one.
    expect(unlockOffers('PIN')).toEqual({ biometric: false, pin: true });
    expect(unlockOffers('WEBAUTHN')).toEqual({ biometric: true, pin: false });
    expect(unlockOffers(null)).toEqual({ biometric: false, pin: false });
  });

  it('claims durability only while the store is actually persistent', () => {
    // R-23's copy defect: "Nothing here is lost." was false while the key lived only in the page.
    expect(pendingDurabilityKey(true)).toBe('pending.subtitleDurable');
    expect(pendingDurabilityKey(false)).toBe('pending.subtitleVolatile');
  });
});
