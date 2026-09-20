import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';

import { AuthStore } from '../../core/auth/auth.store';
import { ConsentService } from '../../core/consent/consent.service';
import {
  CONSENT_KINDS,
  canChangeConsent,
  type ConsentKind,
  type ConsentRecord,
  type RecordableConsentState,
} from '../../core/consent/consent.view';
import { I18nService } from '../../core/i18n/i18n.service';
import { ConsentPurposeComponent } from '../../shared/ui/consent-purpose/consent-purpose.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';

/**
 * The **AI & privacy** pane of the account shell — docs/02 §4.18's `AI podešavanja`, docs/08 §6.6.
 *
 * This is the consent surface's settings half (task R-25a): every purpose the deployment would need
 * permission for, its current state, and one primary action plus *Allow* where a change is possible.
 * The other half — the sheet that asks at the moment an entry needs the AI — is `ui-consent-sheet`,
 * and both render the same `ui-consent-purpose` card so the disclosure cannot drift between them.
 *
 * Two things it does not decide for itself. **What would be sent** comes from `aiEgress`, because a
 * provider name hardcoded in client copy is a claim this project has been burned by (ADR-031). **Who
 * may change it** comes from the session's role, because docs/08 §3.7 and Q-11 make granting and
 * withdrawing an OWNER act: the copy is the lawful-basis evidence, so a MEMBER sees the state and is
 * told whose decision it is.
 *
 * @module apps/web/src/app/features/settings
 */
@Component({
  selector: 'fm-ai-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConsentPurposeComponent, IconComponent],
  template: `
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
        <!-- Nothing is routed anywhere in this deployment, so there is no permission to request.
             Saying so is the honest state; three disabled "Allow" buttons would advertise a decision
             that does not exist. -->
        <p class="muted small">{{ i18n.t('consent.egress.none') }}</p>
      } @else {
        @for (kind of kinds; track kind) {
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
  `,
  styles: `
    p {
      margin: 0;
    }
    .muted {
      color: var(--color-text-muted);
    }
    .small {
      font-size: var(--text-sm);
    }
    .error {
      color: var(--color-danger);
    }
  `,
})
export class AiSettingsComponent {
  readonly consent = inject(ConsentService);
  readonly i18n = inject(I18nService);
  private readonly auth = inject(AuthStore);

  /** The purposes, in the order the section lists them (docs/08 §6.6's vocabulary, not the stored one). */
  readonly kinds = CONSENT_KINDS;

  /** OWNER-only (docs/08 §3.7, Q-11). A MEMBER sees the state and whose decision it is. */
  readonly mayChange = computed(() => canChangeConsent(this.auth.role()));

  constructor() {
    // The pane's state is only needed while it is on screen — the shell builds it on selection — so it
    // is read on entry rather than held app-wide. A failure leaves the previous state and reports it.
    void this.consent.load();
  }

  /** The stored record for a purpose, or `null` when the API reported none (which reads `NOT_ASKED`). */
  recordFor(kind: ConsentKind): ConsentRecord | null {
    return this.consent.states().find((record) => record.kind === kind) ?? null;
  }

  async record(kind: ConsentKind, state: RecordableConsentState): Promise<void> {
    await this.consent.record(kind, state, 'settings');
  }
}
