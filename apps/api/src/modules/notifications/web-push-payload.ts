/**
 * The web-push payload — ADR-028 decision 4 **as amended in 4.2.5**, threat T-09 (docs/08 §2.3).
 *
 * ## The lock-screen rule is structural, not editorial
 *
 * A push payload is rendered by the operating system on a **locked** device, which is the least
 * private surface this product has. T-09 forbids amounts and Merchant/Counterparty names there, and
 * the way this file enforces that is by having no field an amount could travel in:
 *
 * ```
 * {
 *   notificationId, kind, deepLink,
 *   notification: { title, data: { onActionClick: { default: { operation, url } } } }
 * }
 * ```
 *
 * `kind` selects a **generic** sentence the client already has in its i18n catalogue
 * (*"Novo obaveštenje"* / *"You have a new alert"*); the detail is read in the app. There is no
 * figure and no free text in the payload, so a future copy change cannot leak one — the `title`/`body`
 * a notification row carries are deliberately **not read** here even though the sender has them.
 *
 * ## Why the `notification` block exists at all (ADR-028's amendment)
 *
 * `@angular/service-worker`'s `ngsw-worker.js` handles a `push` event in `Driver.handlePush` by
 * broadcasting the payload to any open client and then —
 *
 * ```js
 * if (!data.notification || !data.notification.title) return;
 * await this.scope.registration.showNotification(data.notification.title, options);
 * ```
 *
 * — so a payload without `notification.title` produces **no notification at all** when the app is
 * closed, which is the only moment push exists for. The title it shows is the payload's, because the
 * SPA (and its catalogue) is not running. The only text this builder therefore emits is the **brand**,
 * `APP_NAME`, which is not a sentence, needs no translation and is already a configuration value; a
 * per-kind sentence would move i18n into the API and put copy on a lock screen no catalogue reviews
 * (ADR-028's rejected alternative (c)). `data.onActionClick.default` is how ngsw's own
 * `Driver.handleClick` opens the deep link.
 *
 * A unit test (`web-push-payload.spec.ts`) hands this builder a row whose title and body are full of
 * amounts and names and asserts that **every string in the serialised payload** is one of the four
 * things this file decides — the id, the kind, the deep link, or the brand — which is the only
 * assertion that survives somebody adding a field later.
 *
 * @module apps/api/src/modules/notifications
 */

/** The `kind` a row with no insight behind it falls back to. The client renders its generic sentence. */
export const GENERIC_PUSH_KIND = 'GENERIC';

/** `Notification.data.onActionClick[action]` — the shape `ngsw-worker.js` reads on a click. */
export interface PushActionClick {
  readonly operation: 'navigateLastFocusedOrOpen';
  readonly url: string;
}

/** Exactly what crosses the wire. Adding a field here is a privacy decision, not a convenience. */
export interface WebPushPayload {
  readonly notificationId: string;
  readonly kind: string;
  readonly deepLink: string;
  /** The block `ngsw-worker.js` needs before it will show anything (see the module doc). */
  readonly notification: {
    /** The brand, never the row's copy. */
    readonly title: string;
    readonly data: { readonly onActionClick: Record<'default', PushActionClick> };
  };
}

/**
 * The row fields the builder is allowed to see.
 *
 * `title` and `body` are part of the shape **so the test can prove they are ignored**: the dispatch
 * path has them, and the payload must not.
 */
export interface WebPushPayloadSource {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** The insight kind behind the row, when there is one (`BUDGET_PACE`, `RECURRING_DUE`, …). */
  readonly insightKind: string | null;
}

/**
 * Serialise the payload a push service will carry.
 *
 * This is the **only** thing handed to a {@link WebPushSender}, and it is a string rather than an
 * object so a caller cannot append to it on the way out. `appName` is `APP_NAME` from config
 * (ADR-014: the brand is never hardcoded), and it is the only text that reaches a lock screen.
 */
export function buildWebPushPayload(row: WebPushPayloadSource, appName: string): string {
  const kind = row.insightKind ?? GENERIC_PUSH_KIND;
  const deepLink = pushDeepLink(kind);
  const payload: WebPushPayload = {
    notificationId: row.id,
    kind,
    deepLink,
    notification: {
      title: appName,
      data: {
        // ngsw's `handleClick` reads exactly this path and, for `navigateLastFocusedOrOpen`, focuses
        // the app if it is open and opens this URL if it is not.
        onActionClick: {
          default: { operation: 'navigateLastFocusedOrOpen', url: deepLink },
        },
      },
    },
  };
  return JSON.stringify(payload);
}

/**
 * Where tapping the notification takes the user.
 *
 * The mapping is deliberately the **same** as the web client's own `deepLinkFor`
 * (`features/notifications/notifications.view.ts`) for every insight kind, including its fallback: an
 * unknown kind goes to `/transactions`, which is the client's existing choice and not something the
 * server should silently second-guess. The two differ in exactly one case, and for a reason the client
 * does not have — a row with **no insight at all** (`GENERIC_PUSH_KIND`, i.e. `insightKind === null`),
 * where the client renders no link but a service worker has to open *something*; it opens the centre,
 * which is where that row is listed.
 *
 * Two mappings for one navigation is a divergence waiting to happen, so 4.2.5 — the task that ships the
 * client half — reconciles them, and any change here changes `deepLinkFor` in the same commit.
 */
export function pushDeepLink(kind: string): string {
  switch (kind) {
    case 'BUDGET_PACE':
      return '/budgets';
    case 'CATEGORY_SPIKE':
    case 'UNUSUAL_SPEND':
      return '/transactions';
    case 'RECURRING_DUE':
      return '/recurring';
    case GENERIC_PUSH_KIND:
      return '/notifications';
    default:
      return '/transactions';
  }
}
