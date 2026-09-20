import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AppLockService } from '../../core/app-lock/app-lock.service';
import { AuthStore } from '../../core/auth/auth.store';
import { ConsentService } from '../../core/consent/consent.service';
import {
  CONSENT_KINDS,
  canChangeConsent,
  type ConsentKind,
  type ConsentRecord,
  type RecordableConsentState,
} from '../../core/consent/consent.view';
import {
  PIN_LENGTH,
  isValidPin,
  lockFailureKey,
  lockMessageKey,
} from '../../core/app-lock/lock.view';
import { I18nService } from '../../core/i18n/i18n.service';
import { ConsentPurposeComponent } from '../../shared/ui/consent-purpose/consent-purpose.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { SyncService } from '../../core/offline/sync.service';

/**
 * Settings — docs/02 §4.18's shell, with the first section it needs.
 *
 * docs/02 §4.18 draws a settings shell whose sections are Profil, Domaćinstvo, Računi, Prikaz, Jezik,
 * AI podešavanja, Obaveštenja, Podaci and Članovi. Most of them already have a screen that owns them
 * (`/accounts`, `/onboarding`, `/notifications`), and the ones that do not are not built. What this
 * page adds is the section that had **no home at all**: `Bezbednost`, where the app lock is armed —
 * the control 4.2.6a deliberately left unbuilt.
 *
 * It renders only what exists. A section list with eight disabled rows would be the "disabled with a
 * tooltip rather than a broken control" rule (docs/02 §2) taken to the point of advertising absences;
 * the rows here are real controls and links to the screens that already own their content.
 *
 * ## The AI section is the consent surface's deliberate half (task R-25a)
 *
 * docs/08 §6.6 asks for consent at **first use** and needs the decision reachable from settings for
 * withdrawal "in two taps". This is the settings half: every purpose the deployment would need permission
 * for, its current state, and one primary action plus *Allow* where a change is possible. The other half —
 * the sheet that asks at the moment an entry needs the AI — is its own task, and until it exists this
 * section is the only place a Household can be asked.
 *
 * Two things it does not decide for itself. **What would be sent** comes from `aiEgress`, because a
 * provider name hardcoded in client copy is a claim and this project has been burned by one (ADR-031).
 * **Who may change it** comes from the session's role, because docs/08 §3.7 and Q-11 make granting and
 * withdrawing an OWNER act: the copy is the lawful-basis evidence, so a MEMBER sees the state and is told
 * whose decision it is.
 *
 * @module apps/web/src/app/features/settings
 */
@Component({
  selector: 'fm-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, ConsentPurposeComponent, IconComponent],
  template: `
    <main class="fm-page wrap">
      <h1>{{ i18n.t('settings.title') }}</h1>

      <section class="fm-card" aria-labelledby="profile-heading">
        <div class="fm-card__head">
          <h2 class="fm-card__title" id="profile-heading">
            <fm-icon name="people" [size]="18" />
            {{ i18n.t('profile.title') }}
          </h2>
        </div>
        <p class="muted">{{ i18n.t('profile.intro') }}</p>
        <a class="fm-btn notifications__open" routerLink="/profile">
          {{ i18n.t('profile.open') }}
        </a>
      </section>

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

      <section class="fm-card" aria-labelledby="ai-heading">
        <div class="fm-card__head">
          <h2 class="fm-card__title" id="ai-heading">
            <fm-icon name="sparkles" [size]="18" />
            {{ i18n.t('consent.title') }}
          </h2>
        </div>
        <p class="muted">{{ i18n.t('consent.intro') }}</p>

        @if (consent.error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }

        @if (!consent.loading() && consent.routes().length === 0) {
          <!-- Nothing is routed anywhere in this deployment, so there is no permission to request. Saying
               so is the honest state; three disabled "Allow" buttons would advertise a decision that
               does not exist. -->
          <p class="muted small">{{ i18n.t('consent.egress.none') }}</p>
        } @else {
          @for (kind of kinds; track kind) {
            <!-- The same card the first-use sheet shows, so the disclosure cannot drift between the two
                 (shared/ui/consent-purpose). -->
            <fm-consent-purpose
              [kind]="kind"
              [record]="recordFor(kind)"
              [routes]="consent.routes()"
              [mayChange]="mayChange()"
              [saving]="consent.saving()"
              (decide)="record(kind, $event)"
            />
          }

          <p class="muted small">{{ i18n.t('consent.neverSent') }}</p>
          <p class="muted small">{{ i18n.t('consent.trade') }}</p>

          @if (!mayChange()) {
            <p class="muted small">{{ i18n.t('consent.ownerOnly') }}</p>
          }
        }
      </section>

      <section class="fm-card" aria-labelledby="notifications-heading">
        <div class="fm-card__head">
          <h2 class="fm-card__title" id="notifications-heading">
            <fm-icon name="bell" [size]="18" />
            {{ i18n.t('nav.notifications') }}
          </h2>
        </div>
        <p class="muted">{{ i18n.t('settings.notifications.body') }}</p>
        <a class="fm-btn notifications__open" routerLink="/notifications">
          {{ i18n.t('settings.notifications.open') }}
        </a>
      </section>
    </main>
  `,
  styles: `
    .wrap {
      /* docs/02 §9: no fixed widths. The rhythm, the padding and the card material come from fm-page and
         fm-card; this only sets the reading measure and centres it. */
      max-inline-size: 46rem;
      margin-inline: auto;
    }
    h1 {
      font-size: var(--text-2xl);
      font-weight: var(--weight-bold);
      letter-spacing: var(--tracking-tight);
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
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2);
    }
    /* A shared button is inline-flex and shrink-to-fit, but as a grid child it stretches to the column,
       which drew a full-width empty bar around one short label. */
    .notifications__open {
      justify-self: start;
    }
    .error {
      color: var(--color-danger);
    }
    .purpose {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding-block: 0.5rem;
      border-block-start: 1px solid var(--color-border);
    }
    .purpose h3 {
      font-size: 1rem;
      margin: 0;
    }
    .state {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: baseline;
      margin: 0.25rem 0 0;
    }
  `,
})
export class SettingsComponent {
  private readonly sync = inject(SyncService);
  private readonly auth = inject(AuthStore);
  readonly lock = inject(AppLockService);
  readonly consent = inject(ConsentService);
  readonly i18n = inject(I18nService);

  readonly isValidPin = isValidPin;
  readonly lockMessageKey = lockMessageKey;
  /** Exposed for the template, which cannot call an imported function directly. */
  readonly failureKey = lockFailureKey;

  /** The purposes, in the order the section lists them (docs/08 §6.6's vocabulary, not the stored one). */
  readonly kinds = CONSENT_KINDS;

  readonly pin = signal('');

  /** OWNER-only (docs/08 §3.7, Q-11). A MEMBER sees the state and whose decision it is. */
  readonly mayChange = computed(() => canChangeConsent(this.auth.role()));

  constructor() {
    // The section is one of several, and its state is only needed here — so it is read on entry rather
    // than held app-wide. A failure leaves the previous state on screen and is reported in the section.
    void this.consent.load();
  }

  /** The stored record for a purpose, or `null` when the API reported none (which reads `NOT_ASKED`). */
  recordFor(kind: ConsentKind): ConsentRecord | null {
    return this.consent.states().find((record) => record.kind === kind) ?? null;
  }

  async record(kind: ConsentKind, state: RecordableConsentState): Promise<void> {
    await this.consent.record(kind, state, 'settings');
  }

  /** The queue's size, because arming is refused while it is not empty (ADR-029 decision 6). */
  readonly pendingCount = computed(() => this.sync.pendingCount());

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
}
