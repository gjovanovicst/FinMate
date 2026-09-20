import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { ErrorMessageService } from '../../../core/api/error-message.service';
import { AuthStore } from '../../../core/auth/auth.store';
import { I18nService } from '../../../core/i18n/i18n.service';

/**
 * The unconfirmed-address banner (docs/06 §2, task 0.6.5).
 *
 * It renders **only when this deployment requires a confirmed address and this account's is not** —
 * which is the one situation where the state is blocking rather than advisory. An earlier idea was to
 * show it whenever `emailVerified` was false, and that is wrong twice: a deployment that does not
 * gate on verification would nag every account for nothing, and the demo Household, whose seeded user
 * has never clicked a link, would carry a banner in every screenshot of the product.
 *
 * The re-send is the whole point of the banner: before it, an expired `VERIFY_EMAIL` token had no
 * in-app recovery (docs/09's 5.8 row recorded the gap), so a blocked account was a dead end.
 *
 * @module apps/web/src/app/shared/ui/verify-banner
 */
@Component({
  selector: 'fm-verify-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div class="banner" role="status">
        @if (sent()) {
          <p class="banner__text">{{ i18n.t('verify.bannerSent') }}</p>
        } @else {
          <p class="banner__text">{{ i18n.t('verify.banner', { email: email() }) }}</p>
          <button type="button" class="fm-btn" [disabled]="busy()" (click)="resend()">
            {{ busy() ? i18n.t('verify.resending') : i18n.t('verify.resend') }}
          </button>
        }
        @if (error(); as message) {
          <p class="banner__error" role="alert">{{ message }}</p>
        }
      </div>
    }
  `,
  styles: `
    .banner {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2) var(--space-3);
      margin-block-end: var(--space-3);
      padding: var(--space-3);
      border: 1px solid var(--color-warning, var(--color-border-strong));
      border-radius: var(--radius-md);
      background: var(--color-surface);
    }
    .banner__text {
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-text);
    }
    .banner__error {
      flex-basis: 100%;
      margin: 0;
      font-size: var(--text-sm);
      color: var(--color-danger);
    }
  `,
})
export class VerifyBannerComponent {
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthStore);
  private readonly errors = inject(ErrorMessageService);

  readonly busy = signal(false);
  readonly sent = signal(false);
  readonly error = signal<string | null>(null);

  /** The address the link goes to, which is the session's — the API accepts no body. */
  readonly email = computed(() => this.auth.session()?.email ?? '');

  readonly visible = computed(() => {
    const session = this.auth.session();
    return (
      session !== null && session.emailVerificationRequired && !session.emailVerified
    );
  });

  async resend(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.resendVerification();
      this.sent.set(true);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }
}
