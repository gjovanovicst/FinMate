import { inject } from '@angular/core';
import { type CanActivateFn, Router } from '@angular/router';

import { OnboardingStore } from '../onboarding/onboarding.store';

/**
 * Send a Household with unfinished F-13 onboarding into the wizard.
 *
 * Attached to the **dashboard only**, deliberately. docs/02 FL-01 §3 redirects right after signup, and
 * sign-in lands on `/` — so this catches the case the spec describes without turning the whole app into
 * a lockout. Anything else would mean a Household that chose to skip onboarding could not reach a
 * screen it deliberately navigated to, and "Skip" has to mean something.
 *
 * **It fails open.** If `onboardingState` cannot be read, the answer is "no redirect" (`OnboardingStore`
 * swallows the error and reports `needed = false`), because locking a user out over a network blip on a
 * screen that guards nothing would be a far worse bug than skipping a redirect once.
 */
export const onboardingGuard: CanActivateFn = async () => {
  const store = inject(OnboardingStore);
  const router = inject(Router);

  if (!store.isLoaded()) await store.refresh();

  return store.needed() ? router.createUrlTree(['/onboarding']) : true;
};
