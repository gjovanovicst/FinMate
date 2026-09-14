import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { AuthStore } from '../../core/auth/auth.store';
import { I18nService } from '../../core/i18n/i18n.service';

/**
 * Sign-up.
 *
 * The password rule mirrors `PasswordService.MIN_PASSWORD_LENGTH` (12) on the server. Duplicating a
 * policy is normally a smell, but a client that only learns the rule after a round trip is worse —
 * and the server still enforces it, so this is a UX convenience, never the control.
 */
const MIN_PASSWORD_LENGTH = 12;

@Component({
  selector: 'fm-sign-up',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <section class="auth">
      <h1 class="auth__title">{{ i18n.t('signUp.title') }}</h1>
      <p class="auth__hint">{{ i18n.t('signUp.intro') }}</p>

      <form class="auth__form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <label class="field">
          <span class="field__label">{{ i18n.t('signUp.displayName') }}</span>
          <input class="field__input" type="text" formControlName="displayName" autocomplete="name" required />
        </label>

        <label class="field">
          <span class="field__label">{{ i18n.t('signUp.email') }}</span>
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
          <span class="field__label">{{ i18n.t('signUp.password') }}</span>
          <input
            class="field__input"
            type="password"
            formControlName="password"
            autocomplete="new-password"
            required
          />
          <span class="field__hint">{{ i18n.t('signUp.passwordHint', { min: minLength }) }}</span>
        </label>

        @if (error()) {
          <p class="auth__error" role="alert">{{ error() }}</p>
        }

        <button class="auth__submit" type="submit" [disabled]="submitting()">
          {{ submitting() ? i18n.t('signUp.submitting') : i18n.t('signUp.submit') }}
        </button>
      </form>

      <p class="auth__alt">{{ i18n.t('signUp.haveAccount') }} <a routerLink="/sign-in">{{ i18n.t('signUp.signIn') }}</a></p>
    </section>
  `,
  styles: [
    `
      .auth {
        max-inline-size: 380px;
        margin-inline: auto;
        padding-block-start: var(--space-6);
      }
      .auth__title {
        font-size: var(--text-2xl);
        margin-block: 0 var(--space-2);
      }
      .auth__hint {
        margin-block: 0 var(--space-5);
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .auth__form {
        display: grid;
        gap: var(--space-4);
      }
      .field {
        display: grid;
        gap: var(--space-1);
      }
      .field__label {
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .field__hint {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .field__input {
        padding: var(--space-3);
        font: inherit;
        color: var(--color-text);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .auth__error {
        margin: 0;
        color: var(--color-danger);
        font-size: var(--text-sm);
      }
      .auth__submit {
        padding: var(--space-3);
        font: inherit;
        font-weight: 600;
        color: var(--color-primary-contrast);
        background: var(--color-primary);
        border: none;
        border-radius: var(--radius-md);
        cursor: pointer;
      }
      .auth__submit:hover:not(:disabled) {
        background: var(--color-primary-hover);
      }
      .auth__submit:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .auth__alt {
        margin-block-start: var(--space-5);
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
    `,
  ],
})
export class SignUpComponent {
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);

  readonly minLength = MIN_PASSWORD_LENGTH;

  readonly form = this.fb.nonNullable.group({
    displayName: ['', [Validators.required, Validators.maxLength(80)]],
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH)]],
  });

  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);

  async submit(): Promise<void> {
    if (this.form.invalid || this.submitting()) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.error.set(null);
    try {
      const { email, password, displayName } = this.form.getRawValue();
      await this.auth.signUp(email, password, displayName);
      await this.router.navigateByUrl('/');
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.submitting.set(false);
    }
  }
}
