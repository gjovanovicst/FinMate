import { Injectable, inject, signal } from '@angular/core';

import { AuthStore } from '../auth/auth.store';
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
 * ## The cache is keyed to the Household, not to the page load
 *
 * The store is root-provided, so it outlives a sign-out: sign out of a finished Household and create
 * another account in the same tab and the answer it held belongs to somebody else. A page-load cache
 * would then report "nothing to do" for the brand-new Household and the wizard would never open —
 * measured live, and exactly the F-13 redirect this store exists to make. `isLoaded()` therefore means
 * *"answered for the Household in the session right now"*, so a session change re-asks on the next
 * navigation with no extra request inside one Household.
 *
 * @module apps/web/src/app/core/onboarding
 */
@Injectable({ providedIn: 'root' })
export class OnboardingStore {
  private readonly graphql = inject(GraphqlClient);
  private readonly auth = inject(AuthStore);

  private readonly needsSignal = signal(false);
  /** The Household `needsSignal` and `loaded` were answered for, or `null` before any answer. */
  private answeredFor: string | null = null;
  private loaded = false;

  /** `true` only once we know the Household has unfinished onboarding. */
  readonly needed = this.needsSignal.asReadonly();

  async refresh(): Promise<void> {
    // Read before the await: if the session changes mid-flight the answer is recorded for the
    // Household it was asked about, and `isLoaded()` reports it stale rather than serving it.
    const householdId = this.currentHouseholdId();
    try {
      const data = await this.graphql.query<{
        onboardingState: { step: number; completedAt: string | null };
      }>(ONBOARDING_STATE);
      const state = data.onboardingState;
      // Past the recorded end, or explicitly completed: nothing to do.
      this.needsSignal.set(state.completedAt === null && state.step < 7);
      this.answeredFor = householdId;
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
    this.answeredFor = this.currentHouseholdId();
    this.loaded = true;
  }

  /**
   * Whether the answer is known **for the Household signed in right now**, for a caller that wants to
   * refresh before deciding. A session change makes a previous answer unknown again.
   */
  isLoaded(): boolean {
    return this.loaded && this.answeredFor === this.currentHouseholdId();
  }

  private currentHouseholdId(): string | null {
    return this.auth.session()?.householdId ?? null;
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
