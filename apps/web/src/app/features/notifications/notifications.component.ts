import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { NotificationStore } from '../../core/notifications/notification.store';
import { I18nService } from '../../core/i18n/i18n.service';
import { GraphqlClient } from '../../core/graphql/graphql.client';
import {
  CHANNELS,
  channelLabelKey,
  deepLinkFor,
  kindLabelKey,
  preferencesInput,
  quietHoursProblem,
  ruleUpdateInput,
  statusLabelKey,
  toneFor,
  visibleRows,
  type AlertRuleRow,
  type InsightSeverity,
  type NotificationChannel,
  type NotificationRow,
} from './notifications.view';

/**
 * The notification centre and the alert preferences — F-22, docs/02 §4.17 and §7.1.
 *
 * ## Two screens in one, and why
 *
 * docs/02 §4.18 puts notification preferences inside the Settings shell, which **does not exist yet**
 * (there is no `/settings` route in this build). Rather than invent a settings shell for one section,
 * the preferences live under the list they govern: the question "what am I told?" and the answer "here
 * is what you were told" belong on one screen, and the settings shell can host it later without
 * changing the API. Recorded in docs/06 §5.14.
 *
 * ## The decisions are in `notifications.view.ts`
 *
 * Which rows the filter shows, where a row links, what the badge draws and whether the preferences form
 * can be saved at all are pure functions with their own spec, because each is silent when wrong — a row
 * that looks clickable and goes nowhere, or a quiet-hours window the server stores as "never quiet"
 * while the user believes the opposite.
 *
 * ## What this screen deliberately does not do
 *
 * There is no realtime layer, so the bell updates from the counts the mark-read mutations return (the
 * API returns the new count precisely so the badge needs no second round trip). `PUSH`/`WEB_PUSH` are
 * listed as channels a rule may name, with a note that this build cannot deliver them yet — a checkbox
 * that silently does nothing is worse than a labelled limitation.
 *
 * @module apps/web/src/app/features/notifications
 */
@Component({
  selector: 'fm-notifications',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <main class="wrap">
      <h1>{{ i18n.t('notifications.title') }}</h1>
      <p class="muted">{{ i18n.t('notifications.subtitle') }}</p>

      @if (error()) {
        <p class="error" role="alert">{{ i18n.t('notifications.settings.error') }}</p>
      }

      <div class="toolbar">
        <label class="toggle">
          <input
            type="checkbox"
            [checked]="unreadOnly()"
            (change)="unreadOnly.set(!unreadOnly())"
          />
          <span>{{ i18n.t('notifications.unreadOnly') }}</span>
        </label>
        @if (unreadCount() > 0) {
          <button type="button" class="btn" [disabled]="busy()" (click)="markAllRead()">
            {{ i18n.t('notifications.markAllRead') }}
          </button>
        }
      </div>

      @if (loading()) {
        <p class="muted">{{ i18n.t('notifications.loading') }}</p>
      } @else if (rows().length === 0) {
        <p class="muted">
          {{ unreadOnly() ? i18n.t('notifications.emptyUnread') : i18n.t('notifications.empty') }}
        </p>
      } @else {
        <ul class="list" [attr.aria-label]="i18n.t('notifications.listLabel')">
          @for (row of rows(); track row.id) {
            <li class="row" [class.row--unread]="row.readAt === null" [attr.data-tone]="tone(row)">
              <div class="row__head">
                <span class="row__title">{{ row.title }}</span>
                <span class="row__meta">
                  {{ i18n.t(statusLabelKey(row.status)) }} ·
                  {{ i18n.t(channelLabelKey(row.channel)) }}
                </span>
              </div>
              <p class="row__body">{{ row.body }}</p>
              <div class="row__actions">
                @if (linkFor(row); as href) {
                  <a class="btn btn--link" [routerLink]="href">{{ i18n.t('notifications.open') }}</a>
                }
                @if (row.readAt === null) {
                  <button type="button" class="btn btn--link" [disabled]="busy()" (click)="markRead(row)">
                    {{ i18n.t('notifications.markRead') }}
                  </button>
                }
              </div>
            </li>
          }
        </ul>
      }

      <section class="settings">
        <h2>{{ i18n.t('notifications.settings.title') }}</h2>

        <h3>{{ i18n.t('notifications.settings.kinds') }}</h3>
        @for (rule of rules(); track rule.id) {
          <div class="rule">
            <label class="toggle">
              <input
                type="checkbox"
                [checked]="rule.isActive"
                (change)="toggleRule(rule, !rule.isActive)"
              />
              <span>{{ i18n.t(kindLabel(rule.kind)) }}</span>
            </label>
            <fieldset class="channels">
              <legend class="sr-only">{{ i18n.t('notifications.settings.channels') }}</legend>
              @for (channel of channels; track channel) {
                <label class="toggle toggle--small">
                  <input
                    type="checkbox"
                    [checked]="rule.channels.includes(channel)"
                    (change)="toggleChannel(rule, channel)"
                  />
                  <span>{{ i18n.t(channelLabelKey(channel)) }}</span>
                </label>
              }
            </fieldset>
          </div>
        }

        <h3>{{ i18n.t('notifications.settings.quietHours') }}</h3>
        <label class="toggle">
          <input
            type="checkbox"
            [checked]="quiet().enabled"
            (change)="quiet.set({ ...quiet(), enabled: !quiet().enabled })"
          />
          <span>{{ i18n.t('notifications.settings.quietHint') }}</span>
        </label>
        @if (quiet().enabled) {
          <div class="quiet">
            <label>
              <span>{{ i18n.t('notifications.settings.quietFrom') }}</span>
              <input
                type="time"
                [value]="quiet().start"
                (change)="setQuietTime('start', $event)"
                [attr.aria-invalid]="quietProblem() === 'start' ? 'true' : null"
              />
            </label>
            <label>
              <span>{{ i18n.t('notifications.settings.quietTo') }}</span>
              <input
                type="time"
                [value]="quiet().end"
                (change)="setQuietTime('end', $event)"
                [attr.aria-invalid]="quietProblem() === 'end' ? 'true' : null"
              />
            </label>
          </div>
          @if (quietProblem() !== null) {
            <p class="error" role="alert">
              {{
                quietProblem() === 'same'
                  ? i18n.t('notifications.settings.quietSame')
                  : i18n.t('notifications.settings.quietFormat')
              }}
            </p>
          }
        }

        <label class="toggle">
          <input
            type="checkbox"
            [checked]="positiveFeedback()"
            (change)="positiveFeedback.set(!positiveFeedback())"
          />
          <span>{{ i18n.t('notifications.settings.positive') }}</span>
        </label>

        <p class="muted small">{{ i18n.t('notifications.settings.queuedNote') }}</p>

        <button
          type="button"
          class="btn btn--primary"
          [disabled]="busy() || quietProblem() !== null"
          (click)="savePreferences()"
        >
          {{ i18n.t('notifications.settings.save') }}
        </button>
        @if (saved()) {
          <span class="ok" role="status">{{ i18n.t('notifications.settings.saved') }}</span>
        }
      </section>
    </main>
  `,
  styles: `
    .wrap {
      padding: 1rem;
      /* No fixed widths: the 320 px pass found every one of them (docs/02 §9). */
      max-inline-size: 46rem;
      margin-inline: auto;
    }
    h1 {
      font-size: 1.4rem;
      margin-block: 0 0.25rem;
    }
    h2 {
      font-size: 1.15rem;
      margin-block: 1.5rem 0.5rem;
    }
    h3 {
      font-size: 1rem;
      margin-block: 1rem 0.35rem;
    }
    .muted {
      color: var(--fm-muted, #666);
    }
    .small {
      font-size: 0.85rem;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
      justify-content: space-between;
      margin-block: 1rem 0.5rem;
    }
    .list {
      list-style: none;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .row {
      border: 1px solid var(--fm-border, #ddd);
      border-radius: 0.5rem;
      padding: 0.6rem 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.35rem;
    }
    .row--unread {
      border-inline-start: 4px solid var(--fm-accent, #2b6cb0);
    }
    .row[data-tone='positive'] .row__title {
      color: var(--fm-positive, #1a7f37);
    }
    .row[data-tone='critical'] .row__title {
      color: var(--fm-critical, #b42318);
    }
    .row[data-tone='warning'] .row__title {
      color: var(--fm-warning, #9a6700);
    }
    .row__head {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      justify-content: space-between;
      align-items: baseline;
    }
    .row__title {
      font-weight: 600;
      min-inline-size: 0;
    }
    .row__meta {
      font-size: 0.8rem;
      color: var(--fm-muted, #666);
    }
    .row__body {
      margin: 0;
      min-inline-size: 0;
      overflow-wrap: anywhere;
    }
    .row__actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .settings {
      margin-block-start: 2rem;
      border-block-start: 1px solid var(--fm-border, #ddd);
      padding-block-start: 0.5rem;
    }
    .rule {
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      margin-block-end: 0.75rem;
    }
    .channels {
      border: 0;
      padding: 0;
      margin: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .toggle {
      display: flex;
      gap: 0.4rem;
      align-items: center;
    }
    .toggle--small {
      font-size: 0.9rem;
    }
    .quiet {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-block: 0.5rem;
    }
    .quiet label {
      display: flex;
      flex-direction: column;
      gap: 0.2rem;
    }
    .btn {
      font: inherit;
      padding: 0.35rem 0.7rem;
      border-radius: 0.375rem;
      border: 1px solid var(--fm-border, #ccc);
      background: transparent;
      cursor: pointer;
    }
    .btn--link {
      border: 0;
      padding: 0;
      text-decoration: underline;
    }
    .btn--primary {
      background: var(--fm-accent, #2b6cb0);
      color: #fff;
      border-color: transparent;
    }
    .btn[disabled] {
      opacity: 0.6;
      cursor: not-allowed;
    }
    .error {
      color: var(--fm-critical, #b42318);
    }
    .ok {
      margin-inline-start: 0.5rem;
      color: var(--fm-positive, #1a7f37);
    }
    .sr-only {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class NotificationsComponent {
  private readonly graphql = inject(GraphqlClient);
  private readonly notificationStore = inject(NotificationStore);
  readonly i18n = inject(I18nService);

  readonly channels = CHANNELS;
  readonly channelLabelKey = channelLabelKey;
  readonly statusLabelKey = statusLabelKey;

  private readonly rowsSignal = signal<readonly NotificationRow[]>([]);
  private readonly rulesSignal = signal<readonly AlertRuleRow[]>([]);

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly error = signal(false);
  readonly saved = signal(false);
  readonly unreadOnly = signal(false);
  readonly quiet = signal({ enabled: false, start: '21:00', end: '08:00' });
  readonly positiveFeedback = signal(true);

  readonly rows = computed(() => visibleRows(this.rowsSignal(), { unreadOnly: this.unreadOnly() }));
  readonly rules = this.rulesSignal.asReadonly();
  readonly unreadCount = computed(() => this.rowsSignal().filter((row) => row.readAt === null).length);
  readonly quietProblem = computed(() => quietHoursProblem(this.quiet()));

  constructor() {
    void this.load();
  }

  tone(row: NotificationRow): string {
    return toneFor((row.insightSeverity ?? 'INFO') as InsightSeverity);
  }

  kindLabel(kind: string): ReturnType<typeof kindLabelKey> {
    return kindLabelKey(kind);
  }

  linkFor(row: NotificationRow): string | null {
    return deepLinkFor(row.insightKind);
  }

  async markRead(row: NotificationRow): Promise<void> {
    this.busy.set(true);
    this.error.set(false);
    try {
      const data = await this.graphql.query<{
        markNotificationRead: { notification: { id: string }; unreadNotificationCount: number } | null;
      }>(MARK_READ, { id: row.id });
      // The mutation returns the authoritative count, so the bell needs no second round trip.
      if (data.markNotificationRead !== null) {
        this.notificationStore.setCount(data.markNotificationRead.unreadNotificationCount);
        this.rowsSignal.set(
          this.rowsSignal().map((entry) =>
            entry.id === row.id ? { ...entry, readAt: new Date().toISOString() } : entry,
          ),
        );
      }
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }

  async markAllRead(): Promise<void> {
    this.busy.set(true);
    this.error.set(false);
    try {
      await this.graphql.query<{ markAllNotificationsRead: number }>(MARK_ALL_READ);
      this.notificationStore.setCount(0);
      const stamp = new Date().toISOString();
      this.rowsSignal.set(this.rowsSignal().map((entry) => ({ ...entry, readAt: entry.readAt ?? stamp })));
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }

  async toggleRule(rule: AlertRuleRow, isActive: boolean): Promise<void> {
    await this.patchRule(rule, { isActive });
  }

  async toggleChannel(rule: AlertRuleRow, channel: NotificationChannel): Promise<void> {
    const channels = rule.channels.includes(channel)
      ? rule.channels.filter((entry) => entry !== channel)
      : [...rule.channels, channel];
    await this.patchRule(rule, { channels });
  }

  private async patchRule(
    rule: AlertRuleRow,
    change: { channels?: readonly NotificationChannel[]; isActive?: boolean },
  ): Promise<void> {
    this.busy.set(true);
    this.error.set(false);
    try {
      await this.graphql.query(UPDATE_RULE, { input: ruleUpdateInput(rule, change) });
      this.rulesSignal.set(
        this.rulesSignal().map((entry) => (entry.id === rule.id ? { ...entry, ...change } : entry)),
      );
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }

  setQuietTime(field: 'start' | 'end', event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.quiet.set({ ...this.quiet(), [field]: value });
    this.saved.set(false);
  }

  async savePreferences(): Promise<void> {
    const input = preferencesInput({
      channels: this.preferencesChannels(),
      quietHours: this.quiet(),
      positiveFeedback: this.positiveFeedback(),
      locale: this.i18n.locale(),
    });
    // The form refuses to save a window the server would store as "never quiet" (see the view module).
    if (input === null) return;

    this.busy.set(true);
    this.error.set(false);
    this.saved.set(false);
    try {
      await this.graphql.query(SAVE_PREFERENCES, { input });
      this.saved.set(true);
    } catch {
      this.error.set(true);
    } finally {
      this.busy.set(false);
    }
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(false);
    try {
      const [rows, rules, preferences] = await Promise.all([
        this.graphql.query<{ notifications: { edges: { node: NotificationRow }[] } }>(NOTIFICATIONS),
        this.graphql.query<{ alerts: readonly AlertRuleRow[] }>(ALERTS),
        this.graphql.query<{ notificationPreferences: PreferencesWire }>(PREFERENCES),
      ]);
      this.rowsSignal.set(rows.notifications.edges.map((edge) => edge.node));
      this.rulesSignal.set(rules.alerts);
      this.quiet.set({
        enabled: preferences.notificationPreferences.quietHours !== null,
        start: preferences.notificationPreferences.quietHours?.start ?? '21:00',
        end: preferences.notificationPreferences.quietHours?.end ?? '08:00',
      });
      this.positiveFeedback.set(preferences.notificationPreferences.positiveFeedback);
      this.preferencesChannelsSignal.set(preferences.notificationPreferences.channels);
      this.notificationStore.setCount(this.rowsSignal().filter((row) => row.readAt === null).length);
    } catch {
      this.error.set(true);
    } finally {
      this.loading.set(false);
    }
  }

  private readonly preferencesChannelsSignal = signal<readonly NotificationChannel[]>(['IN_APP']);
  private readonly preferencesChannels = computed(() => this.preferencesChannelsSignal());
}

interface PreferencesWire {
  readonly channels: readonly NotificationChannel[];
  readonly quietHours: { readonly start: string; readonly end: string } | null;
  readonly positiveFeedback: boolean;
  readonly locale: string | null;
}

const NOTIFICATIONS = /* GraphQL */ `
  query Notifications {
    notifications(first: 50) {
      edges {
        node {
          id
          insightId
          channel
          title
          body
          status
          insightKind
          insightSeverity
          sentAt
          readAt
          createdAt
        }
      }
    }
  }
`;

const ALERTS = /* GraphQL */ `
  query Alerts {
    alerts {
      id
      kind
      channels
      quietHours
      isActive
    }
  }
`;

const PREFERENCES = /* GraphQL */ `
  query NotificationPreferences {
    notificationPreferences {
      channels
      quietHours
      positiveFeedback
      locale
    }
  }
`;

const MARK_READ = /* GraphQL */ `
  mutation MarkNotificationRead($id: ID!) {
    markNotificationRead(id: $id) {
      notification {
        id
      }
      unreadNotificationCount
    }
  }
`;

const MARK_ALL_READ = /* GraphQL */ `
  mutation MarkAllNotificationsRead {
    markAllNotificationsRead
  }
`;

const UPDATE_RULE = /* GraphQL */ `
  mutation UpdateAlertRule($input: AlertRuleUpdateInput!) {
    updateAlertRule(input: $input) {
      id
      channels
      isActive
    }
  }
`;

const SAVE_PREFERENCES = /* GraphQL */ `
  mutation SaveNotificationPreferences($input: NotificationPreferencesInput!) {
    updateNotificationPreferences(input: $input) {
      channels
      quietHours
      positiveFeedback
      locale
    }
  }
`;
