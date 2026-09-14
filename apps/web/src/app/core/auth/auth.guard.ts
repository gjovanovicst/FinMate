import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';

import { AuthStore } from './auth.store';

/**
 * Require an authenticated session.
 *
 * `restore()` is attempted once per page load: the access token lives in memory, so a refresh
 * (F5) loses it while the refresh cookie survives. Without this, a reload would bounce an
 * authenticated user to sign-in — the single most annoying bug a session design can ship.
 */
export const authenticatedGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);

  if (auth.isAuthenticated()) return true;

  await auth.restore();
  if (auth.isAuthenticated()) return true;

  return router.createUrlTree(['/sign-in']);
};

/** Keep signed-in users away from the auth pages. */
export const anonymousGuard: CanActivateFn = async () => {
  const auth = inject(AuthStore);
  const router = inject(Router);

  if (!auth.isAuthenticated()) await auth.restore();
  return auth.isAuthenticated() ? router.createUrlTree(['/']) : true;
};
