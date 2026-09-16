import type { TranslationKey } from '../i18n/translations';

/**
 * Push notifications, as a set of decisions rather than a component.
 *
 * F-22's client half (task 4.2.5). What lives here is the part that is **wrong silently**: whether
 * this device can receive a push at all, and what to tell the user about it. A screen that offers a
 * "Turn on notifications" button on a device where `PushManager` does not exist, or that promises push
 * to an iPhone in a Safari tab, is worse than a screen that says nothing — the user believes they are
 * covered and stops checking the app.
 *
 * ## The states come from docs/07 §4.8, which is the platform truth
 *
 * iOS is the reason this is a state machine and not a boolean:
 *
 * - **Web Push needs iOS 16.4+**, and
 * - it works **only in a PWA added to the Home Screen** — in a Safari tab `PushManager` does not exist,
 *   so "your browser does not support this" would be true and useless. The actionable sentence is
 *   *install it*.
 * - `Notification.requestPermission()` **must come from a user gesture**, so the prompt is behind the
 *   explanation's own button and never on load (ADR-028 decision 5).
 * - `badge`/`renotify` are inconsistent, so nothing here depends on them.
 *
 * The precedence below is deliberate and is asserted in `push.view.spec.ts`.
 *
 * @module apps/web/src/app/core/push
 */

/** What this device can do, in the order the panel renders it. */
export type PushState =
  /** No `Notification` API at all: nothing to ask for and nothing to say about installing. */
  | 'UNSUPPORTED'
  /** The deployment has no VAPID key pair (`pushPublicKey` is null), so no device can receive one. */
  | 'SERVER_OFF'
  /** iOS/iPadOS outside an installed PWA, where `PushManager` is absent by design. */
  | 'IOS_INSTALL'
  /** Permission was denied. It cannot be re-prompted; only the browser's site settings undo it. */
  | 'BLOCKED'
  /** A browser subscription exists, so this device receives pushes. */
  | 'SUBSCRIBED'
  /** Everything is in place; the user has not said yes yet. */
  | 'READY';

/** The facts the state is derived from. All of them are environment reads, none of them are stored. */
export interface PushFacts {
  /** `SwPush.isEnabled`: false in dev (`provideServiceWorker(…, { enabled: false })`) and without a worker. */
  readonly serviceWorkerEnabled: boolean;
  /** `'PushManager' in window` — absent on iOS in a tab, and on browsers with no push support. */
  readonly pushManagerSupported: boolean;
  /** `pushPublicKey` from the API. `null` means this deployment has no VAPID pair (ADR-028 decision 2). */
  readonly serverPublicKey: string | null;
  /** `Notification.permission`, or `unsupported` when there is no `Notification` API. */
  readonly permission: 'default' | 'granted' | 'denied' | 'unsupported';
  /** Whether this browser already holds a push subscription for the origin. */
  readonly hasSubscription: boolean;
  /** iOS or iPadOS (including iPadOS pretending to be a Mac, which is why the touch count is a fact). */
  readonly ios: boolean;
  /** Running as an installed PWA, where iOS allows push at all. */
  readonly standalone: boolean;
}

/**
 * Which state this device is in.
 *
 * The order is the substance: **platform first where the platform is the actionable truth** (iOS in a
 * tab is `IOS_INSTALL`, not `UNSUPPORTED`), a missing server key before any device-specific advice
 * (nothing the user does helps), then permission, then the subscription.
 */
export function pushState(facts: PushFacts): PushState {
  if (facts.permission === 'unsupported') return 'UNSUPPORTED';
  if (facts.serverPublicKey === null) return 'SERVER_OFF';
  // iOS in a tab: `PushManager` is missing, and "install it" is the sentence that helps.
  if (facts.ios && !facts.standalone) return 'IOS_INSTALL';
  if (!facts.serviceWorkerEnabled || !facts.pushManagerSupported) return 'UNSUPPORTED';
  if (facts.permission === 'denied') return 'BLOCKED';
  if (facts.hasSubscription) return 'SUBSCRIBED';
  return 'READY';
}

/** The one sentence that explains the state. Never a promise the platform cannot keep. */
export function pushMessageKey(state: PushState): TranslationKey {
  switch (state) {
    case 'UNSUPPORTED':
      return 'notifications.push.unsupported';
    case 'SERVER_OFF':
      return 'notifications.push.serverOff';
    case 'IOS_INSTALL':
      return 'notifications.push.iosInstall';
    case 'BLOCKED':
      return 'notifications.push.blocked';
    case 'SUBSCRIBED':
      return 'notifications.push.subscribed';
    case 'READY':
      return 'notifications.push.explain';
  }
}

/** The label of the panel's one button, or `null` when there is nothing the user can press. */
export function pushActionKey(state: PushState): TranslationKey | null {
  if (state === 'READY') return 'notifications.push.enable';
  if (state === 'SUBSCRIBED') return 'notifications.push.disable';
  return null;
}

/**
 * Whether to point at email instead.
 *
 * docs/07 §4.8's binding consequence (2): *"a user whose subscription cannot be established gets a
 * one-time offer"*. Email is the channel that always works, so the states where push is impossible
 * offer it — not `READY` (the user can simply enable push) and not `SUBSCRIBED`.
 */
export function offersEmailFallback(state: PushState): boolean {
  return state === 'UNSUPPORTED' || state === 'SERVER_OFF' || state === 'IOS_INSTALL' || state === 'BLOCKED';
}

/**
 * iOS or iPadOS, from the user agent and the touch count.
 *
 * `maxTouchPoints > 1` is not decoration: iPadOS 13+ reports a macOS user agent, so a UA check alone
 * would offer the enable button to an iPad in Safari and then fail at `PushManager`.
 */
export function isIos(userAgent: string, maxTouchPoints: number, platform: string): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return platform === 'MacIntel' && maxTouchPoints > 1;
}

/** Installed-PWA detection: iOS uses `navigator.standalone`, everyone else a display-mode query. */
export function isStandalone(iosStandalone: boolean, displayModeStandalone: boolean): boolean {
  return iosStandalone || displayModeStandalone;
}

/** `PushSubscription.toJSON()`, as far as the API needs it. */
export interface BrowserSubscription {
  readonly endpoint: string;
  readonly keys?: { readonly p256dh?: string; readonly auth?: string };
}

/**
 * The API's `PushSubscriptionInput`.
 *
 * Returns `null` when the browser gave no usable key material — the API requires both keys, and
 * sending empty strings would store a subscription that no push service can use and that `dispatch`
 * would count as a live endpoint. A sub-without-keys is a state worth refusing rather than storing.
 */
export function subscriptionInput(
  subscription: BrowserSubscription,
  userAgent: string,
): { endpoint: string; p256dh: string; auth: string; userAgent: string } | null {
  const p256dh = subscription.keys?.p256dh ?? '';
  const auth = subscription.keys?.auth ?? '';
  if (subscription.endpoint === '' || p256dh === '' || auth === '') return null;
  return { endpoint: subscription.endpoint, p256dh, auth, userAgent };
}
