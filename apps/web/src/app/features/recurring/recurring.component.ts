import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { WEEKDAYS, type CurrencyCode, type Weekday } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import { todayLocally } from '../capture/capture.view';
import {
  EMPTY_DRAFT,
  FREQUENCIES,
  evidence,
  proposals,
  buildRRule,
  dateLabel,
  describeSchedule,
  draftFromRule,
  draftProblem,
  orderedRules,
  problemKey,
  ruleWriteInput,
  upcomingWithin,
  weekdayLabelKey,
  type RecurringRule,
  type RuleDraft,
} from './recurring.view';

/**
 * Recurring rules — F-16, docs/02 §4.14, docs/06 §4/§5.8.
 *
 * ## The screen asks; it never expands a recurrence
 *
 * `nextOccurrenceOn` and `upcomingOccurrences` come from the API, which owns the RRULE. The client's
 * only part in the schedule is **building** the rule string from the picker and **saying it in words**;
 * both live in `recurring.view.ts` and are tested against each other, because a sentence that disagrees
 * with the schedule is a screen that lies about when money moves.
 *
 * ## The schedule in words, the raw text behind a disclosure
 *
 * docs/02 §4.14: *"The RRULE renders in words; the raw RFC 5545 string is read-only in an advanced
 * disclosure."* The sentence is the default; `<details>` shows exactly what is stored, which is what
 * makes a support conversation possible without exposing the machinery first.
 *
 * ## `autoConfirm`, explained where it is chosen
 *
 * The checkbox carries one line, as the wireframe asks: unchecked posts a `PENDING` row that appears
 * for confirmation instead of counting as spend (I-7, I-8).
 *
 * ## What the wireframe draws and this build does not
 *
 * The **Proposals** section (detected subscriptions with their evidence) is task 3.3.4: nothing writes
 * `is_detected` yet, so the section would be permanently empty. It is not rendered at all rather than
 * shown empty, and the gap is recorded in AGENTS. The screen also has no "post it now" affordance: that
 * is `materialiseRecurring`, which is the job's entry point and belongs with the job's UI.
 *
 * @module apps/web/src/app/features/recurring
 */
@Component({
  selector: 'fm-recurring',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MoneyComponent],
  template: `
    <main class="wrap">
      <header class="head">
        <h1 class="head__title">{{ i18n.t('recurring.title') }}</h1>
        <button class="head__new" type="button" (click)="toggleForm()">
          {{ formOpen() ? i18n.t('recurring.cancel') : i18n.t('recurring.new') }}
        </button>
      </header>
      <p class="muted">{{ i18n.t('recurring.subtitle') }}</p>

      @if (error()) {
        <p class="alert" role="alert">{{ error() }}</p>
      }
      @if (notice(); as message) {
        <p class="notice" role="status">{{ message }}</p>
      }

      @if (proposals().length > 0) {
        <section class="panel panel--proposals" aria-labelledby="recurring-proposals">
          <h2 class="panel__title" id="recurring-proposals">
            {{ i18n.t('recurring.proposals', { count: proposals().length }) }}
          </h2>
          <p class="muted">{{ i18n.t('recurring.proposalsHint') }}</p>
          <ul class="cards">
            @for (proposal of proposals(); track proposal.id) {
              <li class="card">
                <div class="card__head">
                  <h3 class="card__name">{{ proposal.description }}</h3>
                  <fm-money [amount]="proposal.amount" />
                </div>
                <p class="card__schedule">
                  <span>{{ sentenceText(proposal.rrule) }}</span>
                  <span class="card__next">{{ evidenceText(proposal) }}</span>
                </p>
                <div class="card__actions">
                  <button class="button" type="button" (click)="acceptProposal(proposal)">
                    {{ i18n.t('recurring.accept') }}
                  </button>
                  <button class="button button--quiet" type="button" (click)="dismissProposal(proposal)">
                    {{ i18n.t('recurring.dismiss') }}
                  </button>
                </div>
              </li>
            }
          </ul>
        </section>
      } @else {
        <p class="muted">
          <button class="button button--quiet" type="button" [disabled]="saving()" (click)="checkSubscriptions()">
            {{ saving() ? i18n.t('recurring.checking') : i18n.t('recurring.check') }}
          </button>
        </p>
      }

      @if (formOpen()) {
        <section class="panel" aria-labelledby="recurring-form">
          <h2 class="panel__title" id="recurring-form">
            {{ editingId() === null ? i18n.t('recurring.new') : i18n.t('recurring.edit') }}
          </h2>
          <!-- (submit) with a cancelled default, not (ngSubmit): this component imports no forms
               module, so NgForm is never applied and (ngSubmit) never fires (docs/15). -->
          <form class="form" (submit)="save($event)" novalidate>
            <label class="form__field">
              <span>{{ i18n.t('recurring.description') }}</span>
              <input
                id="rule-description"
                type="text"
                autocomplete="off"
                [value]="draft().description"
                (input)="patch('description', $event)"
              />
            </label>

            <label class="form__field">
              <span>{{ i18n.t('recurring.amount') }}</span>
              <input
                type="text"
                inputmode="decimal"
                [value]="draft().amount"
                (input)="patch('amount', $event)"
              />
            </label>

            <label class="form__field">
              <span>{{ i18n.t('recurring.account') }}</span>
              <select [value]="draft().accountId" (change)="patch('accountId', $event)">
                <option value="">{{ i18n.t('recurring.chooseAccount') }}</option>
                @for (account of accounts(); track account.id) {
                  <option [value]="account.id">{{ account.name }}</option>
                }
              </select>
            </label>

            <label class="form__field">
              <span>{{ i18n.t('recurring.kind') }}</span>
              <select [value]="draft().kind" (change)="patch('kind', $event)">
                <option value="EXPENSE">{{ i18n.t('recurring.kindExpense') }}</option>
                <option value="INCOME">{{ i18n.t('recurring.kindIncome') }}</option>
              </select>
            </label>

            <fieldset class="form__group">
              <legend>{{ i18n.t('recurring.schedule') }}</legend>
              <div class="form__row">
                <label class="form__field">
                  <span>{{ i18n.t('recurring.frequency') }}</span>
                  <select [value]="draft().frequency" (change)="patch('frequency', $event)">
                    @for (frequency of frequencies; track frequency) {
                      <option [value]="frequency">{{ i18n.t(frequencyKey(frequency)) }}</option>
                    }
                  </select>
                </label>
                <label class="form__field">
                  <span>{{ i18n.t('recurring.interval') }}</span>
                  <input
                    type="number"
                    min="1"
                    max="365"
                    [value]="draft().interval"
                    (input)="patch('interval', $event)"
                  />
                </label>
                @if (draft().frequency === 'WEEKLY') {
                  <span class="form__field">
                    <span>{{ i18n.t('recurring.weekdays') }}</span>
                    <span class="days">
                      @for (day of weekdays; track day) {
                        <label class="days__item">
                          <input
                            type="checkbox"
                            [checked]="isDaySelected(day)"
                            (change)="toggleDay(day)"
                          />
                          <span>{{ i18n.t(dayKey(day)) }}</span>
                        </label>
                      }
                    </span>
                  </span>
                }
              </div>

              <div class="form__row">
                <label class="form__field">
                  <span>{{ i18n.t('recurring.startsOn') }}</span>
                  <input type="date" [value]="draft().startsOn" (input)="patch('startsOn', $event)" />
                </label>
                <label class="form__field">
                  <span>{{ i18n.t('recurring.endsOn') }}</span>
                  <input type="date" [value]="draft().endsOn" (input)="patch('endsOn', $event)" />
                </label>
              </div>

              <p class="muted">{{ i18n.t(sentence().key, sentence().params) }}</p>
            </fieldset>

            <label class="form__check">
              <input
                type="checkbox"
                [checked]="draft().autoConfirm"
                (change)="patchAutoConfirm($event)"
              />
              <span>{{ i18n.t('recurring.autoConfirm') }}</span>
            </label>
            <p class="muted">{{ i18n.t('recurring.autoConfirmHint') }}</p>

            @if (problem(); as key) {
              <p class="alert" role="alert">{{ i18n.t(key) }}</p>
            }

            <div class="form__actions">
              <button class="button" type="submit" [disabled]="saving()">
                {{ saving() ? i18n.t('recurring.saving') : i18n.t('recurring.save') }}
              </button>
            </div>
          </form>
        </section>
      }

      <section class="panel" aria-labelledby="recurring-upcoming">
        <h2 class="panel__title" id="recurring-upcoming">{{ i18n.t('recurring.upcoming') }}</h2>
        @if (upcoming().length === 0) {
          <p class="muted">{{ i18n.t('recurring.upcomingEmpty', { days: 30 }) }}</p>
        } @else {
          <ul class="plain">
            @for (entry of upcoming(); track entry.ruleId + entry.date) {
              <li class="plain__row">
                <span class="plain__label">{{ day(entry.date) }}</span>
                <span class="plain__name">{{ entry.description }}</span>
                <fm-money [amount]="entry.amount" />
              </li>
            }
          </ul>
        }
      </section>

      @if (rules().length === 0 && !loading()) {
        <p class="muted">{{ i18n.t('recurring.empty') }}</p>
      }

      <ul class="cards">
        @for (rule of ordered(); track rule.id) {
          <li class="card" [class.card--off]="!rule.isActive">
            <div class="card__head">
              <h2 class="card__name">{{ rule.description }}</h2>
              <fm-money [amount]="rule.amount" />
            </div>
            <p class="card__schedule">
              <span>{{ sentenceText(rule.rrule) }}</span>
              <span class="card__next">{{ i18n.t('recurring.next', { date: day(rule.nextOccurrenceOn) }) }}</span>
            </p>
            <p class="muted">
              {{ rule.accountName ?? i18n.t('recurring.noAccount') }}
              @if (rule.generatedCount > 0) {
                · {{ i18n.t('recurring.posted', { count: rule.generatedCount }) }}
              }
              @if (!rule.isActive) {
                · {{ i18n.t('recurring.inactive') }}
              }
            </p>

            <div class="card__actions">
              <label class="form__check">
                <input
                  type="checkbox"
                  [checked]="rule.autoConfirm"
                  (change)="setAutoConfirm(rule, $event)"
                />
                <span>{{ i18n.t('recurring.autoConfirm') }}</span>
              </label>
              <button class="button button--quiet" type="button" (click)="edit(rule)">
                {{ i18n.t('recurring.edit') }}
              </button>
              @if (rule.isActive) {
                <button class="button button--quiet" type="button" (click)="setActive(rule, false)">
                  {{ i18n.t('recurring.deactivate') }}
                </button>
              } @else {
                <button class="button button--quiet" type="button" (click)="setActive(rule, true)">
                  {{ i18n.t('recurring.activate') }}
                </button>
              }
            </div>

            <details class="raw">
              <summary>{{ i18n.t('recurring.raw') }}</summary>
              <code>{{ rule.rrule }}</code>
            </details>
          </li>
        }
      </ul>
    </main>
  `,
  styles: [
    `
      .wrap {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        padding: var(--space-4);
        max-inline-size: 48rem;
        margin-inline: auto;
      }
      .head {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        align-items: baseline;
        justify-content: space-between;
      }
      .head__title {
        margin: 0;
      }
      .muted {
        color: var(--color-text-muted);
        font-size: var(--text-sm);
        margin: 0;
      }
      .notice {
        margin: 0;
        font-size: var(--text-sm);
      }
      .panel--proposals {
        border-style: dashed;
      }
      .panel,
      .card {
        padding: var(--space-4);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        background: var(--color-surface);
      }
      .panel__title {
        margin: 0 0 var(--space-3);
        font-size: var(--text-lg);
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .form__row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
      }
      .form__group {
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        padding: var(--space-3);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        min-inline-size: 0;
      }
      .form__field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-inline-size: 0;
        font-size: var(--text-sm);
      }
      .form__field input,
      .form__field select {
        max-inline-size: 100%;
      }
      .form__check {
        display: flex;
        gap: var(--space-2);
        align-items: center;
        font-size: var(--text-sm);
      }
      .form__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .days {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .days__item {
        display: flex;
        gap: var(--space-1);
        align-items: center;
      }
      .cards {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .card {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .card--off {
        opacity: 0.65;
      }
      .card__head {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: baseline;
        justify-content: space-between;
      }
      .card__name {
        margin: 0;
        font-size: var(--text-lg);
        overflow-wrap: anywhere;
      }
      .card__schedule {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin: 0;
        font-size: var(--text-sm);
      }
      .card__next {
        margin-inline-start: auto;
        color: var(--color-text-muted);
      }
      .card__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-3);
        align-items: center;
      }
      .button {
        cursor: pointer;
      }
      .raw summary {
        padding-block: var(--space-3);
        cursor: pointer;
        font-size: var(--text-xs);
        color: var(--color-text-muted);
      }
      .raw code {
        display: block;
        margin-block-start: var(--space-1);
        font-size: var(--text-xs);
        overflow-wrap: anywhere;
      }
      .plain {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .plain__row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: baseline;
        border-block-start: 1px solid var(--color-border);
        padding-block: var(--space-1);
        font-size: var(--text-sm);
      }
      .plain__label {
        min-inline-size: 6rem;
        color: var(--color-text-muted);
      }
      .plain__name {
        min-inline-size: 0;
        overflow-wrap: anywhere;
      }
    `,
  ],
})
export class RecurringComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);

  readonly rules = signal<readonly RecurringRule[]>([]);
  readonly accounts = signal<readonly { id: string; name: string }[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  readonly formOpen = signal(false);
  readonly editingId = signal<string | null>(null);
  readonly draft = signal<RuleDraft>(EMPTY_DRAFT);
  readonly problem = signal<TranslationKey | null>(null);

  readonly ordered = computed(() => orderedRules(this.rules()));
  readonly proposals = computed(() => proposals(this.rules()));
  readonly upcoming = computed(() => upcomingWithin(this.rules(), todayLocally(), 30));

  /** The sentence for the draft, live — the form says what it is about to save. */
  readonly sentence = computed(() => {
    const described = describeSchedule(buildRRule(this.draft()));
    return described ?? { key: 'recurring.everyMonth' as TranslationKey, params: {} };
  });

  readonly frequencies = FREQUENCIES;
  readonly weekdays = WEEKDAYS;
  readonly weekdayLabelKey = weekdayLabelKey;

  private readonly currency = computed<CurrencyCode>(
    () => (this.rules()[0]?.amount.currency ?? 'RSD') as CurrencyCode,
  );

  constructor() {
    void this.load();
  }

  day(day: string): string {
    return dateLabel(day, this.i18n.tag());
  }

  evidenceText(proposal: RecurringRule): string {
    return this.i18n.t(evidence(proposal).key, evidence(proposal).params);
  }

  /** Run the detector. The `recurring.detect` job calls the same service method. */
  async checkSubscriptions(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      const result = await this.graphql.query<{ detectSubscriptions: readonly RecurringRule[] }>(
        DETECT_SUBSCRIPTIONS,
      );
      this.notice.set(
        result.detectSubscriptions.length === 0
          ? this.i18n.t('recurring.checkNone')
          : this.i18n.t('recurring.checkFound', { count: result.detectSubscriptions.length }),
      );
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  async acceptProposal(proposal: RecurringRule): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(CONFIRM_PROPOSAL, { ruleId: proposal.id });
      this.notice.set(this.i18n.t('recurring.accepted'));
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  async dismissProposal(proposal: RecurringRule): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(DISMISS_PROPOSAL, { ruleId: proposal.id });
      this.notice.set(this.i18n.t('recurring.dismissed'));
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  frequencyKey(frequency: string): TranslationKey {
    return `recurring.frequency.${frequency}` as TranslationKey;
  }

  dayKey(day: Weekday): TranslationKey {
    return weekdayLabelKey(day);
  }

  isDaySelected(day: Weekday): boolean {
    return this.draft().byDay.includes(day);
  }

  /** The rule in words: the server's text, described by the domain's own parser. */
  sentenceText(rrule: string): string {
    const described = describeSchedule(rrule);
    if (described === null) return rrule;
    const days = described.params['days'];
    return this.i18n.t(described.key, {
      ...described.params,
      ...(typeof days === 'string' ? { days: this.dayList(days) } : {}),
    });
  }

  patch(field: keyof RuleDraft, event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLSelectElement).value;
    this.draft.update((draft) => ({ ...draft, [field]: value }));
    this.problem.set(null);
  }

  patchAutoConfirm(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.draft.update((draft) => ({ ...draft, autoConfirm: checked }));
  }

  toggleDay(day: Weekday): void {
    this.draft.update((draft) => ({
      ...draft,
      byDay: draft.byDay.includes(day)
        ? draft.byDay.filter((entry) => entry !== day)
        : WEEKDAYS.filter((entry) => entry === day || draft.byDay.includes(entry)),
    }));
  }

  toggleForm(): void {
    this.formOpen.update((open) => !open);
    this.editingId.set(null);
    this.draft.set(EMPTY_DRAFT);
    this.problem.set(null);
  }

  edit(rule: RecurringRule): void {
    this.editingId.set(rule.id);
    this.draft.set(draftFromRule(rule));
    this.formOpen.set(true);
    this.problem.set(null);
  }

  /** See `assistant.component.ts`: `event` must be cancelled or the browser navigates instead. */
  async save(event?: Event): Promise<void> {
    event?.preventDefault();
    const problem = draftProblem(this.draft(), this.currency());
    if (problem !== null) {
      this.problem.set(problemKey(problem));
      return;
    }
    const input = ruleWriteInput(this.draft(), this.currency());
    if (input === null) return;

    const editing = this.editingId();
    this.saving.set(true);
    this.error.set(null);
    try {
      if (editing === null) {
        await this.graphql.query(CREATE_RULE, {
          input: {
            accountId: input.accountId,
            kind: input.kind,
            amount: { amountMinor: input.amountMinor.toString(), currency: this.currency() },
            description: input.description,
            rrule: input.rrule,
            startsOn: input.startsOn,
            endsOn: input.endsOn,
            autoConfirm: input.autoConfirm,
          },
        });
        this.notice.set(this.i18n.t('recurring.created'));
      } else {
        await this.graphql.query(UPDATE_RULE, {
          input: {
            ruleId: editing,
            amount: { amountMinor: input.amountMinor.toString(), currency: this.currency() },
            description: input.description,
            rrule: input.rrule,
            startsOn: input.startsOn,
            ...(input.endsOn === null ? { clearEndsOn: true } : { endsOn: input.endsOn }),
            autoConfirm: input.autoConfirm,
          },
        });
        this.notice.set(this.i18n.t('recurring.saved'));
      }
      this.formOpen.set(false);
      this.editingId.set(null);
      this.draft.set(EMPTY_DRAFT);
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  async setAutoConfirm(rule: RecurringRule, event: Event): Promise<void> {
    const checked = (event.target as HTMLInputElement).checked;
    await this.patchRule({ ruleId: rule.id, autoConfirm: checked });
  }

  async setActive(rule: RecurringRule, isActive: boolean): Promise<void> {
    await this.patchRule({ ruleId: rule.id, isActive });
    this.notice.set(this.i18n.t(isActive ? 'recurring.activated' : 'recurring.deactivated'));
  }

  private async patchRule(input: Record<string, unknown>): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(UPDATE_RULE, { input });
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  /** The weekday list inside a sentence, localised: `MO,TH` becomes *pon, čet*. */
  private dayList(days: string): string {
    return days
      .split(',')
      .map((day) => this.i18n.t(weekdayLabelKey(day as Weekday)))
      .join(', ');
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const result = await this.graphql.query<{
        recurringRules: readonly RecurringRule[];
        accounts: { edges: readonly { node: { id: string; name: string } }[] };
      }>(RECURRING_QUERY);
      this.rules.set(result.recurringRules);
      this.accounts.set(result.accounts.edges.map((edge) => edge.node));
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }
}

/** Active rules, then the Accounts a rule may point at. */
const RECURRING_QUERY = /* GraphQL */ `
  query Recurring {
    recurringRules(activeOnly: false) {
      id
      accountId
      accountName
      kind
      amount
      categoryId
      description
      rrule
      nextOccurrenceOn
      endsOn
      autoConfirm
      isDetected
      isActive
      generatedCount
      upcomingOccurrences
    }
    accounts(first: 100) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

const RULE_FIELDS = /* GraphQL */ `
  id
  isActive
  autoConfirm
`;

const CREATE_RULE = /* GraphQL */ `
  mutation CreateRecurringRule($input: RecurringRuleCreateInput!) {
    createRecurringRule(input: $input) {
      ${RULE_FIELDS}
    }
  }
`;

const DETECT_SUBSCRIPTIONS = /* GraphQL */ `
  mutation DetectSubscriptions {
    detectSubscriptions {
      id
      description
    }
  }
`;

const CONFIRM_PROPOSAL = /* GraphQL */ `
  mutation ConfirmDetectedSubscription($ruleId: String!) {
    confirmDetectedSubscription(ruleId: $ruleId) {
      ${RULE_FIELDS}
    }
  }
`;

const DISMISS_PROPOSAL = /* GraphQL */ `
  mutation DismissDetectedSubscription($ruleId: String!) {
    dismissDetectedSubscription(ruleId: $ruleId)
  }
`;

const UPDATE_RULE = /* GraphQL */ `
  mutation UpdateRecurringRule($input: RecurringRuleUpdateInput!) {
    updateRecurringRule(input: $input) {
      ${RULE_FIELDS}
    }
  }
`;
