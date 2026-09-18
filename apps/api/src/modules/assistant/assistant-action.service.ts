/**
 * Propose → Confirm → Execute for assistant **writes** — ADR-035, docs/06 §8.16.
 *
 * The shape is deliberately the fourth instance of a pattern this codebase already uses three times
 * (`captureParse`→`captureCommit`, `detectSubscriptions`→`confirmDetectedSubscription`, a correction→a
 * rule): the server computes a proposal, the human approves it, and only then does a write happen.
 *
 * ## What this class is not allowed to do
 *
 * - **Execute without a click.** There is no path from a question to a write; `execute` exists only
 *   for a `proposalId` the server itself stored.
 * - **Trust the caller's arguments.** `execute` reads `proposalId` and `idempotencyKey` and nothing
 *   else, so the action performed is byte-for-byte the action the card showed (decision 2).
 * - **Invent a number or an id.** A name is text the user typed; an amount comes from `parseAmount`
 *   through the classification pipeline; ids come from the database. Every service call goes through
 *   the method the UI's own mutation calls.
 * - **Offer a write that will fail.** `ADD_CATEGORY` checks the duplicate rule the partial index
 *   enforces at **propose** time, and `ADD_TRANSACTION` refuses what the capture screen refuses (an
 *   ambiguous amount) rather than letting a confirm button offer a doomed write.
 *
 * ## The two actions are built differently on purpose
 *
 * `ADD_CATEGORY` is a name and two defaults: the preview *is* the diff. `ADD_TRANSACTION` runs the
 * whole capture pipeline, so its proposal carries the parser's own output — the amount as minor units
 * for `fm-money`, the Category it resolved, the day it will be filed under, and whether the confidence
 * gate will send the row to the review queue as `PENDING`. That is what makes the confirmation honest:
 * the human is approving the classification, not just the text.
 *
 * ## Idempotency, and why the result is cached
 *
 * `take` consumes the proposal atomically, so a double confirm cannot create two rows. But a *retry*
 * after a timeout must not report failure for a write that happened — so the outcome is remembered
 * against the caller's idempotency key first, and `execute` checks that before touching the proposal.
 *
 * @module apps/api/src/modules/assistant
 */

import { Injectable, Logger } from '@nestjs/common';

import {
  DEFAULT_TIME_ZONE,
  formatMoney,
  money,
  monthPeriod,
  todayIn,
  uuidv7,
  type CurrencyCode,
  type Money,
} from '@finmate/domain';

import { extractFragment } from '@finmate/nlp';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { normaliseForMatching } from '../../common/text/normalise';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { BudgetsService } from '../budgeting/budgets.service';
import { BudgetPeriodEnum } from '../budgeting/budget.model';
import { GoalsService } from '../goals/goals.service';
import { TagsService } from '../taxonomy/tags.service';
import { ClassificationService, type FragmentResult } from '../classification/classification.service';
import { CorrectionsService, type CorrectionRow } from '../classification/corrections.service';
import type { CorrectionSubject } from '../classification/rule-synthesis';
import { CaptureCommitRejected, TransactionsService } from '../ledger/transactions.service';
import { TransactionKind, TransactionStatus } from '../ledger/transaction.model';
import { CategoriesService } from '../taxonomy/categories.service';
import { CategoryKind } from '../taxonomy/category.model';
import { ACTION_TEMPLATES, type ActionSlotName, type AssistantAction } from './assistant-actions';
import { ACTION_NAME_MAX_LENGTH, cleanName, resolveEntityIn } from './action-planner';
import { categoryEntities } from './planner-entities';
import { rulePreviewRows, type RulePreviewNames } from './rule-preview';
import {
  PendingActionStore,
  PROPOSAL_TTL_SECONDS,
  type ActionPreview,
  type ActionPreviewLine,
  type ExecutedActionResult,
  type PendingActionProposal,
} from './pending-action.store';

/** A proposal, or an honest refusal to make one — the shape `assistantAnswer` established. */
export type ProposeOutcome =
  | {
      readonly proposed: true;
      readonly proposalId: string;
      readonly action: AssistantAction;
      readonly preview: ActionPreview;
      readonly expiresAt: string;
    }
  | { readonly proposed: false; readonly reason: string };

export interface ExecuteActionResult {
  readonly action: AssistantAction;
  readonly createdId: string;
  readonly createdLabel: string;
  readonly undo: string;
  readonly sentence: string;
  /** True when the caller's idempotency key had already produced this result. */
  readonly replayed: boolean;
}

/** What one action's builder hands back: the slots to store, the derived args, and the card. */
interface BuiltProposal {
  readonly slots: Readonly<Record<string, string>>;
  readonly args?: Readonly<Record<string, string>>;
  readonly preview: ActionPreview;
}

/** What an executor hands back. `sentence` quotes the **returned** row (ADR-035 decision 8). */
interface Executed {
  readonly id: string;
  readonly label: string;
  readonly sentence: string;
}

/**
 * How one action reads on a card, per language.
 *
 * Two templates, not a catalogue: the API has no i18n layer (docs/06 §5.14 records that breach, and
 * A-7 owns it). A **write confirmation** is nevertheless the one sentence worth not shipping
 * English-only into a Serbian Household, so the phrasings live here beside the action, in the shape
 * ADR-019's amendment prescribes — one entry, its per-language variants together.
 *
 * The money is formatted with the **same language the copy is written in**, deliberately: the sentence
 * and the figures inside it disagreeing about grouping is the one thing a reader would notice.
 */
const COPY = {
  en: {
    locale: 'en-US',
    kind: { EXPENSE: 'expense', INCOME: 'income' },
    topLevel: 'top level',
    noCategory: 'no category',
    fields: {
      name: 'name',
      kind: 'kind',
      parent: 'parent',
      amount: 'amount',
      account: 'account',
      category: 'category',
      period: 'period',
      target: 'target',
      deadline: 'deadline',
      correction: 'correction',
    },
    sentence: (name: string, kind: string, parent: string): string =>
      `New category “${name}” (${kind}, ${parent})`,
    budget: (category: string, amount: string, period: string): string =>
      `Monthly budget for ${category}: ${amount} (${period})`,
    budgetPeriod: 'this month',
    goal: (name: string, target: string): string => `New saving goal “${name}” — ${target}`,
    tag: (name: string): string => `New tag “${name}”`,
    rule: (name: string): string => `New rule “${name}” from that correction.`,
    // The referent, made visible: the entry's own text and the Category it was corrected to.
    correctionFrom: (text: string, category: string): string => `“${text}” → ${category}`,
    // The words a rule's clauses are rendered with (`rule-preview.ts`), so the card says `merchant is
    // Lidl` in the same language as the sentence above it.
    ruleClauses: {
      field: {
        text: 'entry text',
        description: 'description',
        merchant: 'merchant',
        counterparty: 'person',
        category: 'category',
      },
      op: { contains: 'contains', notContains: 'does not contain', equals: 'is', startsWith: 'starts with' },
      asStored: 'shown as stored',
      cleared: 'cleared',
    },
    noDeadline: 'no deadline yet',
    allCategories: 'all categories',
    // Built by joining parts rather than by referring to the sibling key: a template that reads
    // `COPY.en.…` from inside `COPY`'s own literal is a circular inference TypeScript refuses.
    transaction: (
      label: string,
      amount: string,
      category: string,
      needsReview: boolean,
    ): string =>
      [`New transaction “${label}” — ${amount}`, category, ...(needsReview ? ['goes to review'] : [])].join(
        ', ',
      ),
    confirmed: (label: string, amount: string, notes: readonly string[]): string =>
      `Added “${label}” — ${amount}.${notes.length > 0 ? ` ${notes.join(' ')}` : ''}`,
    pendingNote: 'It is waiting in the review queue until you confirm its category.',
    duplicateNote: 'It may be a duplicate of something you already had.',
  },
  sr: {
    locale: 'sr-Latn-RS',
    kind: { EXPENSE: 'rashod', INCOME: 'prihod' },
    topLevel: 'bez nadređene',
    noCategory: 'bez kategorije',
    fields: {
      name: 'naziv',
      kind: 'vrsta',
      parent: 'nadređena',
      amount: 'iznos',
      account: 'račun',
      category: 'kategorija',
      period: 'period',
      target: 'cilj',
      deadline: 'rok',
      correction: 'ispravka',
    },
    sentence: (name: string, kind: string, parent: string): string =>
      `Nova kategorija „${name}” (${kind}, ${parent})`,
    budget: (category: string, amount: string, period: string): string =>
      `Mesečni budžet za ${category}: ${amount} (${period})`,
    budgetPeriod: 'ovaj mesec',
    goal: (name: string, target: string): string => `Novi cilj „${name}” — ${target}`,
    // **`oznaka`, not `tag`.** The Serbian screens call this entity an *oznaka* (`nav.tags`/`tags.title`
    // are `Oznake`, the create sheet says `Nova oznaka`), and the card is quoting the server's sentence,
    // so a Serbian card saying `Novi tag` would use a different word for the same row than the screen it
    // links to. The cue list accepts both (`tag` *and* `oznaka`) — that is about what a *question* says,
    // which is not the glossary (docs/03).
    tag: (name: string): string => `Nova oznaka „${name}”`,
    rule: (name: string): string => `Novo pravilo „${name}” iz te ispravke.`,
    correctionFrom: (text: string, category: string): string => `„${text}” → ${category}`,
    ruleClauses: {
      field: {
        text: 'tekst unosa',
        description: 'opis',
        merchant: 'prodavac',
        counterparty: 'osoba',
        category: 'kategorija',
      },
      op: { contains: 'sadrži', notContains: 'ne sadrži', equals: 'je', startsWith: 'počinje sa' },
      asStored: 'prikazano kako je sačuvano',
      cleared: 'uklonjeno',
    },
    noDeadline: 'još bez roka',
    allCategories: 'sve kategorije',
    transaction: (
      label: string,
      amount: string,
      category: string,
      needsReview: boolean,
    ): string =>
      [`Nova transakcija „${label}” — ${amount}`, category, ...(needsReview ? ['ide na pregled'] : [])].join(
        ', ',
      ),
    confirmed: (label: string, amount: string, notes: readonly string[]): string =>
      `Dodato „${label}” — ${amount}.${notes.length > 0 ? ` ${notes.join(' ')}` : ''}`,
    pendingNote: 'Čeka u pregledu dok ne potvrdiš njenu kategoriju.',
    duplicateNote: 'Možda je duplikat nečega što već imaš.',
  },
} as const;

/** Serbian gets Serbian; anything else gets English, which is the product's primary locale. */
function copyFor(locale: string | undefined): (typeof COPY)['en'] | (typeof COPY)['sr'] {
  return locale !== undefined && locale.toLowerCase().startsWith('sr') ? COPY.sr : COPY.en;
}

@Injectable()
export class AssistantActionService {
  private readonly logger = new Logger(AssistantActionService.name);

  constructor(
    private readonly categories: CategoriesService,
    private readonly budgets: BudgetsService,
    private readonly goals: GoalsService,
    private readonly tags: TagsService,
    private readonly classification: ClassificationService,
    // The learning loop, reached by question (B-5): the correction, the rule it synthesises and the
    // conflict check all come from the services `correctTransaction`/`createRuleFromCorrection` use, so
    // the card and `/transactions` cannot propose different rules for one correction.
    private readonly corrections: CorrectionsService,
    private readonly transactions: TransactionsService,
    private readonly accounts: AccountsService,
    private readonly prisma: PrismaService,
    private readonly store: PendingActionStore,
  ) {}

  /**
   * Build and store a proposal.
   *
   * Writes nothing to the ledger. It is a `Mutation` at the edge for one reason: a transaction
   * proposal runs the classifier, which records a `classification_decisions` row and may call a model —
   * `captureParse` is a Mutation for exactly that reason, and a Query that spends money is a lie about
   * itself (docs/06 §8.16).
   */
  async propose(input: {
    readonly householdId: string;
    readonly userId: string;
    readonly action: AssistantAction;
    readonly slots: Readonly<Record<string, string>>;
    readonly locale?: string;
  }): Promise<ProposeOutcome> {
    const template = ACTION_TEMPLATES[input.action];
    // A `destroys` action is not offered at all, so this cannot be reached through a stored proposal
    // — but the check belongs at the boundary that creates one (ADR-035 decision 7).
    if (template.destroys) {
      throw new ApiError('VALIDATION_FAILED', 'That action is not available.');
    }

    // Only the slots this action declares may be supplied, so a caller cannot inject one an action
    // does not own — `ADD_CATEGORY` has no account, and a client sending one must not be able to give
    // it one. The same filter is what lets the resolver merge its `kind`/`accountId` overrides in
    // without knowing which action it is looking at.
    const slots = this.declaredSlots(input.action, input.slots);
    let built: BuiltProposal | { readonly proposed: false; readonly reason: string };
    try {
      built = await this.builders[input.action]({
        householdId: input.householdId,
        slots,
        ...(input.locale === undefined ? {} : { locale: input.locale }),
      });
    } catch (error) {
      // A slot the proposal cannot be built without is a **refusal with a reason**, not an error —
      // the same distinction `UNRUNNABLE:name` draws on the read side. It is a throw inside a builder
      // because a `Record` of builders has one return type.
      if (error instanceof UnrunnableSlot) {
        return { proposed: false, reason: `UNRUNNABLE:${error.slot}` };
      }
      throw error;
    }
    if ('proposed' in built) return built;

    const id = uuidv7();
    const proposal: PendingActionProposal = {
      id,
      householdId: input.householdId,
      userId: input.userId,
      action: input.action,
      slots: built.slots,
      ...(built.args === undefined ? {} : { args: built.args }),
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      preview: built.preview,
      createdAt: new Date().toISOString(),
    };

    const stored = await this.store.put(proposal);
    if (!stored) {
      // Fail closed: a proposal that cannot be read back cannot be confirmed, and offering a button
      // that will fail is worse than saying so now (pending-action.store.ts).
      this.logger.warn(`could not store a ${input.action} proposal; refusing to offer it`);
      throw new ApiError('INTERNAL', 'Could not prepare that action. Please try again.');
    }

    return {
      proposed: true,
      proposalId: id,
      action: input.action,
      preview: built.preview,
      expiresAt: new Date(Date.now() + PROPOSAL_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /**
   * Perform the action the human approved. The only inputs are *which* proposal and the caller's
   * idempotency key — never the arguments, which were read from the store.
   */
  async execute(input: {
    readonly householdId: string;
    readonly proposalId: string;
    readonly idempotencyKey: string;
  }): Promise<ExecuteActionResult> {
    const replayed = await this.store.recallResult(input.householdId, input.idempotencyKey);
    if (replayed !== null) return { ...replayed, replayed: true };

    const proposal = await this.store.take(input.householdId, input.proposalId);
    if (proposal === null) {
      throw new ApiError(
        'NOT_FOUND',
        'That action is no longer available — it may have expired or already been applied.',
      );
    }
    // Defence in depth: the store key is household-scoped, so this can only fire if a proposal were
    // somehow addressed across Households, which is the one thing ADR-008 forbids outright.
    if (proposal.householdId !== input.householdId) {
      throw new ApiError('NOT_FOUND', 'That action is no longer available.');
    }

    const created = await this.executors[proposal.action](proposal);
    const result: ExecutedActionResult = {
      action: proposal.action,
      createdId: created.id,
      createdLabel: created.label,
      undo: ACTION_TEMPLATES[proposal.action].undo,
      // The confirmation quotes the **returned row**, not the proposal: the sentence must describe
      // what happened, and only the write knows that (ADR-035 decision 8).
      sentence: created.sentence,
      executedAt: new Date().toISOString(),
    };

    await this.store.rememberResult(input.householdId, input.idempotencyKey, result);
    return { ...result, replayed: false };
  }

  // -------------------------------------------------------------------------------------------
  // The builders: what a proposal for each action is
  // -------------------------------------------------------------------------------------------

  private readonly builders: Readonly<
    Record<
      AssistantAction,
      (context: {
        readonly householdId: string;
        readonly slots: Readonly<Record<string, string>>;
        readonly locale?: string;
      }) => Promise<BuiltProposal | { readonly proposed: false; readonly reason: string }>
    >
  > = {
    ADD_CATEGORY: async ({ householdId, slots, locale }) => {
      const name = this.requireName(slots['name'], 'category');
      const kind = this.readKind(slots['kind']);
      await this.assertNameFree(householdId, name);

      return {
        slots: { name, kind },
        preview: this.categoryPreview({ name, kind }, locale),
      };
    },

    SET_BUDGET: async ({ householdId, slots, locale }) => {
      const text = this.requireText(slots['text']);

      const household = await this.prisma.client.households.findFirst({ where: { id: householdId } });
      if (household === null) throw new ApiError('NOT_FOUND', 'Household not found.');
      const currency = household.ledger_currency as CurrencyCode;
      const today = todayIn(household.iana_timezone || DEFAULT_TIME_ZONE, new Date());

      // The parser the capture path uses, on the phrase rather than on a whole entry: it finds the
      // amount, reports **every** reading of `1.200`, and leaves the remaining words as the
      // description — which is what names the Category.
      const fragment = extractFragment(text, { currency, today });
      if (fragment.amountMinor === null) return { proposed: false, reason: 'NO_AMOUNT' };
      const readings = new Set(fragment.candidates.map((candidate) => candidate.amountMinor));
      if (readings.size > 1) return { proposed: false, reason: 'AMBIGUOUS_AMOUNT' };

      // The same ladder, the same vocabulary and the same breadcrumbs a **question** resolves a
      // Category with, so a budget and the answer beside it cannot scope different Categories.
      const resolved = resolveEntityIn(
        fragment.description,
        categoryEntities(await this.categories.list(householdId)),
      );
      if (resolved === null) {
        // Deliberately a refusal and not a Household-wide budget: a typo in a Category name would
        // otherwise become a limit over every Category, which is the wrong write R-29 is about. A
        // whole-Household budget is set on `/budgets`, where the choice is explicit.
        return { proposed: false, reason: 'UNRUNNABLE:categoryId' };
      }

      const period = BudgetPeriodEnum.MONTHLY;
      const periodStart = monthPeriod(today).start;
      const existing = (await this.budgets.list(householdId)).find(
        (budget) =>
          budget.categoryId === resolved.id &&
          budget.period === BudgetPeriodEnum.MONTHLY &&
          budget.periodStart === periodStart,
      );

      const amount = this.readAmount(fragment.amountMinor.toString(), currency);
      if (amount === null) return { proposed: false, reason: 'NO_AMOUNT' };
      if (existing !== undefined) {
        // See `ACTION_TEMPLATES.SET_BUDGET`: overwriting has no honest undo in this build, so the
        // proposal refuses rather than offering a button whose undo would delete the old budget.
        return { proposed: false, reason: 'ALREADY_SET' };
      }

      const copy = copyFor(locale);
      const kind = resolved.kind === 'INCOME' ? 'INCOME' : 'EXPENSE';
      return {
        // The Category is a slot the action **resolved**, not one it filled: nothing about it is a
        // default, and the card must not offer to change a name the user typed.
        slots: { text, ...(resolved.kind === undefined ? {} : { kind }) },
        args: {
          categoryId: resolved.id,
          amountMinor: fragment.amountMinor.toString(),
          currency,
          period,
          periodStart,
        },
        preview: {
          sentence: copy.budget(
            resolved.name,
            formatMoney(amount, copy.locale),
            copy.budgetPeriod,
          ),
          diff: [
            {
              slot: 'categoryId',
              field: copy.fields.category,
              before: null,
              after: resolved.name,
              afterValue: resolved.id,
              defaulted: false,
            },
            {
              slot: 'amountMinor',
              field: copy.fields.amount,
              before: null,
              // The label is the amount as a string **for a reader who never opens the card's own
              // renderer** — the value that matters is `afterMoney`, which the client draws with
              // `fm-money` (ADR-003).
              after: formatMoney(amount, copy.locale),
              afterValue: fragment.amountMinor.toString(),
              afterMoney: { amountMinor: fragment.amountMinor.toString(), currency },
              defaulted: false,
            },
            {
              slot: 'period',
              field: copy.fields.period,
              before: null,
              after: copy.budgetPeriod,
              afterValue: null,
              // A **fixed** part of what this action means, deliberately not `defaulted`: the action
              // sets the monthly budget, so the card says so instead of offering a period it cannot
              // change. Weekly or yearly budgets are not reachable from here.
              defaulted: false,
            },
          ],
        },
      };
    },

    ADD_TAG: async ({ householdId, slots, locale }) => {
      const name = this.requireName(slots['name'], 'tag');
      await this.assertTagNameFree(householdId, name);

      const copy = copyFor(locale);
      return {
        slots: { name },
        preview: {
          sentence: copy.tag(name),
          diff: [
            {
              slot: 'name',
              field: copy.fields.name,
              before: null,
              after: name,
              afterValue: null,
              defaulted: false,
            },
          ],
        },
      };
    },

    ADD_GOAL: async ({ householdId, slots, locale }) => {
      const text = this.requireText(slots['text']);

      const household = await this.prisma.client.households.findFirst({ where: { id: householdId } });
      if (household === null) throw new ApiError('NOT_FOUND', 'Household not found.');
      const currency = household.ledger_currency as CurrencyCode;
      const today = todayIn(household.iana_timezone || DEFAULT_TIME_ZONE, new Date());

      // The same reader the capture path uses: it finds the target, reports every reading of `1.200`,
      // and leaves the **name** as the text around it — in the user's own characters, because a goal is
      // called what they called it (`Rođendan`, not `rodendan`).
      const fragment = extractFragment(text, { currency, today });
      if (fragment.amountMinor === null) return { proposed: false, reason: 'NO_AMOUNT' };
      const readings = new Set(fragment.candidates.map((candidate) => candidate.amountMinor));
      if (readings.size > 1) return { proposed: false, reason: 'AMBIGUOUS_AMOUNT' };

      // An amount with no name around it is a **refusal**, not a validation failure — the same
      // distinction `UNRUNNABLE:name` draws for the category action, and the card turns it into "tell me
      // what to call it" rather than an error banner.
      const name = cleanName(fragment.description);
      if (name.length === 0) return { proposed: false, reason: 'UNRUNNABLE:name' };
      this.requireName(name, 'goal');

      const target = this.readAmount(fragment.amountMinor.toString(), currency);
      if (target === null) return { proposed: false, reason: 'NO_AMOUNT' };

      const copy = copyFor(locale);
      return {
        slots: { text, name },
        args: {
          name,
          targetMinor: fragment.amountMinor.toString(),
          currency,
        },
        preview: {
          sentence: copy.goal(name, formatMoney(target, copy.locale)),
          diff: [
            {
              slot: 'name',
              field: copy.fields.name,
              before: null,
              after: name,
              afterValue: null,
              defaulted: false,
            },
            {
              slot: 'targetMinor',
              field: copy.fields.target,
              before: null,
              after: formatMoney(target, copy.locale),
              afterValue: fragment.amountMinor.toString(),
              afterMoney: { amountMinor: fragment.amountMinor.toString(), currency },
              defaulted: false,
            },
            {
              slot: 'targetDate',
              field: copy.fields.deadline,
              before: null,
              after: copy.noDeadline,
              afterValue: null,
              // **Stated**, not defaulted: the card must not offer a date it cannot parse. Relative dates
              // have no parser (docs/16 B.3), so this action creates the goal without one and says so —
              // `/goals` edits a deadline inline, and `GOAL_REQUIRED_MONTHLY` needs it to answer.
              defaulted: false,
            },
          ],
        },
      };
    },

    ADD_TRANSACTION: async ({ householdId, slots, locale }) => {
      const text = this.requireText(slots['text']);

      // The same pipeline `/capture` runs, including its audit row and its cost (ADR-002's ladder,
      // ADR-009's gate). Nothing about the ledger changes here.
      const parse = await this.classification.parse(householdId, {
        text,
        locale: locale ?? null,
        allowAi: true,
      });

      // A fragment with no amount is a word, not a Transaction — the capture screen drops those from
      // the batch, and dropping them here keeps *"dodaj trošak kafa 180 i hleb"* from refusing.
      const rows = parse.fragments.filter((fragment) => fragment.amountMinor !== null);
      if (rows.length === 0) return { proposed: false, reason: 'NO_AMOUNT' };
      // One row, deliberately. A batch needs per-row editing (categories, amounts, removals) that a
      // confirmation card does not have, and showing only the first of three would be a card that
      // misdescribes what the button does. The capture screen is the surface for more than one.
      if (rows.length > 1) return { proposed: false, reason: 'MULTIPLE_ROWS' };

      const row = rows[0] as FragmentResult;
      // `1.200` is two amounts, and the capture screen refuses the whole batch until the user picks
      // one. A card cannot ask, so it must not guess: a tenfold error in the user's money is exactly
      // what ADR-003's parsing rule exists to prevent.
      if (hasAmbiguousAmount(row)) return { proposed: false, reason: 'AMBIGUOUS_AMOUNT' };

      const amountMinor = row.amountMinor as string;
      const household = await this.prisma.client.households.findFirst({
        where: { id: householdId },
      });
      if (household === null) throw new ApiError('NOT_FOUND', 'Household not found.');

      const currency = (row.currency ?? household.ledger_currency) as CurrencyCode;
      const amount = this.readAmount(amountMinor, currency);
      if (amount === null) return { proposed: false, reason: 'NO_AMOUNT' };
      const account = await this.requireAccount(householdId, slots['accountId']);
      const category = await this.categoryName(householdId, row.categoryId);

      // The direction: stated by the text, or filled in visibly. `UNKNOWN` and a refund/storno word
      // are the two cases the parser refuses to decide, and the card answers both by offering the
      // toggle rather than by guessing (ADR-035 decision 5) — which is also what
      // `needsDirectionConfirmation` is for on the capture screen.
      const parsedKind = row.kind === 'INCOME' || row.kind === 'EXPENSE' ? row.kind : null;
      const kindStated = parsedKind !== null && !row.needsDirectionConfirmation;
      // A supplied `kind` is the card's toggle coming back, and it **wins**: the human chose it, and the
      // stored slot has to be what they were shown. The `defaulted` flag does *not* follow it — it
      // records that the *question* never said, which is what keeps the toggle on the card instead of
      // vanishing the moment it is used once.
      const kind =
        slots['kind'] === 'INCOME' || slots['kind'] === 'EXPENSE' ? slots['kind'] : (parsedKind ?? 'EXPENSE');
      const occurredOn =
        row.occurredOn ?? todayIn(household.iana_timezone || DEFAULT_TIME_ZONE, new Date());
      const description = (row.description.length > 0 ? row.description : text).trim();

      const copy = copyFor(locale);
      const line: ActionPreviewLine = {
        label: description,
        amountMinor,
        currency,
        category: category?.name ?? null,
        occurredOn,
        needsReview: row.needsReview,
      };

      return {
        slots: { text, kind, accountId: account.id },
        args: {
          amountMinor,
          currency,
          kind,
          description,
          occurredOn,
          accountId: account.id,
          // The decision *is* the classification: committing against it reuses the stored category
          // instead of running the pipeline a second time (and paying for it twice).
          acceptedProposalId: row.decisionId,
          // Minted here, once, and stored — the offline queue's rule, for the same reason: a retry
          // must be the same row (I-10), not a second one.
          clientRowId: uuidv7(),
          idempotencyKey: uuidv7(),
          ...(row.merchantId === null ? {} : { merchantId: row.merchantId }),
          ...(row.counterpartyId === null ? {} : { counterpartyId: row.counterpartyId }),
        },
        preview: {
          sentence: copy.transaction(description, formatMoney(amount, copy.locale), line.category ?? copy.noCategory, line.needsReview),
          diff: [
            {
              slot: 'kind',
              field: copy.fields.kind,
              before: null,
              after: copy.kind[kind],
              afterValue: kind,
              // Only when the text did not state it — a direction the user gave is not a suggestion.
              defaulted: !kindStated,
            },
            {
              slot: 'accountId',
              field: copy.fields.account,
              before: null,
              after: account.name,
              afterValue: account.id,
              defaulted: true,
            },
          ],
          lines: [line],
        },
      };
    },

    /**
     * A Rule derived from the Household's **most recent Correction** (B-5).
     *
     * Four refusals, and each one is a *mirror of a gate the write itself has* — the B-4c lesson, which
     * is that a propose-time check copied from the wrong place offers a button that cannot work:
     *
     * | The write | The refusal here |
     * |---|---|
     * | `correctionSubject` returns `null` for a correction with no corrected-to Category | `NO_RULE` |
     * | `createRuleFromCorrection` throws when synthesis yields nothing | `NO_RULE` |
     * | it throws `RuleShadowedError` when an existing rule would win | `SHADOWED` |
     * | it throws `CONFLICT` when this correction already produced a rule | `ALREADY_LEARNED` |
     *
     * The last one is refused rather than left to the write on purpose: the error the write raises is a
     * GraphQL `CONFLICT`, and the card renders that code as *"something with that name already exists"*,
     * which is not what happened. A refusal with its own reason is both honest and actionable.
     */
    CREATE_RULE_FROM_CORRECTION: async ({ householdId, slots, locale }) => {
      // A phrase after the object word — *"napravi pravilo od ispravke za Lidl"* — asks this action to
      // pick a correction **by name**, which this build cannot do: a Correction has no name, only the
      // entry it was made on. Refused rather than ignored, because deriving from a different correction
      // than the one the reader named is exactly the wrong write R-29 is about.
      if ((slots['correctionId'] ?? '').trim().length > 0) {
        return { proposed: false, reason: 'UNRUNNABLE:correctionId' };
      }

      const correction = await this.corrections.latest(householdId);
      if (correction === null) return { proposed: false, reason: 'NO_CORRECTION' };
      // One correction, one rule (ADR-010): the write refuses a second, so the card must not offer one.
      if (correction.rule_created_id !== null) return { proposed: false, reason: 'ALREADY_LEARNED' };

      const subject = await this.correctionSubject(householdId, correction);
      if (subject === null) return { proposed: false, reason: 'NO_RULE' };

      const synthesis = await this.corrections.synthesise(householdId, subject);
      if (synthesis === null) return { proposed: false, reason: 'NO_RULE' };
      if (synthesis.check.shadowed) return { proposed: false, reason: 'SHADOWED' };

      const copy = copyFor(locale);
      const proposal = synthesis.synthesis.proposal;
      return {
        // The question states nothing: the correction is an **arg**, because the backend derived it.
        slots: {},
        args: { correctionId: correction.id },
        preview: {
          sentence: copy.rule(proposal.name),
          diff: [
            {
              slot: 'correctionId',
              field: copy.fields.correction,
              before: null,
              // Which correction this came from, in the reader's own words. It is the one thing the
              // question referred to **deictically** — "that correction" — so the card has to make the
              // referent visible. Flagged `defaulted`, which is exactly what happened: the question said
              // "this one" and the backend chose.
              after: copy.correctionFrom(subject.description, subject.categoryName),
              afterValue: correction.id,
              defaulted: true,
            },
            // The rule's own clauses, rendered from the **document that will be saved** rather than from
            // the trigger that produced it, so the card cannot describe a different rule than the write
            // (rule-preview.ts).
            ...rulePreviewRows(proposal, this.rulePreviewNames(subject), copy.ruleClauses).map((row) => ({
              slot: row.slot,
              field: row.field,
              before: null,
              after: row.after,
              afterValue: row.afterValue,
              // A statement, not a default: these are what the rule *is*, and the card offers no control
              // for any of them (`defaultedSlots` holds only `correctionId`, which is the one thing the
              // backend picked).
              defaulted: false,
            })),
          ],
        },
      };
    },
  };

  // -------------------------------------------------------------------------------------------
  // The executors: what each action does, once a human has confirmed it
  // -------------------------------------------------------------------------------------------

  /**
   * The executor map, `Record<AssistantAction, …>` on purpose: adding a member to
   * `ASSISTANT_ACTIONS` without an executor is a **compile** error, which is ADR-035 decision 3's
   * whole argument made structural.
   */
  private readonly executors: Readonly<
    Record<AssistantAction, (proposal: PendingActionProposal) => Promise<Executed>>
  > = {
    ADD_CATEGORY: async (proposal) => {
      const created = await this.categories.create(proposal.householdId, {
        name: proposal.slots['name'] as string,
        kind: (proposal.slots['kind'] as CategoryKind | undefined) ?? CategoryKind.EXPENSE,
        parentId: null,
      });
      return {
        id: created.id,
        label: created.name,
        sentence: this.categoryPreview(
          {
            name: created.name,
            kind: (proposal.slots['kind'] as CategoryKind | undefined) ?? CategoryKind.EXPENSE,
          },
          proposal.locale,
        ).sentence,
      };
    },

    SET_BUDGET: async (proposal) => {
      const args = proposal.args ?? {};
      const categoryId = args['categoryId'];
      const amountMinor = args['amountMinor'];
      if (categoryId === undefined || amountMinor === undefined) {
        // A proposal written by a build that stored something else is not one this build can execute,
        // and guessing at an amount would be the worst possible reading of that.
        throw new ApiError('INTERNAL', 'That proposal is incomplete and was not applied.');
      }

      const created = await this.budgets.upsert(proposal.householdId, {
        categoryId,
        period: (args['period'] as BudgetPeriodEnum | undefined) ?? BudgetPeriodEnum.MONTHLY,
        amountMinor: BigInt(amountMinor),
        ...(args['periodStart'] === undefined ? {} : { periodStart: args['periodStart'] }),
      });

      const copy = copyFor(proposal.locale);
      return {
        id: created.id,
        label: created.categoryName ?? copy.allCategories,
        // Built from the **returned** budget, not from the proposal: the row is what happened.
        sentence: copy.budget(
          created.categoryName ?? copy.allCategories,
          formatMoney(created.amount, copy.locale),
          copy.budgetPeriod,
        ),
      };
    },

    ADD_TAG: async (proposal) => {
      const created = await this.tags.create(proposal.householdId, {
        name: proposal.slots['name'] as string,
      });
      return {
        id: created.id,
        label: created.name,
        sentence: copyFor(proposal.locale).tag(created.name),
      };
    },

    ADD_GOAL: async (proposal) => {
      const args = proposal.args ?? {};
      const name = args['name'];
      const targetMinor = args['targetMinor'];
      if (name === undefined || targetMinor === undefined) {
        throw new ApiError('INTERNAL', 'That proposal is incomplete and was not applied.');
      }

      // No `targetDate` and no `accountId`: this action creates a goal, and its card **says** the goal
      // has no deadline rather than filling one it cannot read (docs/16 B.3).
      const created = await this.goals.create(proposal.householdId, {
        name,
        targetMinor: BigInt(targetMinor),
      });

      const copy = copyFor(proposal.locale);
      return {
        id: created.id,
        label: created.name,
        // Built from the **returned** goal, not from the proposal.
        sentence: copy.goal(created.name, formatMoney({ amountMinor: created.targetMinor, currency: created.currency as CurrencyCode }, copy.locale)),
      };
    },

    CREATE_RULE_FROM_CORRECTION: async (proposal) => {
      const correctionId = (proposal.args ?? {})['correctionId'];
      if (correctionId === undefined) {
        // A proposal written by a build that stored something else is not one this build can execute.
        throw new ApiError('INTERNAL', 'That proposal is incomplete and was not applied.');
      }

      // Both are re-read **now**: a proposal can sit in the store for ten minutes, and the write has to
      // act on the correction as it is at this moment. `createRuleFromCorrection` re-synthesises and
      // re-runs the shadowing check itself, which is why the executor does not replay the rule the card
      // showed — the proposal's job was to *describe* the write, and the service's is to perform it.
      const correction = await this.corrections.require(proposal.householdId, correctionId);
      const subject = await this.correctionSubject(proposal.householdId, correction);
      const outcome = await this.corrections.createRuleFromCorrection(
        proposal.householdId,
        correction,
        subject,
        { acceptProposal: true, overrides: null },
      );

      return {
        id: outcome.rule.id,
        label: outcome.rule.name,
        // Built from the **returned** rule, not from the proposal (ADR-035 decision 8).
        sentence: copyFor(proposal.locale).rule(outcome.rule.name),
      };
    },

    ADD_TRANSACTION: async (proposal) => {
      const args = proposal.args ?? {};
      const row = this.readStoredRow(args);
      const copy = copyFor(proposal.locale);

      let outcome;
      try {
        outcome = await this.transactions.captureCommit(proposal.householdId, {
          // No `parseId`: the row names the decision it was built from, and `captureCommit` reads that
          // decision's category rather than classifying again. `allowAi: false` is the same statement
          // from the other side — the model was asked once, at propose time, and its answer is what
          // the card showed and the human approved.
          rows: [
            {
              clientRowId: row.clientRowId,
              idempotencyKey: row.idempotencyKey,
              accountId: row.accountId,
              kind: row.kind === 'INCOME' ? TransactionKind.INCOME : TransactionKind.EXPENSE,
              amount: money(BigInt(row.amountMinor), args['currency'] as CurrencyCode),
              description: row.description,
              occurredOn: row.occurredOn,
              acceptedProposalId: row.acceptedProposalId,
              merchantId: args['merchantId'] ?? null,
              counterpartyId: args['counterpartyId'] ?? null,
              // The capture screen's own default: a blocked row is written PENDING and goes to the
              // queue. Writing it CONFIRMED is a deliberate act per row, not something this path does
              // on the user's behalf.
              confirmDespiteLowConfidence: false,
            },
          ],
          allowAi: false,
        });
      } catch (error) {
        // `CaptureCommitRejected` is the capture path's *diagnostic* payload, and the assistant has no
        // rows to hang it on. It becomes the typed error the card can print, with the field the
        // capture path named — never a 500 for a write the user can fix.
        if (error instanceof CaptureCommitRejected) {
          const first = error.rows[0];
          throw new ApiError(
            'VALIDATION_FAILED',
            first === undefined ? error.message : `${first.message} (${first.field ?? first.code})`,
          );
        }
        throw error;
      }

      const committed = outcome.committed[0];
      if (committed === undefined) {
        // The row was skipped rather than written. There is nothing to confirm, so the action failed
        // and the reason is the capture path's own.
        throw new ApiError(
          'VALIDATION_FAILED',
          outcome.skipped[0]?.reason ?? 'The transaction was not written.',
        );
      }

      const transaction = committed.transaction;
      const notes: string[] = [];
      if (transaction.status === TransactionStatus.PENDING) notes.push(copy.pendingNote);
      if (outcome.duplicateSuspects.length > 0) notes.push(copy.duplicateNote);

      return {
        id: transaction.id,
        label: transaction.description,
        sentence: copy.confirmed(
          transaction.description,
          formatMoney(transaction.amount, copy.locale),
          notes,
        ),
      };
    },
  };

  // -------------------------------------------------------------------------------------------
  // Shapes the card is built from
  // -------------------------------------------------------------------------------------------

  /**
   * The category card: one sentence and a field-by-field diff, rendered by the backend so the model
   * can never describe a write (ADR-035 decision 8).
   */
  private categoryPreview(
    input: { readonly name: string; readonly kind: CategoryKind },
    locale?: string,
  ): ActionPreview {
    const copy = copyFor(locale);
    const kindWord = copy.kind[input.kind];
    return {
      sentence: copy.sentence(input.name, kindWord, copy.topLevel),
      diff: [
        {
          slot: 'name',
          field: copy.fields.name,
          before: null,
          after: input.name,
          afterValue: null,
          defaulted: false,
        },
        {
          slot: 'kind',
          field: copy.fields.kind,
          before: null,
          after: kindWord,
          afterValue: input.kind,
          defaulted: true,
        },
        {
          slot: 'parentId',
          field: copy.fields.parent,
          before: null,
          after: copy.topLevel,
          afterValue: null,
          defaulted: false,
        },
      ],
    };
  }

  /**
   * The slots this action declares — required plus defaulted — and nothing else.
   *
   * `kind` and `accountId` arrive from the resolver as overrides, and which of them an action even has
   * is the registry's business, not the client's.
   */
  private declaredSlots(
    action: AssistantAction,
    slots: Readonly<Record<string, string>>,
  ): Readonly<Record<string, string>> {
    const template = ACTION_TEMPLATES[action];
    const allowed = new Set<string>([...template.requiredSlots, ...template.defaultedSlots]);
    return Object.fromEntries(Object.entries(slots).filter(([slot]) => allowed.has(slot)));
  }

  /**
   * The same rule Postgres enforces: `categories_unique_name` is
   * `(household_id, COALESCE(parent_id, nil), lower(name)) WHERE deleted_at IS NULL`.
   *
   * `lower`, not the fold: a preview must refuse **what the write would refuse**, and nothing more.
   * Folding would also catch `Putovánja` against `Putovanja`, which the index permits — refusing a
   * write that would have succeeded is a different bug from offering one that fails.
   */
  private async assertNameFree(householdId: string, name: string): Promise<void> {
    const existing = await this.categories.list(householdId);
    const lowered = name.toLowerCase();
    const clash = existing.find(
      (category) =>
        (category.parentId ?? null) === null && category.name.toLowerCase() === lowered,
    );
    if (clash !== undefined) {
      throw new ApiError('CONFLICT', `A category named "${clash.name}" already exists here.`);
    }
  }

  /**
   * The same rule `TagsService.assertNameFree` enforces — and it is a **different rule** from the
   * category one, which is why this is not `assertNameFree`.
   *
   * A Tag's uniqueness is by the **fold** (`normaliseForMatching`), not by `lower(name)`: `Odmor` and
   * `odmor` collide, and so do `Путовања` and `Putovanja`, because the fold transliterates and `lower`
   * does not. A propose-time check that used the category's rule would offer a confirm button for a write
   * `createTag` refuses. (Not `Rođendan`/`Rodjendan`: the fold maps `đ` → `d` and leaves the digraph `dj`
   * alone — the `đ`/`ђ` asymmetry docs/15 records as a Phase 2 gap.)
   */
  private async assertTagNameFree(householdId: string, name: string): Promise<void> {
    const folded = normaliseForMatching(name);
    const clash = (await this.tags.list(householdId)).find(
      (tag) => normaliseForMatching(tag.name) === folded,
    );
    if (clash !== undefined) {
      throw new ApiError('CONFLICT', `"${clash.name}" already exists.`);
    }
  }

  /**
   * The account a capture goes to: the one `/capture` preselects — the Household's newest live
   * account, because `AccountsService.list` orders by the UUIDv7 key descending.
   *
   * The rule is duplicated from that screen, so it is **visible and changeable** on the card rather
   * than silent: the diff flags `accountId` as defaulted, and the same argument that re-proposes the
   * `kind` re-proposes this. That is what makes a shared guess safe (ADR-035 decision 5).
   */
  private async requireAccount(
    householdId: string,
    requested: string | undefined,
  ): Promise<{ readonly id: string; readonly name: string }> {
    const page = await this.accounts.list({ householdId, first: 10 });
    const live = page.items;
    if (live.length === 0) {
      // Not `PROPOSED: false` with a missing slot: there is nothing the user can add to a card, and
      // the refusal says which slot could not be filled.
      throw new UnrunnableSlot('accountId');
    }
    if (requested === undefined) {
      const first = live[0] as { id: string; name: string };
      return { id: first.id, name: first.name };
    }
    const chosen = live.find((account) => account.id === requested);
    if (chosen === undefined) {
      throw new ApiError('VALIDATION_FAILED', 'That account is not one this Household can use.');
    }
    return { id: chosen.id, name: chosen.name };
  }

  /** The Category a decision chose, by name — `null` when nothing chose one. */
  private async categoryName(
    householdId: string,
    categoryId: string | null,
  ): Promise<{ readonly name: string } | null> {
    if (categoryId === null) return null;
    const categories = await this.categories.list(householdId);
    const found = categories.find((category) => category.id === categoryId);
    return found === undefined ? null : { name: found.name };
  }

  /**
   * The correction's **subject**, resolved exactly as `createRuleFromCorrection` resolves it.
   *
   * The resolver does this inline for the mutation; this is the same two steps — the entry's text and
   * entities from the ledger, and the corrected-to Category from the correction's own `to_value` — done
   * through the same `TransactionsService.correctionSubject`, so the card and the write cannot disagree
   * about what the rule would key on. `null` is a real answer: a correction on an amount or a merchant
   * has no corrected-to Category, and ADR-010's synthesis has nothing to propose for one.
   */
  private async correctionSubject(
    householdId: string,
    correction: CorrectionRow,
  ): Promise<CorrectionSubject | null> {
    if (correction.transaction_id === null) return null;
    return this.transactions.correctionSubject(
      householdId,
      correction.transaction_id,
      correction.to_value,
    );
  }

  /**
   * The names a rule's clause ids resolve to, taken from the **subject**.
   *
   * A correction produces a rule whose conditions name the Merchant or Counterparty the subject already
   * resolved and whose action names the Category it was corrected to — so the subject's own ids are the
   * document's ids, and no extra read is needed. An id the document names that is *not* here makes
   * `rule-preview` render that half as stored, which is the honest outcome rather than a uuid at a
   * reader.
   */
  private rulePreviewNames(subject: CorrectionSubject): RulePreviewNames {
    return {
      category: { [subject.categoryId]: subject.categoryName },
      merchant:
        subject.merchantId === null || subject.merchantName === null
          ? {}
          : { [subject.merchantId]: subject.merchantName },
      counterparty:
        subject.counterpartyId === null || subject.counterpartyName === null
          ? {}
          : { [subject.counterpartyId]: subject.counterpartyName },
    };
  }

  /**
   * The name bound every action's text slot shares, with the noun in the message so a goal is not told
   * its *category* name is too long.
   *
   * Empty is **not** this method's business: the caller refuses with `UNRUNNABLE:name` instead, because
   * "you did not say what to call it" is a question for the reader and "that is too long" is a failure of
   * a request they made.
   */
  private requireName(raw: string | undefined, noun: 'category' | 'goal' | 'tag'): string {
    const name = (raw ?? '').trim();
    if (name.length === 0) {
      throw new ApiError('VALIDATION_FAILED', `A ${noun} name is required.`);
    }
    if (name.length > ACTION_NAME_MAX_LENGTH) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `A ${noun} name can be at most ${ACTION_NAME_MAX_LENGTH} characters.`,
      );
    }
    return name;
  }

  /** The transaction text, bounded by the same rule a Category name is. */
  private requireText(raw: string | undefined): string {
    const text = (raw ?? '').trim();
    if (text.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'Something to record is required.');
    }
    if (text.length > ACTION_NAME_MAX_LENGTH) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `That is longer than ${ACTION_NAME_MAX_LENGTH} characters. Please shorten it.`,
      );
    }
    return text;
  }

  private readKind(raw: string | undefined): CategoryKind {
    if (raw === undefined) return CategoryKind.EXPENSE;
    const upper = raw.toUpperCase();
    if (upper === CategoryKind.EXPENSE || upper === CategoryKind.INCOME) return upper;
    throw new ApiError('VALIDATION_FAILED', 'A category is either an expense or an income.');
  }

  /**
   * The amount as `Money`, from the parser's own string.
   *
   * `money()` throws on a negative or an unsupported currency, so a value that cannot be money is
   * refused as unrunnable rather than 500-ing — the parser is a boundary, and a bug on its side must
   * not become an opaque INTERNAL on the user's screen.
   */
  private readAmount(amountMinor: string, currency: CurrencyCode): Money | null {
    try {
      return money(BigInt(amountMinor), currency);
    } catch {
      // A negative or an unsupported currency is not money (ADR-003). The parser is a boundary, and a
      // value that cannot be money is a refusal — never an opaque INTERNAL on the user's screen.
      return null;
    }
  }

  /** The stored row, or a refusal when the blob is one this build cannot honour. */
  private readStoredRow(args: Readonly<Record<string, string>>): {
    readonly clientRowId: string;
    readonly idempotencyKey: string;
    readonly accountId: string;
    readonly amountMinor: string;
    readonly kind: string;
    readonly description: string;
    readonly occurredOn: string | null;
    readonly acceptedProposalId: string;
  } {
    const required = [
      'clientRowId',
      'idempotencyKey',
      'accountId',
      'amountMinor',
      'description',
      'acceptedProposalId',
    ] as const;
    const missing = required.filter((key) => (args[key] ?? '').length === 0);
    if (missing.length > 0) {
      // A proposal written by an older build is not one this build can execute, and guessing at an
      // amount would be the worst possible reading of that (pending-action.store.ts).
      throw new ApiError('INTERNAL', 'That proposal is incomplete and was not applied.');
    }
    return {
      clientRowId: args['clientRowId'] as string,
      idempotencyKey: args['idempotencyKey'] as string,
      accountId: args['accountId'] as string,
      amountMinor: args['amountMinor'] as string,
      kind: args['kind'] ?? 'EXPENSE',
      description: args['description'] as string,
      occurredOn: args['occurredOn'] ?? null,
      acceptedProposalId: args['acceptedProposalId'] as string,
    };
  }
}

/**
 * A slot the proposal cannot be built without, raised from inside a builder so the caller refuses
 * with a reason instead of an error — the same distinction `UNRUNNABLE:name` draws on the read side.
 *
 * It is a `throw` rather than a return because the builders are a `Record` with one return type, and
 * a `null` return would have to be threaded through every branch; `propose` catches it at the one
 * place that knows how to phrase it.
 */
export class UnrunnableSlot extends Error {
  constructor(readonly slot: ActionSlotName) {
    super(`unrunnable:${slot}`);
    this.name = 'UnrunnableSlot';
  }
}

/**
 * Whether the parser found more than one reading of the amount (`1.200` is 1200 and 1.2).
 *
 * The capture screen refuses the whole batch until the user picks one, and the alternatives live in
 * the decision's own audit blob — so this reads exactly what that screen reads, from the same place
 * (docs/04 §3.1's ambiguity policy).
 */
function hasAmbiguousAmount(fragment: FragmentResult): boolean {
  const readings = new Set(
    fragment.candidates
      .filter((candidate) => candidate.kind === 'AMOUNT')
      .map((candidate) => candidate.amountMinor),
  );
  return readings.size > 1;
}
