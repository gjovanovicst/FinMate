import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { AuthStore } from '../../core/auth/auth.store';
import { ProfileService } from '../../core/auth/profile.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { LanguageSwitcherComponent } from '../../shared/ui/language-switcher/language-switcher.component';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../auth/password-policy';

/**
 * Profile — docs/02 §4.18's **Profil** section.
 *
 * The settings shell lists Profil as *"Display name, email, password change, active sessions"*.
 * This is that screen, and it is the first place a signed-in person can act on their own account:
 * until now the API knew a name (`users.display_name`) that no screen showed and the shell named the
 * role instead.
 *
 * ## Three things it deliberately does not do
 *
 *  - **No device names in the session list.** `sessions` stores only hashes of the User-Agent and IP
 *    (docs/08 §3.9), so the screen says when a session started and when it was last used, and nothing
 *    it cannot know. A plausible "Chrome on macOS" would have to be invented or the raw agent stored.
 *  - **No immediate email change.** The new address is *staged* and a link is mailed to it; `email`
 *    stays the login identity until the link is opened. The screen says so rather than showing the
 *    new address as if it were already in use.
 *  - **No password change without the current password.** A borrowed session must not be able to
 *    change the credential that would take the account back (docs/08 §3).
 *
 * @module apps/web/src/app/features/profile
 */
@Component({
  selector: 'fm-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent, LanguageSwitcherComponent],
  template: `
    <main class="fm-page wrap">
      <h1>{{ i18n.t('profile.title') }}</h1>
      <p class="muted">{{ i18n.t('profile.intro') }}</p>

      @if (profile.loading() && profile.profile() === null) {
        <p class="muted" role="status">{{ i18n.t('profile.loading') }}</p>
      } @else if (profile.profile(); as me) {
        <!-- Identity -->
        <section class="fm-card" aria-labelledby="identity-heading">
          <div class="fm-card__head">
            <h2 class="fm-card__title" id="identity-heading">
              <fm-icon name="people" [size]="18" />
              {{ i18n.t('profile.identity.title') }}
            </h2>
          </div>

          <form class="row" (submit)="saveName($event)">
            <label class="fm-field__label" for="display-name">
              {{ i18n.t('profile.displayName.label') }}
            </label>
            <input
              class="fm-field__input"
              id="display-name"
              type="text"
              autocomplete="name"
              maxlength="80"
              [value]="displayName()"
              (input)="setDisplayName($event)"
            />
            <button
              type="submit"
              class="fm-btn fm-btn--primary"
              [disabled]="busy() || displayName().trim() === ''"
            >
              {{ i18n.t('profile.displayName.save') }}
            </button>
          </form>

          <div class="row row--stack">
            <span class="fm-field__label">{{ i18n.t('profile.email.label') }}</span>
            <span class="value">{{ me.email }}</span>
            <span class="badge" [class.badge--ok]="me.emailVerified">
              {{
                me.emailVerified
                  ? i18n.t('profile.email.verified')
                  : i18n.t('profile.email.unverified')
              }}
            </span>
          </div>

          @if (me.pendingEmail) {
            <p class="note" role="status">
              {{ i18n.t('profile.email.pending', { email: me.pendingEmail }) }}
            </p>
          }

          <form class="row row--wrap" (submit)="submitEmail($event)">
            <label class="fm-field__label" for="new-email">
              {{ i18n.t('profile.email.newLabel') }}
            </label>
            <input
              class="fm-field__input"
              id="new-email"
              type="email"
              autocomplete="email"
              inputmode="email"
              [value]="newEmail()"
              (input)="setNewEmail($event)"
            />
            <label class="fm-field__label" for="email-password">
              {{ i18n.t('profile.email.passwordLabel') }}
            </label>
            <input
              class="fm-field__input"
              id="email-password"
              type="password"
              autocomplete="current-password"
              [value]="emailPassword()"
              (input)="setEmailPassword($event)"
            />
            <button
              type="submit"
              class="fm-btn fm-btn--primary"
              [disabled]="busy() || newEmail().trim() === '' || emailPassword() === ''"
            >
              {{ i18n.t('profile.email.change') }}
            </button>
          </form>
          <p class="muted small">{{ i18n.t('profile.email.hint') }}</p>
        </section>

        <!-- Password -->
        <section class="fm-card" aria-labelledby="password-heading">
          <div class="fm-card__head">
            <h2 class="fm-card__title" id="password-heading">
              <fm-icon name="lock" [size]="18" />
              {{ i18n.t('profile.password.title') }}
            </h2>
          </div>

          <form class="row row--wrap" (submit)="submitPassword($event)">
            <label class="fm-field__label" for="current-password">
              {{ i18n.t('profile.password.current') }}
            </label>
            <input
              class="fm-field__input"
              id="current-password"
              type="password"
              autocomplete="current-password"
              [value]="currentPassword()"
              (input)="setCurrentPassword($event)"
            />
            <label class="fm-field__label" for="new-password">
              {{ i18n.t('profile.password.new') }}
            </label>
            <input
              class="fm-field__input"
              id="new-password"
              type="password"
              autocomplete="new-password"
              [value]="newPassword()"
              (input)="setNewPassword($event)"
            />
            <button
              type="submit"
              class="fm-btn fm-btn--primary"
              [disabled]="busy() || !passwordValid()"
            >
              {{ i18n.t('profile.password.change') }}
            </button>
          </form>
          <p class="muted small">
            {{ i18n.t('profile.password.hint', { min: minLength }) }}
          </p>
        </section>

        <!-- Sessions -->
        <section class="fm-card" aria-labelledby="sessions-heading">
          <div class="fm-card__head">
            <h2 class="fm-card__title" id="sessions-heading">
              <fm-icon name="calendar" [size]="18" />
              {{ i18n.t('profile.sessions.title') }}
            </h2>
          </div>
          <p class="muted small">{{ i18n.t('profile.sessions.intro') }}</p>

          <ul class="sessions">
            @for (session of profile.sessions(); track session.id) {
              <li class="session">
                <div class="session__text">
                  <span class="value">
                    {{ session.current ? i18n.t('profile.sessions.current') : i18n.t('profile.sessions.other') }}
                  </span>
                  <span class="muted small">
                    {{ i18n.t('profile.sessions.started', { when: formatDate(session.createdAt) }) }}
                    &middot;
                    {{ i18n.t('profile.sessions.lastSeen', { when: formatDate(session.lastSeenAt) }) }}
                  </span>
                </div>
                @if (!session.current) {
                  <button
                    type="button"
                    class="fm-btn"
                    [disabled]="busy()"
                    (click)="revoke(session.id)"
                  >
                    {{ i18n.t('profile.sessions.revoke') }}
                  </button>
                }
              </li>
            }
          </ul>

          @if (hasOtherSessions()) {
            <button type="button" class="fm-btn" [disabled]="busy()" (click)="revokeOthers()">
              {{ i18n.t('profile.sessions.revokeOthers') }}
            </button>
          }
        </section>

        <!-- Language -->
        <section class="fm-card" aria-labelledby="language-heading">
          <div class="fm-card__head">
            <h2 class="fm-card__title" id="language-heading">
              <fm-icon name="globe" [size]="18" />
              {{ i18n.t('profile.language.title') }}
            </h2>
          </div>
          <p class="muted small">{{ i18n.t('profile.language.intro') }}</p>
          <fm-language-switcher />
        </section>

        @if (message(); as text) {
          <p class="ok" role="status">{{ text }}</p>
        }
        @if (error(); as text) {
          <p class="error" role="alert">{{ text }}</p>
        }
      } @else if (error(); as text) {
        <p class="error" role="alert">{{ text }}</p>
      }

      <p class="back"><a routerLink="/settings">{{ i18n.t('profile.toSettings') }}</a></p>
    </main>
  `,
  styles: `
    .wrap {
      /* The rhythm and the card material come from fm-page/fm-card; this only sets the reading
         measure and centres it, like the settings screen (docs/02 §9: no fixed widths). */
      max-inline-size: 46rem;
      margin-inline: auto;
    }
    h1 {
      font-size: var(--text-2xl);
      font-weight: var(--weight-bold);
      letter-spacing: var(--tracking-tight);
      margin: 0;
    }
    h2 {
      font-size: 1rem;
      margin: 0;
    }
    p {
      margin: 0;
    }
    .muted {
      color: var(--color-text-muted);
    }
    .small {
      font-size: var(--text-sm);
    }
    .row {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    .row--wrap {
      align-items: flex-end;
    }
    .row--stack {
      align-items: baseline;
    }
    .fm-field__input {
      flex: 1 1 14rem;
      min-inline-size: 0;
    }
    .value {
      font-weight: var(--weight-semibold);
    }
    .badge {
      padding: 0.1rem 0.5rem;
      border-radius: var(--radius-pill);
      border: 1px solid var(--color-border-strong);
      color: var(--color-text-muted);
      font-size: var(--text-xs);
    }
    .badge--ok {
      border-color: var(--color-primary);
      color: var(--color-primary-text);
      background: var(--color-primary-soft);
    }
    .note {
      color: var(--color-text-muted);
      font-size: var(--text-sm);
    }
    .sessions {
      display: grid;
      gap: var(--space-2);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .session {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
      justify-content: space-between;
      padding-block: var(--space-2);
      border-block-start: 1px solid var(--color-border);
    }
    .session__text {
      display: grid;
      gap: 0.15rem;
      min-inline-size: 0;
    }
    .ok {
      color: var(--color-primary-text);
    }
    .error {
      color: var(--color-danger);
    }
    .back a {
      color: var(--color-text-muted);
    }
  `,
})
export class ProfileComponent {
  readonly i18n = inject(I18nService);
  readonly profile = inject(ProfileService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly errors = inject(ErrorMessageService);

  readonly minLength = MIN_PASSWORD_LENGTH;
  readonly maxLength = MAX_PASSWORD_LENGTH;

  readonly displayName = signal('');
  readonly newEmail = signal('');
  readonly emailPassword = signal('');
  readonly currentPassword = signal('');
  readonly newPassword = signal('');

  readonly busy = signal(false);
  readonly message = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  /** At least one session that is not this one, so "sign out everywhere else" is worth offering. */
  readonly hasOtherSessions = computed(() =>
    this.profile.sessions().some((session) => !session.current),
  );

  /** Mirrors `PasswordService.validateStrength`: the length rule, so the button is not a dead end. */
  readonly passwordValid = computed(() => {
    const value = this.newPassword();
    return (
      this.currentPassword().length > 0 &&
      value.length >= MIN_PASSWORD_LENGTH &&
      value.length <= MAX_PASSWORD_LENGTH
    );
  });

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    this.error.set(null);
    try {
      await this.profile.load();
      this.displayName.set(this.profile.profile()?.displayName ?? '');
    } catch (error) {
      this.error.set(this.errors.for(error));
    }
  }

  /** `Intl`, in the reader's language: a hardcoded format would disagree with the interface (ADR-040). */
  formatDate(iso: string): string {
    return new Intl.DateTimeFormat(this.i18n.tag(), {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  }

  setDisplayName(event: Event): void {
    this.displayName.set((event.target as HTMLInputElement).value);
  }

  setNewEmail(event: Event): void {
    this.newEmail.set((event.target as HTMLInputElement).value);
  }

  setEmailPassword(event: Event): void {
    this.emailPassword.set((event.target as HTMLInputElement).value);
  }

  setCurrentPassword(event: Event): void {
    this.currentPassword.set((event.target as HTMLInputElement).value);
  }

  setNewPassword(event: Event): void {
    this.newPassword.set((event.target as HTMLInputElement).value);
  }

  async saveName(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.busy.set(true);
    this.clear();
    try {
      const saved = await this.profile.rename(this.displayName());
      this.displayName.set(saved.displayName);
      // The shell's account block renders the session's copy of the name, so it is re-read too.
      await this.auth.refresh();
      this.message.set(this.i18n.t('profile.displayName.saved'));
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async submitEmail(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.busy.set(true);
    this.clear();
    const target = this.newEmail().trim();
    try {
      await this.profile.changeEmail(target, this.emailPassword());
      this.emailPassword.set('');
      this.newEmail.set('');
      this.message.set(this.i18n.t('profile.email.changeSent', { email: target }));
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async submitPassword(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy() || !this.passwordValid()) return;
    this.busy.set(true);
    this.clear();
    try {
      await this.profile.changePassword(this.currentPassword(), this.newPassword());
      this.currentPassword.set('');
      this.newPassword.set('');
      this.message.set(this.i18n.t('profile.password.changed'));
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async revoke(id: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.clear();
    try {
      const result = await this.profile.revokeSession(id);
      if (result.current) {
        // The caller just ended the session it is using. The API has already revoked it, so there is
        // nothing left to sign out of server-side; clear locally and go to sign-in.
        this.auth.clear();
        await this.router.navigateByUrl('/sign-in');
        return;
      }
      this.message.set(this.i18n.t('profile.sessions.revoked'));
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  async revokeOthers(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.clear();
    try {
      const count = await this.profile.revokeOtherSessions();
      this.message.set(this.i18n.t('profile.sessions.revokedOthers', { count }));
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.busy.set(false);
    }
  }

  private clear(): void {
    this.message.set(null);
    this.error.set(null);
  }
}
