import { Injectable, inject, signal } from '@angular/core';

import { GraphqlClient } from '../graphql/graphql.client';

/**
 * Whether this Household still has onboarding to do — the F-13 redirect's one cached fact.
 *
 * docs/02 FL-01 §3: signup *"Redirects to `/onboarding`; the step is recorded so a killed app resumes"*.
 * The redirect decision needs `onboardingState`, and a guard runs on **every** navigation, so this
 * holds the answer instead of asking per route.
 *
 * ## Two rules that matter more than the caching
 *
 * - **`completedAt` decides, not an empty tree** (this mirrors `needsOnboarding` in
 *   `features/onboarding`). A household that finished onboarding and then deleted its categories is
 *   still finished; inferring from row counts would drag it back in.
 * - **A failure resolves to "no redirect".** If the query errors, the user keeps the app rather than
 *   being bounced into a wizard on the strength of a network blip. A guard that fails closed here
 *   would be a lockout, which is the worst possible failure for a screen that guards nothing.
 *
 * @module apps/web/src/app/core/onboarding
 */
@Injectable({ providedIn: 'root' })
export class OnboardingStore {
  private readonly graphql = inject(GraphqlClient);

  private readonly needsSignal = signal(false);
  private loaded = false;

  /** `true` only once we know the Household has unfinished onboarding. */
  readonly needed = this.needsSignal.asReadonly();

  async refresh(): Promise<void> {
    try {
      const data = await this.graphql.query<{
        onboardingState: { step: number; completedAt: string | null };
      }>(ONBOARDING_STATE);
      const state = data.onboardingState;
      // Past the recorded end, or explicitly completed: nothing to do.
      this.needsSignal.set(state.completedAt === null && state.step < 7);
      this.loaded = true;
    } catch {
      // Deliberately not `loaded = true`: the next navigation retries, and until then the guard
      // answers `false` so nobody is trapped.
      this.needsSignal.set(false);
    }
  }

  /** Called by the wizard once it completes, so the guard stops redirecting without a refetch. */
  markComplete(): void {
    this.needsSignal.set(false);
    this.loaded = true;
  }

  /** Whether the answer is known, for a caller that wants to refresh before deciding. */
  isLoaded(): boolean {
    return this.loaded;
  }
}

const ONBOARDING_STATE = /* GraphQL */ `
  query OnboardingGate {
    onboardingState {
      step
      completedAt
    }
  }
`;
