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

import { uuidv7 } from '@finmate/domain';

import { ErrorMessageService, apiErrorCode } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { MoneyComponent, type MoneyWire } from '../../shared/ui/money/money.component';
import {
  actionDiffRows,
  actionRefusalKey,
  canExpand,
  drillThroughLabelKey,
  drillThroughTarget,
  expiryTime,
  factRows,
  factTotals,
  fallbackNoteKey,
  isProposal,
  kindChoice,
  narrationKey,
  narrationReasonKey,
  periodLabel,
  phaseOf,
  proposalLabelKey,
  proposalSummary,
  provenanceKey,
  renderableProposal,
  suggestionChips,
  undoPlan,
  type ActionProposal,
  type ActionResult,
  type AnswerPhase,
  type AssistantActionName,
  type AssistantAnswer,
  type AssistantFacts,
  type KindChoice,
  type Turn,
  type TurnAction,
  type UndoPlan,
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

          <!--
            B-2b: the write the question asked for. It sits beside the card rather than inside it
            because it is not an *answer* — the ledger refused to answer, and this is the offer the
            refusal made possible. Nothing here has happened until the Confirm button is pressed, and
            the card says so (ADR-035).
          -->
          @if (turn.action; as action) {
            @if (action.result; as result) {
              <section class="act act--done" [attr.aria-labelledby]="'act-done-' + turn.id">
                <h3 class="act__title" [id]="'act-done-' + turn.id">
                  {{ i18n.t('assistant.action.done') }}
                </h3>
                <p class="act__sentence">{{ result.sentence }}</p>
                @if (result.replayed) {
                  <!-- The retry landed on an outcome the server had already recorded. Saying so is the
                       difference between "it worked" and "it worked, and only once". -->
                  <p class="act__note">{{ i18n.t('assistant.action.replayed') }}</p>
                }
                @if (action.undone) {
                  <p class="act__note">
                    {{ i18n.t('assistant.action.undone', { name: result.createdLabel }) }}
                  </p>
                } @else if (undoPlan(result); as plan) {
                  <button
                    class="act__undo"
                    type="button"
                    [disabled]="action.undoing"
                    (click)="undo(turn, plan)"
                  >
                    {{ action.undoing ? i18n.t('assistant.action.undoing') : i18n.t('assistant.action.undo') }}
                  </button>
                }
                <a class="card__link" routerLink="/categories">
                  {{ i18n.t('assistant.action.openCategories') }}
                </a>
              </section>
            } @else if (renderableProposal(action.proposal); as proposal) {
              <section class="act" [attr.aria-labelledby]="'act-' + turn.id">
                <h3 class="act__title" [id]="'act-' + turn.id">
                  {{ i18n.t('assistant.action.title') }}
                </h3>
                <!-- The sentence is the backend's, never the model's: a write confirmation carries
                     figures and names, so ADR-017 applies to it exactly as to an answer. -->
                <p class="act__sentence">{{ proposal.preview.sentence }}</p>

                <ul class="act__diff">
                  @for (row of actionDiffRows(proposal.preview); track row.slot) {
                    <li class="act__row">
                      <span class="act__field">{{ row.field }}</span>
                      <span class="act__value">{{ row.after }}</span>
                      @if (row.defaulted) {
                        <span class="act__flag">{{ i18n.t('assistant.action.defaulted') }}</span>
                      }
                    </li>
                  }
                </ul>

                @if (kindChoice(proposal.preview); as choice) {
                  <!-- The one field the card may change, offered because the server flagged the row as
                       "defaulted" — a kind the question stated is not a suggestion to revise. Never put a
                       backtick in this literal, not even in a comment (AGENTS.md). -->
                  <div class="act__kind" role="group" [attr.aria-label]="i18n.t('assistant.action.kind')">
                    <span class="act__field">{{ i18n.t('assistant.action.kind') }}</span>
                    @for (option of kindOptions(choice); track option.kind) {
                      <button
                        class="act__toggle"
                        type="button"
                        [attr.aria-pressed]="option.active"
                        [disabled]="action.switching || action.stale"
                        (click)="setKind(turn, option.kind)"
                      >
                        {{ i18n.t(option.key) }}
                      </button>
                    }
                  </div>
                }

                <p class="act__note">{{ i18n.t('assistant.action.note') }}</p>
                @if (!action.stale) {
                  <button
                    class="act__confirm"
                    type="button"
                    [disabled]="action.confirming"
                    (click)="confirm(turn)"
                  >
                    {{ action.confirming ? i18n.t('assistant.action.confirming') : i18n.t('assistant.action.confirm') }}
                  </button>
                }
                @if (expiryLabel(proposal.expiresAt); as time) {
                  <p class="act__expiry">{{ i18n.t('assistant.action.expires', { time }) }}</p>
                }
              </section>
            } @else if (actionNoteKey(action.proposal); as noteKey) {
              <!-- UNRUNNABLE: the request was unmistakable and did not say what to write. An ordinary
                   NOT_AN_ACTION says nothing here, because the refusal above already did. -->
              <p class="card__note">{{ i18n.t(noteKey) }}</p>
            }

            @if (action.error) {
              <p class="alert" role="alert">{{ action.error }}</p>
            }
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
      .act {
        margin-block-start: var(--space-3);
        padding: var(--space-4);
        border: 1px solid var(--color-primary-text);
        border-radius: var(--radius-lg);
        background: color-mix(in srgb, var(--color-accent) 6%, transparent);
      }
      .act--done {
        background: color-mix(in srgb, var(--color-accent) 12%, transparent);
      }
      .act__title {
        margin: 0 0 var(--space-2);
        font-size: var(--text-sm);
        font-weight: 600;
      }
      .act__sentence {
        margin: 0;
        font-weight: 600;
      }
      .act__diff {
        margin: var(--space-3) 0 0;
        padding: 0;
        list-style: none;
      }
      .act__row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: baseline;
        padding-block: var(--space-1);
        border-block-start: 1px solid var(--color-border);
      }
      .act__field {
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .act__value {
        margin-inline-start: auto;
        overflow-wrap: anywhere;
      }
      .act__flag {
        flex-basis: 100%;
        color: var(--color-text-muted);
        font-size: var(--text-xs);
      }
      .act__kind {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: center;
        margin-block-start: var(--space-3);
      }
      .act__toggle,
      .act__confirm,
      .act__undo {
        min-block-size: var(--control-size, 2.75rem);
        padding: var(--space-2) var(--space-4);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface);
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .act__toggle[aria-pressed='true'] {
        border-color: var(--color-primary-text);
        font-weight: 600;
      }
      .act__confirm {
        margin-block-start: var(--space-4);
        border: 0;
        background: var(--color-accent);
        color: var(--color-on-accent);
        font-weight: 600;
      }
      .act__confirm:disabled,
      .act__toggle:disabled,
      .act__undo:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .act__note,
      .act__expiry {
        margin: var(--space-3) 0 0;
        font-size: var(--text-xs);
        color: var(--color-text-muted);
      }
      .act__undo {
        margin-block-start: var(--space-3);
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

    let refused = false;
    try {
      const result = await this.graphql.query<{ assistantAnswer: AssistantAnswer }>(ASSISTANT_QUERY, {
        question,
        // The household's language, so the money in `answerText` is grouped the way the rest of the
        // screen renders it. Without it the server would use its own default locale and the sentence
        // and the figures beside it could disagree for an English reader.
        locale: this.i18n.tag(),
      });
      this.settle(id, { answer: result.assistantAnswer, failed: false });
      refused = !result.assistantAnswer.answered;
    } catch (error) {
      this.error.set(this.errors.for(error));
      this.settle(id, { answer: null, failed: true });
    } finally {
      this.asking.set(false);
    }

    // **The answer wins, and this is why.** A write is offered only for a question the ledger could not
    // answer, so a question that *is* answerable is never turned into an offer to change something —
    // and no proposal is created that nobody sees (docs/06 §8.16). Asking after the answer rather than
    // in parallel costs one round trip on a refusal and nothing on the ordinary path.
    if (refused) await this.offerAction(id, question);
  }

  /** A chip asks its question immediately: a suggestion the user must copy is not a suggestion. */
  useSuggestion(suggestion: string): void {
    if (this.asking()) return;
    this.question.set(suggestion);
    void this.ask();
  }

  /**
   * Confirm the proposal: the only call in this component that can change the ledger.
   *
   * Two arguments, and neither is the action's content. The `proposalId` is the server's own reference
   * to what it stored, and the `idempotencyKey` was minted once when the card was rendered — so a
   * double-click, a retry, or a click after a timeout all describe **one** intended write, and the
   * server can answer the second call with the first call's outcome (ADR-035 decision 2).
   */
  async confirm(turn: Turn): Promise<void> {
    const action = turn.action ?? null;
    const proposal = action === null ? null : renderableProposal(action.proposal);
    if (action === null || proposal === null || action.confirming) return;

    this.patchAction(turn.id, { confirming: true, error: null });
    try {
      const result = await this.graphql.query<{ assistantExecuteAction: ActionResult }>(
        EXECUTE_ACTION,
        { proposalId: proposal.proposalId, idempotencyKey: action.idempotencyKey },
      );
      this.patchAction(turn.id, { result: result.assistantExecuteAction, confirming: false });
    } catch (error) {
      // `NOT_FOUND` means the proposal is gone — expired, or consumed by an earlier click. The server
      // consumed the proposal *before* attempting the write, so a retry cannot work and the card stops
      // offering one; every other failure may still be retried with the same idempotency key, which is
      // exactly what that key is for (R-29).
      const lapsed = apiErrorCode(error) === 'NOT_FOUND';
      this.patchAction(turn.id, {
        confirming: false,
        stale: lapsed,
        error: lapsed ? this.i18n.t('assistant.action.expired') : this.actionErrorMessage(error),
      });
    }
  }

  /** Take the completed action back, through the same mutation `/categories` uses. */
  async undo(turn: Turn, plan: UndoPlan): Promise<void> {
    const action = turn.action ?? null;
    if (action === null || action.undoing) return;

    this.patchAction(turn.id, { undoing: true, error: null });
    try {
      await this.graphql.query(UNDO_MUTATIONS[plan.action], { id: plan.id });
      this.patchAction(turn.id, { undoing: false, undone: true });
    } catch (error) {
      this.patchAction(turn.id, { undoing: false, error: this.actionErrorMessage(error) });
    }
  }

  /**
   * Replace the proposal with one of the other kind.
   *
   * Supplying `kind` **re-proposes** rather than editing the stored proposal, which is what keeps the
   * confirmation honest: the id a person confirms always names the action they were shown. The new
   * proposal therefore gets a **new idempotency key** — reusing the old one would let the server replay
   * the previous kind's outcome.
   */
  async setKind(turn: Turn, kind: 'EXPENSE' | 'INCOME'): Promise<void> {
    const action = turn.action ?? null;
    if (action === null || action.switching) return;

    this.patchAction(turn.id, { switching: true, error: null });
    try {
      const result = await this.graphql.query<{ assistantProposeAction: ActionProposal | null }>(
        PROPOSE_ACTION,
        { question: turn.question, kind, locale: this.i18n.tag() },
      );
      const proposal = result.assistantProposeAction ?? null;
      if (renderableProposal(proposal) === null) {
        // Nothing drawable came back. The old card stays rather than being replaced by a blank one.
        const key = actionRefusalKey(proposal?.reason);
        this.patchAction(turn.id, {
          switching: false,
          ...(key === null ? {} : { error: this.i18n.t(key) }),
        });
        return;
      }
      this.patchAction(turn.id, {
        proposal,
        idempotencyKey: uuidv7(),
        result: null,
        switching: false,
      });
    } catch (error) {
      this.patchAction(turn.id, { switching: false, error: this.actionErrorMessage(error) });
    }
  }

  /** The two kind options, with the one the server currently proposes marked active. */
  kindOptions(choice: KindChoice): readonly {
    kind: 'EXPENSE' | 'INCOME';
    active: boolean;
    key: 'assistant.action.kindExpense' | 'assistant.action.kindIncome';
  }[] {
    return (['EXPENSE', 'INCOME'] as const).map((kind) => ({
      kind,
      active: kind === choice.current,
      key: kind === 'EXPENSE' ? 'assistant.action.kindExpense' : 'assistant.action.kindIncome',
    }));
  }

  /** When the offer lapses, in the reader's own clock — or `null` when the server sent none. */
  expiryLabel(at: string | null): string | null {
    return expiryTime(at, this.i18n.tag());
  }

  /** What to say when the server declined to propose, or `null` for the ordinary `NOT_AN_ACTION`. */
  actionNoteKey(proposal: ActionProposal | null): TranslationKey | null {
    return actionRefusalKey(proposal?.reason);
  }

  // The write path's view decisions, re-exposed for the template without logic in it.
  readonly actionDiffRows = actionDiffRows;
  readonly kindChoice = kindChoice;
  readonly renderableProposal = renderableProposal;
  readonly undoPlan = undoPlan;

  /**
   * Ask whether the question was a request to **write** something.
   *
   * Only ever called for a refused answer, and `NOT_AN_ACTION` — by far the most common reply — leaves
   * the turn exactly as a refusal left it. A failure here does **not** turn the refusal into a failure:
   * the ledger's answer stands, and the write offer is an extra the user never asked for by name.
   */
  private async offerAction(turnId: string, question: string): Promise<void> {
    try {
      const result = await this.graphql.query<{ assistantProposeAction: ActionProposal | null }>(
        PROPOSE_ACTION,
        { question, locale: this.i18n.tag() },
      );
      // A response with no proposal field at all is treated as "not an action": there is nothing to
      // draw, and the answer above already refused. Only a *stated* reason earns a sentence.
      const proposal = result.assistantProposeAction ?? null;
      if (renderableProposal(proposal) === null && actionRefusalKey(proposal?.reason) === null) {
        return;
      }
      this.setAction(turnId, {
        proposal,
        idempotencyKey: uuidv7(),
        result: null,
        confirming: false,
        switching: false,
        undoing: false,
        undone: false,
        stale: false,
        error: null,
      });
    } catch (error) {
      this.setAction(turnId, {
        proposal: null,
        idempotencyKey: uuidv7(),
        result: null,
        confirming: false,
        switching: false,
        undoing: false,
        undone: false,
        stale: false,
        error: this.actionErrorMessage(error),
      });
    }
  }

  /**
   * A failed **write**, in the reader's language.
   *
   * `CONFLICT` gets its own sentence, because the server's message names the clashing Category and the
   * generic localized one ("something with those details already exists") hides the only thing the
   * reader can act on. Everything else goes through the shared mapper, which localises by code.
   */
  private actionErrorMessage(error: unknown): string {
    return apiErrorCode(error) === 'CONFLICT'
      ? this.i18n.t('assistant.action.taken')
      : this.errors.for(error);
  }

  private setAction(turnId: string, action: TurnAction): void {
    this.thread.update((turns) =>
      turns.map((turn) => (turn.id === turnId ? { ...turn, action } : turn)),
    );
  }

  private patchAction(turnId: string, patch: Partial<TurnAction>): void {
    this.thread.update((turns) =>
      turns.map((turn) =>
        turn.id === turnId && turn.action != null
          ? { ...turn, action: { ...turn.action, ...patch } }
          : turn,
      ),
    );
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

/**
 * Propose a write.
 *
 * A **mutation**, which is the API's own decision and was a Query until `ADD_TRANSACTION` (docs/06
 * §8.16): proposing a transaction runs the classification pipeline, which records an audit row and may
 * call a model, and `captureParse` is a Mutation for exactly that reason. The document keyword is the
 * client's whole contribution to that distinction — the transport is the same POST either way.
 */
const PROPOSE_ACTION = /* GraphQL */ `
  mutation AssistantProposeAction(
    $question: String!
    $kind: CategoryKind
    $accountId: ID
    $locale: String
  ) {
    assistantProposeAction(question: $question, kind: $kind, accountId: $accountId, locale: $locale) {
      proposed
      reason
      proposalId
      action
      preview {
        sentence
        diff {
          slot
          field
          before
          after
          afterValue
          defaulted
        }
        lines {
          label
          # Money is a SCALAR: a selection set on it is a validation error (docs/15). No backticks
          # here — this document is a template literal, and one would end it (AGENTS.md).
          amount
          category
          occurredOn
          needsReview
        }
      }
      expiresAt
    }
  }
`;

/**
 * Perform the approved write — the only request in this component that changes the ledger.
 *
 * Note what is **not** sent: the action, the name, the kind, the parent. The server re-reads the
 * proposal it stored, so the write is byte-for-byte the one the card rendered (ADR-035 decision 2).
 */
const EXECUTE_ACTION = /* GraphQL */ `
  mutation AssistantExecuteAction($proposalId: UUID!, $idempotencyKey: String!) {
    assistantExecuteAction(proposalId: $proposalId, idempotencyKey: $idempotencyKey) {
      action
      createdId
      createdLabel
      undo
      sentence
      replayed
    }
  }
`;

/**
 * How each action is taken back.
 *
 * `Record<AssistantActionName, …>` and not a `switch` with a default, for the reason the server's
 * registry is a `Record`: a default arm would let an action the client knows nothing about be "undone"
 * by whatever the fall-through happened to call. {@link undoPlan} refuses instead — a card whose action
 * this client cannot undo offers no Undo control at all, which is honest and never wrong.
 *
 * The one entry calls `deleteCategory`, the same mutation `/categories` calls. The server declares the
 * action's undo as `SOFT_DELETE`, and a soft delete is what this is.
 */
const UNDO_MUTATIONS: Readonly<Record<AssistantActionName, string>> = {
  ADD_CATEGORY: /* GraphQL */ `
    mutation AssistantUndoAddCategory($id: ID!) {
      deleteCategory(id: $id)
    }
  `,
};
