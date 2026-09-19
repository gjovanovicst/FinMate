import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { AuthStore } from '../../core/auth/auth.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { BrandComponent } from '../../shared/ui/brand/brand.component';
import { AUTH_STYLES } from './auth.styles';

@Component({
  selector: 'fm-sign-in',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, BrandComponent],
  template: `
    <section class="auth">
      <div class="auth__brand"><fm-brand size="lg" [tagline]="true" /></div>
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
    </section>
  `,
  styles: [AUTH_STYLES],
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

  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);

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
      await this.auth.signIn(email, password);
      await this.router.navigateByUrl('/');
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.submitting.set(false);
    }
  }
}
