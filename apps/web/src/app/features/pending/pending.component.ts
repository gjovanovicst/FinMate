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
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { I18nService } from '../../core/i18n/i18n.service';
import { nextAttemptDelay, type OutboxEntry } from '../../core/offline/outbox';
import { SyncService } from '../../core/offline/sync.service';
import type { SyncDiff } from '../../core/offline/sync.types';
import { categoryLabel, rawInputs, syncedAtLabel, whyKey } from '../../core/offline/sync.view';

@Component({
  selector: 'fm-pending',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="head">
      <h1 class="head__title">{{ i18n.t('pending.title') }}</h1>
      <p class="head__sub">{{ i18n.t('pending.subtitle') }}</p>
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
      <button
        class="btn btn--primary"
        type="button"
        [disabled]="sync.busy() || empty()"
        (click)="retryAll()"
      >
        {{ i18n.t('pending.retryAll') }}
      </button>
      <button class="btn" type="button" [disabled]="empty()" (click)="exportText()">
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
      <div class="empty">
        <p class="empty__title">{{ i18n.t('pending.empty') }}</p>
        <p class="empty__body">{{ i18n.t('pending.emptyBody') }}</p>
      </div>
    } @else {
      @if (sync.rejected().length > 0) {
        <section class="group">
          <h2 class="group__title">{{ i18n.t('pending.rejectedTitle') }}</h2>
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
                  <button class="btn" type="button" [disabled]="sync.busy()" (click)="retry(entry.seq)">
                    {{ i18n.t('pending.retry') }}
                  </button>
                  <button class="btn" type="button" [disabled]="sync.busy()" (click)="discard(entry.seq)">
                    {{ i18n.t('pending.discard') }}
                  </button>
                </div>
              </li>
            }
          </ul>
        </section>
      }

      @if (sync.pending().length > 0) {
        <section class="group">
          <h2 class="group__title">{{ i18n.t('pending.pendingTitle') }}</h2>
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
                  <button class="btn" type="button" [disabled]="sync.busy()" (click)="retry(entry.seq)">
                    {{ i18n.t('pending.retry') }}
                  </button>
                  <button class="btn" type="button" [disabled]="sync.busy()" (click)="discard(entry.seq)">
                    {{ i18n.t('pending.discard') }}
                  </button>
                </div>
              </li>
            }
          </ul>
        </section>
      }
    }

    @if (sync.diffs().length > 0) {
      <section class="diffs">
        <h2 class="group__title">{{ i18n.t('pending.diffTitle', { count: sync.diffs().length }) }}</h2>
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
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .head__title {
        margin: 0;
        font-size: var(--text-xl);
      }
      .head__sub {
        margin: var(--space-1) 0 var(--space-3);
        color: var(--color-text-muted);
      }
      .count {
        margin: 0 0 var(--space-3);
        font-size: var(--text-sm);
        color: var(--color-text-subtle);
      }
      .status,
      .alert {
        margin: 0 0 var(--space-3);
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
        margin-block-end: var(--space-4);
      }
      .export {
        display: grid;
        gap: var(--space-1);
        min-inline-size: 0;
        margin-block-end: var(--space-4);
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
        margin-block-end: var(--space-5);
        min-inline-size: 0;
      }
      .group__title {
        margin: 0 0 var(--space-2);
        font-size: var(--text-lg);
      }
      .group__body {
        margin: 0 0 var(--space-2);
        color: var(--color-text-muted);
      }
      .list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: grid;
        gap: var(--space-3);
      }
      .row,
      .diff {
        min-inline-size: 0;
        padding: var(--space-3);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        background: var(--color-surface);
      }
      .row--refused {
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
        margin-block-start: var(--space-5);
        text-align: center;
        color: var(--color-text-muted);
      }
      .empty__title {
        margin: 0;
        font-size: var(--text-lg);
      }
      .empty__body {
        margin: var(--space-1) 0 0;
      }
      .btn {
        padding: var(--space-2) var(--space-4);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-sm);
        background: var(--color-bg);
        color: inherit;
        font: inherit;
        cursor: pointer;
      }
      .btn--primary {
        background: var(--color-primary);
        border-color: var(--color-primary);
        color: var(--color-primary-contrast);
      }
      .btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
    `,
  ],
})
export class PendingComponent {
  readonly i18n = inject(I18nService);
  readonly sync = inject(SyncService);

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
