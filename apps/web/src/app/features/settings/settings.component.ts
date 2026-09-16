import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AppLockService } from '../../core/app-lock/app-lock.service';
import {
  PIN_LENGTH,
  isValidPin,
  lockFailureKey,
  lockMessageKey,
} from '../../core/app-lock/lock.view';
import { I18nService } from '../../core/i18n/i18n.service';
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
 * the two rows here are a real control and a link to the screen that already owns its content.
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
  `,
})
export class SettingsComponent {
  private readonly sync = inject(SyncService);
  readonly lock = inject(AppLockService);
  readonly i18n = inject(I18nService);

  readonly isValidPin = isValidPin;
  readonly lockMessageKey = lockMessageKey;
  /** Exposed for the template, which cannot call an imported function directly. */
  readonly failureKey = lockFailureKey;

  readonly pin = signal('');

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
