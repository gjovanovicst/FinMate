import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { parseAmount } from '@finmate/domain';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { OnboardingStore } from '../../core/onboarding/onboarding.store';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { CaptureComponent } from '../capture/capture.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import {
  LAST_STEP,
  canContinue as canContinueStep,
  clampStep,
  filterMerchants,
  merchantGroups,
  personProposals,
  previewRows,
  stepAt,
  treeSummary,
  type OnboardingDraft,
  type OnboardingStepKey,
  type PersonProposal,
} from './onboarding.view';

/**
 * `/onboarding` — the F-13 wizard (docs/02 §4.1, FL-01).
 *
 * ## What makes this worth three minutes of the user's time
 *
 * docs/01 §5: *"A blank slate produces a disappointing first session, which is the single biggest
 * retention risk."* So this screen is not configuration — it is the cold start being paid for before
 * the user has any history. Step 1 alone is what makes `Lidar 2000`-style input categorise (verified
 * live in 2.3.3a: the whole tree and its 131 keywords, with zero AI calls), and step 6 is the only
 * place the product teaches by interruption.
 *
 * ## One field, one screen, one write per step
 *
 * Every step posts on *Nastavi* rather than batching to the end (docs/02 FL-01 §4), so a skip leaves a
 * coherent state and a killed tab resumes where it stopped. The recorded step lives in
 * `households.settings.onboarding`, written by the server — this component only reads it and asks for
 * the next one.
 *
 * ## What it deliberately does not do
 *
 * - **No inline category editing** (docs/02 §4.1 asks for rename/delete in step 1). The wizard previews
 *   the tree and links to `/categories`, which is the shipped editor for exactly that. Duplicating a
 *   tree editor here would be a second implementation of I-11/I-12 for one screen's convenience; the
 *   wireframe's own copy says *"menjaš ih kasnije"*.
 * - **No savings target.** docs/02 §4.1 step 5 asks for "monthly income + savings target"; SavingGoal is
 *   Phase 3 (task 3.3.2) and does not exist, and the budget model is expense-side only. Step 5 therefore
 *   offers a monthly **budget**, which is what `upsertBudget` and the dashboard can actually use.
 *   Recorded in docs/02 §4.1.
 * - **No `SavingGoal`, no receipt, no AI.** None of them exist yet.
 */
@Component({
  selector: 'fm-onboarding',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, RouterLink, CaptureComponent, IconComponent],
  template: `
    <div class="wizard">
      <header class="head">
        <button class="link" type="button" [disabled]="busy()" (click)="back()">
          {{ i18n.t('onboarding.back') }}
        </button>
        <p class="head__count">
          {{ i18n.t('onboarding.progress', { step: step(), total: lastStep }) }}
        </p>
      </header>

      @if (error(); as message) {
        <p class="alert" role="alert">{{ message }}</p>
      }
      <p class="announce" aria-live="polite">{{ announcement() }}</p>

      @if (loading()) {
        <p class="muted">{{ i18n.t('onboarding.loading') }}</p>
      } @else if (stepAt(step()); as current) {
        <h1 class="title">{{ i18n.t(titleKey(current.key)) }}</h1>
        <p class="lede">{{ i18n.t(ledeKey(current.key)) }}</p>

        @switch (current.key) {
          @case ('categories') {
            <p class="summary">
              {{ i18n.t('onboarding.categories.summary', { count: tree().categories }) }}
            </p>
            <div class="tabs" role="group" [attr.aria-label]="i18n.t('categories.title')">
              @for (kind of kinds; track kind) {
                <button
                  type="button"
                  class="tab"
                  [class.tab--on]="tab() === kind"
                  [attr.aria-pressed]="tab() === kind"
                  (click)="tab.set(kind)"
                >
                  {{ i18n.t(kind === 'EXPENSE' ? 'transactionKind.EXPENSE' : 'transactionKind.INCOME') }}
                </button>
              }
            </div>
            <ul class="tree">
              @for (row of visibleRows(); track row.key) {
                <li class="tree__row" [style.--depth]="row.depth">
                  <span class="tree__icon" aria-hidden="true">{{ row.icon ?? '•' }}</span>
                  <span class="tree__name">{{ row.name }}</span>
                  @if (row.decisive > 0) {
                    <span class="badge">{{ i18n.t('onboarding.categories.decisive', { count: row.decisive }) }}</span>
                  }
                </li>
              }
            </ul>
            <p class="hint">{{ i18n.t('onboarding.categories.editLater') }}</p>
            <a class="link" routerLink="/categories">{{ i18n.t('nav.categories') }}</a>
          }

          @case ('accounts') {
            <label class="field">
              <span class="field__label">{{ i18n.t('onboarding.accounts.currency') }}</span>
              <input class="input" type="text" value="RSD" readonly />
            </label>
            <p class="hint">{{ i18n.t('onboarding.accounts.currencyHint') }}</p>

            <label class="field">
              <span class="field__label">{{ i18n.t('onboarding.accounts.name') }}</span>
              <input
                class="input"
                type="text"
                name="accountName"
                [(ngModel)]="accountName"
                [disabled]="busy()"
              />
            </label>

            <label class="field">
              <span class="field__label">{{ i18n.t('onboarding.accounts.kind') }}</span>
              <select class="input" name="accountKind" [(ngModel)]="accountKind" [disabled]="busy()">
                @for (kind of accountKinds; track kind) {
                  <option [value]="kind">{{ i18n.t(kindKey(kind)) }}</option>
                }
              </select>
            </label>

            @if (accounts() > 0) {
              <p class="hint">
                {{ i18n.t('onboarding.accounts.have', { count: accounts() }) }}
              </p>
            }
          }

          @case ('people') {
            <label class="field">
              <span class="field__label">{{ i18n.t('onboarding.people.label') }}</span>
              <input
                class="input"
                type="text"
                name="peopleInput"
                [placeholder]="i18n.t('onboarding.people.placeholder')"
                [(ngModel)]="peopleInput"
                [disabled]="busy()"
                (blur)="proposePeople()"
              />
            </label>
            <button class="btn" type="button" [disabled]="busy()" (click)="proposePeople()">
              {{ i18n.t('onboarding.people.suggest') }}
            </button>

            @if (proposals().length > 0) {
              <ul class="cards">
                @for (proposal of proposals(); track proposal.index) {
                  <li class="card">
                    <p class="card__name">
                      <fm-icon name="people" [size]="18" />
                      {{ proposal.personName }}
                    </p>
                    <!--
                      A category picker, not just a label. The pipeline only suggests a category when the
                      phrase itself implies one (a bill such as septicka jama does; a person's name does
                      not), and without a choice here step 3 could never create a rule for a PERSON,
                      which is exactly the F-09 case docs/01 section 5 asks it to cover. No backticks or
                      glob patterns in this comment: it lives inside a template literal.
                    -->
                    <label class="card__meta">
                      <span class="field__label">{{ i18n.t('onboarding.people.category') }}</span>
                      <select
                        class="input"
                        [name]="'personCategory' + proposal.index"
                        [ngModel]="chosenFor(proposal)"
                        (ngModelChange)="chooseCategory(proposal.index, $event)"
                        [disabled]="busy()"
                      >
                        <option value="">{{ i18n.t('onboarding.people.noCategory') }}</option>
                        @for (category of categories(); track category.id) {
                          <option [value]="category.id">{{ category.path.join(' › ') }}</option>
                        }
                      </select>
                    </label>
                    @if (addedPeople().has(proposal.index)) {
                      <p class="card__done">{{ i18n.t('onboarding.people.added') }}</p>
                    } @else {
                      <button class="btn" type="button" [disabled]="busy()" (click)="addPerson(proposal)">
                        {{ i18n.t('onboarding.people.add') }}
                      </button>
                    }
                  </li>
                }
              </ul>
              <p class="hint">{{ i18n.t('onboarding.people.ruleHint') }}</p>
            }
          }

          @case ('merchants') {
            <label class="field">
              <span class="field__label">{{ i18n.t('onboarding.merchants.search') }}</span>
              <input
                class="input"
                type="search"
                name="merchantSearch"
                [(ngModel)]="merchantQuery"
                [disabled]="busy()"
              />
            </label>
            <p class="hint">
              {{ i18n.t('onboarding.merchants.selected', { count: selectedMerchants().length }) }}
            </p>
            @for (group of groups(); track group.categoryPath) {
              <section class="group">
                <h2 class="group__title">{{ group.categoryPath }}</h2>
                <div class="chips">
                  @for (name of group.merchants; track name) {
                    <button
                      type="button"
                      class="chip"
                      [class.chip--on]="selectedMerchants().includes(name)"
                      [attr.aria-pressed]="selectedMerchants().includes(name)"
                      [disabled]="busy()"
                      (click)="toggleMerchant(name)"
                    >
                      {{ name }}
                    </button>
                  }
                </div>
              </section>
            }
          }

          @case ('plan') {
            <label class="field">
              <span class="field__label">{{ i18n.t('onboarding.plan.budget') }}</span>
              <input
                class="input"
                type="text"
                inputmode="decimal"
                name="budget"
                [placeholder]="i18n.t('onboarding.plan.optional')"
                [(ngModel)]="budgetAmount"
                [disabled]="busy()"
              />
            </label>
            <p class="hint">{{ i18n.t('onboarding.plan.budgetHint') }}</p>
          }

          @case ('firstEntry') {
            <p class="hint">{{ i18n.t('onboarding.firstEntry.hint') }}</p>
            <fm-capture />
          }
        }

        <footer class="foot">
          <button class="btn" type="button" [disabled]="busy()" (click)="skip()">
            {{ i18n.t(skipKey()) }}
          </button>
          <button
            class="btn btn--primary"
            type="button"
            [disabled]="busy() || !canContinue()"
            (click)="next()"
          >
            {{ i18n.t(isLastStep() ? 'onboarding.finish' : 'onboarding.continue') }}
          </button>
        </footer>
      } @else {
        <p class="muted">{{ i18n.t('onboarding.done') }}</p>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .wizard {
        display: grid;
        gap: var(--space-3);
        max-inline-size: 48rem;
        margin-inline: auto;
      }
      .head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .head__count {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .title {
        margin: 0;
        font-size: var(--text-xl);
      }
      .lede {
        margin: 0;
        color: var(--color-text-muted);
      }
      .summary {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .alert {
        margin: 0;
        padding: var(--space-3);
        border: 1px solid var(--color-danger);
        border-radius: var(--radius-md);
        color: var(--color-danger);
      }
      .announce:empty {
        display: none;
      }
      .announce,
      .hint,
      .muted {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .tabs {
        display: flex;
        gap: var(--space-2);
      }
      .tab {
        padding: var(--space-1) var(--space-3);
        font: inherit;
        font-size: var(--text-sm);
        color: inherit;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        cursor: pointer;
      }
      .tab--on {
        border-color: var(--color-primary);
        color: var(--color-primary-text);
      }
      .tree {
        display: grid;
        gap: var(--space-1);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      /* Indent by depth from the document, so the preview shows the shape the server will create. */
      .tree__row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding-inline-start: calc(var(--depth) * var(--space-4));
      }
      .tree__name {
        overflow-wrap: anywhere;
      }
      .badge {
        padding: 0 var(--space-2);
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
      }
      .field {
        display: grid;
        gap: var(--space-1);
      }
      .field__label {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .input {
        inline-size: 100%;
        max-inline-size: 100%;
        padding: var(--space-2);
        font: inherit;
        font-size: var(--text-sm);
        color: inherit;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
      }
      .cards {
        display: grid;
        gap: var(--space-2);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      .card {
        display: grid;
        gap: var(--space-2);
        padding: var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface);
      }
      .card__name,
      .card__meta,
      .card__done {
        margin: 0;
      }
      .card__meta {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .card__done {
        font-size: var(--text-xs);
        color: var(--color-primary-text);
      }
      .group {
        display: grid;
        gap: var(--space-2);
      }
      .group__title {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .chip {
        padding: var(--space-1) var(--space-3);
        font: inherit;
        font-size: var(--text-sm);
        color: inherit;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        cursor: pointer;
        overflow-wrap: anywhere;
      }
      .chip--on {
        border-color: var(--color-primary);
        color: var(--color-primary-text);
      }
      .foot {
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: var(--space-3);
        margin-block-start: var(--space-4);
      }
      .btn {
        padding: var(--space-2) var(--space-4);
        font: inherit;
        font-size: var(--text-sm);
        color: inherit;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        cursor: pointer;
      }
      .btn--primary {
        color: var(--color-primary-contrast);
        background: var(--color-primary);
        border-color: var(--color-primary);
      }
      .btn:disabled,
      .chip:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .link {
        padding: 0;
        font: inherit;
        font-size: var(--text-sm);
        color: var(--color-primary-text);
        background: none;
        border: none;
        cursor: pointer;
        text-decoration: underline;
      }
    `,
  ],
})
export class OnboardingComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly router = inject(Router);
  private readonly store = inject(OnboardingStore);

  readonly lastStep = LAST_STEP;
  readonly kinds = ['EXPENSE', 'INCOME'] as const;
  readonly accountKinds = ['CASH', 'BANK', 'CARD', 'OTHER'] as const;

  readonly step = signal(1);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly announcement = signal('');

  /** Server truth, used for the per-step gate and the step headers. */
  readonly accounts = signal(0);
  readonly categoryCount = signal(0);
  /** Category id → breadcrumb, for the step-3 cards. */
  private readonly categoryNames = signal<ReadonlyMap<string, string>>(new Map());

  readonly tab = signal<'EXPENSE' | 'INCOME'>('EXPENSE');
  readonly tree = computed(() => treeSummary());
  readonly rows = computed(() => previewRows());
  readonly visibleRows = computed(() => this.rows().filter((row) => row.kind === this.tab()));

  /**
   * The account-name field's starting value.
   *
   * Seeded from the catalogue rather than typed here: it used to be the literal `Keš`, so an English
   * reader was handed a Serbian account name before typing a character. Assigned **once** in the
   * constructor, because from then on it is the user's own text — re-seeding it on a locale change
   * would overwrite what they typed.
   */
  accountName: string;
  accountKind: 'CASH' | 'BANK' | 'CARD' | 'OTHER' = 'CASH';

  peopleInput = '';
  readonly proposals = signal<readonly PersonProposal[]>([]);
  readonly addedPeople = signal<ReadonlySet<number>>(new Set());
  /** Per-card category choice, keyed by the proposal's index. Seeded from the pipeline's suggestion. */
  private readonly chosenCategories = signal<ReadonlyMap<number, string>>(new Map());
  /** The Household's categories, for the step-3 picker. */
  readonly categories = signal<readonly CategoryOption[]>([]);

  readonly merchantQuery = signal('');
  readonly selectedMerchants = signal<readonly string[]>([]);
  readonly groups = computed(() => {
    const query = this.merchantQuery();
    // Filtering keeps the groups, so the category that made a merchant findable stays on screen — and
    // it goes through the tested `filterMerchants`, so a Cyrillic or accent-typed query finds the same
    // merchants the server would resolve.
    if (query.trim() === '') return merchantGroups();
    const matches = new Set(filterMerchants(query));
    return merchantGroups()
      .map((group) => ({
        categoryPath: group.categoryPath,
        merchants: group.merchants.filter((name) => matches.has(name)),
      }))
      .filter((group) => group.merchants.length > 0);
  });

  budgetAmount = '';

  readonly stepAt = stepAt;
  readonly canContinue = computed(() => canContinueStep(this.step(), this.draft()));

  constructor() {
    this.accountName = this.i18n.t('onboarding.accounts.defaultName');
    void this.load();
  }

  private draft(): OnboardingDraft {
    return {
      categoryCount: this.categoryCount(),
      accountCount: this.accounts(),
      acceptedPeople: this.addedPeople().size,
      selectedMerchants: this.selectedMerchants().length,
    };
  }

  // ---- loading ------------------------------------------------------------------------------

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [stateData, categories] = await Promise.all([
        this.graphql.query<{ onboardingState: OnboardingState }>(ONBOARDING_STATE),
        // Loaded with the state so a step-3 card can name the category the pipeline proposed. A second
        // round trip on the step that needs it would be a visible stall mid-wizard.
        this.graphql.query<{ categories: readonly CategoryOption[] }>(CATEGORY_NAMES),
      ]);

      const state = stateData.onboardingState;
      this.step.set(clampStep(state.step));
      this.categoryCount.set(state.categories);
      this.accounts.set(state.accounts);
      this.categories.set(categories.categories);
      this.categoryNames.set(new Map(categories.categories.map((row) => [row.id, row.path.join(' \u203a ')])));
    } catch (failure) {
      this.error.set(this.errors.for(failure));
    } finally {
      this.loading.set(false);
    }
  }

  // ---- navigation ---------------------------------------------------------------------------

  isLastStep(): boolean {
    return this.step() === LAST_STEP;
  }

  /** Advance, writing whatever this step writes. Completion is recorded on the last step. */
  async next(): Promise<void> {
    if (this.busy() || !this.canContinue()) return;
    await this.runStep(true);
  }

  /**
   * Skip this step.
   *
   * **Skip is never gated by `canContinue`.** The gate exists to stop an invalid *write*, and skipping
   * is the way out of every step (docs/01 F-13: "skippable at every step") — so a step 1 whose tree
   * does not exist yet must still be skippable, or the user is stuck on it.
   *
   * docs/02 §4.1's Skip column is not uniform, and the exception is the one that matters: skipping
   * **step 2** creates the single `CASH` account a Transaction needs to be legal at all (I-4). The
   * button's label says so, so "Skip" never quietly creates a record the user did not ask for.
   */
  async skip(): Promise<void> {
    if (this.busy()) return;
    if (stepAt(this.step())?.key === 'accounts' && this.accounts() === 0) {
      await this.createAccount({ name: this.i18n.t('onboarding.accounts.defaultName'), kind: 'CASH' });
    }
    await this.runStep(false);
  }

  /** The shared tail: optionally write this step, then advance or finish. */
  private async runStep(write: boolean): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      if (write) await this.writeCurrentStep();

      if (this.isLastStep()) {
        await this.graphql.query(COMPLETE_ONBOARDING);
        // The guard caches the answer, so it has to be told — otherwise `/` would bounce straight back
        // here off a stale "still onboarding" until the next page load.
        this.store.markComplete();
        await this.router.navigateByUrl('/');
        return;
      }
      await this.goTo(this.step() + 1);
    } catch (failure) {
      // Stay on the step: advancing past a write that did not happen would lose the user's work.
      this.error.set(this.errors.for(failure));
    } finally {
      this.busy.set(false);
    }
  }

  async back(): Promise<void> {
    if (this.busy() || this.step() <= 1) return;
    await this.goTo(this.step() - 1);
  }

  private async goTo(step: number): Promise<void> {
    const data = await this.graphql.query<{ setOnboardingStep: OnboardingState }>(SET_STEP, { step });
    this.step.set(clampStep(data.setOnboardingStep.step));
    this.categoryCount.set(data.setOnboardingStep.categories);
    this.accounts.set(data.setOnboardingStep.accounts);
  }

  // ---- per-step writes ----------------------------------------------------------------------

  private async writeCurrentStep(): Promise<void> {
    switch (stepAt(this.step())?.key) {
      case 'categories':
        // Idempotent by (parent, name), so pressing Continue twice reuses the tree rather than
        // creating a second one.
        await this.graphql.query(SEED_STARTER_CATEGORIES);
        return;

      case 'accounts':
        // Step 2 is "your first account": on a resume the Household already has one, and creating a
        // second would be a duplicate the user did not ask for.
        if (this.accounts() === 0 && this.accountName.trim() !== '') {
          await this.createAccount({ name: this.accountName.trim(), kind: this.accountKind });
        }
        return;

      case 'merchants': {
        const names = this.selectedMerchants();
        if (names.length === 0) return;
        const data = await this.graphql.query<{ applyMerchantSelection: SelectionResult }>(
          APPLY_MERCHANTS,
          { names },
        );
        this.announceSelection(data.applyMerchantSelection);
        return;
      }

      case 'plan': {
        const amount = this.budgetAmount.trim();
        if (amount === '') return;
        // The API rejects a JSON number for Money (ADR-003), so the minor units go as a string.
        // RSD is the Household's ledger currency (ADR-011); one currency per household.
        const parsed = parseAmount(amount, 'RSD');
        if (!parsed.money) throw new Error(this.i18n.t('onboarding.plan.invalid'));
        await this.graphql.query(UPSERT_BUDGET, {
          amount: { amountMinor: parsed.money.amountMinor.toString(), currency: 'RSD' },
          categoryId: null,
          period: 'MONTHLY',
        });
        return;
      }

      default:
        // Steps 3 and 6 write through their own controls: a Counterparty card, and the capture screen.
        return;
    }
  }

  private async createAccount(input: { name: string; kind: string }): Promise<void> {
    const data = await this.graphql.query<{ createAccount: { id: string } }>(CREATE_ACCOUNT, input);
    if (data.createAccount.id !== '') this.accounts.update((count) => count + 1);
  }

  private announceSelection(result: SelectionResult): void {
    const parts = [this.i18n.t('onboarding.merchants.applied', { count: result.applied })];
    if (result.alreadyOwned > 0) {
      parts.push(this.i18n.t('onboarding.merchants.alreadyOwned', { count: result.alreadyOwned }));
    }
    if (result.withoutCategory.length > 0) {
      // Not an error, but the user should know the suggestion was not made rather than assume it was.
      parts.push(
        this.i18n.t('onboarding.merchants.withoutCategory', { count: result.withoutCategory.length }),
      );
    }
    if (result.unresolved.length > 0) {
      parts.push(this.i18n.t('onboarding.merchants.unresolved', { items: result.unresolved.join(', ') }));
    }
    this.announcement.set(parts.join(' '));
  }

  // ---- step 3 ------------------------------------------------------------------------------

  /**
   * Ask the pipeline what each phrase means.
   *
   * The category suggestion is a classification, so it comes from `captureParse` rather than from a
   * second copy of the keyword rules — `Dejan rođa, septička jama` segments into two fragments, each
   * with whatever category (if any) the real pipeline found.
   */
  async proposePeople(): Promise<void> {
    const text = this.peopleInput.trim();
    if (text === '' || this.busy()) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      const data = await this.graphql.query<{ captureParse: { fragments: readonly ProposalFragmentWire[] } }>(
        CAPTURE_PARSE,
        { text },
      );
      const proposals = personProposals(data.captureParse.fragments);
      this.proposals.set(proposals);
      this.chosenCategories.set(
        new Map(
          proposals
            .filter((proposal) => proposal.categoryId !== null)
            .map((proposal) => [proposal.index, proposal.categoryId as string]),
        ),
      );
    } catch (failure) {
      this.error.set(this.errors.for(failure));
    } finally {
      this.busy.set(false);
    }
  }

  /** The category chosen for a card: the pipeline's suggestion until the user picks another. */
  chosenFor(proposal: PersonProposal): string {
    return this.chosenCategories().get(proposal.index) ?? '';
  }

  chooseCategory(index: number, categoryId: string): void {
    const next = new Map(this.chosenCategories());
    if (categoryId === '') next.delete(index);
    else next.set(index, categoryId);
    this.chosenCategories.set(next);
  }

  /**
   * Create the Counterparty with its alias, and a rule when a category is chosen.
   *
   * The category is the user's choice, seeded from the pipeline's suggestion: a person's name does not
   * imply a category by itself, so asking is the only way step 3 can create the rule docs/01 §5 wants
   * ("Creates Counterparty + rule from day one") for a person rather than only for a bill.
   */
  async addPerson(proposal: PersonProposal): Promise<void> {
    if (this.busy()) return;
    const categoryId = this.chosenFor(proposal) === '' ? null : this.chosenFor(proposal);
    this.busy.set(true);
    this.error.set(null);
    try {
      const created = await this.graphql.query<{ createCounterparty: { id: string } }>(
        CREATE_COUNTERPARTY,
        { name: proposal.personName, type: 'PERSON', defaultCategoryId: categoryId },
      );
      const id = created.createCounterparty.id;

      // The alias is the WHOLE phrase, because rung 3 requires every token of the name to occur in the
      // input — `Dejan` alone would not match a later `Dejan rođa 3600` (docs/04 §4).
      await this.graphql.query(SET_COUNTERPARTY_ALIASES, { counterpartyId: id, aliases: [proposal.alias] });

      if (categoryId !== null) {
        // docs/02 FL-01 §4: step 3 is the only step that creates a Rule, and only because the user
        // pressed Dodaj — synthesis proposes, the user confirms (ADR-010).
        await this.graphql.query(CREATE_RULE, {
          name: this.i18n.t('onboarding.people.ruleName', { person: proposal.personName }),
          priority: 100,
          conditions: { all: [{ field: 'counterparty', op: 'eq', value: id }] },
          actions: { setCategoryId: categoryId },
        });
      }

      this.addedPeople.update((set) => new Set([...set, proposal.index]));
      this.announcement.set(this.i18n.t('onboarding.people.announce', { person: proposal.personName }));
    } catch (failure) {
      this.error.set(this.errors.for(failure));
    } finally {
      this.busy.set(false);
    }
  }

  // ---- step 4 ------------------------------------------------------------------------------

  toggleMerchant(name: string): void {
    this.selectedMerchants.update((selected) =>
      selected.includes(name) ? selected.filter((candidate) => candidate !== name) : [...selected, name],
    );
  }

  // ---- copy --------------------------------------------------------------------------------

  titleKey(key: OnboardingStepKey): TranslationKey {
    return `onboarding.${key}.title` as TranslationKey;
  }

  ledeKey(key: OnboardingStepKey): TranslationKey {
    return `onboarding.${key}.lede` as TranslationKey;
  }

  skipKey(): TranslationKey {
    return stepAt(this.step())?.key === 'accounts' && this.accounts() === 0
      ? 'onboarding.skipWithDefaultAccount'
      : 'onboarding.skip';
  }

  kindKey(kind: string): TranslationKey {
    return `accountKind.${kind}` as TranslationKey;
  }

  /** Load the Household's category names once, for the step-3 cards. */
  async retry(): Promise<void> {
    await this.load();
  }
}

// ---------------------------------------------------------------------------------------------
// Wire shapes and documents
// ---------------------------------------------------------------------------------------------

interface OnboardingState {
  readonly step: number;
  readonly categories: number;
  readonly accounts: number;
}

interface SelectionResult {
  readonly applied: number;
  readonly alreadyOwned: number;
  readonly unresolved: readonly string[];
  readonly withoutCategory: readonly string[];
}

interface CategoryOption {
  readonly id: string;
  readonly path: readonly string[];
}

interface ProposalFragmentWire {
  readonly description: string;
  readonly categoryId: string | null;
  readonly needsReview: boolean;
}

const ONBOARDING_STATE = /* GraphQL */ `
  query OnboardingState {
    onboardingState {
      step
      categories
      accounts
    }
  }
`;

const CATEGORY_NAMES = /* GraphQL */ `
  query OnboardingCategoryNames {
    categories {
      id
      path
    }
  }
`;

const SET_STEP = /* GraphQL */ `
  mutation SetOnboardingStep($step: Int!) {
    setOnboardingStep(step: $step) {
      step
      categories
      accounts
    }
  }
`;

const SEED_STARTER_CATEGORIES = /* GraphQL */ `
  mutation SeedStarterCategories {
    seedStarterCategories {
      categories
      keywords
      reused
    }
  }
`;

const CREATE_ACCOUNT = /* GraphQL */ `
  mutation OnboardingAccount($name: String!, $kind: AccountKind!) {
    createAccount(name: $name, kind: $kind) {
      id
    }
  }
`;

const CAPTURE_PARSE = /* GraphQL */ `
  mutation OnboardingParse($text: String!) {
    captureParse(text: $text) {
      fragments {
        description
        categoryId
        needsReview
      }
    }
  }
`;

const CREATE_COUNTERPARTY = /* GraphQL */ `
  mutation OnboardingCounterparty($name: String!, $type: CounterpartyType, $defaultCategoryId: ID) {
    createCounterparty(name: $name, type: $type, defaultCategoryId: $defaultCategoryId) {
      id
    }
  }
`;

const SET_COUNTERPARTY_ALIASES = /* GraphQL */ `
  mutation OnboardingAliases($counterpartyId: ID!, $aliases: [String!]!) {
    setCounterpartyAliases(counterpartyId: $counterpartyId, aliases: $aliases) {
      id
    }
  }
`;

const CREATE_RULE = /* GraphQL */ `
  mutation OnboardingRule($name: String!, $priority: Int, $conditions: JSON!, $actions: JSON!) {
    createRule(name: $name, priority: $priority, conditions: $conditions, actions: $actions) {
      id
    }
  }
`;

const APPLY_MERCHANTS = /* GraphQL */ `
  mutation ApplyMerchantSelection($names: [String!]!) {
    applyMerchantSelection(names: $names) {
      applied
      alreadyOwned
      unresolved
      withoutCategory
    }
  }
`;

const UPSERT_BUDGET = /* GraphQL */ `
  mutation OnboardingBudget($amount: Money!, $categoryId: ID, $period: BudgetPeriod!) {
    upsertBudget(amount: $amount, categoryId: $categoryId, period: $period) {
      id
    }
  }
`;

const COMPLETE_ONBOARDING = /* GraphQL */ `
  mutation CompleteOnboarding {
    completeOnboarding {
      step
      completedAt
    }
  }
`;
