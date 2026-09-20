import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';

import { AppLockService } from '../app-lock/app-lock.service';
import { AuthStore } from './auth.store';

/**
 * Require an authenticated session — with one deliberate exception (ADR-033, amended).
 *
 * `restore()` is attempted once per page load: the access token lives in memory, so a refresh
 * (F5) loses it while the refresh cookie survives. Without this, a reload would bounce an
 * authenticated user to sign-in — the single most annoying bug a session design can ship.
 *
 * The exception is the offline app: an install the lock has **unlocked** whose session could not be
 * restored because nothing answered opens the app's own screens. Every route is admitted, not a
 * two-entry allow-list, because the destinations do open — each screen serves the record it has
 * (the dashboard snapshot, the ledger cache, the queue) or its own honest "needs a connection"
 * state. What the unlock does **not** authorise is a session: `isAuthenticated()` stays false and
 * nothing is sent (ADR-033 decision 4), so a revoked session is never kept alive on the device.
 * A session the server actually refused still goes to `/sign-in`.
 */
export const authenticatedGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const lock = inject(AppLockService);

  if (auth.isAuthenticated()) return true;

  // Attempted once per page load: a second navigation must not re-ask the server (the store records
  // *why* the first attempt failed, which is what the branch below reads).
  if (auth.restoreFailure() === null) await auth.restore();
  if (auth.isAuthenticated()) return true;

  await lock.ready();
  if (lock.state() === 'UNLOCKED' && auth.restoreFailure() === 'UNREACHABLE') return true;

  return router.createUrlTree(['/sign-in']);
};

/**
 * Restore the session if the cookie still carries one, and **never redirect**.
 *
 * The catch-all route needs this and neither guard fits it. Without it `restore()` never runs on an
 * unknown URL — it lives only in the two guards — so a signed-in person who mistypes an address, or
 * refreshes one, landed on a page with no navigation and no account block that read as signed out. That
 * was true of `/nema-ovakve-strane` in both themes (found by the ADR-039 audit).
 *
 * A signed-out visitor is left alone: "not found" is the honest answer to a bad URL, and bouncing them to
 * `/sign-in` would claim the page exists behind a login.
 */
export const shellGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  if (!auth.isAuthenticated() && auth.restoreFailure() === null) await auth.restore();
  return true;
};

/** Keep signed-in users away from the auth pages. */
export const anonymousGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);

  if (!auth.isAuthenticated()) await auth.restore();
  return auth.isAuthenticated() ? router.createUrlTree(['/']) : true;
};
