import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AppLockService } from '../../core/app-lock/app-lock.service';
import { AuthStore } from '../../core/auth/auth.store';
import { ConsentService } from '../../core/consent/consent.service';
import {
  CONSENT_KINDS,
  canChangeConsent,
  egressFor,
  kindNameKey,
  kindWhatKey,
  needsConsent,
  regionKey,
  stateKey,
} from '../../core/consent/consent.view';
import {
  PIN_LENGTH,
  isValidPin,
  lockFailureKey,
  lockMessageKey,
} from '../../core/app-lock/lock.view';
import { I18nService } from '../../core/i18n/i18n.service';
import { syncedAtLabel } from '../../core/offline/sync.view';
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
  imports: [RouterLink],
  template: `
    <main class="wrap">
      <h1>{{ i18n.t('settings.title') }}</h1>

      <section class="card" aria-labelledby="security-heading">
        <h2 id="security-heading">{{ i18n.t('settings.security.title') }}</h2>
        <p class="muted">{{ i18n.t(lockMessageKey(lock.state())) }}</p>

        @if (lock.state() === 'OFF') {
          <p class="muted small">{{ i18n.t('settings.security.why') }}</p>

          @if (lock.webauthnPossible) {
            <button type="button" class="btn" [disabled]="lock.busy()" (click)="armWithDevice()">
              {{ i18n.t('settings.security.withDevice') }}
            </button>
          }

          <form class="pin" (submit)="armWithPin($event)">
            <label for="new-pin">{{ i18n.t('settings.security.pinLabel') }}</label>
            <input
              id="new-pin"
              type="password"
              inputmode="numeric"
              autocomplete="new-password"
              maxlength="6"
              [value]="pin()"
              (input)="setPin($event)"
            />
            <button type="submit" class="btn" [disabled]="lock.busy() || !isValidPin(pin())">
              {{ i18n.t('settings.security.withPin') }}
            </button>
          </form>
          <p class="muted small">{{ i18n.t('settings.security.pinHint') }}</p>
        }

        @if (lock.state() === 'UNLOCKED') {
          <div class="actions">
            <button type="button" class="btn" [disabled]="lock.busy()" (click)="lockNow()">
              {{ i18n.t('settings.security.lockNow') }}
            </button>
            <button type="button" class="btn btn--danger" [disabled]="lock.busy()" (click)="turnOff()">
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

      <section class="card" aria-labelledby="ai-heading">
        <h2 id="ai-heading">{{ i18n.t('consent.title') }}</h2>
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
            <article class="purpose">
              <h3>{{ i18n.t(kindNameKey(kind)) }}</h3>
              <p class="muted small">{{ i18n.t(kindWhatKey(kind)) }}</p>

              @for (route of egressFor(consent.routes(), kind); track route.task) {
                <p class="muted small">
                  {{ i18n.t('consent.egress', { provider: route.provider, region: i18n.t(regionKey(route.region)) }) }}
                </p>
              }
              @if (needsConsent(consent.routes(), kind)) {
                <p class="muted small">{{ i18n.t('consent.egress.nonEea') }}</p>
              }

              <p class="state">
                <strong>{{ i18n.t(stateKey(consent.state(kind))) }}</strong>
                @if (recordedAtLabel(kind); as recorded) {
                  <span class="muted small">{{ i18n.t('consent.recorded', { time: recorded }) }}</span>
                }
              </p>

              @if (kindNote(kind); as note) {
                <p class="muted small">{{ note }}</p>
              }

              @if (mayChange()) {
                <div class="actions">
                  @if (consent.state(kind) === 'GRANTED') {
                    <button
                      type="button"
                      class="btn btn--danger"
                      [disabled]="consent.saving()"
                      (click)="record(kind, 'WITHDRAWN')"
                    >
                      {{ i18n.t('consent.withdraw') }}
                    </button>
                  } @else {
                    <button
                      type="button"
                      class="btn"
                      [disabled]="consent.saving()"
                      (click)="record(kind, 'GRANTED')"
                    >
                      {{ i18n.t('consent.allow') }}
                    </button>
                    @if (consent.state(kind) === 'NOT_ASKED') {
                      <!-- Present only while the question is open. Once somebody has declined, "Decline"
                           again would be a button that changes nothing. -->
                      <button
                        type="button"
                        class="btn"
                        [disabled]="consent.saving()"
                        (click)="record(kind, 'DECLINED')"
                      >
                        {{ i18n.t('consent.decline') }}
                      </button>
                    }
                  }
                </div>
              }
            </article>
          }

          <p class="muted small">{{ i18n.t('consent.neverSent') }}</p>
          <p class="muted small">{{ i18n.t('consent.trade') }}</p>

          @if (!mayChange()) {
            <p class="muted small">{{ i18n.t('consent.ownerOnly') }}</p>
          }
        }
      </section>

      <section class="card" aria-labelledby="notifications-heading">
        <h2 id="notifications-heading">{{ i18n.t('nav.notifications') }}</h2>
        <p class="muted">{{ i18n.t('settings.notifications.body') }}</p>
        <a class="btn" routerLink="/notifications">{{ i18n.t('settings.notifications.open') }}</a>
      </section>
    </main>
  `,
  styles: `
    .wrap {
      padding: 1rem;
      /* docs/02 §9: no fixed widths. */
      max-inline-size: 46rem;
      margin-inline: auto;
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    h1 {
      font-size: 1.4rem;
      margin: 0;
    }
    .card {
      border: 1px solid var(--fm-border, #ddd);
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      align-items: flex-start;
    }
    h2 {
      font-size: 1.1rem;
      margin: 0;
    }
    p {
      margin: 0;
    }
    .muted {
      color: var(--fm-muted, #666);
    }
    .small {
      font-size: 0.85rem;
    }
    .pin {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
    }
    .pin input {
      font-size: 1.2rem;
      letter-spacing: 0.3em;
      inline-size: 7rem;
      padding: 0.35rem;
      text-align: center;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .error {
      color: var(--fm-critical, #b42318);
    }
    .purpose {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      padding-block: 0.5rem;
      border-block-start: 1px solid var(--fm-border, #ddd);
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
  readonly kindNameKey = kindNameKey;
  readonly kindWhatKey = kindWhatKey;
  readonly stateKey = stateKey;
  readonly regionKey = regionKey;
  readonly egressFor = egressFor;
  readonly needsConsent = needsConsent;

  readonly pin = signal('');

  /** OWNER-only (docs/08 §3.7, Q-11). A MEMBER sees the state and whose decision it is. */
  readonly mayChange = computed(() => canChangeConsent(this.auth.role()));

  constructor() {
    // The section is one of several, and its state is only needed here — so it is read on entry rather
    // than held app-wide. A failure leaves the previous state on screen and is reported in the section.
    void this.consent.load();
  }

  /** The `recordedAt` of a purpose, in the app's one timestamp style, or `null`. */
  recordedAtLabel(kind: (typeof CONSENT_KINDS)[number]): string | null {
    const at = this.consent.states().find((record) => record.kind === kind)?.recordedAt ?? null;
    return at === null ? null : syncedAtLabel(at, this.i18n.tag());
  }

  /**
   * The honest note for a purpose, or `null`.
   *
   * Only `EVAL_DATASET` needs one: the record is real and the API enforces it, but nothing consumes it in
   * this build (docs/08 §8.7 is unbuilt), so a row that looked like the other two would be offering a
   * switch that changes nothing yet. A per-purpose key set would be three keys of which two are empty,
   * and an empty catalogue value is a defect this repo's i18n spec already refuses.
   */
  kindNote(kind: (typeof CONSENT_KINDS)[number]): string | null {
    return kind === 'EVAL_DATASET' ? this.i18n.t('consent.evalNotLive') : null;
  }

  async record(kind: (typeof CONSENT_KINDS)[number], state: 'GRANTED' | 'DECLINED' | 'WITHDRAWN'): Promise<void> {
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
