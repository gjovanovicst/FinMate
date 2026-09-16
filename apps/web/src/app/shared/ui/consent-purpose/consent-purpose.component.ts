import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { I18nService } from '../../../core/i18n/i18n.service';
import {
  egressFor,
  kindNameKey,
  kindWhatKey,
  needsConsent as needsConsentFor,
  regionKey,
  stateKey,
  type AiEgressEntry,
  type ConsentKind,
  type ConsentRecord,
  type RecordableConsentState,
} from '../../../core/consent/consent.view';
import { syncedAtLabel } from '../../../core/offline/sync.view';

/**
 * One consent purpose, disclosed — docs/08 §6.6, ADR-032.
 *
 * ## Why this is a component and not a block of template
 *
 * Two screens show the same disclosure: `/settings`, where a Household decides deliberately, and the
 * first-use sheet (task 5.2a), which asks at the moment an entry needs the model. The *logic* was
 * already shared (`consent.view.ts`); the risk here is the markup — two renderings of "what is sent,
 * where, and what is never sent" can drift, and the one that drifts is the one somebody consents to.
 * One component, used twice.
 *
 * ## What it may and may not decide
 *
 * It renders; it does not fetch, and it does not choose the verbs. `decide` carries the state the caller
 * should record and nothing else, so the sheet can offer *Allow/Decline/Not now* while settings offers
 * *Allow/Decline* or *Withdraw* without either screen owning a second copy of the rules. `showActions`
 * exists for exactly that: the sheet puts its own buttons under the disclosure rather than inside it.
 *
 * @module apps/web/src/app/shared/ui/consent-purpose
 */
@Component({
  selector: 'fm-consent-purpose',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article class="purpose">
      <h3>{{ i18n.t(nameKey()) }}</h3>
      <p class="muted small">{{ i18n.t(whatKey()) }}</p>

      @for (route of egress(); track route.task) {
        <p class="muted small">
          {{ i18n.t('consent.egress', { provider: route.provider, region: i18n.t(regionKey(route.region)) }) }}
        </p>
      }
      @if (needsConsent()) {
        <p class="muted small">{{ i18n.t('consent.egress.nonEea') }}</p>
      }

      <p class="state">
        <strong>{{ i18n.t(stateKey(state())) }}</strong>
        @if (recordedAtLabel(); as recorded) {
          <span class="muted small">{{ i18n.t('consent.recorded', { time: recorded }) }}</span>
        }
      </p>

      @if (note(); as text) {
        <p class="muted small">{{ text }}</p>
      }

      @if (showActions()) {
        @if (mayChange()) {
          <div class="actions">
            @if (state() === 'GRANTED') {
              <button type="button" class="btn btn--danger" [disabled]="saving()" (click)="decide.emit('WITHDRAWN')">
                {{ i18n.t('consent.withdraw') }}
              </button>
            } @else {
              <button type="button" class="btn" [disabled]="saving()" (click)="decide.emit('GRANTED')">
                {{ i18n.t('consent.allow') }}
              </button>
              @if (state() === 'NOT_ASKED') {
                <!-- Present only while the question is open. Once somebody has declined, "Decline" again
                     would be a button that changes nothing. -->
                <button type="button" class="btn" [disabled]="saving()" (click)="decide.emit('DECLINED')">
                  {{ i18n.t('consent.decline') }}
                </button>
              }
            }
          </div>
        } @else {
          <p class="muted small">{{ i18n.t('consent.ownerOnly') }}</p>
        }
      }
    </article>
  `,
  styles: `
    .purpose {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    h3 {
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
      font-size: 0.85rem;
    }
    .state {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: baseline;
      margin-block-start: 0.25rem;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-block-start: 0.25rem;
    }
  `,
})
export class ConsentPurposeComponent {
  readonly i18n = inject(I18nService);

  readonly kind = input.required<ConsentKind>();
  /** The stored record, or `null` for a purpose the API did not mention — which reads `NOT_ASKED`. */
  readonly record = input<ConsentRecord | null>(null);
  readonly routes = input.required<readonly AiEgressEntry[]>();
  readonly mayChange = input(false);
  readonly saving = input(false);
  /** False when the caller renders the verbs itself — the first-use sheet does. */
  readonly showActions = input(true);

  readonly decide = output<RecordableConsentState>();

  readonly nameKey = computed(() => kindNameKey(this.kind()));
  readonly whatKey = computed(() => kindWhatKey(this.kind()));
  readonly state = computed(() => this.record()?.state ?? 'NOT_ASKED');
  readonly egress = computed(() => egressFor(this.routes(), this.kind()));
  readonly needsConsent = computed(() => needsConsentFor(this.routes(), this.kind()));

  readonly recordedAtLabel = computed(() => {
    const at = this.record()?.recordedAt ?? null;
    return at === null ? null : syncedAtLabel(at, this.i18n.tag());
  });

  /**
   * The honest note for a purpose, or `null`.
   *
   * Only `EVAL_DATASET` needs one: the record is real and the API enforces it, but nothing consumes it in
   * this build (docs/08 §8.7 is unbuilt), so a row that looked like the other two would be offering a
   * switch that changes nothing yet.
   */
  readonly note = computed(() =>
    this.kind() === 'EVAL_DATASET' ? this.i18n.t('consent.evalNotLive') : null,
  );

  /** Exposed for the template, which cannot call an imported function directly. */
  readonly regionKey = regionKey;
  readonly stateKey = stateKey;
}
