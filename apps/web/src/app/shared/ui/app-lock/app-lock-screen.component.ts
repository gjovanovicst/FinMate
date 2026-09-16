import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AppLockService } from '../../../core/app-lock/app-lock.service';
import { PIN_LENGTH, lockFailureKey, unlockOffers } from '../../../core/app-lock/lock.view';
import { AuthStore } from '../../../core/auth/auth.store';
import { I18nService } from '../../../core/i18n/i18n.service';
import { SyncService } from '../../../core/offline/sync.service';

/**
 * The re-auth screen — docs/08 §3.9's *"Re-auth on cold start and after 5 minutes idle"*.
 *
 * The shell renders this **instead of** the navigation and the router outlet while the app lock is
 * `LOCKED`, so it is a gate rather than a dialog somebody can dismiss: there is no route to navigate
 * to and no control behind it. That is also why the store shows nothing while it is up — the data key
 * is not in memory (ADR-029 decision 5), so the queue, the snapshot and the taxonomy cache all read
 * as empty by construction rather than by a rule this screen has to enforce.
 *
 * The prompt is never raised on load: WebAuthn requires a user gesture, and a screen that asked
 * automatically would re-prompt on every reload until the user gave up. The PIN field is the one
 * control that is always available for a PIN-armed lock, and it is focused so a keyboard user can
 * type without reaching for the mouse.
 *
 * @module apps/web/src/app/shared/ui/app-lock
 */
@Component({
  selector: 'fm-app-lock-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="lock" role="dialog" aria-modal="true" [attr.aria-label]="i18n.t('lock.screen.title')">
      <h1 class="lock__title">{{ i18n.t('lock.screen.title') }}</h1>
      <p class="lock__body">{{ i18n.t('lock.screen.body') }}</p>

      @if (offers().biometric) {
        <button type="button" class="lock__primary" [disabled]="lock.busy()" (click)="unlockWithDevice()">
          {{ i18n.t('lock.screen.unlockWithDevice') }}
        </button>
      }

      @if (offers().pin) {
        <form class="lock__form" (submit)="unlockWithPin($event)">
          <label class="lock__label" for="lock-pin">{{ i18n.t('lock.screen.pinLabel') }}</label>
          <input
            id="lock-pin"
            class="lock__input"
            type="password"
            inputmode="numeric"
            autocomplete="off"
            maxlength="6"
            [value]="pin()"
            (input)="setPin($event)"
            [attr.aria-invalid]="failed() ? 'true' : null"
            [attr.aria-describedby]="failed() ? 'lock-error' : null"
          />
          <button type="submit" class="lock__primary" [disabled]="lock.busy() || pin().length !== 6">
            {{ i18n.t('lock.screen.unlock') }}
          </button>
        </form>
      }

      @if (lock.busy()) {
        <p class="lock__muted" role="status">{{ i18n.t('lock.screen.working') }}</p>
      }
      @if (failed() !== null) {
        <p id="lock-error" class="lock__error" role="alert">{{ i18n.t(failed()!) }}</p>
      }

      <!-- The way out for somebody who is not the owner: no data is readable, and signing out wipes
           the database rather than leaving it for the next person (ADR-025 decision 6). -->
      <button type="button" class="lock__signout" [disabled]="signingOut()" (click)="signOut()">
        {{ i18n.t('lock.screen.signOut') }}
      </button>
    </main>
  `,
  styles: `
    .lock {
      max-inline-size: 24rem;
      margin: 12vh auto 0;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      /* No fixed widths beyond a readable cap: 320 px still lays out (docs/02 §9). */
      inline-size: 100%;
      box-sizing: border-box;
      text-align: center;
    }
    .lock__title {
      font-size: 1.3rem;
      margin: 0;
    }
    .lock__body {
      margin: 0;
      color: var(--color-text-muted);
    }
    .lock__form {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      text-align: start;
    }
    .lock__label {
      font-size: 0.9rem;
    }
    .lock__input {
      font-size: 1.4rem;
      letter-spacing: 0.4em;
      padding: 0.5rem;
      inline-size: 100%;
      box-sizing: border-box;
      text-align: center;
    }
    .lock__primary {
      padding: 0.6rem 1rem;
      font-size: 1rem;
      cursor: pointer;
    }
    .lock__muted {
      color: var(--color-text-muted);
      margin: 0;
    }
    .lock__error {
      color: var(--color-danger);
      margin: 0;
    }
    .lock__signout {
      margin-block-start: 0.5rem;
      background: none;
      border: 0;
      color: var(--color-text-muted);
      text-decoration: underline;
      cursor: pointer;
    }
  `,
})
export class AppLockScreenComponent {
  private readonly auth = inject(AuthStore);
  private readonly sync = inject(SyncService);
  readonly lock = inject(AppLockService);
  readonly i18n = inject(I18nService);

  readonly pin = signal('');
  readonly signingOut = signal(false);

  /** Which controls this lock accepts (see `unlockOffers`). */
  readonly offers = computed(() => unlockOffers(this.lock.method()));

  /** The sentence for the last failure, if there was one. */
  readonly failed = computed(() => {
    const failure = this.lock.failure();
    return failure === null ? null : lockFailureKey(failure);
  });

  setPin(event: Event): void {
    // Digits only, capped at six: an input that accepts letters can only produce a failure that looks
    // like a wrong PIN.
    const digits = (event.target as HTMLInputElement).value.replace(/\D/g, '').slice(0, PIN_LENGTH);
    this.pin.set(digits);
  }

  async unlockWithPin(event: Event): Promise<void> {
    event.preventDefault();
    if (this.pin().length !== PIN_LENGTH) return;
    const ok = await this.lock.unlockWithPin(this.pin());
    this.pin.set('');
    if (ok) await this.afterUnlock();
  }

  async unlockWithDevice(): Promise<void> {
    const ok = await this.lock.unlockWithWebAuthn();
    if (ok) await this.afterUnlock();
  }

  async signOut(): Promise<void> {
    this.signingOut.set(true);
    try {
      await this.auth.signOut();
    } finally {
      // The lock goes with the wipe (ADR-029 decision 9), so there is nothing left to unlock.
      await this.lock.purge();
      this.signingOut.set(false);
    }
  }

  /**
   * The queue is re-read the moment the key is back.
   *
   * The store's backing switches from memory to IndexedDB on unlock (ADR-029 decision 5), so every
   * count on screen is stale by definition — including the header chip's, which is the one a user
   * would notice as a lie.
   */
  private async afterUnlock(): Promise<void> {
    await this.sync.refresh();
  }
}
