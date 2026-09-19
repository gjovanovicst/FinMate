/**
 * The pending tray: what has not reached the server yet, why, and what can be done about it.
 *
 * ADR-026 puts this screen at `/pending`, reached from the header's sync chip rather than from a badged
 * nav slot, and decides what it shows: each entry's raw input, its local time, its attempt count and its
 * last error in plain language, per-row *Pokušaj ponovo* and *Odbaci*, *Pokušaj sve*, *Izvezi kao tekst*,
 * and a *Pregledaj razlike* section comparing the queued preview with the server's own answer. The
 * comparison is never applied silently (docs/02 §4.3 point 3), and *Izvezi kao tekst* is the last-resort
 * escape hatch docs/07 §6 asks for, so a queue can never be a dead end.
 *
 * It renders entirely from `SyncService`'s signals and re-reads the queue on open, because a flush can
 * run while the screen is up (docs/07 §6 flushes on `online` and `visibilitychange`).
 *
 * @module apps/web/src/app/features/pending
 */
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AppLockService } from '../../core/app-lock/app-lock.service';
import { pendingDurabilityKey } from '../../core/app-lock/lock.view';
import type { TranslationKey } from '../../core/i18n/translations';
import { AuthStore } from '../../core/auth/auth.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { nextAttemptDelay, type OutboxEntry } from '../../core/offline/outbox';
import { SyncService } from '../../core/offline/sync.service';
import type { SyncDiff } from '../../core/offline/sync.types';
import { categoryLabel, rawInputs, syncedAtLabel, whyKey } from '../../core/offline/sync.view';
import { IconComponent } from '../../shared/ui/icon/icon.component';

@Component({
  selector: 'fm-pending',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <div class="fm-page">
      <header class="fm-page__head">
        <div>
          <h1 class="fm-page__title">{{ i18n.t('pending.title') }}</h1>
          <p class="fm-page__sub">{{ i18n.t(subtitleKey()) }}</p>
        </div>
      </header>

      <!-- The count is announced, not only drawn: it is the one number that changes under the user. -->
      <p class="count" role="status" aria-live="polite">
        {{
          i18n.t('pending.count', {
            waiting: sync.pendingCount(),
            refused: sync.rejected().length
          })
        }}
      </p>

      @if (sync.busy()) {
        <p class="status" role="status">{{ i18n.t('pending.sending') }}</p>
      }

      @if (sync.lastError(); as message) {
        <p class="alert" role="alert">{{ i18n.t('pending.flushError', { message }) }}</p>
      }

      <div class="toolbar">
        <!-- ADR-033 decision 4: nothing can be sent without a session, so the control is not offered
             rather than shown broken (docs/02 §2). The offline shell says why, once, above this screen. -->
        @if (canSend()) {
          <button
            class="fm-btn fm-btn--primary"
            type="button"
            [disabled]="sync.busy() || empty()"
            (click)="retryAll()"
          >
            {{ i18n.t('pending.retryAll') }}
          </button>
        }
        <button class="fm-btn" type="button" [disabled]="empty()" (click)="exportText()">
          {{ i18n.t('pending.export') }}
        </button>
      </div>

      @if (exported(); as text) {
        <label class="export">
          <span class="export__label">{{ i18n.t('pending.exportLabel') }}</span>
          <textarea class="export__text" readonly rows="10" [value]="text"></textarea>
        </label>
      }

      @if (loading()) {
        <p class="status" role="status">{{ i18n.t('pending.loading') }}</p>
      } @else if (empty() && !sync.busy()) {
        <section class="fm-card empty">
          <p class="empty__title">{{ i18n.t('pending.empty') }}</p>
          <p class="empty__body">{{ i18n.t('pending.emptyBody') }}</p>
        </section>
      } @else {
        @if (sync.rejected().length > 0) {
          <section class="fm-card group">
            <div class="fm-card__head">
              <h2 class="fm-card__title">
                <fm-icon name="alert" [size]="18" />
                {{ i18n.t('pending.rejectedTitle') }}
              </h2>
            </div>
            <p class="group__body">{{ i18n.t('pending.rejectedBody') }}</p>
            <ul class="list">
              @for (entry of sync.rejected(); track entry.seq) {
                <li class="row row--refused">
                  <div class="row__head">
                    <span class="row__status">{{ i18n.t('pending.statusRejected') }}</span>
                    <span class="row__meta">
                      <time [attr.datetime]="entry.enqueuedAt">{{ localTime(entry.enqueuedAt) }}</time>
                      @if (entry.attempts > 0) {
                        <span>{{ attemptsLabel(entry) }}</span>
                      }
                    </span>
                  </div>
                  @for (input of inputs(entry); track $index) {
                    <p class="row__input">{{ input }}</p>
                  }
                  <p class="row__error">{{ i18n.t('pending.lastError', { message: errorText(entry) }) }}</p>
                  <div class="row__actions">
                    @if (canSend()) {
                      <button class="fm-btn" type="button" [disabled]="sync.busy()" (click)="retry(entry.seq)">
                        {{ i18n.t('pending.retry') }}
                      </button>
                    }
                    <button class="fm-btn" type="button" [disabled]="sync.busy()" (click)="discard(entry.seq)">
                      {{ i18n.t('pending.discard') }}
                    </button>
                  </div>
                </li>
              }
            </ul>
          </section>
        }

        @if (sync.pending().length > 0) {
          <section class="fm-card group">
            <div class="fm-card__head">
              <h2 class="fm-card__title">
                <fm-icon name="transactions" [size]="18" />
                {{ i18n.t('pending.pendingTitle') }}
              </h2>
            </div>
            <ul class="list">
              @for (entry of sync.pending(); track entry.seq) {
                <li class="row">
                  <div class="row__head">
                    <span class="row__status">{{ i18n.t('pending.statusPending') }}</span>
                    <span class="row__meta">
                      <time [attr.datetime]="entry.enqueuedAt">{{ localTime(entry.enqueuedAt) }}</time>
                      @if (entry.attempts > 0) {
                        <span>{{ attemptsLabel(entry) }}</span>
                      }
                    </span>
                  </div>
                  @for (input of inputs(entry); track $index) {
                    <p class="row__input">{{ input }}</p>
                  }
                  @if (entry.error) {
                    <p class="row__error">
                      {{ i18n.t('pending.lastError', { message: errorText(entry) }) }}
                    </p>
                    <p class="row__wait">
                      {{ i18n.t('pending.nextAttempt', { seconds: nextWaitSeconds(entry) }) }}
                    </p>
                  }
                  <div class="row__actions">
                    @if (canSend()) {
                      <button class="fm-btn" type="button" [disabled]="sync.busy()" (click)="retry(entry.seq)">
                        {{ i18n.t('pending.retry') }}
                      </button>
                    }
                    <button class="fm-btn" type="button" [disabled]="sync.busy()" (click)="discard(entry.seq)">
                      {{ i18n.t('pending.discard') }}
                    </button>
                  </div>
                </li>
              }
            </ul>
          </section>
        }
      }

      @if (sync.conflicts().length > 0) {
        <!-- A refused edit (task 4.2.7b, ADR-030). Deliberately a separate panel from the diffs below:
             that one explains the server's *decision* about a row it accepted, this one explains a write
             it **rejected**. It also quotes no reason it was not given — the two versions are the whole
             explanation the API supports, and the Zašto line stays with the re-classification diff. -->
        <section class="fm-card diffs">
          <div class="fm-card__head">
            <h2 class="fm-card__title">
              <fm-icon name="alert" [size]="18" />
              {{ i18n.t('pending.conflictTitle') }}
            </h2>
          </div>
          <p class="group__body">{{ i18n.t('pending.conflictBody') }}</p>
          <ul class="list">
            @for (conflict of sync.conflicts(); track conflict.seq + ':' + conflict.transactionId) {
              <li class="diff">
                <p class="diff__line">
                  {{ i18n.t('pending.conflictVersions', { edited: conflict.editedVersion, server: conflict.serverVersion }) }}
                </p>
                @if (conflict.changes.length === 0) {
                  <p class="diff__why">{{ i18n.t('pending.conflictNoFieldChanges') }}</p>
                } @else {
                  <table class="fm-table conflict">
                    <caption class="fm-visually-hidden">{{ i18n.t('pending.conflictTitle') }}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{{ i18n.t('pending.diffField') }}</th>
                        <th scope="col">{{ i18n.t('pending.diffBefore') }}</th>
                        <th scope="col">{{ i18n.t('pending.diffAfter') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (change of conflict.changes; track change.field) {
                        <tr>
                          <th scope="row">{{ i18n.t(fieldKey(change.field)) }}</th>
                          <td>{{ change.before ?? '—' }}</td>
                          <td>{{ change.after ?? '—' }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                }
              </li>
            }
          </ul>
        </section>
      }

      @if (sync.diffs().length > 0) {
        <section class="fm-card diffs">
          <div class="fm-card__head">
            <h2 class="fm-card__title">
              <fm-icon name="info" [size]="18" />
              {{ i18n.t('pending.diffTitle', { count: sync.diffs().length }) }}
            </h2>
          </div>
          <p class="group__body">{{ i18n.t('pending.diffBody') }}</p>
          <ul class="list">
            @for (diff of sync.diffs(); track $index + ':' + diff.seq) {
              <li class="diff">
                <p class="diff__text">{{ diff.rawText }}</p>
                <p class="diff__line">
                  <span class="diff__side">{{ i18n.t('pending.diffBefore') }}</span>
                  {{ beforeLabel(diff) }}
                </p>
                <p class="diff__line">
                  <span class="diff__side">{{ i18n.t('pending.diffAfter') }}</span>
                  {{ afterLabel(diff) }}
                </p>
                <p class="diff__why">{{ i18n.t('pending.diffWhy', { why: whyLabel(diff.why) }) }}</p>
              </li>
            }
          </ul>
        </section>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .conflict {
        overflow-wrap: anywhere;
      }
      .count {
        margin: 0;
        font-size: var(--text-sm);
        color: var(--color-text-subtle);
      }
      .status,
      .alert {
        margin: 0;
        padding: var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }
      .alert {
        border-color: var(--color-danger);
        color: var(--color-danger);
        overflow-wrap: anywhere;
      }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
      .export {
        display: grid;
        gap: var(--space-1);
        min-inline-size: 0;
      }
      .export__label {
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .export__text {
        inline-size: 100%;
        min-inline-size: 0;
        padding: var(--space-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg);
        color: var(--color-text);
        font: inherit;
        font-size: var(--text-xs);
        resize: vertical;
      }
      .group {
        min-inline-size: 0;
      }
      .group__body {
        margin: 0;
        color: var(--color-text-muted);
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
      }
      .row,
      .diff {
        min-inline-size: 0;
        padding-block: var(--space-3);
        border-block-end: 1px solid var(--color-border);
      }
      .row:last-child,
      .diff:last-child {
        padding-block-end: 0;
        border-block-end: none;
      }
      .row--refused {
        padding-inline-start: var(--space-3);
        border-inline-start: 3px solid var(--color-danger);
      }
      .row__head {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        justify-content: space-between;
        gap: var(--space-1) var(--space-3);
      }
      .row__status {
        font-size: var(--text-sm);
      }
      .row__meta {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .row__input {
        margin: var(--space-2) 0 0;
        overflow-wrap: anywhere;
      }
      .row__error {
        margin: var(--space-1) 0 0;
        font-size: var(--text-xs);
        color: var(--color-danger);
        overflow-wrap: anywhere;
      }
      .row__wait {
        margin: var(--space-1) 0 0;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
      }
      .row__actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        margin-block-start: var(--space-3);
      }
      .diff__text {
        margin: 0;
        overflow-wrap: anywhere;
      }
      .diff__line {
        margin: var(--space-1) 0 0;
        overflow-wrap: anywhere;
      }
      .diff__side {
        display: inline-block;
        margin-inline-end: var(--space-2);
        color: var(--color-text-subtle);
        font-size: var(--text-xs);
      }
      .diff__why {
        margin: var(--space-2) 0 0;
        font-size: var(--text-xs);
        color: var(--color-text-subtle);
        overflow-wrap: anywhere;
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
    `,
  ],
})
export class PendingComponent {
  readonly i18n = inject(I18nService);

  /**
   * What the page may claim about the queue's durability.
   *
   * R-23's copy defect: 4.2.3 said *"Nothing here is lost."*, which was true of the server's copy and
   * false of this one while the store ran on a session key. The sentence follows the **store**, not a
   * setting, because the two can disagree — a lock that is configured but locked is not persistence.
   */
  readonly subtitleKey = computed(() => pendingDurabilityKey(this.appLock.state() === 'UNLOCKED'));

  /**
   * The catalogue key for a conflicted field.
   *
   * The diff comes from stored, untyped data, so an unknown field name must not render as a raw
   * GraphQL identifier: `error.<field>` is a key no catalogue has, and `t` falls back to the key
   * itself — visible and obviously wrong, which is how a new field gets its label (the same rule
   * `ErrorMessageService` uses for an unknown code).
   */
  fieldKey(field: string): TranslationKey {
    return `pending.field.${field}` as TranslationKey;
  }
  readonly sync = inject(SyncService);
  private readonly appLock = inject(AppLockService);
  private readonly auth = inject(AuthStore);

  /**
   * Whether the queue can be sent from here at all (ADR-033 decision 4).
   *
   * Without a session nothing is attempted, so the retry controls are hidden rather than offered and
   * ignored — docs/02 §2's rule that a control which cannot work is not shown. Viewing, exporting and
   * discarding stay available: they are local, and they are the escape hatch F-26 promises.
   */
  readonly canSend = computed(() => this.auth.accessToken() !== null);

  private readonly exportedText = signal<string | null>(null);
  private readonly loadingSignal = signal(true);

  constructor() {
    // A flush can have run while this screen was closed, so re-read rather than trusting the last
    // signals the shell happened to see. Opening the tray does not itself trigger a send.
    void this.load();
  }

  readonly exported = this.exportedText.asReadonly();
  readonly loading = this.loadingSignal.asReadonly();

  /** The queue lives in IndexedDB, so the first read is a real wait; the empty state must not flash. */
  private async load(): Promise<void> {
    try {
      await this.sync.refresh();
    } finally {
      this.loadingSignal.set(false);
    }
  }

  /** No entry of either kind, which is what collapses the tray into its empty state. */
  empty(): boolean {
    return this.sync.pending().length === 0 && this.sync.rejected().length === 0;
  }

  /** The raw inputs of one queued batch, in order. */
  inputs(entry: OutboxEntry): readonly string[] {
    return rawInputs(entry);
  }

  attemptsLabel(entry: OutboxEntry): string {
    return entry.attempts === 1
      ? this.i18n.t('pending.attemptsOne')
      : this.i18n.t('pending.attemptsMany', { count: entry.attempts });
  }

  /**
   * The wait the backoff policy intends before the next automatic attempt, in whole seconds.
   *
   * This build flushes on events rather than on a timer (ADR-026 decision 3), so the figure explains
   * the policy rather than promising a scheduled call.
   */
  nextWaitSeconds(entry: OutboxEntry): number {
    return Math.round(nextAttemptDelay(entry.attempts) / 1000);
  }

  /** The stored failure, or a translated generic when the server's message was empty. */
  errorText(entry: OutboxEntry): string {
    const message = entry.error?.trim() ?? '';
    return message === '' ? this.i18n.t('pending.errorUnknown') : message;
  }

  /** `dateStyle`/`timeStyle` follow the active language; the instant itself is the device's local one. */
  localTime(enqueuedAt: string): string {
    return syncedAtLabel(enqueuedAt, this.i18n.tag());
  }

  beforeLabel(diff: SyncDiff): string {
    return categoryLabel(diff.localCategoryId, diff.localCategoryName) ?? this.i18n.t('pending.diffNoCategory');
  }

  afterLabel(diff: SyncDiff): string {
    return categoryLabel(diff.serverCategoryId, diff.serverCategoryName) ?? this.i18n.t('pending.diffNoCategory');
  }

  /** The server's decision source in words, falling back to its own token when no word exists. */
  whyLabel(why: string): string {
    const key = whyKey(why);
    return key === null ? why : this.i18n.t(key);
  }

  async retry(seq: number): Promise<void> {
    this.exportedText.set(null);
    await this.sync.retry(seq);
  }

  async discard(seq: number): Promise<void> {
    this.exportedText.set(null);
    await this.sync.discard(seq);
  }

  async retryAll(): Promise<void> {
    this.exportedText.set(null);
    await this.sync.retryAll();
  }

  exportText(): void {
    this.exportedText.set(this.sync.exportAsText());
  }
}
