import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { type CurrencyCode, uuidv7 } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import type { TranslationKey } from '../../core/i18n/translations';
import {
  EMPTY_DRAFT,
  activeGoals,
  amountMinor,
  canContribute,
  contributionProblem,
  dateLabel,
  draftProblem,
  goalWriteInput,
  orderedGoals,
  percent,
  problemKey,
  rateLabelKey,
  statusLabelKey,
  type Goal,
  type GoalDraft,
} from './goals.view';

/**
 * Saving goals — F-18, docs/02 §4.13, docs/06 §5.7.
 *
 * ## The screen asks; it never computes
 *
 * `contributed`, `remaining`, `progress` and `requiredPerMonth` arrive from the API, which computes
 * them from the contributions on every read (docs/03 §6). Nothing here adds money up: the only
 * arithmetic is the progress bar's whole-percent width and the format of a typed target, and both go
 * through code that is tested for exactly that. The **required monthly amount is never editable** —
 * it is a figure the backend derives (docs/02 §4.13), so the card renders it and offers a date picker
 * instead of an input.
 *
 * ## Idempotency is the client's half of the contract
 *
 * `contributeToGoal` requires an `idempotencyKey` (I-10) and this screen mints **one per submission**
 * — a fresh key each time the form is submitted, never on every keystroke — so a double-tap on
 * *Dodaj uplatu* reuses the key and the API returns the original contribution rather than saving the
 * money twice.
 *
 * ## What the wireframe draws and this build does not
 *
 * The contribution list shows a contribution's **note** where docs/02 §4.13 draws "(Kartica)": a
 * contribution has no Account column (`goal_contributions` carries none, and neither does the SDL),
 * and inventing one on the client would be a claim about where the money moved that nothing recorded.
 * The screen offers **Archive**, not delete: a soft-deleted goal takes its contribution history out of
 * view, and the wireframe's own action is *Arhiviraj*. Deleting a goal stays API-only.
 *
 * @module apps/web/src/app/features/goals
 */
@Component({
  selector: 'fm-goals',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MoneyComponent],
  template: `
    <main class="wrap">
      <header class="head">
        <h1 class="head__title">{{ i18n.t('goals.title') }}</h1>
        <button class="head__new" type="button" (click)="toggleCreate()">
          {{ creating() ? i18n.t('goals.cancel') : i18n.t('goals.new') }}
        </button>
      </header>
      <p class="muted">{{ i18n.t('goals.subtitle') }}</p>

      @if (error()) {
        <p class="alert" role="alert">{{ error() }}</p>
      }
      @if (notice(); as message) {
        <p class="notice" role="status">{{ message }}</p>
      }

      @if (creating()) {
        <section class="panel" aria-labelledby="goals-new">
          <h2 class="panel__title" id="goals-new">{{ i18n.t('goals.new') }}</h2>
          <!-- (submit) with a cancelled default, not (ngSubmit): this component imports no forms
               module, so NgForm is never applied and (ngSubmit) never fires (docs/15). -->
          <form class="form" (submit)="create($event)" novalidate>
            <label class="form__field">
              <span>{{ i18n.t('goals.name') }}</span>
              <input
                id="goal-name"
                type="text"
                autocomplete="off"
                [value]="draft().name"
                (input)="patchDraft('name', $event)"
              />
            </label>
            <label class="form__field">
              <span>{{ i18n.t('goals.target') }}</span>
              <input
                type="text"
                inputmode="decimal"
                [value]="draft().target"
                (input)="patchDraft('target', $event)"
              />
            </label>
            <label class="form__field">
              <span>{{ i18n.t('goals.targetDate') }}</span>
              <input
                type="date"
                [value]="draft().targetDate"
                (input)="patchDraft('targetDate', $event)"
              />
            </label>
            <label class="form__field">
              <span>{{ i18n.t('goals.account') }}</span>
              <select [value]="draft().accountId" (change)="patchDraft('accountId', $event)">
                <option value="">{{ i18n.t('goals.noAccount') }}</option>
                @for (account of accounts(); track account.id) {
                  <option [value]="account.id">{{ account.name }}</option>
                }
              </select>
            </label>

            @if (problem()) {
              <p class="alert" role="alert">{{ i18n.t(problem()!) }}</p>
            }

            <div class="form__actions">
              <button class="button" type="submit" [disabled]="saving()">
                {{ saving() ? i18n.t('goals.saving') : i18n.t('goals.save') }}
              </button>
            </div>
          </form>
        </section>
      }

      @if (goals().length === 0 && !loading()) {
        <p class="muted">{{ i18n.t('goals.empty') }}</p>
      }

      <ul class="cards">
        @for (goal of ordered(); track goal.id) {
          <li class="card" [class.card--archived]="goal.status === 'ARCHIVED'">
            <div class="card__head">
              <h2 class="card__name">{{ goal.name }}</h2>
              <span class="chip" [attr.data-status]="goal.status">
                {{ i18n.t(statusKey(goal.status)) }}
              </span>
            </div>

            <p class="card__figures">
              <fm-money [amount]="goal.contributed" />
              <span class="card__of">/</span>
              <fm-money [amount]="goal.target" />
              <span class="card__percent">{{ percent(goal.progress) }} %</span>
            </p>

            <span
              class="track"
              role="progressbar"
              [attr.aria-valuenow]="percent(goal.progress)"
              aria-valuemin="0"
              aria-valuemax="100"
              [attr.aria-label]="goal.name"
            >
              <span class="track__fill" [style.inline-size.%]="percent(goal.progress)"></span>
            </span>

            <p class="card__rate">
              @if (goal.targetDate; as date) {
                <span>{{ i18n.t('goals.due', { date: day(date) }) }}</span>
              }
              <span>{{ i18n.t(rateKey(goal)) }}</span>
              @if (goal.requiredPerMonth; as rate) {
                <fm-money [amount]="rate" />
              }
            </p>

            @if (goal.contributions.length > 0) {
              <ul class="payments">
                @for (contribution of goal.contributions; track contribution.id) {
                  <li class="payments__row">
                    <fm-money [amount]="contribution.amount" />
                    <span class="payments__meta">
                      {{ day(contribution.contributedOn) }}
                      @if (contribution.note) {
                        · {{ contribution.note }}
                      }
                    </span>
                    <button
                      class="payments__remove"
                      type="button"
                      [attr.aria-label]="i18n.t('goals.removePayment', { name: goal.name })"
                      (click)="removeContribution(contribution.id)"
                    >
                      ×
                    </button>
                  </li>
                }
              </ul>
            } @else {
              <p class="muted">{{ i18n.t('goals.noPayments') }}</p>
            }

            @if (contributingFor() === goal.id) {
              <form class="form form--inline" (submit)="contribute(goal, $event)" novalidate>
                <label class="form__field">
                  <span>{{ i18n.t('goals.paymentAmount') }}</span>
                  <input
                    type="text"
                    inputmode="decimal"
                    [value]="paymentAmount()"
                    (input)="paymentAmount.set(value($event))"
                  />
                </label>
                <label class="form__field">
                  <span>{{ i18n.t('goals.paymentNote') }}</span>
                  <input
                    type="text"
                    autocomplete="off"
                    [value]="paymentNote()"
                    (input)="paymentNote.set(value($event))"
                  />
                </label>
                @if (paymentProblem(); as key) {
                  <p class="alert" role="alert">{{ i18n.t(key) }}</p>
                }
                <div class="form__actions">
                  <button class="button" type="submit" [disabled]="saving()">
                    {{ i18n.t('goals.savePayment') }}
                  </button>
                  <button class="button button--quiet" type="button" (click)="closePayment()">
                    {{ i18n.t('goals.cancel') }}
                  </button>
                </div>
              </form>
            } @else {
              <div class="card__actions">
                @if (canPay(goal)) {
                  <button class="button" type="button" (click)="openPayment(goal)">
                    {{ i18n.t('goals.addPayment') }}
                  </button>
                }
                @if (editingFor() === goal.id) {
                  <span class="edit">
                    <label class="form__field">
                      <span>{{ i18n.t('goals.newTarget') }}</span>
                      <input
                        type="text"
                        inputmode="decimal"
                        [value]="editTarget()"
                        (input)="editTarget.set(value($event))"
                      />
                    </label>
                    <label class="form__field">
                      <span>{{ i18n.t('goals.targetDate') }}</span>
                      <input
                        type="date"
                        [value]="editDate()"
                        (input)="editDate.set(value($event))"
                      />
                    </label>
                    <span class="edit__actions">
                      <button class="button" type="button" (click)="saveEdit(goal)">
                        {{ i18n.t('goals.save') }}
                      </button>
                      <button class="button button--quiet" type="button" (click)="editingFor.set(null)">
                        {{ i18n.t('goals.cancel') }}
                      </button>
                    </span>
                  </span>
                } @else {
                  <button class="button button--quiet" type="button" (click)="openEdit(goal)">
                    {{ i18n.t('goals.edit') }}
                  </button>
                }
                @if (goal.status === 'ARCHIVED') {
                  <button class="button button--quiet" type="button" (click)="setStatus(goal, 'ACTIVE')">
                    {{ i18n.t('goals.restore') }}
                  </button>
                } @else {
                  <button class="button button--quiet" type="button" (click)="setStatus(goal, 'ARCHIVED')">
                    {{ i18n.t('goals.archive') }}
                  </button>
                }
              </div>
            }
          </li>
        }
      </ul>

      @if (archivedCount() > 0) {
        <p class="muted">{{ i18n.t('goals.archivedNote', { count: archivedCount() }) }}</p>
      }
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
      }
      .notice {
        margin: 0;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
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
      .form--inline {
        margin-block-start: var(--space-3);
        padding-block-start: var(--space-3);
        border-block-start: 1px solid var(--color-border);
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
      .form__actions,
      .card__actions,
      .edit,
      .edit__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: flex-end;
      }
      .button {
        cursor: pointer;
      }
      .button--quiet {
        opacity: 0.85;
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
      .card--archived {
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
      .chip {
        font-size: var(--text-xs);
        padding: 0.1rem 0.5rem;
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        white-space: nowrap;
      }
      .card__figures {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: baseline;
        margin: 0;
      }
      .card__of {
        color: var(--color-text-muted);
      }
      .card__percent {
        margin-inline-start: auto;
        font-variant-numeric: tabular-nums;
        color: var(--color-text-muted);
      }
      .track {
        display: block;
        block-size: 0.5rem;
        border-radius: var(--radius-sm);
        background: var(--color-border);
        overflow: hidden;
      }
      .track__fill {
        display: block;
        block-size: 100%;
        background: var(--color-accent, currentColor);
      }
      .card__rate {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin: 0;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .payments {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        margin: 0;
        padding: 0;
        list-style: none;
        font-size: var(--text-sm);
      }
      .payments__row {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        align-items: baseline;
        border-block-start: 1px solid var(--color-border);
        padding-block: var(--space-1);
      }
      .payments__meta {
        min-inline-size: 0;
        overflow-wrap: anywhere;
        color: var(--color-text-muted);
      }
      .payments__remove {
        margin-inline-start: auto;
        cursor: pointer;
      }
    `,
  ],
})
export class GoalsComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);

  readonly goals = signal<readonly Goal[]>([]);
  readonly accounts = signal<readonly { id: string; name: string }[]>([]);
  readonly loading = signal(false);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);
  readonly notice = signal<string | null>(null);

  readonly creating = signal(false);
  readonly draft = signal<GoalDraft>(EMPTY_DRAFT);
  readonly problem = signal<TranslationKey | null>(null);

  readonly contributingFor = signal<string | null>(null);
  readonly paymentAmount = signal('');
  readonly paymentNote = signal('');
  readonly paymentProblem = signal<TranslationKey | null>(null);

  readonly editingFor = signal<string | null>(null);
  readonly editTarget = signal('');
  readonly editDate = signal('');

  readonly ordered = computed(() => orderedGoals(activeGoals(this.goals())));
  readonly archivedCount = computed(
    () => this.goals().filter((goal) => goal.status === 'ARCHIVED').length,
  );

  /**
   * The currency a typed amount is read in.
   *
   * Taken from a goal the API already returned, and `RSD` before the first one exists. The Household's
   * ledger currency is not on the wire in any query this screen makes (docs/06 §4.1's
   * `activeHousehold` is not built and there is no multi-currency ledger yet), which is the same gap
   * the budgets screen has; a typed target is parsed by `parseAmount` either way, so the *reading* is
   * never re-implemented — only the label could be wrong for a non-RSD Household.
   */
  private readonly currency = computed<CurrencyCode>(
    () => (this.goals()[0]?.target.currency ?? 'RSD') as CurrencyCode,
  );

  constructor() {
    void this.load();
  }

  // The view module's decisions, re-exposed for the template without logic in it.
  readonly canPay = canContribute;
  readonly percent = percent;
  readonly statusKey = statusLabelKey;
  readonly rateKey = rateLabelKey;

  day(day: string): string {
    return dateLabel(day, this.i18n.tag());
  }

  /** The typed value of an input, so the template does not repeat the cast. */
  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  patchDraft(field: keyof GoalDraft, event: Event): void {
    this.draft.update((draft) => ({ ...draft, [field]: this.value(event) }));
    this.problem.set(null);
  }

  toggleCreate(): void {
    this.creating.update((open) => !open);
    this.problem.set(null);
    this.draft.set(EMPTY_DRAFT);
  }

  /** See `assistant.component.ts`: `event` must be cancelled or the browser navigates instead. */
  async create(event?: Event): Promise<void> {
    event?.preventDefault();
    const problem = draftProblem(this.draft(), this.currency());
    if (problem !== null) {
      this.problem.set(problemKey(problem));
      return;
    }
    const input = goalWriteInput(this.draft(), this.currency());
    if (input === null) return;

    this.saving.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(CREATE_GOAL, {
        input: {
          name: input.name,
          target: { amountMinor: input.targetMinor.toString(), currency: this.currency() },
          targetDate: input.targetDate,
          accountId: input.accountId,
        },
      });
      this.creating.set(false);
      this.draft.set(EMPTY_DRAFT);
      this.notice.set(this.i18n.t('goals.created'));
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  openPayment(goal: Goal): void {
    this.contributingFor.set(goal.id);
    this.paymentAmount.set('');
    this.paymentNote.set('');
    this.paymentProblem.set(null);
  }

  closePayment(): void {
    this.contributingFor.set(null);
  }

  /**
   * Add a contribution. The key is minted **here**, once per submit: a retry after a network failure
   * reuses nothing new, and a double-tap cannot save the money twice (I-10).
   */
  async contribute(goal: Goal, event?: Event): Promise<void> {
    event?.preventDefault();
    if (contributionProblem(this.paymentAmount(), this.currency()) !== null) {
      this.paymentProblem.set('goals.problem.AMOUNT');
      return;
    }
    const minor = amountMinor(this.paymentAmount(), this.currency());
    if (minor === null) return;

    this.saving.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(CONTRIBUTE, {
        input: {
          goalId: goal.id,
          amount: { amountMinor: minor.toString(), currency: this.currency() },
          note: this.paymentNote().trim() === '' ? null : this.paymentNote().trim(),
          idempotencyKey: uuidv7(),
        },
      });
      this.contributingFor.set(null);
      this.notice.set(this.i18n.t('goals.paymentSaved'));
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  openEdit(goal: Goal): void {
    this.editingFor.set(goal.id);
    this.editTarget.set(String(goal.target.amountMinor));
    this.editDate.set(goal.targetDate ?? '');
  }

  /** Patch a goal. An empty date field is sent as `clearTargetDate`, which is why the flag exists. */
  async saveEdit(goal: Goal): Promise<void> {
    const targetMinor = amountMinor(this.editTarget(), this.currency());
    if (targetMinor === null) {
      this.error.set(this.i18n.t('goals.problem.TARGET'));
      return;
    }
    const date = this.editDate().trim();

    this.saving.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(UPDATE_GOAL, {
        input: {
          goalId: goal.id,
          target: { amountMinor: targetMinor.toString(), currency: goal.target.currency },
          ...(date === '' ? { clearTargetDate: true } : { targetDate: date }),
        },
      });
      this.editingFor.set(null);
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  async setStatus(goal: Goal, status: 'ACTIVE' | 'ARCHIVED'): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(UPDATE_GOAL, { input: { goalId: goal.id, status } });
      this.notice.set(
        this.i18n.t(status === 'ARCHIVED' ? 'goals.archived' : 'goals.restored'),
      );
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  async removeContribution(contributionId: string): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    try {
      await this.graphql.query(REMOVE_CONTRIBUTION, { id: contributionId });
      await this.load();
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.saving.set(false);
    }
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const result = await this.graphql.query<{
        savingGoals: readonly Goal[];
        accounts: { edges: readonly { node: { id: string; name: string } }[] };
      }>(GOALS_QUERY);
      this.goals.set(result.savingGoals);
      this.accounts.set(result.accounts.edges.map((edge) => edge.node));
    } catch (error) {
      this.error.set(this.errors.for(error));
    } finally {
      this.loading.set(false);
    }
  }
}

const GOAL_FIELDS = /* GraphQL */ `
  id
  name
  target
  targetDate
  accountId
  account {
    id
    name
  }
  status
  contributed
  remaining
  progress
  requiredPerMonth
  monthsRemaining
  contributions {
    id
    goalId
    amount
    contributedOn
    note
  }
`;

/**
 * One operation for the whole screen. `target`, `contributed`, `amount` and `requiredPerMonth` are
 * `Money` **scalars**: they are selected bare, because a selection set on a scalar is a validation
 * error the client only sees at runtime (the 3.2.4 defect, docs/15).
 */
const GOALS_QUERY = /* GraphQL */ `
  query Goals {
    savingGoals {
      ${GOAL_FIELDS}
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

const CREATE_GOAL = /* GraphQL */ `
  mutation CreateGoal($input: SavingGoalCreateInput!) {
    createSavingGoal(input: $input) {
      id
    }
  }
`;

const UPDATE_GOAL = /* GraphQL */ `
  mutation UpdateGoal($input: SavingGoalUpdateInput!) {
    updateSavingGoal(input: $input) {
      id
    }
  }
`;

const CONTRIBUTE = /* GraphQL */ `
  mutation Contribute($input: ContributeToGoalInput!) {
    contributeToGoal(input: $input) {
      wasReplayed
      goal {
        id
      }
      contribution {
        id
      }
    }
  }
`;

const REMOVE_CONTRIBUTION = /* GraphQL */ `
  mutation RemoveContribution($id: String!) {
    deleteGoalContribution(id: $id) {
      id
    }
  }
`;
