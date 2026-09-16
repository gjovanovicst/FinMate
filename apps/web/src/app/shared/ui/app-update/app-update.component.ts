import { ChangeDetectionStrategy, Component, DOCUMENT, inject, signal } from '@angular/core';
import { SwUpdate } from '@angular/service-worker';

import { I18nService } from '../../../core/i18n/i18n.service';

/**
 * What the banner is telling the user, or `null` when there is nothing to say.
 *
 * Two states, and they are different sentences on purpose: `ready` means the app is *running* an older
 * build and a newer one is installed, `broken` means the shell's own cache cannot serve a file at all —
 * which is not "an update is available", it is "this page is missing something".
 */
export type UpdateNotice = 'ready' | 'broken';

/**
 * The app-shell update banner — F-26, ADR-024.
 *
 * ## Why it exists
 *
 * A service worker keeps serving the build it cached, so without this the only way a fix reaches a user
 * with an open tab is for them to close every tab. ADR-024 settled how that interacts with a half-typed
 * capture: the banner is **non-dismissible** (docs/08 §12 wants a *forced* flow rather than an
 * indefinitely stale shell) and the activation happens **only on the click** (docs/10 §8.3 wants a
 * *prompt* rather than a swap under an active capture). There is no timer, no `skipWaiting` and no
 * automatic reload anywhere in this component — `activate()` is the only path, and the user is the only
 * one who can take it.
 *
 * ## Why it is not a dismissible toast
 *
 * A close button turns "you are running an old version" into a decision the user has to remember they
 * made. The banner stays until the reload it asks for; the cost is one line of chrome in the corner of
 * the screen, and the benefit is that a broken build cannot be parked for weeks.
 *
 * ## What it deliberately does not do
 *
 * It does not call `checkForUpdate()`: `SwUpdate` already checks on registration and on navigation, and
 * a manual poll would only add requests. It does not show a version hash or a build time — nothing in
 * docs/02 §2.2 asks for one, and a hash is not a fact a person can use. It does not gate on offline:
 * `activateUpdate()` needs the new version already installed, so an offline client cannot be in
 * `ready` in the first place.
 *
 * @module apps/web/src/app/shared/ui/app-update
 */
@Component({
  selector: 'fm-app-update',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (notice(); as state) {
      <!-- role="status" and not "alert": an available update is not an emergency, and interrupting a
           screen reader mid-sentence for it would be worse than the stale shell. -->
      <div class="update" role="status">
        <p class="update__text">
          {{ i18n.t(state === 'broken' ? 'app.update.broken' : 'app.update.available') }}
        </p>
        <button type="button" class="update__action" [disabled]="applying()" (click)="activate()">
          {{ applying() ? i18n.t('app.update.reloading') : i18n.t('app.update.reload') }}
        </button>
      </div>
    }
  `,
  styles: `
    .update {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2) var(--space-4);
      margin-block-end: var(--space-3);
      padding: var(--space-2) var(--space-3);
      border-radius: var(--radius-md);
      border-inline-start: 3px solid var(--color-primary);
      background: color-mix(in srgb, var(--color-primary) 12%, transparent);
      /* The copy wraps rather than truncating: a 320 px screen shows both lines and the button. */
      min-inline-size: 0;
    }
    .update__text {
      margin: 0;
      font-size: var(--text-sm);
      min-inline-size: 0;
    }
    .update__action {
      flex: none;
      padding: var(--space-1) var(--space-3);
      border: 1px solid var(--color-primary);
      border-radius: var(--radius-sm);
      background: var(--color-primary);
      color: var(--color-primary-contrast);
      font-size: var(--text-sm);
      cursor: pointer;
    }
    .update__action:disabled {
      opacity: 0.6;
      cursor: default;
    }
  `,
})
export class AppUpdateComponent {
  private readonly sw = inject(SwUpdate);
  /**
   * The injected document, not the global one: Angular's `DOCUMENT` token is the framework's own seam
   * over the DOM, so a spec can hand this component a fake whose `location.reload` is observable. (It
   * also has to be — jsdom defines the real `location.reload` as a non-configurable stub that only logs
   * "Not implemented: navigation", and the reload is the one behaviour this component's guarantee
   * rests on. Angular's `Location` service is not an option: it has no `reload()`.)
   */
  private readonly document = inject(DOCUMENT);
  protected readonly i18n = inject(I18nService);

  readonly notice = signal<UpdateNotice | null>(null);
  readonly applying = signal(false);

  constructor() {
    // `versionUpdates` is a hot stream of everything the worker does; only VERSION_READY means a new
    // build is installed and waiting for this client. Anything else is recorded nowhere on purpose —
    // VERSION_INSTALLATION_FAILED is a deployment fact, not something a user can act on.
    this.sw.versionUpdates.subscribe((event) => {
      if (event.type === 'VERSION_READY') this.notice.set('ready');
    });

    // A cache that cannot serve a file it needs is not recoverable from inside the running app: the
    // only fix is a reload, which re-installs the version. Saying so is better than a blank screen.
    this.sw.unrecoverable.subscribe(() => this.notice.set('broken'));
  }

  /**
   * Act on the notice.
   *
   * The two states take different paths on purpose. `ready` asks the **worker** to activate the version
   * it has already installed, then reloads into it. `broken` cannot — the running version's cache is
   * missing a file it needs, and there may be no newer version at all — so the only thing that can fix
   * it is a plain reload, which re-installs and re-fetches.
   *
   * The reload is explicit rather than a side effect of `activateUpdate()`: the promise resolves once
   * the *worker* has activated, and the page still has to be reloaded to run the new bundle. A refused
   * activation (the worker was replaced again underneath us) leaves the banner up, which is correct —
   * there is still a newer version than the one being served.
   */
  async activate(): Promise<void> {
    if (this.applying()) return;
    if (this.notice() === 'broken') {
      this.applying.set(true);
      this.document.defaultView?.location.reload();
      return;
    }

    this.applying.set(true);
    try {
      await this.sw.activateUpdate();
    } catch {
      // Nothing to tell the user beyond what the banner already says. The reload below is deliberately
      // not attempted: if activation failed the page would come back on the same stale version.
      this.applying.set(false);
      return;
    }
    this.document.defaultView?.location.reload();
  }
}
