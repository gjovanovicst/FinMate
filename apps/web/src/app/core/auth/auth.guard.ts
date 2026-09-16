import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';

import { AppLockService } from '../app-lock/app-lock.service';
import { AuthStore } from './auth.store';

/**
 * Require an authenticated session — with one deliberate exception (ADR-033).
 *
 * `restore()` is attempted once per page load: the access token lives in memory, so a refresh
 * (F5) loses it while the refresh cookie survives. Without this, a reload would bounce an
 * authenticated user to sign-in — the single most annoying bug a session design can ship.
 *
 * The exception is the offline shell: an install the lock has **unlocked** whose session could not be
 * restored because nothing answered may reach the routes that read only what is already on the device,
 * marked `data: { offline: true }` (today `/pending` and `/transactions`' cache). Everything else
 * redirects to the tray, and a session the server actually refused still goes to `/sign-in`.
 */
export const authenticatedGuard: CanActivateFn = async (route) => {
  const auth = inject(AuthStore);
  const router = inject(Router);
  const lock = inject(AppLockService);

  if (auth.isAuthenticated()) return true;

  // Attempted once per page load: a second navigation must not re-ask the server (the store records
  // *why* the first attempt failed, which is what the branch below reads).
  if (auth.restoreFailure() === null) await auth.restore();
  if (auth.isAuthenticated()) return true;

  await lock.ready();
  if (lock.state() === 'UNLOCKED' && auth.restoreFailure() === 'UNREACHABLE') {
    return route.data?.['offline'] === true ? true : router.createUrlTree(['/pending']);
  }

  return router.createUrlTree(['/sign-in']);
};

/** Keep signed-in users away from the auth pages. */
export const anonymousGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);

  if (!auth.isAuthenticated()) await auth.restore();
  return auth.isAuthenticated() ? router.createUrlTree(['/']) : true;
};
