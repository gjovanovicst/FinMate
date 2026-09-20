import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { AuthStore } from '../../core/auth/auth.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { BrandComponent } from '../../shared/ui/brand/brand.component';
import { AUTH_STYLES } from './auth.styles';

/**
 * Sign-in, in **two steps when the account has a second factor** (ADR-041).
 *
 * The password form is unchanged for an account without one. With a factor on, the API answers a
 * challenge and sets **no cookie**, so this screen must not navigate: it swaps to a code form, and
 * only `verifyMfa` establishes the session. The challenge lives in `AuthStore`, not here, so a wrong
 * code does not cost the person their password.
 *
 * The code field accepts any of the three kinds — an authenticator code, an emailed code or a
 * recovery code — because the server decides which the challenge offered. The copy says so rather
 * than making the user choose a mode the client would have to keep in sync.
 */
@Component({
  selector: 'fm-sign-in',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, BrandComponent],
  template: `
    <section class="auth">
      <div class="auth__brand"><fm-brand size="lg" [tagline]="true" /></div>

      @if (step() === 'MFA') {
        <h1 class="auth__title">{{ i18n.t('signIn.mfaTitle') }}</h1>
        <p class="auth__hint">{{ mfaIntro() }}</p>

        @if (submitting()) {
          <p class="auth__progress" role="status">{{ i18n.t('signIn.mfaVerifying') }}</p>
        } @else {
          <form class="auth__form" [formGroup]="codeForm" (ngSubmit)="verify()" novalidate>
            <label class="field">
              <span class="field__label">{{ i18n.t('signIn.mfaCode') }}</span>
              <input
                class="field__input code"
                type="text"
                formControlName="code"
                inputmode="text"
                autocomplete="one-time-code"
                autocapitalize="characters"
                required
              />
            </label>

            <p class="auth__hint small">{{ i18n.t('signIn.mfaRecoveryHint') }}</p>

            @if (resent()) {
              <p class="auth__hint" role="status">{{ i18n.t('signIn.mfaResendSent') }}</p>
            }

            @if (error()) {
              <p class="auth__error" role="alert">{{ error() }}</p>
            }

            <button class="auth__submit" type="submit" [disabled]="codeForm.controls.code.value.trim() === ''">
              {{ i18n.t('signIn.mfaVerify') }}
            </button>
          </form>

          @if (mayResendEmail()) {
            <p class="auth__forgot">
              <button type="button" class="link" [disabled]="resending()" (click)="resend()">
                {{ resending() ? i18n.t('signIn.mfaResending') : i18n.t('signIn.mfaResend') }}
              </button>
            </p>
          }

          <p class="auth__alt">
            <button type="button" class="link" (click)="back()">{{ i18n.t('signIn.mfaBack') }}</button>
          </p>
        }
      } @else {
        <h1 class="auth__title">{{ i18n.t('signIn.title') }}</h1>

        <!-- The dashboard is a **lazy** route, and the router keeps this component mounted until its chunk
             and guards are ready — so a submit that succeeded would otherwise sit on screen as the login
             form, with only a disabled button to say anything was happening. The form is replaced for the
             whole of the submit (the credentials call *and* the navigation), and comes back with the error
             if either fails. -->
        @if (submitting()) {
          <p class="auth__progress" role="status">{{ i18n.t('signIn.submitting') }}</p>
        } @else {
          <form class="auth__form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
            <label class="field">
              <span class="field__label">{{ i18n.t('signIn.email') }}</span>
              <input
                class="field__input"
                type="email"
                formControlName="email"
                autocomplete="username"
                inputmode="email"
                required
              />
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('signIn.password') }}</span>
              <input
                class="field__input"
                type="password"
                formControlName="password"
                autocomplete="current-password"
                required
              />
            </label>

            <!-- The way into the recovery flow (F-28, task 5.8). It sits under the fields rather than in the
                 alternate-links row, because "I cannot get in" is part of signing in. -->
            <p class="auth__forgot">
              <a routerLink="/reset-password">{{ i18n.t('signIn.forgot') }}</a>
            </p>

            <!-- role="alert" so a screen reader announces the failure immediately rather than
                 leaving the user to discover it by re-reading the form. -->
            @if (error()) {
              <p class="auth__error" role="alert">{{ error() }}</p>
            }

            <button class="auth__submit" type="submit" [disabled]="submitting()">
              {{ submitting() ? i18n.t('signIn.submitting') : i18n.t('signIn.submit') }}
            </button>
          </form>

          <p class="auth__alt">
            {{ i18n.t('signIn.noAccount') }}
            <a routerLink="/sign-up">{{ i18n.t('signIn.register') }}</a>
          </p>
        }
      }
    </section>
  `,
  styles: [
    AUTH_STYLES,
    `
      /* The one field whose value is read character by character: wide tracking, and a monospace face
         so a recovery code's groups line up with what the server compares. */
      .code {
        font-family: var(--font-mono, monospace);
        letter-spacing: 0.15em;
      }
      .small {
        font-size: var(--text-sm);
      }
      .link {
        padding: 0;
        border: none;
        background: none;
        color: var(--color-primary-text);
        font: inherit;
        text-decoration: underline;
        cursor: pointer;
      }
      .link:disabled {
        opacity: 0.6;
        cursor: default;
      }
    `,
  ],
})
export class SignInComponent {
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  /**
   * The code step's own form, and it must be a **reactive** one.
   *
   * A bare `<form (ngSubmit)="…">` with no form directive is not a form Angular knows about: `ngSubmit`
   * is an output of `FormGroupDirective`/`NgForm`, so nothing emits it and nothing calls
   * `preventDefault()` either — the browser then does a **native GET submit** to the current URL, which
   * reloads the page and throws away the in-memory challenge and access token. Measured live before this
   * was fixed: clicking *Verify* navigated to `/sign-in?`, `POST /auth/login/mfa` was never sent, and the
   * password form came back (docs/15). Binding the control is what makes the directive cancel the native
   * submit, exactly as it does on the password step above.
   */
  readonly codeForm = this.fb.nonNullable.group({
    code: ['', [Validators.required]],
  });

  readonly step = signal<'PASSWORD' | 'MFA'>('PASSWORD');
  readonly submitting = signal(false);
  readonly resending = signal(false);
  readonly resent = signal(false);
  readonly error = signal<string | null>(null);

  private readonly challenge = this.auth.mfaChallenge;

  /** Whether the account also has the emailed factor, so "email me a code" is worth offering. */
  readonly mayResendEmail = computed(() => this.challenge()?.methods.includes('EMAIL') ?? false);

  /**
   * What the code is and where it came from.
   *
   * When email is the **only** factor there is nothing to open an app for, so the sentence names the
   * masked address the code went to. When an app is on, the sentence assumes the app and the hint
   * below the field covers the recovery code.
   */
  readonly mfaIntro = computed(() => {
    const challenge = this.challenge();
    if (challenge === null) return this.i18n.t('signIn.mfaIntroApp');
    if (challenge.methods.includes('TOTP')) return this.i18n.t('signIn.mfaIntroApp');
    return this.i18n.t('signIn.mfaIntroEmail', { email: challenge.emailHint });
  });

  async submit(): Promise<void> {
    if (this.form.invalid || this.submitting()) {
      // Marking touched surfaces the field-level messages on a failed submit.
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.error.set(null);
    try {
      const { email, password } = this.form.getRawValue();
      const outcome = await this.auth.signIn(email, password);
      if (outcome === 'MFA') {
        this.step.set('MFA');
        this.codeForm.reset({ code: '' });
        return;
      }
      await this.router.navigateByUrl('/');
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.submitting.set(false);
    }
  }

  async verify(): Promise<void> {
    const code = this.codeForm.getRawValue().code.trim();
    if (code === '' || this.submitting()) return;

    this.submitting.set(true);
    this.error.set(null);
    try {
      await this.auth.verifyMfa(code);
      await this.router.navigateByUrl('/');
    } catch (error) {
      // The challenge survives a wrong code, so the form stays and only the message changes.
      this.error.set(this.errors.for(error));
    } finally {
      this.submitting.set(false);
    }
  }

  async resend(): Promise<void> {
    if (this.resending()) return;
    this.resending.set(true);
    this.error.set(null);
    try {
      await this.auth.resendMfaCode();
      this.resent.set(true);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.resending.set(false);
    }
  }

  /** Go back to the password form. The half-finished challenge is dropped, not kept. */
  back(): void {
    this.auth.cancelMfa();
    this.step.set('PASSWORD');
    this.codeForm.reset({ code: '' });
    this.resent.set(false);
    this.error.set(null);
  }
}
