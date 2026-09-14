import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { messageForError } from '../../core/api/error-messages';
import { AuthStore } from '../../core/auth/auth.store';

@Component({
  selector: 'fm-sign-in',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink],
  template: `
    <section class="auth">
      <h1 class="auth__title">Prijava</h1>

      <form class="auth__form" [formGroup]="form" (ngSubmit)="submit()" novalidate>
        <label class="field">
          <span class="field__label">Email</span>
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
          <span class="field__label">Lozinka</span>
          <input
            class="field__input"
            type="password"
            formControlName="password"
            autocomplete="current-password"
            required
          />
        </label>

        <!-- role="alert" so a screen reader announces the failure immediately rather than
             leaving the user to discover it by re-reading the form. -->
        @if (error()) {
          <p class="auth__error" role="alert">{{ error() }}</p>
        }

        <button class="auth__submit" type="submit" [disabled]="submitting()">
          {{ submitting() ? 'Prijavljivanje…' : 'Prijavi se' }}
        </button>
      </form>

      <p class="auth__alt">
        Nemaš nalog? <a routerLink="/sign-up">Registruj se</a>
      </p>
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
        margin-block: 0 var(--space-5);
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
      .field__input {
        padding: var(--space-3);
        font: inherit;
        color: var(--color-text);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .field__input:focus-visible {
        border-color: var(--color-primary);
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
        transition: background var(--motion-fast) ease;
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
export class SignInComponent {
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
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
      this.error.set(messageForError(error));
    } finally {
      this.submitting.set(false);
    }
  }
}
