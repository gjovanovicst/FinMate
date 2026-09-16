import { Inject, Injectable } from '@nestjs/common';

import {
  alertKindForInsight,
  evaluateAlerts,
  isQuietHour,
  uuidv7,
  type AlertCandidate,
  type AlertRuleFact,
  type NotificationChannel,
  type NotificationStatus,
  type QuietHours,
} from '@finmate/domain';

import { CONFIG, type AppConfig } from '../../config/config';
import { Prisma } from '../../generated/prisma/client';
import type { CursorPage } from '../../graphql/pagination';
import { normalisePageSize } from '../../graphql/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { InsightsService } from '../insights/insights.service';
import { composeNotification } from './notification-copy';
import {
  effectiveChannels,
  effectiveQuietHours,
  parseNotificationPreferences,
  serialiseNotificationPreferences,
  type NotificationPreferences,
} from './notification-preferences';

/**
 * Alerts and notifications — docs/05 §9's pipeline, docs/06 §5.14.
 *
 * ## It decides nothing about *whether* to speak
 *
 * `evaluateAlerts` in `@finmate/domain` owns every veto (rule state, quiet hours, dedupe, the daily
 * cap) and is unit-tested on both sides of each boundary. This service loads what that decision needs,
 * writes the rows it produces, and composes the copy.
 *
 * ## `SUPPRESSED` decisions are not persisted, and that is load-bearing
 *
 * `notifications` is `UNIQUE (user_id, dedupe_key)`. Writing a rate-limited row would burn the key and
 * make the condition **permanently undeliverable** once the cap resets — the notification equivalent of
 * poisoning a cache. So only `SENT` and `QUEUED` become rows; suppression is reported in the run
 * summary instead. `QUEUED` does occupy the key, correctly: the row exists and will be delivered.
 *
 * ## Copy
 *
 * `title`/`body` are composed here from the insight's **payload**, so every numeral in a notification
 * came from the backend's own arithmetic (ADR-001). They are **English only**: the API has no i18n
 * catalogue (the web's lives in `apps/web`), which docs/06 §5.14 records as a Definition-of-Done
 * breach of the same shape as `fm-money`'s hardcoded accessible label.
 *
 * @module apps/api/src/modules/notifications
 */

export interface AlertRuleView {
  readonly id: string;
  readonly kind: string;
  readonly threshold: Record<string, unknown>;
  readonly channels: readonly string[];
  readonly quietHours: Record<string, unknown> | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NotificationView {
  readonly id: string;
  readonly insightId: string | null;
  /**
   * The insight behind the row, flattened.
   *
   * The screen needs two things from it — the **tone** (severity) and where the row **links** (kind) —
   * and reading them from a nested object would mean every client walking a relation. Two scalars are
   * cheaper than the join-per-row a full `insight { … }` field would invite.
   */
  readonly insightKind: string | null;
  readonly insightSeverity: string | null;
  readonly channel: string;
  readonly title: string;
  readonly body: string;
  readonly sentAt: Date | null;
  readonly readAt: Date | null;
  readonly status: string;
  readonly createdAt: Date;
}

export interface DispatchResult {
  readonly considered: number;
  readonly sent: number;
  readonly failed: number;
  /** Held because the user's quiet hours are on right now. */
  readonly deferred: number;
  /** Channels this build cannot deliver yet (push), left `QUEUED` rather than marked sent. */
  readonly skipped: number;
}

export interface AlertRunResult {
  readonly insightsCreated: number;
  readonly notificationsCreated: number;
  readonly duplicates: number;
  readonly rateLimited: number;
  readonly queued: number;
  readonly suppressed: number;
}

export interface AlertRuleInputShape {
  readonly kind: string;
  readonly threshold?: Record<string, unknown>;
  readonly channels?: readonly string[];
  readonly quietHours?: Record<string, unknown> | null;
  readonly isActive?: boolean;
}

/** Every field optional but `id` — the update path. */
export type UpdateAlertRuleShape = Partial<AlertRuleInputShape> & { readonly id: string };

/**
 * `null` on a nullable JSONB column means "store SQL NULL", which Prisma spells `DbNull`; passing a
 * bare `null` is a type error and passing `JsonNull` would store the JSON value `null`.
 */
function quietHoursValue(value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | typeof Prisma.DbNull {
  if (value === undefined || value === null) return Prisma.DbNull;
  return value as Prisma.InputJsonValue;
}

/**
 * The rules a Household has before it configures anything (docs/02 §7.1 shows alerts arriving without
 * the user visiting settings).
 *
 * Written as **rows**, not as hidden code defaults, so `/settings/alerts` (3.1.4) shows the user what is
 * actually on and `PATCH`ing a rule edits the thing that decides. `BUDGET_THRESHOLD` and
 * `GOAL_REACHED` are absent because no insight produces them: a `BUDGET_PACE` insight is mapped to
 * `PACE_OVERRUN`, and a "% of budget used" arm would be a second generator (docs/06 §5.13).
 */
/** How many queued rows one drain pass handles. The job runs every minute (docs/05 §8). */
export const DISPATCH_BATCH = 200;

export const DEFAULT_ALERT_RULES: readonly AlertRuleInputShape[] = [
  { kind: 'PACE_OVERRUN', threshold: {}, channels: ['IN_APP'], isActive: true },
  { kind: 'UNUSUAL_SPEND', threshold: {}, channels: ['IN_APP'], isActive: true },
  // A due bill is the one alert a user is *glad* to receive, so it is on by default (F-22's bills arm,
  // task 3.4.3). `INFO` severity means it never consumes a `CRITICAL` exemption or a positive-toggle.
  { kind: 'RECURRING_DUE', threshold: {}, channels: ['IN_APP'], isActive: true },
];

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly insights: InsightsService,
    private readonly mail: MailService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------------------------

  async alerts(householdId: string): Promise<readonly AlertRuleView[]> {
    const rows = await this.prisma.client.alert_rules.findMany({
      where: { household_id: householdId },
      orderBy: [{ kind: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.toRuleView(row));
  }

  async createRule(householdId: string, input: AlertRuleInputShape): Promise<AlertRuleView> {
    const row = await this.prisma.client.alert_rules.create({
      data: {
        id: uuidv7(),
        household_id: householdId,
        kind: input.kind,
        threshold: (input.threshold ?? {}) as Prisma.InputJsonValue,
        channels: [...(input.channels ?? ['IN_APP'])],
        quiet_hours: quietHoursValue(input.quietHours),
        is_active: input.isActive ?? true,
      },
    });
    return this.toRuleView(row);
  }

  async updateRule(
    householdId: string,
    input: UpdateAlertRuleShape,
  ): Promise<AlertRuleView | null> {
    // Scoped by household: a client cannot edit another Household's rule (ADR-008).
    const existing = await this.prisma.client.alert_rules.findFirst({
      where: { id: input.id, household_id: householdId },
    });
    if (existing === null) return null;

    const row = await this.prisma.client.alert_rules.update({
      where: { id: input.id },
      data: {
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.threshold !== undefined
          ? { threshold: input.threshold as Prisma.InputJsonValue }
          : {}),
        ...(input.channels !== undefined ? { channels: [...input.channels] } : {}),
        ...(input.quietHours !== undefined ? { quiet_hours: quietHoursValue(input.quietHours) } : {}),
        ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
      },
    });
    return this.toRuleView(row);
  }

  async deleteRule(householdId: string, id: string): Promise<boolean> {
    const result = await this.prisma.client.alert_rules.deleteMany({
      where: { id, household_id: householdId },
    });
    return result.count > 0;
  }

  // -------------------------------------------------------------------------------------------
  // Evaluation
  // -------------------------------------------------------------------------------------------

  /**
   * Run the whole F-22 chain for one period: generate insights, then evaluate them against the rules.
   *
   * Both halves in one method on purpose, and it is the method the **daily job** calls as well as the
   * `runAlerts` mutation — a scheduled pass and a user-triggered one must not be two implementations of
   * the pipeline. The order is docs/05 §9's: generate, then evaluate. `notifications.dispatch` is the
   * separate per-minute drain that delivers what this wrote.
   */
  async run(householdId: string, userId: string, asOf?: string): Promise<AlertRunResult> {
    const generated = await this.insights.generate(householdId, asOf);
    await this.ensureDefaultRules(householdId);

    const [insights, rules, notifications, localTime, preferences] = await Promise.all([
      this.insights.list(householdId, { includeDismissed: true }, 200),
      this.alerts(householdId),
      this.prisma.client.notifications.findMany({
        where: { user_id: userId },
        select: { dedupe_key: true, created_at: true },
      }),
      this.localTime(householdId),
      this.preferences(householdId),
    ]);

    const candidates: AlertCandidate[] = [];
    const insightById = new Map<string, (typeof insights.items)[number]>();
    const dedupeKeyByInsight = new Map<string, string>();
    for (const insight of insights.items) {
      const alertKind = alertKindForInsight(insight.kind);
      const dedupeKey = insight.payload['dedupeKey'];
      if (alertKind === null || typeof dedupeKey !== 'string') continue;
      insightById.set(insight.id, insight);
      dedupeKeyByInsight.set(insight.id, dedupeKey);
      candidates.push({
        insightId: insight.id,
        dedupeKey,
        kind: insight.kind,
        severity: insight.severity as AlertCandidate['severity'],
        periodStart: insight.periodStart,
        alertKind,
      });
    }

    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const decisions = evaluateAlerts({
      candidates,
      rules: rules.map((rule) => this.toRuleFact(rule, preferences)),
      localTime,
      sentDedupeKeys: new Set(notifications.map((row) => row.dedupe_key)),
      sentInLastDay: notifications.filter((row) => row.created_at >= dayAgo).length,
      positiveFeedback: preferences.positiveFeedback,
    });

    let created = 0;
    for (const decision of decisions) {
      if (decision.status !== 'SENT' && decision.status !== 'QUEUED') continue;
      const insight = insightById.get(decision.insightId);
      const dedupeKey = dedupeKeyByInsight.get(decision.insightId);
      if (insight === undefined || dedupeKey === undefined) continue;
      const copy = composeNotification(
        insight.kind,
        insight.payload,
        decision.channel,
        this.config.APP_NAME,
      );
      // The evaluator's `SENT` means "deliverable". Only `IN_APP` can actually be delivered in this
      // build — email/push is 3.1.3 — so a non-in-app row is stored `QUEUED` rather than claiming a
      // delivery that has not happened.
      const status: NotificationStatus =
        decision.status === 'SENT' && decision.channel !== 'IN_APP' ? 'QUEUED' : decision.status;
      try {
        await this.prisma.client.notifications.create({
          data: {
            id: uuidv7(),
            household_id: householdId,
            user_id: userId,
            insight_id: decision.insightId,
            channel: decision.channel,
            title: copy.title,
            body: copy.body,
            dedupe_key: `${dedupeKey}:${decision.channel}`,
            status,
            // `SENT` for `IN_APP` is the honest state: the row *is* the delivery.
            sent_at: status === 'SENT' ? new Date() : null,
          },
        });
        created += 1;
      } catch {
        // The unique constraint on `(user_id, dedupe_key)` is the real dedupe. A race that reaches
        // here lost it, which is the correct outcome — not an error worth failing the run for.
      }
    }

    return {
      insightsCreated: generated.created,
      notificationsCreated: created,
      duplicates: decisions.filter((decision) => decision.reason === 'DUPLICATE').length,
      rateLimited: decisions.filter((decision) => decision.reason === 'RATE_LIMITED').length,
      queued: decisions.filter((decision) => decision.reason === 'QUIET_HOURS').length,
      suppressed: decisions.filter(
        (decision) =>
          decision.reason === 'RULE_INACTIVE' || decision.reason === 'POSITIVE_DISABLED',
      ).length,
    };
  }

  /** Create the documented defaults, once, and only for a Household that has configured nothing. */
  private async ensureDefaultRules(householdId: string): Promise<void> {
    const existing = await this.prisma.client.alert_rules.count({ where: { household_id: householdId } });
    if (existing > 0) return;
    for (const rule of DEFAULT_ALERT_RULES) {
      await this.prisma.client.alert_rules.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          kind: rule.kind,
          threshold: (rule.threshold ?? {}) as Prisma.InputJsonValue,
          channels: [...(rule.channels ?? ['IN_APP'])],
          quiet_hours: quietHoursValue(rule.quietHours),
          is_active: rule.isActive ?? true,
        },
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------------------------

  /**
   * `notifications.dispatch` — docs/05 §8, every minute.
   *
   * Drains what is deliverable **now**: the row exists (`QUEUED`), the user's window has ended, and the
   * channel can actually be delivered by this build.
   *
   * | Channel | What "delivered" means here |
   * |---|---|
   * | `IN_APP` | The row is the delivery: `SENT`, `sent_at = now`. The centre and the badge read it. |
   * | `EMAIL` | Sent through `MailService` (Mailhog in development). A failure sets `FAILED` — never a retry loop, because the row records that we tried. |
   * | `PUSH` / `WEB_PUSH` | **Not dispatched.** The browser subscription store and the service worker are Phase 4 (docs/09 §6), and there is no push dependency to send with. The rows stay `QUEUED`, which is the honest state, and `skipped` says how many. |
   *
   * The recipient is the Household's **owner**: v1 has exactly one Member (F-29 is a `Won't`), so the
   * `user_id` on the row is already the only candidate, and resolving "members who want this" is a
   * question the sharing UI has to answer anyway.
   */
  async dispatch(householdId: string): Promise<DispatchResult> {
    const preferences = await this.preferences(householdId);
    const localTime = await this.localTime(householdId);
    const queued = await this.prisma.client.notifications.findMany({
      where: { household_id: householdId, status: 'QUEUED' },
      orderBy: { id: 'asc' },
      take: DISPATCH_BATCH,
    });

    const owner = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { owner_user_id: true, users: { select: { email: true } } },
    });

    let sent = 0;
    let failed = 0;
    let deferred = 0;
    let skipped = 0;

    for (const row of queued) {
      // Quiet hours are re-checked at dispatch time, not trusted from when the row was written: the
      // window is a clock, and the row may have waited hours for it to end.
      if (this.inQuietHours(localTime, preferences.quietHours)) {
        deferred += 1;
        continue;
      }
      if (row.channel === 'PUSH' || row.channel === 'WEB_PUSH') {
        skipped += 1;
        continue;
      }

      try {
        if (row.channel === 'EMAIL') {
          if (owner?.users?.email === undefined) {
            skipped += 1;
            continue;
          }
          await this.mail.sendNotification(owner.users.email, row.title, row.body);
        }
        await this.prisma.client.notifications.updateMany({
          where: { id: row.id, status: 'QUEUED' },
          data: { status: 'SENT', sent_at: new Date() },
        });
        sent += 1;
      } catch {
        // A failed delivery is recorded, not retried forever: the status is the honest report, and
        // `runAlerts` will not recreate the condition because the dedupe key is spent.
        await this.prisma.client.notifications.updateMany({
          where: { id: row.id },
          data: { status: 'FAILED' },
        });
        failed += 1;
      }
    }

    return { sent, failed, deferred, skipped, considered: queued.length };
  }

  /** The window that governs dispatch: the Household preference (rules are re-read at generation). */
  private inQuietHours(localTime: string, quietHours: QuietHours | null): boolean {
    if (quietHours === null) return false;
    return isQuietHour(localTime, quietHours);
  }

  // -------------------------------------------------------------------------------------------
  // Preferences
  // -------------------------------------------------------------------------------------------

  /** docs/06 §3.2: `households.settings.notifications`, with per-field fallback (docs/06 §5.14). */
  async preferences(householdId: string): Promise<NotificationPreferences> {
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { settings: true },
    });
    const settings = (household?.settings ?? {}) as Record<string, unknown>;
    return parseNotificationPreferences(settings['notifications']);
  }

  async updatePreferences(
    householdId: string,
    input: {
      readonly channels?: readonly NotificationChannel[];
      readonly quietHours?: QuietHours | null;
      readonly positiveFeedback?: boolean;
      readonly locale?: string | null;
    },
  ): Promise<NotificationPreferences> {
    const current = await this.preferences(householdId);
    const next = serialiseNotificationPreferences({
      channels: input.channels ?? current.channels,
      quietHours: input.quietHours === undefined ? current.quietHours : input.quietHours,
      positiveFeedback: input.positiveFeedback ?? current.positiveFeedback,
      locale: input.locale === undefined ? current.locale : input.locale,
    });

    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { settings: true },
    });
    const settings = (household?.settings ?? {}) as Record<string, unknown>;
    // Read-modify-write of one JSONB key: the other keys (onboarding progress, AI thresholds) must
    // survive, which is why the document is merged rather than replaced.
    await this.prisma.client.households.updateMany({
      where: { id: householdId },
      data: { settings: { ...settings, notifications: next } as Prisma.InputJsonValue },
    });
    return parseNotificationPreferences(next);
  }

  // -------------------------------------------------------------------------------------------
  // Reading and marking
  // -------------------------------------------------------------------------------------------

  async list(
    householdId: string,
    userId: string,
    options: { readonly unreadOnly?: boolean },
    first?: number,
    after?: string,
  ): Promise<CursorPage<NotificationView>> {
    const take = normalisePageSize(first);
    const where = {
      household_id: householdId,
      user_id: userId,
      ...(options.unreadOnly === true ? { read_at: null } : {}),
      ...(after !== undefined ? { id: { lt: after } } : {}),
    };
    const [rows, totalCount] = await Promise.all([
      this.prisma.client.notifications.findMany({
        where,
        orderBy: { id: 'desc' },
        take: take + 1,
        include: { insights: { select: { kind: true, severity: true } } },
      }),
      this.prisma.client.notifications.count({ where }),
    ]);
    const hasNextPage = rows.length > take;
    const page = hasNextPage ? rows.slice(0, take) : rows;
    return {
      items: page.map((row) => this.toNotificationView(row)),
      totalCount,
      hasNextPage,
      endCursor: hasNextPage ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async unreadCount(householdId: string, userId: string): Promise<number> {
    return this.prisma.client.notifications.count({
      where: { household_id: householdId, user_id: userId, read_at: null },
    });
  }

  async markRead(
    householdId: string,
    userId: string,
    id: string,
  ): Promise<{ notification: NotificationView; unreadCount: number } | null> {
    const result = await this.prisma.client.notifications.updateMany({
      where: { id, household_id: householdId, user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });
    // `updateMany` reports 0 both when the row is not ours and when it was already read; the read
    // below distinguishes them, and marking an already-read row is a no-op rather than an error.
    const row = await this.prisma.client.notifications.findFirst({
      where: { id, household_id: householdId, user_id: userId },
    });
    if (row === null || (result.count === 0 && row.read_at === null)) return null;
    return {
      notification: this.toNotificationView(row),
      unreadCount: await this.unreadCount(householdId, userId),
    };
  }

  async markAllRead(householdId: string, userId: string): Promise<number> {
    const result = await this.prisma.client.notifications.updateMany({
      where: { household_id: householdId, user_id: userId, read_at: null },
      data: { read_at: new Date() },
    });
    return result.count;
  }

  // -------------------------------------------------------------------------------------------
  // Copy and small helpers
  // -------------------------------------------------------------------------------------------

  private async timeZoneFor(householdId: string): Promise<string> {
    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { iana_timezone: true },
    });
    return household?.iana_timezone ?? 'Europe/Belgrade';
  }

  /** `HH:MM` in the Household's zone — the clock the quiet-hours window is expressed in. */
  private async localTime(householdId: string): Promise<string> {
    const timeZone = await this.timeZoneFor(householdId);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
    return parts.slice(0, 5);
  }

  private toRuleView(row: {
    id: string;
    kind: string;
    threshold: unknown;
    channels: string[];
    quiet_hours: unknown;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
  }): AlertRuleView {
    return {
      id: row.id,
      kind: row.kind,
      threshold: (row.threshold ?? {}) as Record<string, unknown>,
      channels: row.channels,
      quietHours: (row.quiet_hours ?? null) as Record<string, unknown> | null,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private toRuleFact(rule: AlertRuleView, preferences: NotificationPreferences): AlertRuleFact {
    return {
      id: rule.id,
      kind: rule.kind as AlertRuleFact['kind'],
      // Both are the *effective* values: a rule states what it wants, the preference states what the
      // user accepts, and intersection is the only combination that cannot over-deliver.
      channels: effectiveChannels(rule.channels as readonly NotificationChannel[], preferences),
      quietHours: effectiveQuietHours(this.toQuietHours(rule.quietHours), preferences),
      isActive: rule.isActive,
    };
  }

  /** A malformed window is treated as **no** window: the alternative mutes every alert silently. */
  private toQuietHours(value: Record<string, unknown> | null): QuietHours | null {
    if (value === null) return null;
    const start = value['start'];
    const end = value['end'];
    const pattern = /^\d{2}:\d{2}$/;
    if (typeof start !== 'string' || typeof end !== 'string') return null;
    if (!pattern.test(start) || !pattern.test(end)) return null;
    return { start, end };
  }

  private toNotificationView(row: {
    id: string;
    insight_id: string | null;
    insights?: { kind: string; severity: string } | null;
    channel: string;
    title: string;
    body: string;
    sent_at: Date | null;
    read_at: Date | null;
    status: string;
    created_at: Date;
  }): NotificationView {
    return {
      id: row.id,
      insightId: row.insight_id,
      insightKind: row.insights?.kind ?? null,
      insightSeverity: row.insights?.severity ?? null,
      channel: row.channel,
      title: row.title,
      body: row.body,
      sentAt: row.sent_at,
      readAt: row.read_at,
      status: row.status as NotificationStatus,
      createdAt: row.created_at,
    };
  }
}
