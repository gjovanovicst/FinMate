import { ArgsType, Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';

import { Paginated } from '../../graphql/pagination';
import { JsonScalar } from '../../graphql/scalars/json.scalar';
import { InsightModel } from '../insights/insight.model';
import type { AlertRuleView, NotificationView } from './notifications.service';

/**
 * Alerts and notifications — docs/06 §3.2 (`AlertRule`, `Notification`), §5.11, §5.14.
 *
 * Deviations from the SDL, recorded in docs/06 §5.14:
 *
 * - **`AlertRule.version` is absent.** The SDL declares it and `AlertRuleUpdateInput` takes it, but
 *   neither docs/03 §4's DDL nor the migrated table has the column. Optimistic concurrency on a
 *   settings list nobody edits concurrently is not worth inventing a migration for.
 * - **`dismissInsight`-style unions are not declared here.** `markNotificationRead` returns the
 *   notification plus the new unread count directly; a missing row is not a case the UI distinguishes.
 * - **`updateNotificationPreferences` is not built.** It needs a preferences store that no table
 *   provides (`NotificationPreferencesInput` is not in docs/03 §4), and the settings screen is 3.1.4.
 */

export enum NotificationChannelEnum {
  IN_APP = 'IN_APP',
  EMAIL = 'EMAIL',
  PUSH = 'PUSH',
  WEB_PUSH = 'WEB_PUSH',
}

registerEnumType(NotificationChannelEnum, {
  name: 'NotificationChannel',
  description:
    'docs/03 §4\'s CHECK constraint. Only `IN_APP` is delivered in this build — the fan-out is 3.1.3 — ' +
    'but a rule may name the others and the evaluator already decides per channel.',
});

export enum NotificationStatusEnum {
  QUEUED = 'QUEUED',
  SENT = 'SENT',
  FAILED = 'FAILED',
  SUPPRESSED = 'SUPPRESSED',
}

registerEnumType(NotificationStatusEnum, {
  name: 'NotificationStatus',
  description:
    '`QUEUED` is what quiet hours produce: delayed by docs/05 §8\'s dispatch job, never dropped.',
});

@ObjectType()
export class AlertRuleModel {
  @Field(() => ID)
  id!: string;

  @Field(() => String, {
    description:
      'BUDGET_THRESHOLD · PACE_OVERRUN · RECURRING_DUE · UNUSUAL_SPEND · GOAL_REACHED. An open ' +
      'string: the column is `TEXT` and a new kind must not need a schema change.',
  })
  kind!: string;

  @Field(() => JsonScalar)
  threshold!: Record<string, unknown>;

  @Field(() => [NotificationChannelEnum])
  channels!: NotificationChannelEnum[];

  @Field(() => JsonScalar, { nullable: true })
  quietHours!: Record<string, unknown> | null;

  @Field(() => Boolean)
  isActive!: boolean;

  @Field(() => Date)
  createdAt!: Date;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType()
export class NotificationModel {
  @Field(() => ID)
  id!: string;

  @Field(() => ID, { nullable: true })
  insightId!: string | null;

  @Field(() => InsightModel, { nullable: true })
  insight!: InsightModel | null;

  @Field(() => NotificationChannelEnum)
  channel!: NotificationChannelEnum;

  @Field(() => String)
  title!: string;

  @Field(() => String)
  body!: string;

  @Field(() => Date, { nullable: true })
  sentAt!: Date | null;

  @Field(() => Date, { nullable: true })
  readAt!: Date | null;

  @Field(() => NotificationStatusEnum)
  status!: NotificationStatusEnum;

  @Field(() => Date)
  createdAt!: Date;
}

@ObjectType()
export class NotificationConnection extends Paginated(NotificationModel) {}

@InputType()
export class AlertRuleInput {
  @Field(() => String)
  kind!: string;

  @Field(() => JsonScalar, {
    nullable: true,
    description: 'Kind-specific thresholds. `{}` means "the documented defaults".',
  })
  threshold?: Record<string, unknown>;

  @Field(() => [NotificationChannelEnum], { nullable: true })
  channels?: NotificationChannelEnum[];

  @Field(() => JsonScalar, {
    nullable: true,
    description: '`{ "start": "21:00", "end": "08:00" }` in the Household timezone; `null` = none.',
  })
  quietHours?: Record<string, unknown> | null;

  @Field(() => Boolean, { nullable: true, defaultValue: true })
  isActive?: boolean;
}

@InputType()
export class AlertRuleUpdateInput {
  @Field(() => ID)
  id!: string;

  @Field(() => String, { nullable: true })
  kind?: string;

  @Field(() => JsonScalar, { nullable: true })
  threshold?: Record<string, unknown>;

  @Field(() => [NotificationChannelEnum], { nullable: true })
  channels?: NotificationChannelEnum[];

  @Field(() => JsonScalar, { nullable: true })
  quietHours?: Record<string, unknown> | null;

  @Field(() => Boolean, { nullable: true })
  isActive?: boolean;
}

/** What one dispatch pass did — the number the "why has nothing arrived?" question needs. */
@ObjectType()
export class AlertDispatchModel {
  @Field(() => Int, { description: 'Queued rows this pass looked at.' })
  considered!: number;

  @Field(() => Int)
  sent!: number;

  @Field(() => Int)
  failed!: number;

  @Field(() => Int, { description: "Held: quiet hours are on right now, so it waits." })
  deferred!: number;

  @Field(() => Int, {
    description: 'Push channels this build cannot deliver yet; the rows stay QUEUED.',
  })
  skipped!: number;
}

@ObjectType()
export class NotificationPreferencesModel {
  @Field(() => [NotificationChannelEnum], {
    description: 'Channels the user accepts at all. A rule may name others; they are not delivered.',
  })
  channels!: NotificationChannelEnum[];

  @Field(() => JsonScalar, {
    nullable: true,
    description: 'Applied to a rule that has none of its own. `null` disables quiet hours.',
  })
  quietHours!: Record<string, unknown> | null;

  @Field(() => Boolean)
  positiveFeedback!: boolean;

  @Field(() => String, {
    nullable: true,
    description: 'Recorded now, honoured when server-side copy is localised (docs/06 §5.14).',
  })
  locale!: string | null;
}

@InputType()
export class NotificationPreferencesInput {
  @Field(() => [NotificationChannelEnum], { nullable: true })
  channels?: NotificationChannelEnum[];

  @Field(() => JsonScalar, { nullable: true })
  quietHours?: Record<string, unknown> | null;

  @Field(() => Boolean, { nullable: true })
  positiveFeedback?: boolean;

  @Field(() => String, { nullable: true })
  locale?: string | null;
}

@ArgsType()
export class NotificationPageArgs {
  @Field(() => Boolean, { nullable: true, defaultValue: false })
  unreadOnly?: boolean;

  @Field(() => Int, { nullable: true })
  first?: number;

  @Field(() => String, { nullable: true, description: 'Cursor from a previous page.' })
  after?: string;
}

/** What one evaluation run did, per outcome — the count the UI's "why did I not get told?" needs. */
@ObjectType()
export class AlertRunModel {
  @Field(() => Int, { description: 'Insights the generators wrote in this run.' })
  insightsCreated!: number;

  @Field(() => Int, { description: 'Notification rows written (delivered or queued).' })
  notificationsCreated!: number;

  @Field(() => Int, { description: 'Conditions already sent — the dedupe key did its job.' })
  duplicates!: number;

  @Field(() => Int, { description: 'Held back by the daily cap.' })
  rateLimited!: number;

  @Field(() => Int, { description: 'Deferred to the end of quiet hours — queued, not dropped.' })
  queued!: number;

  @Field(() => Int, { description: 'Nothing configured for the condition, or the user opted out.' })
  suppressed!: number;
}

/** `markNotificationRead`'s answer: the row, plus the badge the shell needs next. */
@ObjectType()
export class NotificationReadModel {
  @Field(() => NotificationModel)
  notification!: NotificationModel;

  @Field(() => Int)
  unreadNotificationCount!: number;
}

export function toAlertRuleModel(view: AlertRuleView): AlertRuleModel {
  return {
    id: view.id,
    kind: view.kind,
    threshold: view.threshold,
    channels: view.channels as NotificationChannelEnum[],
    quietHours: view.quietHours,
    isActive: view.isActive,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

export function toNotificationModel(view: NotificationView): NotificationModel {
  return {
    id: view.id,
    insightId: view.insightId,
    // Not resolved here: the notification list is read far more often than the insight is needed, and
    // a join per row is the kind of cost that shows up as a slow badge. The client links by id.
    insight: null,
    channel: view.channel as NotificationChannelEnum,
    title: view.title,
    body: view.body,
    sentAt: view.sentAt,
    readAt: view.readAt,
    status: view.status as NotificationStatusEnum,
    createdAt: view.createdAt,
  };
}
