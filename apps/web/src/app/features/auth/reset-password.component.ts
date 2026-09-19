import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import type { AbstractControl, ValidationErrors } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';

import { ErrorMessageService, apiErrorCode } from '../../core/api/error-message.service';
import { AuthStore } from '../../core/auth/auth.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { BrandComponent } from '../../shared/ui/brand/brand.component';
import { AUTH_STYLES } from './auth.styles';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password-policy';

/** The group is valid only while both password fields agree. */
function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password')?.value as string | undefined;
  const repeat = group.get('repeat')?.value as string | undefined;
  return password === repeat ? null : { mismatch: true };
}

/**
 * Password reset — F-28, task 5.8.
 *
 * ## One route, two questions
 *
 * `/reset-password` with no `token` asks *"which address?"*; with a token it asks *"what should the new
 * password be?"*. That is deliberate: the link in the mail points here, so the person who clicked it
 * lands on the second question directly, and the person who forgot their password reaches the first
 * through sign-in's *Forgot your password?* link. One screen, because the recovery path from a dead link
 * is the other half of the same question — *request a new one* — and it is one link away.
 *
 * ## What this screen may not do
 *
 * The API answers `204` for **any** address, known or not (docs/06 §2), so this screen cannot tell the
 * user whether their account exists and must not try: the success sentence names the address they
 * typed and says a link is on its way *if an account exists*. That is a security property of the
 * endpoint, not politeness.
 *
 * ## A dead link is expected, not exceptional
 *
 * Tokens expire and are single-use, and the API answers one `VALIDATION_FAILED` for unknown, used and
 * expired alike. The set form therefore treats that code as *this link cannot be used* and offers the
 * one action that works — request another — rather than printing "check the details you entered", which
 * would point at a form nothing is wrong with. The client checks the same length rule the server does,
 * so a weak password is caught here and cannot be mistaken for the token case.
 *
 * @module apps/web/src/app/features/auth
 */
@Component({
  selector: 'fm-reset-password',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, BrandComponent],
  template: `
    <section class="auth">
      <div class="auth__brand"><fm-brand size="lg" [tagline]="true" /></div>
      @if (done()) {
        <h1 class="auth__title">{{ i18n.t('reset.doneTitle') }}</h1>
        <p class="auth__hint">{{ i18n.t('reset.done') }}</p>
        <!-- Every session was revoked with the password, so this is the only way on. -->
        <p class="auth__alt"><a routerLink="/sign-in">{{ i18n.t('reset.toSignIn') }}</a></p>
      } @else if (sentTo(); as email) {
        <h1 class="auth__title">{{ i18n.t('reset.sentTitle') }}</h1>
        <p class="auth__hint">{{ i18n.t('reset.sent', { email }) }}</p>
        <p class="auth__alt"><a routerLink="/sign-in">{{ i18n.t('reset.toSignIn') }}</a></p>
      } @else if (expired()) {
        <h1 class="auth__title">{{ i18n.t('reset.expiredTitle') }}</h1>
        <p class="auth__hint">{{ i18n.t('reset.expired') }}</p>
        <p class="auth__alt">
          <a routerLink="/reset-password">{{ i18n.t('reset.requestAnother') }}</a>
        </p>
      } @else if (hasToken()) {
        <h1 class="auth__title">{{ i18n.t('reset.setTitle') }}</h1>
        <p class="auth__hint">{{ i18n.t('reset.setIntro') }}</p>

        <form class="auth__form" [formGroup]="setForm" (ngSubmit)="save()" novalidate>
          <label class="field">
            <span class="field__label">{{ i18n.t('reset.newPassword') }}</span>
            <input
              class="field__input"
              type="password"
              formControlName="password"
              autocomplete="new-password"
              required
            />
            <span class="field__hint">{{ i18n.t('reset.passwordHint', { min: minLength }) }}</span>
          </label>

          <label class="field">
            <span class="field__label">{{ i18n.t('reset.repeat') }}</span>
            <input
              class="field__input"
              type="password"
              formControlName="repeat"
              autocomplete="new-password"
              required
            />
          </label>

          @if (mismatch()) {
            <p class="auth__error" role="alert">{{ i18n.t('reset.mismatch') }}</p>
          }
          @if (error(); as message) {
            <p class="auth__error" role="alert">{{ message }}</p>
          }

          <button class="auth__submit" type="submit" [disabled]="saving()">
            {{ saving() ? i18n.t('reset.setSubmitting') : i18n.t('reset.setSubmit') }}
          </button>
        </form>
      } @else {
        <h1 class="auth__title">{{ i18n.t('reset.title') }}</h1>
        <p class="auth__hint">{{ i18n.t('reset.requestIntro') }}</p>

        <form class="auth__form" [formGroup]="requestForm" (ngSubmit)="request()" novalidate>
          <label class="field">
            <span class="field__label">{{ i18n.t('reset.email') }}</span>
            <input
              class="field__input"
              type="email"
              formControlName="email"
              autocomplete="username"
              inputmode="email"
              required
            />
          </label>

          @if (error(); as message) {
            <p class="auth__error" role="alert">{{ message }}</p>
          }

          <button class="auth__submit" type="submit" [disabled]="sending()">
            {{ sending() ? i18n.t('reset.requestSubmitting') : i18n.t('reset.requestSubmit') }}
          </button>
        </form>

        <p class="auth__alt"><a routerLink="/sign-in">{{ i18n.t('reset.toSignIn') }}</a></p>
      }
    </section>
  `,
  styles: [AUTH_STYLES],
})
export class ResetPasswordComponent {
  readonly i18n = inject(I18nService);
  private readonly route = inject(ActivatedRoute);
  private readonly auth = inject(AuthStore);
  private readonly errors = inject(ErrorMessageService);
  private readonly fb = inject(FormBuilder);

  /**
   * `?token=…` from the emailed link — empty means "ask for a link".
   *
   * Read from `queryParamMap` and kept in a signal, not taken from `snapshot`: the screen's own *Request
   * a new link* action navigates to `/reset-password` with **no** query param, and the router reuses the
   * component instance for that (only the query changed), so a `snapshot` read at construction would keep
   * showing the set-password form with the dead token. It is also the way this codebase reads query
   * parameters (see `transactions.component.ts`) — a router-bound `input()` is written `undefined` for an
   * absent parameter, which overrides the input's own default and threw on the first live run of this
   * screen (docs/15).
   */
  readonly token = signal('');

  readonly minLength = MIN_PASSWORD_LENGTH;

  readonly hasToken = computed(() => this.token().trim() !== '');

  readonly requestForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
  });

  readonly setForm = this.fb.nonNullable.group(
    {
      password: [
        '',
        [
          Validators.required,
          Validators.minLength(MIN_PASSWORD_LENGTH),
          Validators.maxLength(MAX_PASSWORD_LENGTH),
        ],
      ],
      repeat: ['', [Validators.required]],
    },
    { validators: passwordsMatch },
  );

  constructor() {
    // `queryParamMap` replays the current value on subscribe, so this one path covers the first read and
    // every later change (the *Request a new link* link included).
    this.route.queryParamMap.subscribe((params) => this.token.set((params.get('token') ?? '').trim()));
  }

  readonly sending = signal(false);
  readonly saving = signal(false);
  readonly sentTo = signal<string | null>(null);
  readonly done = signal(false);
  readonly expired = signal(false);
  readonly error = signal<string | null>(null);

  /**
   * Whether the two password fields disagree, as soon as there are two values to compare.
   *
   * The condition is the second field's **value**, not its `dirty`/`touched` flag: this is a comparison,
   * so it appears when a comparison is possible and disappears when the two agree. Interaction flags
   * depend on how a value got there (a blur, a paste, a test's `setValue`), which is a rule nobody can
   * state from the outside.
   *
   * ⚠️ A **method**, not a `computed`. A reactive form's `errors`/`value` are plain properties, not
   * signals, so a `computed` that reads them is evaluated once and then cached for the life of the
   * component — the message never appears. The first version of this line was a `computed`, and the spec
   * below is what caught it (docs/15).
   */
  mismatch(): boolean {
    return this.setForm.hasError('mismatch') && this.setForm.controls.repeat.value !== '';
  }

  async request(): Promise<void> {
    if (this.requestForm.invalid || this.sending()) {
      this.requestForm.markAllAsTouched();
      return;
    }
    this.sending.set(true);
    this.error.set(null);
    try {
      const { email } = this.requestForm.getRawValue();
      await this.auth.requestPasswordReset(email);
      this.sentTo.set(email);
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.sending.set(false);
    }
  }

  async save(): Promise<void> {
    if (this.setForm.invalid || this.saving()) {
      this.setForm.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    this.error.set(null);
    try {
      const { password } = this.setForm.getRawValue();
      await this.auth.resetPassword(this.token().trim(), password);
      this.done.set(true);
    } catch (error) {
      if (apiErrorCode(error) === 'VALIDATION_FAILED') {
        // Unknown, used and expired tokens all answer this one code, and the client has already
        // checked the length rule, so the token is the only thing left it can be (docs/06 §2).
        this.expired.set(true);
      } else {
        this.error.set(this.errors.for(error));
      }
    } finally {
      this.saving.set(false);
    }
  }
}
