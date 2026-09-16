import { Injectable, computed, inject, signal } from '@angular/core';
import { SwPush } from '@angular/service-worker';
import { firstValueFrom } from 'rxjs';

import { GraphqlClient } from '../graphql/graphql.client';
import {
  isIos,
  isStandalone,
  pushState,
  subscriptionInput,
  type BrowserSubscription,
  type PushFacts,
  type PushState,
} from './push.view';

/**
 * Push notifications on this device — the client half of F-22 (task 4.2.5, ADR-028).
 *
 * The decisions live in `push.view.ts`; this service is the only place that touches `SwPush`, the
 * `Notification` API and the two GraphQL operations, and it holds the current facts in a signal so the
 * panel is a pure function of them.
 *
 * ## Permission is asked after an explanation, never on load
 *
 * ADR-028 decision 5 and docs/07 §4.8 both say it, for different reasons: a prompt on load is ignored
 * on iOS (the gesture requirement) and is the fastest way to get a permanent `denied` everywhere else.
 * So nothing here prompts — {@link enable} runs from a button the user pressed, and a denial is a
 * state the panel explains rather than an error.
 *
 * ## Re-register on every app start
 *
 * docs/07 §4.8: `pushsubscriptionchange` is **unreliable**, so `syncOnStart` re-registers whatever
 * subscription the browser holds whenever permission is granted. That is also what revives a row the
 * server retired after a `404`/`410` (ADR-028 decision 3), because reviving is an upsert of the same
 * `endpoint`. It is one request, once per page load, and it is silent — the user asked for push once
 * and should not see it happen again.
 *
 * ## Why every `SwPush` read is guarded
 *
 * With `provideServiceWorker(…, { enabled: false })` — i.e. every dev build and any browser without a
 * worker — `SwPush.isEnabled` is false and its observables are `NEVER`. `firstValueFrom` on a `NEVER`
 * observable never resolves and never rejects, so an unguarded await is a promise that silently
 * hangs the caller forever. Every read below is therefore behind `isEnabled`.
 *
 * @module apps/web/src/app/core/push
 */

/** The absence of facts, used until {@link PushService.refresh} has read them. */
const UNKNOWN: PushFacts = {
  serviceWorkerEnabled: false,
  pushManagerSupported: false,
  serverPublicKey: null,
  permission: 'unsupported',
  hasSubscription: false,
  ios: false,
  standalone: false,
};

@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly graphql = inject(GraphqlClient);
  private readonly swPush = inject(SwPush);

  private readonly factsSignal = signal<PushFacts>(UNKNOWN);
  private readonly busySignal = signal(false);
  private readonly errorSignal = signal(false);

  /** What this device can do (see `push.view.ts` for the precedence). */
  readonly state = computed<PushState>(() => pushState(this.factsSignal()));
  readonly busy = this.busySignal.asReadonly();
  readonly error = this.errorSignal.asReadonly();

  /** `true` once {@link syncOnStart} has made its one attempt for this page load. */
  private synced = false;

  /** Re-read the environment and the deployment's key. Called by the screen that shows the panel. */
  async refresh(): Promise<void> {
    const facts = await this.readFacts();
    this.factsSignal.set(facts);
  }

  /**
   * Ask for permission and register this browser.
   *
   * Only meaningful in `READY`, and a no-op otherwise: the button that calls it is rendered in that
   * state alone, and a state that changed in another tab between render and click must not turn into
   * a prompt the user did not ask for.
   */
  async enable(): Promise<void> {
    const facts = this.factsSignal();
    if (pushState(facts) !== 'READY' || facts.serverPublicKey === null) return;

    this.busySignal.set(true);
    this.errorSignal.set(false);
    try {
      const subscription = await this.swPush.requestSubscription({
        serverPublicKey: facts.serverPublicKey,
      });
      const input = subscriptionInput(
        subscription.toJSON() as BrowserSubscription,
        globalThis.navigator?.userAgent ?? '',
      );
      // A browser that returns no key material cannot be registered, and the API would accept an
      // unusable row. Refusing shows the error instead of a "subscribed" state that never delivers.
      if (input === null) throw new Error('the browser returned a subscription without keys');
      await this.graphql.query(REGISTER_SUBSCRIPTION, { input });
    } catch {
      this.errorSignal.set(true);
    } finally {
      // Whatever happened, the facts are stale — re-read rather than guess.
      this.factsSignal.set(await this.readFacts());
      this.busySignal.set(false);
    }
  }

  /**
   * Turn this device off.
   *
   * The **browser first, then the server**. If unsubscribing fails the row stays and the next push to
   * a dead endpoint is pruned by the push service's own `404`/`410`; the other order would leave a live
   * browser subscription behind and `syncOnStart` would immediately re-register it — the button would
   * appear not to work.
   */
  async disable(): Promise<void> {
    this.busySignal.set(true);
    this.errorSignal.set(false);
    const subscription = await this.readSubscription();
    try {
      if (this.swPush.isEnabled) await this.swPush.unsubscribe();
    } catch {
      // Already gone, or the worker refused: the server-side delete below is still the right next step.
    }
    try {
      if (subscription?.endpoint) {
        await this.graphql.query(DELETE_SUBSCRIPTION, { endpoint: subscription.endpoint });
      }
    } catch {
      this.errorSignal.set(true);
    } finally {
      this.factsSignal.set(await this.readFacts());
      this.busySignal.set(false);
    }
  }

  /**
   * Re-register the subscription this browser already holds — docs/07 §4.8.
   *
   * Once per page load, only when permission is already granted, and deliberately silent: it is not a
   * user action and there is no screen to report to. A failure costs one stale row that the push
   * service prunes on the next dispatch.
   */
  async syncOnStart(): Promise<void> {
    if (this.synced) return;
    this.synced = true;
    if (!this.swPush.isEnabled) return;
    if (readPermission() !== 'granted') return;

    const subscription = await this.readSubscription();
    if (subscription === null) return;
    const input = subscriptionInput(subscription, globalThis.navigator?.userAgent ?? '');
    if (input === null) return;

    try {
      await this.graphql.query(REGISTER_SUBSCRIPTION, { input });
    } catch {
      // Silent on purpose: no screen is waiting, and the next app start tries again.
    }
  }

  private async readFacts(): Promise<PushFacts> {
    const publicKey = await this.readPublicKey();
    const subscription = await this.readSubscription();
    const permission = readPermission();
    return {
      serviceWorkerEnabled: this.swPush.isEnabled,
      pushManagerSupported: typeof globalThis.PushManager !== 'undefined',
      serverPublicKey: publicKey,
      permission,
      hasSubscription: subscription !== null,
      ios: isIos(
        globalThis.navigator?.userAgent ?? '',
        globalThis.navigator?.maxTouchPoints ?? 0,
        globalThis.navigator?.platform ?? '',
      ),
      standalone: isStandalone(
        (globalThis.navigator as { standalone?: boolean } | undefined)?.standalone === true,
        globalThis.matchMedia?.('(display-mode: standalone)').matches === true,
      ),
    };
  }

  /**
   * The deployment's VAPID public key, or `null`.
   *
   * A failure is reported as `null` (push is not available) rather than thrown: the panel then says
   * push is not set up, which is true from the user's point of view and is not a scary error for a
   * nicety. The API itself answers `null` for a deployment without keys (ADR-028 decision 2).
   */
  private async readPublicKey(): Promise<string | null> {
    try {
      const data = await this.graphql.query<{ pushPublicKey: string | null }>(PUBLIC_KEY);
      return data.pushPublicKey ?? null;
    } catch {
      return null;
    }
  }

  /** The browser's own subscription, or `null`. Guarded: `subscription` is `NEVER` without a worker. */
  private async readSubscription(): Promise<BrowserSubscription | null> {
    if (!this.swPush.isEnabled) return null;
    try {
      const subscription = await firstValueFrom(this.swPush.subscription);
      return subscription === null ? null : (subscription.toJSON() as BrowserSubscription);
    } catch {
      return null;
    }
  }
}

/** `Notification.permission`, or `unsupported` when the API does not exist at all. */
function readPermission(): PushFacts['permission'] {
  if (typeof globalThis.Notification === 'undefined') return 'unsupported';
  const permission = globalThis.Notification.permission;
  return permission === 'default' || permission === 'granted' || permission === 'denied'
    ? permission
    : 'unsupported';
}

const PUBLIC_KEY = /* GraphQL */ `
  query PushPublicKey {
    pushPublicKey
  }
`;

const REGISTER_SUBSCRIPTION = /* GraphQL */ `
  mutation RegisterPushSubscription($input: PushSubscriptionInput!) {
    registerPushSubscription(input: $input) {
      id
      endpoint
      lastSeenAt
    }
  }
`;

const DELETE_SUBSCRIPTION = /* GraphQL */ `
  mutation DeletePushSubscription($endpoint: String!) {
    deletePushSubscription(endpoint: $endpoint)
  }
`;
