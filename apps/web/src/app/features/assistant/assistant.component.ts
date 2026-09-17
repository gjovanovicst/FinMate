import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import { MoneyComponent, type MoneyWire } from '../../shared/ui/money/money.component';
import {
  canExpand,
  drillThroughLabelKey,
  drillThroughTarget,
  factRows,
  factTotals,
  fallbackNoteKey,
  isProposal,
  narrationKey,
  narrationReasonKey,
  periodLabel,
  phaseOf,
  proposalLabelKey,
  proposalSummary,
  provenanceKey,
  suggestionChips,
  type AnswerPhase,
  type AssistantAnswer,
  type AssistantFacts,
  type Turn,
} from './assistant.view';

/**
 * The assistant — F-23, docs/02 §FL-09 and the `Više › Uvid` slot of its screen map.
 *
 * ## The screen asks; it never computes
 *
 * Every figure on this page arrives in `facts` and is rendered through `fm-money` — the client does
 * no arithmetic on money at all (ADR-003) and cannot, because `answerText` is the backend's sentence
 * and `facts` is the backend's payload. The one thing the client formats is a *date range* in the
 * provenance line, which is presentation of a value the server chose.
 *
 * ## What the screen says about how an answer was worded
 *
 * `narrationMode` and `reason` are rendered **inside the provenance panel**, never as a badge on the
 * card, plus one visible sentence when the fallback was a decision the reader can change (consent, with
 * a link to `/settings`). docs/06 §8.5 used to ask for the fallback to be invisible; the reasoning and
 * the reversal are in {@link narrationKey} — the short version is that a mode every answer shares
 * carries no information, and once narration is routed it is the only statement of which path produced
 * the words.
 *
 * ## The transcript is the client's, and only for this visit
 *
 * `assistantAnswer` has no `conversationId` (docs/06 §8.8: there is no conversation store), so
 * follow-up questions have no context and the thread lives in a signal. It is lost on reload, which
 * the empty state says rather than implying memory the API does not have.
 *
 * ## Why the questions come from the API
 *
 * The starter chips are `assistantSuggestions`, the same closed set the refusal returns. Hardcoding
 * them here would be a second copy of the planner's own question list — the exact drift the intent
 * registry exists to prevent.
 *
 * @module apps/web/src/app/features/assistant
 */
@Component({
  selector: 'fm-assistant',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, MoneyComponent],
  template: `
    <main class="wrap">
      <h1 class="head">{{ i18n.t('assistant.title') }}</h1>
      <p class="muted">{{ i18n.t('assistant.subtitle') }}</p>

      <!--
        (submit), not (ngSubmit). This component imports no forms module, so NgForm is never applied: an
        (ngSubmit) binding still compiles — Angular treats an unknown event name on an element as a DOM
        listener — but it never fires, and the browser's own submit then reloads the whole page.
        Measured before the fix: the URL went /assistant? -> /assistant and no answer arrived.
      -->
      <form class="ask" (submit)="ask($event)" novalidate>
        <label class="ask__label" for="assistant-question">{{ i18n.t('assistant.askLabel') }}</label>
        <div class="ask__row">
          <input
            id="assistant-question"
            class="ask__input"
            type="text"
            autocomplete="off"
            [value]="question()"
            [placeholder]="i18n.t('assistant.placeholder')"
            (input)="onInput($event)"
          />
          <button class="ask__go" type="submit" [disabled]="!canAsk()">
            {{ asking() ? i18n.t('assistant.asking') : i18n.t('assistant.ask') }}
          </button>
        </div>
      </form>

      @if (error()) {
        <p class="alert" role="alert">{{ error() }}</p>
      }

      @if (thread().length === 0) {
        <section class="starters" aria-labelledby="assistant-starters">
          <h2 class="starters__title" id="assistant-starters">
            {{ i18n.t('assistant.starters') }}
          </h2>
          <ul class="chips">
            @for (starter of starters(); track starter) {
              <li>
                <button class="chip" type="button" (click)="useSuggestion(starter)">
                  {{ starter }}
                </button>
              </li>
            }
          </ul>
          <p class="muted">{{ i18n.t('assistant.startersHint') }}</p>
        </section>
      }

      @for (turn of thread(); track turn.id) {
        <article class="turn">
          <p class="turn__question">{{ turn.question }}</p>

          @if (turn.failed) {
            <p class="alert" role="alert">{{ i18n.t('assistant.failed') }}</p>
          }

          @if (turn.answer; as answer) {
            <div class="card" [class.card--refused]="!answer.answered">
              <p class="card__text">{{ answer.answerText }}</p>

              @if (answer.answered && isProposal(answer.facts)) {
                <!-- F-30: a computed plan, not a report. It is labelled as a proposal and it says
                     outright that nothing has been applied — the numbers are for the user to act on. -->
                <section class="proposal">
                  <h3 class="proposal__title">{{ i18n.t('assistant.proposal') }}</h3>
                  <ul class="facts">
                    @for (total of proposalTotals(answer.facts); track total.label) {
                      <li class="facts__row facts__row--total">
                        <span class="facts__label">{{ proposalLabel(total.label) }}</span>
                        <fm-money class="facts__value" [amount]="total.money" />
                      </li>
                    }
                  </ul>
                  @if (proposalSummary(answer.facts).lines.length > 0) {
                    <ul class="facts">
                      @for (row of proposalSummary(answer.facts).lines; track row.label) {
                        <li class="facts__row">
                          <span class="facts__label">{{ row.label }}</span>
                          <!-- The sign is asked for without a direction: the minus means "less", and
                               the money component's direction word would call a reduction an expense. -->
                          <fm-money class="facts__value" [amount]="row.money" [sign]="true" />
                        </li>
                      }
                    </ul>
                  }
                  <p class="proposal__note">{{ i18n.t('assistant.proposalNote') }}</p>
                </section>
              }

              @if (answer.answered) {
                <!-- One panel for every answer, so how it was worded is always reachable and never a
                     badge. The figures live inside it only when the card does not already show them. -->
                <details class="prov">
                  <summary class="prov__summary">{{ provenanceText(answer) }}</summary>
                  @if (!isProposal(answer.facts) && canExpand(answer.facts)) {
                    <ul class="facts">
                      @for (total of factTotals(answer.facts); track total.label) {
                        <li class="facts__row facts__row--total">
                          <span class="facts__label">{{ total.label }}</span>
                          <fm-money class="facts__value" [amount]="total.money" />
                        </li>
                      }
                      @for (row of factRows(answer.facts); track row.label) {
                        <li class="facts__row">
                          <span class="facts__label">{{ row.label }}</span>
                          <fm-money class="facts__value" [amount]="row.money" />
                        </li>
                      }
                    </ul>
                    <p class="prov__meta">{{ answer.provenance.sourceQuery }}</p>
                  }
                  <p class="prov__note">{{ i18n.t(narrationKey(answer.narrationMode)) }}</p>
                  @if (narrationReasonKey(answer.reason); as whyKey) {
                    <p class="prov__note">{{ i18n.t(whyKey) }}</p>
                  }
                </details>

                @if (fallbackNoteKey(answer); as noteKey) {
                  <p class="card__note">
                    {{ i18n.t(noteKey) }}
                    <a class="card__link" routerLink="/settings">{{ i18n.t('assistant.narration.settings') }}</a>
                  </p>
                }
              }

              @if (drillThroughTarget(answer.drillThrough); as target) {
                <a class="card__link" [routerLink]="target.route" [queryParams]="target.queryParams">
                  {{ i18n.t(drillThroughLabelKey(answer.drillThrough)) }}
                </a>
              }
            </div>
          }
        </article>
      }

      @if (suggestionChips(latest()).length > 0) {
        <section class="starters" aria-labelledby="assistant-suggestions">
          <h2 class="starters__title" id="assistant-suggestions">
            {{ i18n.t('assistant.suggestions') }}
          </h2>
          <ul class="chips">
            @for (suggestion of suggestionChips(latest()); track suggestion) {
              <li>
                <button class="chip" type="button" (click)="useSuggestion(suggestion)">
                  {{ suggestion }}
                </button>
              </li>
            }
          </ul>
        </section>
      }
    </main>
  `,
  styles: [
    `
      .wrap {
        max-inline-size: var(--content-max, 48rem);
      }
      .head {
        margin: 0;
        font-size: var(--text-2xl);
      }
      .muted {
        margin: var(--space-1) 0 0;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .ask {
        margin-block: var(--space-5) var(--space-4);
      }
      .ask__label {
        display: block;
        margin-block-end: var(--space-1);
        font-size: var(--text-sm);
        font-weight: 600;
      }
      .ask__row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .ask__input {
        flex: 1 1 16rem;
        min-inline-size: 0;
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        font: inherit;
      }
      .ask__go {
        padding: var(--space-2) var(--space-4);
        border: 0;
        border-radius: var(--radius-md);
        background: var(--color-accent);
        color: var(--color-on-accent);
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      .ask__go:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .alert {
        padding: var(--space-3);
        border-radius: var(--radius-md);
        background: color-mix(in srgb, var(--color-danger) 15%, transparent);
        color: var(--color-danger);
        font-size: var(--text-sm);
      }
      .starters {
        margin-block-start: var(--space-5);
      }
      .starters__title {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--color-text-muted);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .chip {
        padding: var(--space-2) var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: 999px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: var(--text-sm);
        cursor: pointer;
        text-align: start;
      }
      .chip:hover {
        border-color: var(--color-accent);
      }
      .turn {
        margin-block-start: var(--space-5);
      }
      .turn__question {
        margin: 0 0 var(--space-2);
        font-weight: 600;
      }
      .card {
        padding: var(--space-4);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        background: var(--color-surface);
      }
      .card--refused {
        border-style: dashed;
      }
      .card__text {
        margin: 0;
      }
      .card__link {
        display: inline-block;
        margin-block-start: var(--space-3);
        font-size: var(--text-sm);
      }
      .proposal {
        margin-block-start: var(--space-3);
        padding: var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .proposal__title {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: 600;
        text-transform: none;
      }
      .proposal__note {
        margin: var(--space-3) 0 0;
        font-size: var(--text-xs);
        color: var(--color-text-muted);
      }
      .prov {
        margin-block-start: var(--space-3);
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .prov__summary {
        margin: var(--space-3) 0 0;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        cursor: pointer;
      }
      .prov__meta {
        margin: var(--space-2) 0 0;
        font-family: var(--font-mono, monospace);
        font-size: var(--text-xs);
        opacity: 0.7;
      }
      .prov__note {
        margin: var(--space-2) 0 0;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .card__note {
        margin: var(--space-3) 0 0;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .card__note .card__link {
        margin-block-start: 0;
      }
      .facts {
        margin: var(--space-2) 0 0;
        padding: 0;
        list-style: none;
      }
      .facts__row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        justify-content: space-between;
        padding-block: var(--space-1);
        border-block-start: 1px solid var(--color-border);
      }
      .facts__row--total {
        font-weight: 600;
      }
      .facts__label {
        min-inline-size: 0;
        overflow-wrap: anywhere;
      }
      .facts__value {
        margin-inline-start: auto;
      }
    `,
  ],
})
export class AssistantComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);

  readonly question = signal('');
  readonly asking = signal(false);
  readonly thread = signal<readonly Turn[]>([]);
  readonly error = signal<string | null>(null);
  /** The API's canonical answerable questions — one source, also used by a refusal's chips. */
  readonly starters = signal<readonly string[]>([]);

  readonly latest = computed<Turn | null>(() => this.thread().at(-1) ?? null);
  readonly phase = computed<AnswerPhase>(() => phaseOf(this.latest(), this.asking()));
  readonly canAsk = computed(() => !this.asking() && this.question().trim().length > 0);

  /** Cheap keys for `track`, and stable within a session — the thread is never persisted. */
  private turnCount = 0;

  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  constructor() {
    // docs/02 §9, FL-09: *"Composer takes focus on route entry (it is a chat)"*. The capture field is
    // deliberately **not** autofocused (FL-02), because a stray keystroke there creates a transaction;
    // here a keystroke only writes a question, and a chat that needs a click before you can type is
    // not one.
    //
    // The element is found through the host rather than a `viewChild` signal on purpose: a signal
    // query is not populated when this hook runs — it returned `undefined` in both `afterNextRender`
    // and `ngAfterViewInit` under the test harness — and a focus that silently does nothing is worse
    // than one `querySelector` (docs/15).
    afterNextRender(() =>
      this.host.nativeElement.querySelector<HTMLInputElement>('#assistant-question')?.focus(),
    );
    void this.loadStarters();
  }

  // The view module's decisions, re-exposed for the template without logic in it.
  readonly canExpand = canExpand;
  readonly drillThroughLabelKey = drillThroughLabelKey;
  readonly drillThroughTarget = drillThroughTarget;
  readonly factRows = factRows;
  readonly factTotals = factTotals;
  readonly fallbackNoteKey = fallbackNoteKey;
  readonly isProposal = isProposal;
  readonly narrationKey = narrationKey;
  readonly narrationReasonKey = narrationReasonKey;
  readonly proposalSummary = proposalSummary;
  readonly suggestionChips = suggestionChips;

  /** The proposal's headline figures, in the order the plan reads: target, proposed, short by. */
  proposalTotals(facts: AssistantFacts): readonly { label: string; money: MoneyWire }[] {
    const summary = proposalSummary(facts);
    return [
      ...(summary.target === null ? [] : [{ label: 'Target', money: summary.target }]),
      ...(summary.proposed === null ? [] : [{ label: 'Proposed', money: summary.proposed }]),
      ...(summary.shortfall === null ? [] : [{ label: 'Shortfall', money: summary.shortfall }]),
    ];
  }

  /** A localised label for a proposal total, falling back to the server's own word. */
  proposalLabel(label: string): string {
    const key = proposalLabelKey(label);
    return key === null ? label : this.i18n.t(key);
  }

  onInput(event: Event): void {
    this.question.set((event.target as HTMLInputElement).value);
  }

  /** Ask the question in the box. Refuses an empty or in-flight one rather than sending it. */
  /**
   * Ask the assistant.
   *
   * `event` is the form's submit, and cancelling it is not optional: with no forms module the native
   * submit is what a browser does, so without `preventDefault()` the page reloads and no question is
   * ever sent. Optional so the chip path (`useSuggestion`) can call the same method.
   */
  async ask(event?: Event): Promise<void> {
    event?.preventDefault();
    const question = this.question().trim();
    if (question.length === 0 || this.asking()) return;

    this.turnCount += 1;
    const id = `turn-${this.turnCount}`;
    this.thread.update((turns) => [...turns, { id, question, answer: null, failed: false }]);
    this.question.set('');
    this.error.set(null);
    this.asking.set(true);

    try {
      const result = await this.graphql.query<{ assistantAnswer: AssistantAnswer }>(ASSISTANT_QUERY, {
        question,
        // The household's language, so the money in `answerText` is grouped the way the rest of the
        // screen renders it. Without it the server would use its own default locale and the sentence
        // and the figures beside it could disagree for an English reader.
        locale: this.i18n.tag(),
      });
      this.settle(id, { answer: result.assistantAnswer, failed: false });
    } catch (error) {
      this.error.set(this.errors.for(error));
      this.settle(id, { answer: null, failed: true });
    } finally {
      this.asking.set(false);
    }
  }

  /** A chip asks its question immediately: a suggestion the user must copy is not a suggestion. */
  useSuggestion(suggestion: string): void {
    if (this.asking()) return;
    this.question.set(suggestion);
    void this.ask();
  }

  /** The provenance sentence, interpolated here so a `{count}` placeholder can never reach the DOM. */
  provenanceText(answer: AssistantAnswer): string {
    const count = answer.provenance.transactionCount;
    return this.i18n.t(provenanceKey(count), {
      count,
      period: periodLabel(answer.provenance, this.i18n.tag()),
    });
  }

  private settle(id: string, update: { answer: AssistantAnswer | null; failed: boolean }): void {
    this.thread.update((turns) =>
      turns.map((turn) => (turn.id === id ? { ...turn, ...update } : turn)),
    );
  }

  private async loadStarters(): Promise<void> {
    try {
      const result = await this.graphql.query<{ assistantSuggestions: readonly string[] }>(
        STARTERS_QUERY,
      );
      this.starters.set(result.assistantSuggestions);
    } catch {
      // The starters are an invitation, not part of the question path: a failure here leaves the
      // composer working and shows no chips, rather than blocking the screen with an error the user
      // can do nothing about.
      this.starters.set([]);
    }
  }
}

const ASSISTANT_QUERY = /* GraphQL */ `
  query AssistantAnswer($question: String!, $locale: String) {
    assistantAnswer(question: $question, locale: $locale) {
      id
      question
      intent
      answered
      answerText
      suggestions
      narrationMode
      latencyMs
      costMicros
      reason
      facts {
        template
        rows {
          label
          value
          formatted
          categoryId
          merchantId
        }
        totals {
          label
          # Money is a SCALAR: a selection set on it is a validation error the client cannot see
          # until the request is made, which is how this shipped broken in 3.2.4 (docs/15).
          money
          formatted
        }
        formatted
      }
      provenance {
        periodStart
        periodEnd
        transactionCount
        sourceQuery
        filters
        computedAt
        ledgerCurrency
      }
      drillThrough {
        route
        transactionIds
        filter
      }
    }
  }
`;

const STARTERS_QUERY = /* GraphQL */ `
  query AssistantSuggestions {
    assistantSuggestions
  }
`;
