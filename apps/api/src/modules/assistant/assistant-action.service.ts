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
 * - **Invent a number or an id.** The only slot a caller supplies is `name`, which is text; ids come
 *   from the database and every service call goes through the same method the UI's mutation uses.
 * - **Offer a write that will fail.** The duplicate check runs at **propose** time, against the same
 *   rule Postgres enforces (`categories_unique_name`: household, parent, `lower(name)`), because a
 *   confirm button for a doomed write is a lie the card does not need to tell.
 *
 * ## Idempotency, and why the result is cached
 *
 * `take` consumes the proposal atomically, so a double confirm cannot create two Categories. But a
 * *retry* after a timeout must not report failure for a write that happened — so the outcome is
 * remembered against the caller's idempotency key first, and `execute` checks that before touching
 * the proposal. The worst case is then "expired" for a write that did not happen, never a second row.
 *
 * @module apps/api/src/modules/assistant
 */

import { Injectable, Logger } from '@nestjs/common';

import { uuidv7 } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { CategoriesService } from '../taxonomy/categories.service';
import { CategoryKind } from '../taxonomy/category.model';
import { ACTION_TEMPLATES, type AssistantAction } from './assistant-actions';
import { ACTION_NAME_MAX_LENGTH } from './action-planner';
import {
  PendingActionStore,
  PROPOSAL_TTL_SECONDS,
  type ActionDiffEntry,
  type ActionPreview,
  type ExecutedActionResult,
  type PendingActionProposal,
} from './pending-action.store';

export interface ProposeActionResult {
  readonly proposalId: string;
  readonly action: AssistantAction;
  readonly preview: ActionPreview;
  readonly expiresAt: string;
}

export interface ExecuteActionResult {
  readonly action: AssistantAction;
  readonly createdId: string;
  readonly createdLabel: string;
  readonly undo: string;
  readonly sentence: string;
  /** True when the caller's idempotency key had already produced this result. */
  readonly replayed: boolean;
}

/**
 * How one action reads on a card, per language.
 *
 * Two templates, not a catalogue: the API has no i18n layer (docs/06 §5.14 records that breach, and
 * A-7 owns it). A **write confirmation** is nevertheless the one sentence worth not shipping
 * English-only into a Serbian Household, so the two phrasings live here beside the action, in the
 * shape ADR-019's amendment prescribes — one entry, its per-language variants together.
 */
const COPY = {
  en: {
    kind: { EXPENSE: 'expense', INCOME: 'income' },
    topLevel: 'top level',
    sentence: (name: string, kind: string, parent: string): string =>
      `New category “${name}” (${kind}, ${parent})`,
    fields: { name: 'name', kind: 'kind', parent: 'parent' },
  },
  sr: {
    kind: { EXPENSE: 'rashod', INCOME: 'prihod' },
    topLevel: 'bez nadređene',
    sentence: (name: string, kind: string, parent: string): string =>
      `Nova kategorija „${name}” (${kind}, ${parent})`,
    fields: { name: 'naziv', kind: 'vrsta', parent: 'nadređena' },
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
    private readonly store: PendingActionStore,
  ) {}

  /**
   * Build and store a proposal. Writes nothing to the ledger and is therefore a `Query` at the edge,
   * exactly as `captureParse` is a read that writes only its own audit row.
   */
  async propose(input: {
    readonly householdId: string;
    readonly userId: string;
    readonly action: AssistantAction;
    readonly slots: Readonly<Record<string, string>>;
    readonly locale?: string;
  }): Promise<ProposeActionResult> {
    const template = ACTION_TEMPLATES[input.action];
    // A `destroys` action is not offered at all, so this cannot be reached through a stored proposal
    // — but the check belongs at the boundary that creates one (ADR-035 decision 7).
    if (template.destroys) {
      throw new ApiError('VALIDATION_FAILED', 'That action is not available.');
    }

    const name = this.requireName(input.slots['name']);
    const kind = this.readKind(input.slots['kind']);

    await this.assertNameFree(input.householdId, name);

    const preview = this.renderPreview(input.action, { name, kind }, input.locale);
    const id = uuidv7();
    const createdAt = new Date().toISOString();
    const proposal: PendingActionProposal = {
      id,
      householdId: input.householdId,
      userId: input.userId,
      action: input.action,
      slots: { name, kind },
      preview,
      createdAt,
    };

    const stored = await this.store.put(proposal);
    if (!stored) {
      // Fail closed: a proposal that cannot be read back cannot be confirmed, and offering a button
      // that will fail is worse than saying so now (pending-action.store.ts).
      this.logger.warn(`could not store a ${input.action} proposal; refusing to offer it`);
      throw new ApiError('INTERNAL', 'Could not prepare that action. Please try again.');
    }

    return {
      proposalId: id,
      action: input.action,
      preview,
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

    const created = await this.dispatch(proposal);
    const result: ExecutedActionResult = {
      action: proposal.action,
      createdId: created.id,
      createdLabel: created.label,
      undo: ACTION_TEMPLATES[proposal.action].undo,
      // The confirmation quotes the **returned row**, not the proposal: the sentence must describe
      // what happened, and only the write knows that (ADR-035 decision 8).
      sentence: this.renderPreview(proposal.action, {
        name: proposal.slots['name'] ?? created.label,
        kind: this.readKind(proposal.slots['kind']),
      }).sentence,
      executedAt: new Date().toISOString(),
    };

    await this.store.rememberResult(input.householdId, input.idempotencyKey, result);
    return { ...result, replayed: false };
  }

  /**
   * The executor map, `Record<AssistantAction, …>` on purpose: adding a member to
   * `ASSISTANT_ACTIONS` without an executor is a **compile** error, which is ADR-035 decision 3's
   * whole argument made structural.
   */
  private readonly executors: Readonly<
    Record<AssistantAction, (proposal: PendingActionProposal) => Promise<{ id: string; label: string }>>
  > = {
    ADD_CATEGORY: async (proposal) => {
      const created = await this.categories.create(proposal.householdId, {
        name: proposal.slots['name'] as string,
        kind: (proposal.slots['kind'] as CategoryKind | undefined) ?? CategoryKind.EXPENSE,
        parentId: null,
      });
      return { id: created.id, label: created.name };
    },
  };

  private dispatch(proposal: PendingActionProposal): Promise<{ id: string; label: string }> {
    return this.executors[proposal.action](proposal);
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

  private requireName(raw: string | undefined): string {
    const name = (raw ?? '').trim();
    if (name.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'A category name is required.');
    }
    if (name.length > ACTION_NAME_MAX_LENGTH) {
      throw new ApiError(
        'VALIDATION_FAILED',
        `A category name can be at most ${ACTION_NAME_MAX_LENGTH} characters.`,
      );
    }
    return name;
  }

  private readKind(raw: string | undefined): CategoryKind {
    if (raw === undefined) return CategoryKind.EXPENSE;
    const upper = raw.toUpperCase();
    if (upper === CategoryKind.EXPENSE || upper === CategoryKind.INCOME) return upper;
    throw new ApiError('VALIDATION_FAILED', 'A category is either an expense or an income.');
  }

  /**
   * The card's content: one sentence and a field-by-field diff, rendered by the backend so the model
   * can never describe a write (ADR-035 decision 8). The `defaulted` flag is what lets the UI offer to
   * change a value the question did not state.
   */
  private renderPreview(
    action: AssistantAction,
    slots: { readonly name: string; readonly kind: CategoryKind },
    locale?: string,
  ): ActionPreview {
    const copy = copyFor(locale);
    const template = ACTION_TEMPLATES[action];
    const kindWord = copy.kind[slots.kind];
    const parentWord = copy.topLevel;
    const diff: ActionDiffEntry[] = [
      {
        slot: 'name',
        field: copy.fields.name,
        before: null,
        after: slots.name,
        afterValue: null,
        defaulted: template.defaultedSlots.includes('name'),
      },
      {
        slot: 'kind',
        field: copy.fields.kind,
        before: null,
        after: kindWord,
        afterValue: slots.kind,
        defaulted: template.defaultedSlots.includes('kind'),
      },
      {
        slot: 'parentId',
        field: copy.fields.parent,
        before: null,
        after: parentWord,
        afterValue: null,
        defaulted: template.defaultedSlots.includes('parentId'),
      },
    ];

    return { sentence: copy.sentence(slots.name, kindWord, parentWord), diff };
  }
}
