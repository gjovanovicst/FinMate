import { Injectable } from '@nestjs/common';

import {
  alertKindForInsight,
  evaluateAlerts,
  money,
  toMajorString,
  uuidv7,
  type AlertCandidate,
  type AlertDecision,
  type AlertRuleFact,
  type CurrencyCode,
  type NotificationChannel,
  type NotificationStatus,
  type QuietHours,
} from '@finmate/domain';

import { Prisma } from '../../generated/prisma/client';
import type { CursorPage } from '../../graphql/pagination';
import { normalisePageSize } from '../../graphql/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { InsightsService } from '../insights/insights.service';

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
  readonly channel: string;
  readonly title: string;
  readonly body: string;
  readonly sentAt: Date | null;
  readonly readAt: Date | null;
  readonly status: string;
  readonly createdAt: Date;
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
 * `RECURRING_DUE`/`GOAL_REACHED` are absent because nothing produces them yet.
 */
export const DEFAULT_ALERT_RULES: readonly AlertRuleInputShape[] = [
  { kind: 'PACE_OVERRUN', threshold: {}, channels: ['IN_APP'], isActive: true },
  { kind: 'UNUSUAL_SPEND', threshold: {}, channels: ['IN_APP'], isActive: true },
];

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly insights: InsightsService,
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
   * Both halves in one method on purpose. docs/05 §8 has two jobs (`insights.generate` daily at 06:00
   * and `notifications.dispatch` every minute), and neither is scheduled yet; until they are, this is
   * the single entry point a resolver — or the future worker — calls, and the order is the pipeline's.
   */
  async run(householdId: string, userId: string, asOf?: string): Promise<AlertRunResult> {
    const generated = await this.insights.generate(householdId, asOf);
    await this.ensureDefaultRules(householdId);

    const [insights, rules, notifications, localTime] = await Promise.all([
      this.insights.list(householdId, { includeDismissed: true }, 200),
      this.alerts(householdId),
      this.prisma.client.notifications.findMany({
        where: { user_id: userId },
        select: { dedupe_key: true, created_at: true },
      }),
      this.localTime(householdId),
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
      rules: rules.map((rule) => this.toRuleFact(rule)),
      localTime,
      sentDedupeKeys: new Set(notifications.map((row) => row.dedupe_key)),
      sentInLastDay: notifications.filter((row) => row.created_at >= dayAgo).length,
      // Preferences have no store yet (docs/06 §5.14); positive feedback is on by default, which is
      // F-22's stated intent.
      positiveFeedback: true,
    });

    let created = 0;
    for (const decision of decisions) {
      if (decision.status !== 'SENT' && decision.status !== 'QUEUED') continue;
      const insight = insightById.get(decision.insightId);
      const dedupeKey = dedupeKeyByInsight.get(decision.insightId);
      if (insight === undefined || dedupeKey === undefined) continue;
      const copy = this.compose(decision, insight);
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
      this.prisma.client.notifications.findMany({ where, orderBy: { id: 'desc' }, take: take + 1 }),
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

  /**
   * Compose the notification text from the insight's payload.
   *
   * Every numeral comes from the payload the generators wrote (ADR-001) — this function formats and
   * never computes. English only, see the module docs.
   */
  compose(
    decision: AlertDecision,
    insight: { readonly kind: string; readonly payload: Record<string, unknown> },
  ): { title: string; body: string } {
    const payload = insight.payload;
    const currency = typeof payload['currency'] === 'string' ? payload['currency'] : 'RSD';
    const amount = (key: string): string => {
      const raw = payload[key];
      if (typeof raw !== 'string') return '—';
      return toMajorString(money(BigInt(raw), currency as CurrencyCode));
    };
    const subject = typeof payload['categoryPath'] === 'string' ? payload['categoryPath'] : null;

    switch (insight.kind) {
      case 'BUDGET_PACE':
        return {
          title: subject === null ? 'Budget overrun ahead' : `Budget overrun ahead: ${subject}`,
          body:
            `Projected ${amount('projectedTotalMinor')} against a ${amount('limitMinor')} limit — ` +
            `${amount('projectedOverrunMinor')} over.`,
        };
      case 'CATEGORY_SPIKE':
        return {
          title: `Spending spike: ${subject ?? 'a category'}`,
          body:
            `${amount('currentMinor')} so far, against a usual ${amount('baselineMeanMinor')} ` +
            `(${String(payload['multiple'] ?? '—')}×).`,
        };
      case 'UNUSUAL_SPEND':
        return {
          title: `Unusual amount: ${subject ?? 'a category'}`,
          body:
            `${amount('amountMinor')} is ${String(payload['multiple'] ?? '—')}× the usual ` +
            `${amount('medianMinor')} here.`,
        };
      case 'POSITIVE_TREND':
        return {
          title: `Good news: ${subject ?? 'a category'}`,
          body: `${amount('savedMinor')} less than usual this month.`,
        };
      default:
        // A kind added to the vocabulary but not to this switch must still produce a usable row.
        return {
          title: `Insight: ${insight.kind}`,
          body: `${decision.alertKind} — ${amount('currentMinor')}`,
        };
    }
  }

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

  private toRuleFact(rule: AlertRuleView): AlertRuleFact {
    return {
      id: rule.id,
      kind: rule.kind as AlertRuleFact['kind'],
      channels: rule.channels as readonly NotificationChannel[],
      quietHours: this.toQuietHours(rule.quietHours),
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
