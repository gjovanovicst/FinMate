import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { suggestCurrencyForLocale } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { AuthStore } from '../../core/auth/auth.store';
import { currencyOptionLabel, SUPPORTED_CURRENCIES } from '../../core/i18n/currency-names';
import { I18nService } from '../../core/i18n/i18n.service';
import { BrandComponent } from '../../shared/ui/brand/brand.component';
import { AUTH_STYLES } from './auth.styles';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-policy';

/**
 * Sign-up.
 *
 * The password rule lives in `password-policy.ts` (it mirrors `PasswordService` on the API) and the
 * form styles in `auth.styles.ts`, so this screen and the reset screen cannot drift about either.
 */

@Component({
  selector: 'fm-sign-up',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, BrandComponent],
  template: `
    <section class="auth">
      <div class="auth__brand"><fm-brand size="lg" [tagline]="true" /></div>
      <h1 class="auth__title">{{ i18n.t('signUp.title') }}</h1>
      <p class="auth__hint">{{ i18n.t('signUp.intro') }}</p>

      <!-- Same reason as sign-in: the destination is a lazy route, so the form is replaced for the whole
           of the submit rather than left on screen while the dashboard's chunk loads. -->
      @if (submitting()) {
        <p class="auth__progress" role="status">{{ i18n.t('signUp.submitting') }}</p>
      } @else {
        <form class="auth__form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
          <label class="field">
            <span class="field__label">{{ i18n.t('signUp.displayName') }}</span>
            <input
              class="field__input"
              type="text"
              formControlName="displayName"
              autocomplete="name"
              required
            />
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

          <!-- The ledger currency (ADR-045). It used to be the literal 'RSD' on the server, so a reader
               anywhere else was given a dinar ledger without ever being asked. Pre-filled from the
               browser's region and confirmed here, because a wrong ledger currency is not a setting
               people go looking for — it silently mislabels every amount they record. -->
          <label class="field">
            <span class="field__label">{{ i18n.t('signUp.currency') }}</span>
            <select class="field__input" formControlName="currency" required>
              @for (code of currencies; track code) {
                <option [value]="code" [selected]="code === form.controls.currency.value">
                  {{ optionLabel(code) }}
                </option>
              }
            </select>
            <span class="field__hint">{{ i18n.t('signUp.currencyHint') }}</span>
          </label>

          @if (error()) {
            <p class="auth__error" role="alert">{{ error() }}</p>
          }

          <button class="auth__submit" type="submit" [disabled]="submitting()">
            {{ submitting() ? i18n.t('signUp.submitting') : i18n.t('signUp.submit') }}
          </button>
        </form>

        <p class="auth__alt">
          {{ i18n.t('signUp.haveAccount') }}
          <a routerLink="/sign-in">{{ i18n.t('signUp.signIn') }}</a>
        </p>
      }
    </section>
  `,
  styles: [AUTH_STYLES],
})
export class SignUpComponent {
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);
  private readonly document = inject(DOCUMENT);

  readonly minLength = MIN_PASSWORD_LENGTH;

  /** Every currency a Household's ledger may be kept in (ADR-045). */
  readonly currencies = SUPPORTED_CURRENCIES;

  readonly form = this.fb.nonNullable.group({
    displayName: ['', [Validators.required, Validators.maxLength(80)]],
    email: ['', [Validators.required, Validators.email]],
    password: [
      '',
      [
        Validators.required,
        Validators.minLength(MIN_PASSWORD_LENGTH),
        Validators.maxLength(MAX_PASSWORD_LENGTH),
      ],
    ],
    // The **browser's** locale, deliberately, not the app's language: an English-speaking reader in
    // Germany should be offered EUR, and `i18n.tag()` would have followed the language picker instead.
    currency: [this.suggestedCurrency(), [Validators.required]],
  });

  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);

  /** `"EUR — Euro"`, named by CLDR in the reader's current language. */
  optionLabel(code: string): string {
    return currencyOptionLabel(code, this.i18n.tag());
  }

  async submit(): Promise<void> {
    if (this.form.invalid || this.submitting()) {
      this.form.markAllAsTouched();
      return;
    }

    this.submitting.set(true);
    this.error.set(null);
    try {
      const { email, password, displayName, currency } = this.form.getRawValue();
      await this.auth.signUp(email, password, displayName, this.i18n.tag(), currency);
      await this.router.navigateByUrl('/');
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.submitting.set(false);
    }
  }

  private suggestedCurrency(): string {
    return suggestCurrencyForLocale(this.document.defaultView?.navigator.language ?? null);
  }
}
