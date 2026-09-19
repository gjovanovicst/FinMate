import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { ErrorMessageService } from '../../core/api/error-message.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import { I18nService } from '../../core/i18n/i18n.service';
import type { TranslationKey } from '../../core/i18n/translations';
import { ReviewQueueStore } from '../../core/review/review-queue.store';
import type { ConfidenceBand } from '../../shared/confidence';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { MoneyComponent } from '../../shared/ui/money/money.component';
import {
  badgeOf as confidenceBandOf,
  canApplyToSimilar,
  choicesOf,
  commandFor,
  cursorAfterRemoval,
  isEditableTarget,
  nextIndex,
  percentOf,
  rememberAvailable,
  resolvePlan,
  type ReviewCommand,
  type ReviewItem,
  type ReviewReason,
} from './review.view';

/**
 * `/review` — the blocking lane of the review queue (F-08, docs/02 §4.6, invariant I-8).
 *
 * ## Why this screen is the point of F-08
 *
 * Until it existed, a row the classifier could not decide was written to the database with
 * `needs_review = true` and then became **invisible**: it never appeared in a list filtered by
 * category, it is excluded from nothing (I-7 counts it as pending, so it correctly stays out of
 * reports), and no screen ever mentioned it. The badge in the shell plus this queue are what make the
 * blocking lane a to-do list instead of a black hole.
 *
 * ## It resolves through the correction path, never by dismissing
 *
 * `resolveReviewItem`'s `SET_CATEGORY` writes a `Correction` and can create a `Rule` (ADR-010), so
 * clearing the queue is also how the engine learns. Anything else — a `needs_review = false` patch —
 * would throw that signal away and make this screen a "mark as read" button.
 *
 * ## What is not here, and why
 *
 * - **Lane B ("Za proveru").** docs/02 §2.3 and docs/04 §7 define the advisory band
 *   (`category_source = 'AI'`, confidence in `[0.60, 0.90)`), and docs/02 §4.6 draws it as a tab. The
 *   API cannot serve it yet: `reviewQueue` filters `needs_review: true` and `resolveReviewItem`
 *   no-ops on a row where the flag is already false, so an advisory row is neither listable nor
 *   resolvable. Recorded in docs/06 §4.2 and owned by a follow-up task rather than faked with a tab
 *   that is permanently empty.
 * - **The reason filter.** `reviewQueue` accepts `reason`/`confidenceBelow`, but they are applied to
 *   the **enriched item** after the page is fetched, so a filtered page can come back short while
 *   matches sit on the next page. A filter UI would therefore need either server-side predicates or
 *   page-until-full; shipping the control without that would make "nothing matches" sometimes false.
 * - **Multi-select and bulk resolve.** docs/02 §8's `Shift+J`/`Shift+K` selection and
 *   `bulkResolveReviewItems` are not built; `applyToSimilar` is the batch affordance here.
 *
 * @module apps/web/src/app/features/review
 */
@Component({
  selector: 'fm-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MoneyComponent, IconComponent],
  template: `
    <div class="fm-page">
      <header class="fm-page__head">
        <div>
          <h1 class="fm-page__title">{{ i18n.t('review.title') }}</h1>
          <p class="fm-page__sub">{{ i18n.t('review.subtitle') }}</p>
        </div>
        @if (!loading() && items().length > 0) {
          <div class="fm-page__actions">
            <p class="head__count">{{ i18n.t('review.waiting', { count: items().length }) }}</p>
          </div>
        }
      </header>

    @if (error(); as message) {
      <p class="alert" role="alert">
        <span>{{ message }}</span>
        <button class="btn" type="button" [disabled]="loading()" (click)="load()">
          {{ i18n.t('review.retry') }}
        </button>
      </p>
    }

    <p class="announce" aria-live="polite">{{ announcement() }}</p>

    @if (cleared()) {
      <p class="cleared" role="status">
        <span>{{ i18n.t('review.cleared') }}</span>
        <button class="btn" type="button" (click)="cleared.set(false)">
          {{ i18n.t('review.clearedDismiss') }}
        </button>
      </p>
    }

    @if (loading()) {
      <ul class="skeletons" aria-hidden="true">
        @for (placeholder of skeletonRows; track placeholder) {
          <li class="skeleton"></li>
        }
      </ul>
    } @else if (items().length > 0) {
      <!-- A single focusable region owns the keyboard model. Focusing it is what turns j/k on, so the
           shortcuts never fight a text field elsewhere on the page (docs/02 §8). -->
      <ol
        class="queue"
        tabindex="0"
        [attr.aria-label]="i18n.t('review.listLabel')"
        (keydown)="onKeydown($event)"
      >
        @for (item of items(); track item.id; let i = $index) {
          <li
            class="row"
            [id]="rowId(item.id)"
            [class.row--cursor]="i === cursor()"
            [attr.aria-current]="i === cursor() ? 'true' : null"
            (click)="cursor.set(i)"
          >
            <div class="row__head">
              <span class="row__index" aria-hidden="true">{{ i + 1 }}</span>
              <span class="row__description">{{ item.transaction.description }}</span>
              <fm-money [amount]="item.transaction.amount" />
              <span class="badge" [attr.data-band]="badgeOf(item)">
                <fm-icon
                  class="badge__glyph"
                  [name]="glyphFor(item)"
                  [size]="16"
                />
                <span class="badge__text">{{ badgeLabel(item) }}</span>
              </span>
            </div>

            <p class="row__meta">
              <span class="chip">{{ reasonLabel(item.reason) }}</span>
              @if (entityLabel(item); as entity) {
                <span class="chip chip--entity">{{ entity }}</span>
              }
              @if (item.ageHours > 0) {
                <span class="row__age">{{ i18n.t('review.ageHours', { count: item.ageHours }) }}</span>
              }
            </p>

            <div class="row__choice">
              <label class="row__label" [attr.for]="selectId(item.id)">
                {{ i18n.t('review.category') }}
              </label>
              <select
                class="select"
                [id]="selectId(item.id)"
                [value]="chosenOf(item) ?? ''"
                [disabled]="busy()"
                (change)="choose(item.id, $event)"
              >
                <option value="">{{ i18n.t('review.noChoice') }}</option>
                @for (option of categoriesFor(item); track option.id) {
                  <option [value]="option.id">{{ option.path.join(' › ') }}</option>
                }
              </select>
            </div>

            @if (choicesOf(item).length > 0) {
              <div class="alternatives">
                <span class="row__label">{{ i18n.t('review.alternatives') }}</span>
                @for (choice of choicesOf(item); track choice; let n = $index) {
                  <button
                    class="alt"
                    type="button"
                    [class.alt--on]="chosenOf(item) === choice"
                    [disabled]="busy()"
                    [attr.aria-pressed]="chosenOf(item) === choice"
                    (click)="cursor.set(i); choose(item.id, choice)"
                  >
                    <span class="alt__key" aria-hidden="true">{{ n + 1 }}</span>
                    <span>{{ categoryName(choice) }}</span>
                  </button>
                }
              </div>
            }

            @if (rememberAvailable(item, chosenOf(item))) {
              <label class="check check--remember">
                <input
                  type="checkbox"
                  [checked]="remember().has(item.id)"
                  [disabled]="busy()"
                  (change)="toggleRemember(item.id, $event)"
                />
                <span>{{ i18n.t('review.remember') }}</span>
              </label>
            } @else if (chosenOf(item) !== null) {
              <!-- The checkbox is hidden rather than disabled: the server ignores
                   rememberForFuture on the accept path, and a control that does nothing teaches the
                   user that the learning loop does not work. See review.view.ts. -->
              <p class="hint">{{ i18n.t('review.rememberNotApplicable') }}</p>
            }

            @if (canApplyToSimilar(item)) {
              <label class="check check--similar">
                <input
                  type="checkbox"
                  [checked]="similar().has(item.id)"
                  [disabled]="busy()"
                  (change)="toggleSimilar(item.id, $event)"
                />
                <span>{{ i18n.t('review.applyToSimilar') }}</span>
              </label>
            }

            <div class="row__actions">
              <button
                class="btn btn--primary"
                type="button"
                [disabled]="busy() || resolvePlan(item, chosenOf(item)) === null"
                (click)="resolve(item)"
              >
                {{ i18n.t('review.resolve') }}
              </button>
              @if (item.suggestedCategoryId !== null && resolvePlan(item, chosenOf(item))?.action === 'ACCEPT_SUGGESTION') {
                <span class="hint">{{ i18n.t('review.acceptHint') }}</span>
              } @else if (chosenOf(item) === null) {
                <span class="hint">{{ i18n.t('review.chooseFirst') }}</span>
              }
            </div>
          </li>
        }
      </ol>

      <p class="shortcuts">{{ i18n.t('review.shortcuts') }}</p>
    } @else if (error() === null) {
      <!-- Only when the queue is genuinely empty. Showing "all caught up" under a failure banner
           would state a fact the screen does not know (docs/02 §6). -->
      <section class="fm-card empty">
        <p class="empty__title">{{ i18n.t('review.empty') }}</p>
        <p class="empty__body">{{ i18n.t('review.emptyBody') }}</p>
      </section>
    }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .head__count {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--color-text-subtle);
      }
      .alert {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-3);
        margin: 0;
        padding: var(--space-3);
        border: 1px solid var(--color-danger);
        border-radius: var(--radius-md);
        color: var(--color-danger);
      }
      .announce:empty {
        display: none;
      }
      .announce {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
      .cleared {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-3);
        margin: 0;
        padding: var(--space-3);
        border: 1px solid var(--color-primary);
        border-radius: var(--radius-md);
      }
      .skeletons {
        display: grid;
        gap: var(--space-2);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      /* Geometry-preserving: the placeholder is the height of a real row, so nothing jumps when the
         data arrives (docs/02 §6, cross-cutting rules). */
      .skeleton {
        block-size: 9rem;
        border-radius: var(--radius-md);
        background: var(--color-surface);
      }
      .empty {
        gap: var(--space-2);
        text-align: center;
      }
      .empty__title {
        margin: 0;
        font-size: var(--text-lg);
      }
      .empty__body {
        margin: 0;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .queue {
        display: grid;
        gap: var(--space-3);
        margin: 0;
        padding: 0;
        list-style: none;
        outline: none;
      }
      .queue:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 2px;
      }
      .row {
        display: grid;
        gap: var(--space-2);
        padding: var(--space-3);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      /* The cursor is a border and a background, not a colour alone: the row it is on must be
         identifiable without perceiving hue (WCAG 1.4.1). */
      .row--cursor {
        border-color: var(--color-primary);
        box-shadow: inset 3px 0 0 var(--color-primary);
      }
      .row__head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: var(--space-2);
      }
      .row__index {
        min-inline-size: 1.5rem;
        color: var(--color-text-subtle);
        font-variant-numeric: tabular-nums;
      }
      .row__description {
        flex: 1 1 8rem;
        min-inline-size: 0;
        overflow-wrap: anywhere;
      }
      .row__meta {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
        margin: 0;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .chip {
        padding: 0 var(--space-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
      }
      .chip--entity {
        color: var(--color-text-muted);
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-xs);
      }
      .badge[data-band='ASK'] {
        color: var(--color-danger);
      }
      .badge[data-band='VERIFY'] {
        color: var(--color-warning);
      }
      .badge[data-band='AUTO'] {
        /* Brand **text**, not the fill: --color-primary is 3.78:1 on a card and this is a 12 px badge. */
        color: var(--color-primary-text);
      }
      .row__choice {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
      }
      .row__label {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .select {
        flex: 1 1 10rem;
        min-inline-size: 0;
        max-inline-size: 100%;
        padding: var(--space-1) var(--space-2);
        font: inherit;
        font-size: var(--text-sm);
        color: inherit;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
      }
      .alternatives {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-2);
      }
      .alt {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        padding: var(--space-1) var(--space-2);
        font: inherit;
        font-size: var(--text-sm);
        color: inherit;
        background: var(--color-bg);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        cursor: pointer;
        overflow-wrap: anywhere;
      }
      .alt--on {
        border-color: var(--color-primary);
        color: var(--color-primary);
      }
      .alt__key {
        color: var(--color-text-subtle);
        font-variant-numeric: tabular-nums;
      }
      .check {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-sm);
      }
      .row__actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--space-3);
      }
      .btn {
        padding: var(--space-1) var(--space-3);
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
      .alt:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .hint {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .shortcuts {
        margin: 0;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
    `,
  ],
})
export class ReviewComponent {
  readonly i18n = inject(I18nService);
  private readonly graphql = inject(GraphqlClient);
  private readonly errors = inject(ErrorMessageService);
  private readonly store = inject(ReviewQueueStore);
  private readonly document = inject(DOCUMENT);

  readonly items = signal<readonly ReviewItem[]>([]);
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly announcement = signal('');
  readonly cleared = signal(false);

  /** Which row the keyboard is on. An index, not DOM focus — `j`/`k` must not move the tab stop. */
  readonly cursor = signal(0);

  /** The category chosen per row id. Absent means "not decided yet", which is not the same as null. */
  private readonly chosen = signal<ReadonlyMap<string, string>>(new Map());
  private readonly rememberRows = signal<ReadonlySet<string>>(new Set());
  private readonly similarRows = signal<ReadonlySet<string>>(new Set());

  readonly remember = this.rememberRows.asReadonly();
  readonly similar = this.similarRows.asReadonly();

  private readonly categories = signal<readonly CategoryOption[]>([]);
  private readonly names = signal<ReadonlyMap<string, string>>(new Map());

  /** Six placeholders: the height of a real row, and enough to fill a phone. */
  readonly skeletonRows = [0, 1, 2, 3, 4, 5];

  readonly choicesOf = choicesOf;
  readonly resolvePlan = resolvePlan;
  readonly rememberAvailable = rememberAvailable;
  readonly canApplyToSimilar = canApplyToSimilar;
  readonly badgeOf = confidenceBandOf;

  constructor() {
    void this.load();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    // Seed the shared count before anything can be resolved. The toast below depends on knowing the
    // queue *became* empty, and the shell's own refresh races this screen's load on a direct visit.
    void this.store.refresh();
    try {
      const [queue, categories, merchants, counterparties] = await Promise.all([
        this.graphql.query<{ reviewQueue: { edges: { node: ReviewItem }[] } }>(REVIEW_QUEUE_QUERY),
        this.graphql.query<{ categories: readonly CategoryOption[] }>(CATEGORIES_QUERY),
        this.graphql.query<{ merchants: { edges: { node: { id: string; name: string } }[] } }>(
          MERCHANTS_QUERY,
        ),
        this.graphql.query<{
          counterparties: { edges: { node: { id: string; name: string } }[] };
        }>(COUNTERPARTIES_QUERY),
      ]);

      const rows = queue.reviewQueue.edges.map((edge) => edge.node);
      this.items.set(rows);
      this.categories.set(categories.categories);

      const names = new Map<string, string>();
      for (const edge of merchants.merchants.edges) names.set(edge.node.id, edge.node.name);
      for (const edge of counterparties.counterparties.edges) names.set(edge.node.id, edge.node.name);
      this.names.set(names);

      // A row that has a suggestion starts on it, so `Enter` means "yes, that one" for the common
      // case and the queue is a sequence of confirmations rather than of selections (docs/02 §4.6).
      const seed = new Map<string, string>();
      for (const row of rows) {
        if (row.suggestedCategoryId !== null) seed.set(row.id, row.suggestedCategoryId);
      }
      this.chosen.set(seed);
      this.rememberRows.set(new Set());
      this.similarRows.set(new Set());
      this.cursor.set(0);
    } catch (failure) {
      this.error.set(this.errors.for(failure));
    } finally {
      this.loading.set(false);
    }
  }

  // ---- rendering helpers (pure computations, kept out of the template) ------------------------

  rowId(id: string): string {
    return `review-row-${id}`;
  }

  selectId(id: string): string {
    return `review-select-${id}`;
  }

  /**
   * The band's glyph, as an **icon name** rather than an emoji.
   *
   * It returned 🟢🟡🔴⚪ until the ADR-039 audit: an emoji is drawn by the platform in its own colour, so
   * the reserved band tints (`--color-success`/`--color-warning`/`--color-danger`, ADR-009) could not
   * reach it and the badge looked different on every OS. The tint is already on the badge's `[data-band]`
   * rule, which now colours the stroke instead of a glyph the platform owns.
   */
  glyphFor(item: ReviewItem): 'check' | 'alert' | 'info' {
    switch (this.badgeOf(item)) {
      case 'AUTO':
        return 'check';
      case 'VERIFY':
      case 'ASK':
        return 'alert';
      default:
        return 'info';
    }
  }

  badgeLabel(item: ReviewItem): string {
    const keys: Record<ConfidenceBand, TranslationKey> = {
      AUTO: 'confidence.auto',
      VERIFY: 'confidence.verify',
      ASK: 'confidence.ask',
      NONE: 'review.noConfidence',
    };
    const percent = percentOf(item.confidence);
    const label = this.i18n.t(keys[this.badgeOf(item)]);
    return percent === null ? label : `${label} ${percent} %`;
  }

  reasonLabel(reason: ReviewReason): string {
    const keys: Record<ReviewReason, TranslationKey> = {
      LOW_CONFIDENCE: 'review.reason.LOW_CONFIDENCE',
      UNCATEGORISED: 'review.reason.UNCATEGORISED',
    };
    return this.i18n.t(keys[reason]);
  }

  /** The resolved Merchant or Counterparty, when there is one — the `applyToSimilar` group. */
  entityLabel(item: ReviewItem): string | null {
    const id = item.transaction.merchantId ?? item.transaction.counterpartyId;
    return id === null ? null : (this.names().get(id) ?? null);
  }

  categoryName(id: string): string {
    const option = this.categories().find((category) => category.id === id);
    return option === undefined ? id : option.path.join(' › ');
  }

  /** Only the categories of this row's own direction — I-3 forbids an expense category on income. */
  categoriesFor(item: ReviewItem): readonly CategoryOption[] {
    return this.categories().filter((category) => category.kind === item.transaction.kind);
  }

  chosenOf(item: ReviewItem): string | null {
    return this.chosen().get(item.id) ?? null;
  }

  // ---- interaction ---------------------------------------------------------------------------

  choose(id: string, event: Event | string): void {
    const value = typeof event === 'string' ? event : ((event.target as HTMLSelectElement).value ?? '');
    const next = new Map(this.chosen());
    if (value === '') next.delete(id);
    else next.set(id, value);
    this.chosen.set(next);
  }

  toggleRemember(id: string, event: Event): void {
    this.rememberRows.set(toggle(this.rememberRows(), id, (event.target as HTMLInputElement).checked));
  }

  toggleSimilar(id: string, event: Event): void {
    this.similarRows.set(toggle(this.similarRows(), id, (event.target as HTMLInputElement).checked));
  }

  onKeydown(event: KeyboardEvent): void {
    const command = commandFor(
      {
        key: event.key,
        modified: event.ctrlKey || event.metaKey || event.altKey,
        targetTag: (event.target as Element | null)?.tagName ?? '',
        targetEditable: isEditableTarget(
          (event.target as Element | null)?.tagName ?? '',
          (event.target as HTMLElement | null)?.isContentEditable === true,
        ),
      },
      this.items()[this.cursor()] === undefined ? [] : choicesOf(this.items()[this.cursor()]!),
    );

    if (command.kind === 'NONE') return;
    event.preventDefault();
    this.run(command);
  }

  private run(command: ReviewCommand): void {
    switch (command.kind) {
      case 'MOVE': {
        const index = nextIndex(this.cursor(), command.delta, this.items().length);
        this.cursor.set(index);
        this.announceCursor(index);
        return;
      }
      case 'CHOOSE': {
        const item = this.items()[this.cursor()];
        if (item !== undefined) this.choose(item.id, command.categoryId);
        return;
      }
      case 'RESOLVE': {
        const item = this.items()[this.cursor()];
        if (item !== undefined) void this.resolve(item);
        return;
      }
      case 'FOCUS_CATEGORY': {
        const item = this.items()[this.cursor()];
        if (item === undefined) return;
        const select = this.document.getElementById(this.selectId(item.id));
        if (select instanceof HTMLElement) select.focus();
        return;
      }
      default:
        return;
    }
  }

  /** `j`/`k` moves a cursor that is not DOM focus, so the move has to be said out loud. */
  private announceCursor(index: number): void {
    const item = this.items()[index];
    if (item === undefined) return;
    this.announcement.set(
      this.i18n.t('review.rowAnnounce', {
        index: index + 1,
        total: this.items().length,
        description: item.transaction.description,
      }),
    );
  }

  async resolve(item: ReviewItem): Promise<void> {
    if (this.busy()) return;

    const plan = resolvePlan(item, this.chosenOf(item));
    if (plan === null) return;

    this.busy.set(true);
    this.error.set(null);
    try {
      const data = await this.graphql.query<{ resolveReviewItem: ResolveResponse }>(
        RESOLVE_REVIEW_ITEM,
        {
          input: {
            id: item.id,
            action: plan.action,
            categoryId: plan.categoryId,
            // Never sent where it would be ignored: `rememberAvailable` is the same predicate the
            // checkbox is rendered from, so a hidden control cannot leak a stale true.
            rememberForFuture: plan.learns && this.rememberRows().has(item.id),
            applyToSimilar: canApplyToSimilar(item) && this.similarRows().has(item.id),
          },
        },
      );

      const result = data.resolveReviewItem;
      this.announce(result);

      const remaining = this.items().filter((row) => row.id !== item.id);
      this.items.set(remaining);
      this.cursor.set(cursorAfterRemoval(this.cursor(), remaining.length));

      // The server's count is authoritative — `applyToSimilar` resolves more than one row per action,
      // so a local decrement would be wrong exactly when the sweep found peers.
      if (this.store.setCount(result.reviewQueueCount)) this.cleared.set(true);

      // Peers resolved by the sweep are no longer in the queue either, but the client cannot know
      // which they were without a re-read. One scoped query keeps the list and the badge honest.
      if (result.resolvedSimilarCount > 1) await this.load();
    } catch (failure) {
      // The row stays: a failed resolve must never look like a resolved one (docs/02 §6).
      this.error.set(this.errors.for(failure));
    } finally {
      this.busy.set(false);
    }
  }

  private announce(result: ResolveResponse): void {
    const parts: string[] = [
      result.resolvedSimilarCount > 1
        ? this.i18n.t('review.resolvedMany', { count: result.resolvedSimilarCount })
        : this.i18n.t('review.resolvedOne'),
    ];

    if (result.ruleCreated !== null) {
      parts.push(this.i18n.t('review.ruleCreated', { name: result.ruleCreated.name }));
    }

    this.announcement.set(parts.join(' '));
  }
}

interface CategoryOption {
  readonly id: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly path: readonly string[];
}

interface ResolveResponse {
  readonly resolvedSimilarCount: number;
  readonly reviewQueueCount: number;
  readonly ruleCreated: { readonly id: string; readonly name: string } | null;
}

/** Add or remove an id from a `Set` signal, without mutating the previous value. */
function toggle(current: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  const next = new Set(current);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

const REVIEW_QUEUE_QUERY = /* GraphQL */ `
  query ReviewQueue {
    reviewQueue(first: 50) {
      edges {
        node {
          id
          reason
          confidence
          suggestedCategoryId
          candidates {
            categoryId
            confidence
          }
          ageHours
          transaction {
            id
            kind
            status
            amount
            description
            occurredLocalDate
            categoryId
            merchantId
            counterpartyId
          }
        }
      }
    }
  }
`;

const CATEGORIES_QUERY = /* GraphQL */ `
  query ReviewCategories {
    categories {
      id
      kind
      path
    }
  }
`;

const MERCHANTS_QUERY = /* GraphQL */ `
  query ReviewMerchantNames {
    merchants(first: 200) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

const COUNTERPARTIES_QUERY = /* GraphQL */ `
  query ReviewCounterpartyNames {
    counterparties(first: 200) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

const RESOLVE_REVIEW_ITEM = /* GraphQL */ `
  mutation ResolveReviewItem($input: ResolveReviewItemInput!) {
    resolveReviewItem(input: $input) {
      resolvedSimilarCount
      reviewQueueCount
      ruleCreated {
        id
        name
      }
    }
  }
`;
