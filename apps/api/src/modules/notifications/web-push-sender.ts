import * as webpush from 'web-push';

import type { AppConfig } from '../../config/config';

/**
 * The web-push sender seam — ADR-028, task 4.2.9.
 *
 * ## Why a seam with an inert default
 *
 * Push is the one delivery channel whose transport is a **third party by construction**: the endpoint,
 * the timing and the count pass through Apple's, Google's or Mozilla's push service, even though the
 * payload itself is end-to-end encrypted (RFC 8291). A deployment that has not configured VAPID keys
 * must therefore be able to boot, run the whole dispatch path, and *see* that nothing was delivered.
 *
 * `UNCONFIGURED_WEB_PUSH` is that honest default, exactly as `UNCONFIGURED_OBJECT_STORAGE` (ADR-018),
 * `UNCONFIGURED_SCANNER` (ADR-023) and `UNCONFIGURED_EMBEDDINGS` (ADR-021) are for their seams:
 * `available = false`, a reason a human can act on, and no throw at construction. The dispatch path
 * leaves rows `QUEUED` and reports them skipped with that reason rather than pretending they were sent
 * (ADR-028 decision 2).
 *
 * The implementation is `web-push`, the protocol's own library: a few hundred readable lines of
 * RFC 8291 + VAPID, not a vendor platform with an account, a dashboard and a second copy of the data
 * (ADR-028 decision 1).
 *
 * ## `SENT` means "accepted", so a dead endpoint is not an error
 *
 * The push service answers `404`/`410` for an endpoint that no longer exists. That is not a delivery
 * failure to retry — the subscription is gone — so the caller prunes the row (ADR-028 decision 3) and
 * a uniform {@link WebPushSendError} carries the HTTP status so the decision lives in one place.
 *
 * @module apps/api/src/modules/notifications
 */

/** DI token. Nothing outside this module imports a sender implementation. */
export const WEB_PUSH = Symbol('WEB_PUSH');

/** A stored subscription, in the shape RFC 8291 needs. `keys` is the browser's public key material. */
export interface WebPushSubscription {
  readonly endpoint: string;
  readonly keys: {
    readonly p256dh: string;
    readonly auth: string;
  };
}

/** Every rejection from a sender, with the push service's HTTP status when there was one. */
export class WebPushSendError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
  ) {
    super(message);
    this.name = 'WebPushSendError';
  }
}

export interface WebPushSender {
  /** `false` when no VAPID key pair is configured; callers must not attempt a send. */
  readonly available: boolean;
  readonly unavailableReason: string | null;
  /**
   * Resolves once the push service **accepted** the message — never "the user saw it", because push
   * has no receipt (ADR-028 decision 6). Rejects with {@link WebPushSendError}.
   */
  sendNotification(subscription: WebPushSubscription, payload: string): Promise<void>;
}

export const WEB_PUSH_UNCONFIGURED_REASON =
  'Web push is not configured: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (ADR-028). Generate a pair ' +
  'once with `npx web-push generate-vapid-keys`; until then notification rows stay QUEUED and nothing ' +
  'is delivered to a browser.';

/** The sender a deployment without VAPID keys gets. Never throws at construction. */
export class UnconfiguredWebPushSender implements WebPushSender {
  readonly available = false;
  readonly unavailableReason = WEB_PUSH_UNCONFIGURED_REASON;

  async sendNotification(): Promise<void> {
    throw new WebPushSendError(this.unavailableReason, null);
  }
}

export const UNCONFIGURED_WEB_PUSH: WebPushSender = new UnconfiguredWebPushSender();

/** The real sender: RFC 8291 payload encryption and VAPID, through `web-push`. */
export class RfcWebPushSender implements WebPushSender {
  readonly available = true;
  readonly unavailableReason = null;

  constructor(
    private readonly subject: string,
    private readonly publicKey: string,
    private readonly privateKey: string,
  ) {}

  async sendNotification(subscription: WebPushSubscription, payload: string): Promise<void> {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
        },
        payload,
        // Per-call rather than `setVapidDetails`, which mutates module-global state: two senders in
        // one process (a test, or a rotation) would otherwise silently share the last keys set.
        {
          vapidDetails: {
            subject: this.subject,
            publicKey: this.publicKey,
            privateKey: this.privateKey,
          },
        },
      );
    } catch (error) {
      throw toSendError(error, subscription.endpoint);
    }
  }
}

/**
 * `true` when the push service says the subscription is dead.
 *
 * `404`/`410` is the whole point of carrying the status through the seam: the caller soft-deletes the
 * row instead of failing the notification, because a vanished endpoint is not a delivery problem.
 */
export function isGoneError(error: unknown): boolean {
  return (
    error instanceof WebPushSendError && (error.statusCode === 404 || error.statusCode === 410)
  );
}

/** `web-push` rejects with a `WebPushError` carrying `statusCode`; a socket error carries none. */
function toSendError(error: unknown, endpoint: string): WebPushSendError {
  if (error instanceof WebPushSendError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new WebPushSendError(
    `Push service rejected the notification for ${endpoint}: ${detail}`,
    readStatusCode(error),
  );
}

function readStatusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return null;
  const value = (error as { readonly statusCode?: unknown }).statusCode;
  return typeof value === 'number' ? value : null;
}

/**
 * The sender this deployment gets: a real one only when **both** VAPID keys are present.
 *
 * Partial configuration is treated as none, for the same reason `makeObjectStorage` does it: a sender
 * with a public key and no private key can only produce requests every push service will reject.
 */
export function makeWebPushSender(config: AppConfig): WebPushSender {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = config;
  if (VAPID_PUBLIC_KEY === undefined || VAPID_PRIVATE_KEY === undefined) {
    return UNCONFIGURED_WEB_PUSH;
  }
  return new RfcWebPushSender(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}
