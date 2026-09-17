import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { AUTH_STYLES } from './auth.styles';

/** What the exchange with the API produced. `missing` never leaves the browser. */
type VerifyState = 'working' | 'verified' | 'failed' | 'missing';

/**
 * Email confirmation — F-28, task 5.8.
 *
 * The link in the mail carries `?token=…`, so this screen has one job: hand the token to
 * `POST /auth/verify-email` exactly once and report what came back. There is no form.
 *
 * ## Exactly once, on a single-use token
 *
 * The API consumes the token on the first successful call, so a second POST with the same value is a
 * `VALIDATION_FAILED` — and a screen that retried on a re-render would flip a success into a failure in
 * front of the user. The subscription therefore remembers **which tokens it has already sent**. The
 * token itself comes from `queryParamMap` (replayed on subscribe) rather than a router-bound `input()`,
 * which the router writes `undefined` for an absent parameter — the first live run of the sibling reset
 * screen threw on exactly that (docs/15).
 *
 * ## What "confirmed" means today — and what it does not
 *
 * ⚠️ `users.email_verified_at` is written by this flow and **read by nothing**: logging in does not
 * require it, and no feature is gated on it (docs/09's 5.8 row records the finding). So the failure copy
 * says that plainly — a dead link costs the user nothing yet — rather than implying they are locked out.
 * Deciding what verification *should* gate is a product decision, and it is scheduled, not assumed here.
 *
 * @module apps/web/src/app/features/auth
 */
@Component({
  selector: 'fm-verify-email',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section class="auth">
      @switch (state()) {
        @case ('working') {
          <h1 class="auth__title">{{ i18n.t('verify.title') }}</h1>
          <!-- role="status", not alert: the exchange is progress, not a failure. -->
          <p class="auth__hint" role="status">{{ i18n.t('verify.working') }}</p>
        }
        @case ('verified') {
          <h1 class="auth__title">{{ i18n.t('verify.doneTitle') }}</h1>
          <p class="auth__hint">{{ i18n.t('verify.done') }}</p>
          <p class="auth__alt"><a routerLink="/">{{ i18n.t('verify.toApp') }}</a></p>
        }
        @case ('failed') {
          <h1 class="auth__title">{{ i18n.t('verify.failedTitle') }}</h1>
          <p class="auth__hint" role="alert">{{ i18n.t('verify.failed') }}</p>
          <p class="auth__alt">
            <a routerLink="/sign-in">{{ i18n.t('verify.toSignIn') }}</a>
          </p>
        }
        @default {
          <h1 class="auth__title">{{ i18n.t('verify.failedTitle') }}</h1>
          <p class="auth__hint" role="alert">{{ i18n.t('verify.missing') }}</p>
          <p class="auth__alt">
            <a routerLink="/sign-in">{{ i18n.t('verify.toSignIn') }}</a>
          </p>
        }
      }
    </section>
  `,
  styles: [AUTH_STYLES],
})
export class VerifyEmailComponent {
  readonly i18n = inject(I18nService);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthStore);

  /** `?token=…` from the emailed link, as read from the URL. */
  readonly token = signal('');

  readonly state = signal<VerifyState>('working');

  /**
   * The tokens this component has already sent.
   *
   * A `Set` and not a single "last token": the subscription runs again whenever the URL changes, and a
   * token that was sent once must never be sent again even if the URL returns to it — the value is
   * single-use, so a second POST would report a failure for an address that is already confirmed.
   */
  private readonly sent = new Set<string>();

  constructor() {
    // `queryParamMap` replays the current value on subscribe, so this one path covers the first read and
    // any later change of the URL.
    this.route.queryParamMap.subscribe((params) => {
      const token = (params.get('token') ?? '').trim();
      this.token.set(token);
      if (token === '') {
        // Nothing to exchange. Calling the API with an empty token would only produce a failure that
        // says less than the sentence this state already has.
        this.state.set('missing');
        return;
      }
      if (this.sent.has(token)) return;
      this.sent.add(token);
      void this.verify(token);
    });
  }

  private async verify(token: string): Promise<void> {
    try {
      await this.auth.verifyEmail(token);
      this.state.set('verified');
    } catch {
      // One message for unknown, used and expired — the API does not distinguish them on purpose, and
      // this screen has nothing to add: the address is confirmed or it is not.
      this.state.set('failed');
    }
  }
}
