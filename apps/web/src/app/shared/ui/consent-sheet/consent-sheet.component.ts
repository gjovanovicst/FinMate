import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import {
  kindNameKey,
  type AiEgressEntry,
  type ConsentKind,
  type ConsentRecord,
  type RecordableConsentState,
} from '../../../core/consent/consent.view';
import { I18nService } from '../../../core/i18n/i18n.service';
import { ConsentPurposeComponent } from '../consent-purpose/consent-purpose.component';

/**
 * The first-use consent sheet — docs/08 §6.6, ADR-032, task 5.2a.
 *
 * ## What §6.6 asks for, and what this is
 *
 * "Requested at **first use**, not buried in onboarding — the first fragment that fails rules resolution
 * … opens an inline sheet in plain Serbian/English naming the provider, the region, what is sent and what
 * is never sent (§6.4), including one sentence of the §6.1 trade." The screen that owns that first use is
 * `/capture`, and this is the sheet it opens.
 *
 * ## Three answers, and only two of them are decisions
 *
 * **Allow** and **Decline** are the decisions, and they are the same weight: §6.6 says declining is a
 * first-class button, not a dark-pattern link. **Not now** is the third — it defers without deciding, and
 * deliberately writes nothing, because "I have not decided" is not a consent state the table has
 * (`NOT_ASKED` is the absence of a row, and writing a row to say "asked and unanswered" would be evidence
 * of a decision nobody made). The *caller* owns not asking again in this visit; the sheet does not nag on
 * its own.
 *
 * ## It discloses, it does not decide what to disclose
 *
 * The provider, the region, what is sent and what is never sent all come from the purpose card, which
 * `/settings` renders too — so the two screens cannot drift about what somebody is agreeing to.
 *
 * @module apps/web/src/app/shared/ui/consent-sheet
 */
@Component({
  selector: 'fm-consent-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ConsentPurposeComponent],
  template: `
    <!-- Call the signal: an attribute binding stringifies whatever it is given, so a missing pair of
         parentheses renders a Computed wrapper as the label — naming no element, silently. -->
    <section class="sheet" role="region" [attr.aria-labelledby]="headingId()">
      <h2 class="sheet__title" [id]="headingId()">{{ i18n.t('consent.ask.title') }}</h2>
      <p class="muted">{{ i18n.t(whyKey()) }}</p>

      <fm-consent-purpose
        [kind]="kind()"
        [record]="record()"
        [routes]="routes()"
        [showActions]="false"
      />

      <p class="muted small">{{ i18n.t('consent.neverSent') }}</p>
      <p class="muted small">{{ i18n.t('consent.trade') }}</p>

      @if (mayChange()) {
        <div class="actions">
          <button type="button" class="btn" [disabled]="saving()" (click)="decide.emit('GRANTED')">
            {{ i18n.t('consent.allow') }}
          </button>
          <button type="button" class="btn" [disabled]="saving()" (click)="decide.emit('DECLINED')">
            {{ i18n.t('consent.decline') }}
          </button>
          <button type="button" class="link" [disabled]="saving()" (click)="dismiss.emit()">
            {{ i18n.t('consent.ask.notNow') }}
          </button>
        </div>
      } @else {
        <!-- docs/08 §6.6: a Member is told whose decision this is rather than shown a control they
             cannot use. -->
        <p class="muted small">{{ i18n.t('consent.ownerOnly') }}</p>
        <button type="button" class="link" (click)="dismiss.emit()">{{ i18n.t('consent.ask.notNow') }}</button>
      }
    </section>
  `,
  styles: `
    .sheet {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      border: 1px solid var(--color-border);
      border-radius: 0.5rem;
      background: var(--color-surface-raised);
    }
    .sheet__title {
      font-size: 1.1rem;
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
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
    }
  `,
})
export class ConsentSheetComponent {
  readonly i18n = inject(I18nService);

  readonly kind = input.required<ConsentKind>();
  readonly record = input<ConsentRecord | null>(null);
  readonly routes = input.required<readonly AiEgressEntry[]>();
  readonly mayChange = input(false);
  readonly saving = input(false);

  readonly decide = output<RecordableConsentState>();
  readonly dismiss = output<void>();

  /** A stable id so the region is labelled by its own heading, not by whatever is near it. */
  readonly headingId = computed(() => `consent-ask-${this.kind().toLowerCase()}`);

  /**
   * Why the question is being asked *now*.
   *
   * The sheet exists because a specific thing just happened, and saying which thing is the difference
   * between an explanation and an interruption. Per purpose, because "your entry could not be
   * categorised" is true of text and false of a receipt photo.
   */
  readonly whyKey = computed(() =>
    this.kind() === 'CLOUD_OCR' ? 'consent.ask.whyOcr' : this.kind() === 'EVAL_DATASET' ? 'consent.ask.whyEval' : 'consent.ask.whyText',
  );

  /** Exposed for the template's heading, so a reader can see which purpose is being asked about. */
  readonly nameKey = computed(() => kindNameKey(this.kind()));
}
