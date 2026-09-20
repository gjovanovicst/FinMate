import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { AppLockService } from '../../core/app-lock/app-lock.service';
import {
  PIN_LENGTH,
  isValidPin,
  lockFailureKey,
  lockMessageKey,
} from '../../core/app-lock/lock.view';
import { AuthStore } from '../../core/auth/auth.store';
import { ProfileService, type MfaState, type TotpSetup } from '../../core/auth/profile.service';
import { I18nService } from '../../core/i18n/i18n.service';
import { SyncService } from '../../core/offline/sync.service';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { TotpQrComponent } from '../../shared/ui/totp-qr/totp-qr.component';

/**
 * The **Security** pane of the shell — the account's factors, the device lock, and the sessions.
 *
 * These three belong together because they answer one question — *who can get in* — and they were
 * previously split across two screens (`/settings` owned the app lock, `/profile` owned the factors
 * and the sessions), which meant a person had to remember which page a control lived on.
 *
 * What it deliberately does not do: **name a device**. `sessions` stores only hashes of the User-Agent
 * and IP (docs/08 §3.9), so the list gives the times it actually knows and nothing it would have to
 * invent. And every factor change carries the password, because the API re-authenticates each one —
 * a borrowed session must not be able to arm a lockout.
 *
 * @module apps/web/src/app/features/settings
 */
@Component({
  selector: 'fm-security-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, TotpQrComponent, RouterLink],
  template: `
    <!-- Two-step verification (ADR-041) -->
    <section class="fm-card" aria-labelledby="mfa-heading">
      <div class="fm-card__head">
        <h2 class="fm-card__title" id="mfa-heading">
          <fm-icon name="lock" [size]="18" />
          {{ i18n.t('mfa.title') }}
        </h2>
      </div>
      <p class="muted small">{{ i18n.t('mfa.intro') }}</p>

      @if (profile.loading() && profile.mfa() === null && !mfaFailed()) {
        <p class="muted small" role="status">{{ i18n.t('profile.loading') }}</p>
      } @else if (profile.mfa(); as mfa) {
        <p class="value">{{ mfaStatus(mfa) }}</p>

        <div class="row">
          <label class="fm-field__label" for="mfa-password">{{ i18n.t('mfa.passwordLabel') }}</label>
          <input
            class="fm-field__input"
            id="mfa-password"
            type="password"
            autocomplete="current-password"
            [value]="mfaPassword()"
            (input)="setMfaPassword($event)"
          />
        </div>

        <div class="actions">
          @if (!mfa.totpEnabled) {
            @if (mfa.totpAvailable) {
              <button
                type="button"
                class="fm-btn fm-btn--primary"
                [disabled]="mfaBusy() || mfaPassword() === ''"
                (click)="startTotp()"
              >
                {{ i18n.t('mfa.app.setup') }}
              </button>
            } @else {
              <!-- The key is absent, so the authenticator factor cannot be stored safely. Saying so is
                   the honest state; a button here would fail on submit. -->
              <p class="muted small">{{ i18n.t('mfa.app.unavailable') }}</p>
            }
          } @else {
            <button
              type="button"
              class="fm-btn fm-btn--danger"
              [disabled]="mfaBusy() || mfaPassword() === ''"
              (click)="disableTotp()"
            >
              {{ i18n.t('mfa.app.disable') }}
            </button>
          }

          <button
            type="button"
            class="fm-btn"
            [disabled]="mfaBusy() || mfaPassword() === ''"
            (click)="toggleEmail(mfa)"
          >
            {{ mfa.emailOtpEnabled ? i18n.t('mfa.email.disable') : i18n.t('mfa.email.enable') }}
          </button>

          @if (mfa.totpEnabled || mfa.emailOtpEnabled) {
            <button
              type="button"
              class="fm-btn"
              [disabled]="mfaBusy() || mfaPassword() === ''"
              (click)="regenerateCodes()"
            >
              {{ i18n.t('mfa.codes.regenerate') }}
            </button>
          }
        </div>

        @if (totpSetup(); as setup) {
          <div class="totp">
            <fm-totp-qr [uri]="setup.otpauthUri" />
            <div class="totp__text">
              <p class="muted small">{{ i18n.t('mfa.app.scan') }}</p>
              <!-- The secret as text as well as a code: a desktop browser, a screen reader and every
                   app with manual entry need it. -->
              <code class="secret">{{ setup.secret }}</code>
              <p class="muted small">{{ i18n.t('mfa.app.manual') }}</p>
              <div class="row">
                <label class="fm-field__label" for="totp-code">{{ i18n.t('mfa.app.codeLabel') }}</label>
                <input
                  class="fm-field__input code"
                  id="totp-code"
                  type="text"
                  inputmode="numeric"
                  autocomplete="one-time-code"
                  [value]="totpCode()"
                  (input)="setTotpCode($event)"
                />
                <button
                  type="button"
                  class="fm-btn fm-btn--primary"
                  [disabled]="mfaBusy() || totpCode().trim() === ''"
                  (click)="enableTotp()"
                >
                  {{ i18n.t('mfa.app.confirm') }}
                </button>
              </div>
            </div>
          </div>
        }

        @if (recoveryCodes().length > 0) {
          <div class="codes" role="status">
            <p class="muted small">{{ i18n.t('mfa.codes.intro') }}</p>
            <ul class="codes__list">
              @for (entry of recoveryCodes(); track entry) {
                <li><code>{{ entry }}</code></li>
              }
            </ul>
            <button type="button" class="fm-btn fm-btn--primary" (click)="dismissCodes()">
              {{ i18n.t('mfa.codes.saved') }}
            </button>
          </div>
        }
      }

      @if (mfaFailed()) {
        <p class="error" role="alert">{{ i18n.t('mfa.failed') }}</p>
      }
      @if (mfaMessage(); as text) {
        <p class="ok" role="status">{{ text }}</p>
      }
      @if (mfaError(); as text) {
        <p class="error" role="alert">{{ text }}</p>
      }
    </section>

    <!-- App lock (ADR-029, task 4.2.6b) -->
    <section class="fm-card" aria-labelledby="security-heading">
      <div class="fm-card__head">
        <h2 class="fm-card__title" id="security-heading">
          <fm-icon name="lock" [size]="18" />
          {{ i18n.t('settings.security.title') }}
        </h2>
      </div>
      <p class="muted">{{ i18n.t(lockMessageKey(lock.state())) }}</p>

      @if (lock.state() === 'OFF') {
        <p class="muted small">{{ i18n.t('settings.security.why') }}</p>

        @if (lock.webauthnPossible) {
          <button
            type="button"
            class="fm-btn fm-btn--primary"
            [disabled]="lock.busy()"
            (click)="armWithDevice()"
          >
            {{ i18n.t('settings.security.withDevice') }}
          </button>
        }

        <form class="pin" (submit)="armWithPin($event)">
          <label class="fm-field__label" for="new-pin">
            {{ i18n.t('settings.security.pinLabel') }}
          </label>
          <input
            class="fm-field__input pin__input"
            id="new-pin"
            type="password"
            inputmode="numeric"
            autocomplete="new-password"
            maxlength="6"
            [value]="pin()"
            (input)="setPin($event)"
          />
          <button type="submit" class="fm-btn fm-btn--primary" [disabled]="lock.busy() || !isValidPin(pin())">
            {{ i18n.t('settings.security.withPin') }}
          </button>
        </form>
        <p class="muted small">{{ i18n.t('settings.security.pinHint') }}</p>
      }

      @if (lock.state() === 'UNLOCKED') {
        <div class="actions">
          <button type="button" class="fm-btn" [disabled]="lock.busy()" (click)="lockNow()">
            {{ i18n.t('settings.security.lockNow') }}
          </button>
          <button
            type="button"
            class="fm-btn fm-btn--danger"
            [disabled]="lock.busy()"
            (click)="turnOff()"
          >
            {{ i18n.t('settings.security.turnOff') }}
          </button>
        </div>
        <p class="muted small">{{ i18n.t('settings.security.turnOffHint') }}</p>
      }

      @if (pendingCount() > 0 && lock.state() === 'OFF') {
        <p class="muted small">
          {{ i18n.t('settings.security.queueFirst', { count: pendingCount() }) }}
          <a routerLink="/pending">{{ i18n.t('settings.security.queueLink') }}</a>
        </p>
      }

      @if (lock.failure(); as failure) {
        <p class="error" role="alert">{{ i18n.t(failureKey(failure)) }}</p>
      }
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

      @if (sessionsFailed()) {
        <p class="error" role="alert">{{ i18n.t('profile.sessions.failed') }}</p>
      }

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
              <button type="button" class="fm-btn" [disabled]="busy()" (click)="revoke(session.id)">
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

    @if (message(); as text) {
      <p class="ok" role="status">{{ text }}</p>
    }
    @if (error(); as text) {
      <p class="error" role="alert">{{ text }}</p>
    }
  `,
  styles: `
    /* A custom element is inline until told otherwise; see the shell's own note. */
    :host {
      display: block;
    }
    p {
      margin: 0;
      /* The card spans the pane now, so prose is capped where it is read rather than the page. */
      max-inline-size: 72ch;
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
    .fm-field__input {
      flex: 1 1 14rem;
      /* Same reason as the Account pane: a full-width card must not stretch a text field. */
      max-inline-size: 26rem;
      min-inline-size: 0;
    }
    .value {
      font-weight: var(--weight-semibold);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    .pin {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
      align-items: center;
    }
    /* The one field in the app whose value is read digit by digit: wider tracking, centred, and narrow
       because a six-digit PIN does not need a full-width box. */
    .pin__input {
      inline-size: 8rem;
      font-size: var(--text-lg);
      letter-spacing: 0.3em;
      text-align: center;
    }
    /* The QR and its manual-entry fallback sit side by side where there is room and stack where there
       is not; the secret is monospace so it can be compared character by character. */
    .totp {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-4);
      align-items: flex-start;
      margin-block: var(--space-3);
      padding-block-start: var(--space-3);
      border-block-start: 1px solid var(--color-border);
    }
    .totp__text {
      display: grid;
      gap: var(--space-2);
      flex: 1 1 16rem;
      min-inline-size: 0;
    }
    .secret,
    .code {
      font-family: var(--font-mono, monospace);
      letter-spacing: 0.1em;
      overflow-wrap: anywhere;
    }
    .codes {
      display: grid;
      gap: var(--space-2);
      margin-block-start: var(--space-3);
      padding: var(--space-3);
      border: 1px solid var(--color-border-strong);
      border-radius: var(--radius-md);
    }
    .codes__list {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
      gap: var(--space-1) var(--space-3);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .codes__list code {
      font-family: var(--font-mono, monospace);
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
  `,
})
export class SecuritySettingsComponent {
  readonly i18n = inject(I18nService);
  readonly profile = inject(ProfileService);
  readonly lock = inject(AppLockService);

  private readonly sync = inject(SyncService);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly errors = inject(ErrorMessageService);

  readonly isValidPin = isValidPin;
  readonly lockMessageKey = lockMessageKey;
  /** Exposed for the template, which cannot call an imported function directly. */
  readonly failureKey = lockFailureKey;

  readonly pin = signal('');

  readonly busy = signal(false);
  readonly message = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  /** Which optional reads failed, so one of them cannot blank the pane. */
  readonly sessionsFailed = signal(false);
  readonly mfaFailed = signal(false);

  /**
   * Two-factor state (ADR-041).
   *
   * **One** password field serves every action in the card rather than one per button: the API
   * re-authenticates each change, and asking for the same password four times would be hostile for no
   * security gain. The recovery codes are held here only until the person confirms they saved them —
   * the API will not show them again.
   */
  readonly mfaPassword = signal('');
  readonly totpCode = signal('');
  readonly totpSetup = signal<TotpSetup | null>(null);
  readonly recoveryCodes = signal<readonly string[]>([]);
  readonly mfaBusy = signal(false);
  readonly mfaMessage = signal<string | null>(null);
  readonly mfaError = signal<string | null>(null);

  /** At least one session that is not this one, so "sign out everywhere else" is worth offering. */
  readonly hasOtherSessions = computed(() =>
    this.profile.sessions().some((session) => !session.current),
  );

  /** The queue's size, because arming is refused while it is not empty (ADR-029 decision 6). */
  readonly pendingCount = computed(() => this.sync.pendingCount());

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const result = await this.profile.ensureLoaded();
      this.sessionsFailed.set(result.sessionsFailed);
      this.mfaFailed.set(result.mfaFailed);
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

  /**
   * One sentence for what is on, built from whole translated fragments rather than a concatenated
   * template — Serbian inflects, and a sentence assembled from English word order cannot.
   */
  mfaStatus(mfa: MfaState): string {
    const parts = [
      mfa.totpEnabled ? this.i18n.t('mfa.status.appOn') : this.i18n.t('mfa.status.appOff'),
      mfa.emailOtpEnabled ? this.i18n.t('mfa.status.emailOn') : this.i18n.t('mfa.status.emailOff'),
    ];
    if (mfa.totpEnabled || mfa.emailOtpEnabled) {
      parts.push(this.i18n.t('mfa.status.codes', { count: mfa.recoveryCodesRemaining }));
    }
    return parts.join(' · ');
  }

  setMfaPassword(event: Event): void {
    this.mfaPassword.set((event.target as HTMLInputElement).value);
  }

  setTotpCode(event: Event): void {
    this.totpCode.set((event.target as HTMLInputElement).value);
  }

  async startTotp(): Promise<void> {
    if (this.mfaBusy()) return;
    await this.runMfa(async () => {
      this.totpSetup.set(await this.profile.startTotpSetup(this.mfaPassword()));
      this.totpCode.set('');
    });
  }

  async enableTotp(): Promise<void> {
    if (this.mfaBusy()) return;
    await this.runMfa(async () => {
      const codes = await this.profile.enableTotp(this.mfaPassword(), this.totpCode().trim());
      this.recoveryCodes.set(codes);
      this.totpSetup.set(null);
      this.totpCode.set('');
      this.mfaMessage.set(this.i18n.t('mfa.app.enabled'));
    });
  }

  async disableTotp(): Promise<void> {
    if (this.mfaBusy()) return;
    await this.runMfa(async () => {
      await this.profile.disableTotp(this.mfaPassword());
      this.totpSetup.set(null);
      this.mfaMessage.set(this.i18n.t('mfa.app.disabled'));
    });
  }

  async toggleEmail(mfa: MfaState): Promise<void> {
    if (this.mfaBusy()) return;
    const enabled = !mfa.emailOtpEnabled;
    await this.runMfa(async () => {
      const codes = await this.profile.setEmailOtp(this.mfaPassword(), enabled);
      if (codes.length > 0) this.recoveryCodes.set(codes);
      this.mfaMessage.set(
        enabled ? this.i18n.t('mfa.email.enabled') : this.i18n.t('mfa.email.disabled'),
      );
    });
  }

  async regenerateCodes(): Promise<void> {
    if (this.mfaBusy()) return;
    await this.runMfa(async () => {
      this.recoveryCodes.set(await this.profile.regenerateRecoveryCodes(this.mfaPassword()));
      this.mfaMessage.set(this.i18n.t('mfa.codes.regenerated'));
    });
  }

  /** The codes are shown once; acknowledging removes them from the screen (not from the server). */
  dismissCodes(): void {
    this.recoveryCodes.set([]);
  }

  private async runMfa(action: () => Promise<void>): Promise<void> {
    this.mfaBusy.set(true);
    this.mfaMessage.set(null);
    this.mfaError.set(null);
    try {
      await action();
    } catch (error) {
      this.mfaError.set(this.errors.for(error));
    } finally {
      this.mfaBusy.set(false);
    }
  }

  setPin(event: Event): void {
    const digits = (event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, PIN_LENGTH);
    this.pin.set(digits);
  }

  async armWithDevice(): Promise<void> {
    if (await this.lock.enableWithWebAuthn(this.pendingCount())) this.pin.set('');
  }

  async armWithPin(event: Event): Promise<void> {
    event.preventDefault();
    if (await this.lock.enableWithPin(this.pin(), this.pendingCount())) this.pin.set('');
  }

  lockNow(): void {
    this.lock.lock();
  }

  async turnOff(): Promise<void> {
    await this.lock.purge();
    // The queue is gone with the wipe, so the header chip must stop advertising it.
    await this.sync.refresh();
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
