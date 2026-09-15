import { Args, ArgsType, Field, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId, CurrentTenant } from '../../common/auth/current-tenant.decorator';
import type { TenantContext } from '../../common/tenancy/tenant-context';
import { toConnection } from '../../graphql/pagination';
import {
  AlertRuleInput,
  AlertRuleModel,
  AlertRuleUpdateInput,
  AlertRunModel,
  NotificationConnection,
  NotificationModel,
  NotificationPageArgs,
  NotificationReadModel,
  toAlertRuleModel,
  toNotificationModel,
} from './notification.model';
import { NotificationsService } from './notifications.service';

/**
 * Alerts and notifications — docs/06 §3.2, §5.11, §5.14.
 *
 * The Household and the **user** both come from the session: a notification belongs to a person, so
 * the row is scoped by `user_id` as well as `household_id`, and neither is a client argument (ADR-008).
 * In v1 a Household has exactly one Member, so the two coincide today — writing the predicate now is
 * what makes F-29 (sharing) a schema change rather than a security review.
 *
 * `runAlerts` is the dev entry point for the two jobs docs/05 §8 defines but nothing schedules yet
 * (`insights.generate` and `notifications.dispatch`). It calls the same service method the worker will.
 *
 * @module apps/api/src/modules/notifications
 */

@ArgsType()
export class RunAlertsArgs {
  @Field(() => String, {
    nullable: true,
    description: 'The local day to generate and evaluate for. Defaults to today in the Household zone.',
  })
  asOf?: string;
}

@Resolver(() => NotificationModel)
export class NotificationsResolver {
  constructor(private readonly notificationsService: NotificationsService) {}

  // ---- rules --------------------------------------------------------------------------------

  @Query(() => [AlertRuleModel], {
    description: 'The Household alert rules, including the documented defaults once anything has run.',
  })
  async alerts(@CurrentHouseholdId() householdId: string): Promise<AlertRuleModel[]> {
    const rules = await this.notificationsService.alerts(householdId);
    return rules.map(toAlertRuleModel);
  }

  @Mutation(() => AlertRuleModel)
  async createAlertRule(
    @CurrentHouseholdId() householdId: string,
    @Args('input') input: AlertRuleInput,
  ): Promise<AlertRuleModel> {
    const rule = await this.notificationsService.createRule(householdId, {
      kind: input.kind,
      ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
      ...(input.quietHours !== undefined ? { quietHours: input.quietHours } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    });
    return toAlertRuleModel(rule);
  }

  @Mutation(() => AlertRuleModel, {
    nullable: true,
    description: 'Returns null when the id is not this Household\'s rule.',
  })
  async updateAlertRule(
    @CurrentHouseholdId() householdId: string,
    @Args('input') input: AlertRuleUpdateInput,
  ): Promise<AlertRuleModel | null> {
    const rule = await this.notificationsService.updateRule(householdId, {
      id: input.id,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
      ...(input.quietHours !== undefined ? { quietHours: input.quietHours } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    });
    return rule === null ? null : toAlertRuleModel(rule);
  }

  @Mutation(() => Boolean, { description: 'Returns false when the id is not this Household\'s rule.' })
  async deleteAlertRule(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    return this.notificationsService.deleteRule(householdId, id);
  }

  // ---- notifications ------------------------------------------------------------------------

  @Query(() => NotificationConnection, {
    description: 'The notification centre, newest first, keyset-paged on the UUIDv7 id.',
  })
  async notifications(
    @CurrentHouseholdId() householdId: string,
    @CurrentTenant() tenant: TenantContext,
    @Args() args: NotificationPageArgs,
  ): Promise<unknown> {
    const page = await this.notificationsService.list(
      householdId,
      tenant.userId,
      { ...(args.unreadOnly !== undefined ? { unreadOnly: args.unreadOnly } : {}) },
      args.first,
      args.after,
    );
    return toConnection({
      items: page.items.map(toNotificationModel),
      totalCount: page.totalCount,
      hasNextPage: page.hasNextPage,
      endCursor: page.endCursor,
    });
  }

  @Query(() => Int, { description: 'The badge count for the current user.' })
  async unreadNotificationCount(
    @CurrentHouseholdId() householdId: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<number> {
    return this.notificationsService.unreadCount(householdId, tenant.userId);
  }

  @Mutation(() => NotificationReadModel, {
    nullable: true,
    description:
      'Marks one notification read and returns the new unread count, so the badge never needs a ' +
      'second round trip. Null when the row is not this user\'s.',
  })
  async markNotificationRead(
    @CurrentHouseholdId() householdId: string,
    @CurrentTenant() tenant: TenantContext,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<NotificationReadModel | null> {
    const result = await this.notificationsService.markRead(householdId, tenant.userId, id);
    if (result === null) return null;
    return {
      notification: toNotificationModel(result.notification),
      unreadNotificationCount: result.unreadCount,
    };
  }

  @Mutation(() => Int, {
    description: 'Marks every unread notification read. Returns how many rows changed.',
  })
  async markAllNotificationsRead(
    @CurrentHouseholdId() householdId: string,
    @CurrentTenant() tenant: TenantContext,
  ): Promise<number> {
    return this.notificationsService.markAllRead(householdId, tenant.userId);
  }

  // ---- evaluation ---------------------------------------------------------------------------

  @Mutation(() => AlertRunModel, {
    description:
      'Generate the period insights, then evaluate them against the Household rules: dedupe, quiet ' +
      'hours and the daily cap are applied, and deliverable notifications are written. Idempotent — ' +
      'the dedupe key is enforced by UNIQUE (user_id, dedupe_key).',
  })
  async runAlerts(
    @CurrentHouseholdId() householdId: string,
    @CurrentTenant() tenant: TenantContext,
    @Args() args: RunAlertsArgs,
  ): Promise<AlertRunModel> {
    const result = await this.notificationsService.run(householdId, tenant.userId, args.asOf);
    return { ...result };
  }
}
