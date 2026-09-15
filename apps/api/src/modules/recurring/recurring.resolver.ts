import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { CurrentHouseholdId } from '../../common/auth/current-tenant.decorator';
import {
  MaterialiseRecurringInput,
  MaterialiseRecurringResultModel,
  RecurringRuleCreateInput,
  RecurringRuleModel,
  RecurringRuleUpdateInput,
  RecurringSkipModel,
  toOccurrenceModel,
  toPreviewModel,
  toRecurringRuleModel,
} from './recurring.model';
import { RecurringService } from './recurring.service';

/**
 * Recurring rules — F-16, docs/06 §4 (`recurringRules`, `upcomingRecurring`) and §5.8.
 *
 * Every operation takes `@CurrentHouseholdId()`, which fails closed without a `TenantContext`
 * (ADR-008): there is no `householdId` argument, so a client cannot name another Household's rule.
 *
 * `materialiseRecurring` is a mutation in this build because the `recurring.materialise` job (docs/05
 * §8) needs the worker and its scheduler, which do not exist yet. It calls exactly the service method
 * the job will, so wiring the job later changes nothing here — the same shape as `generateInsights` and
 * `runAlerts`, and leaving the path unreachable would make the feature unverifiable before the worker.
 *
 * @module apps/api/src/modules/recurring
 */
@Resolver(() => RecurringRuleModel)
export class RecurringResolver {
  constructor(private readonly recurringService: RecurringService) {}

  @Query(() => [RecurringRuleModel], {
    description:
      'The Household’s standing orders, soonest next occurrence first. `activeOnly` defaults to true; ' +
      'false lists deactivated and deleted ones too, because deactivating keeps the history.',
  })
  async recurringRules(
    @CurrentHouseholdId() householdId: string,
    @Args('activeOnly', { type: () => Boolean, nullable: true, defaultValue: true })
    activeOnly?: boolean | null,
  ): Promise<RecurringRuleModel[]> {
    const rules = await this.recurringService.list(householdId, activeOnly);
    return rules.map(toRecurringRuleModel);
  }

  @Query(() => [RecurringRuleModel], {
    description:
      'The rules with an occurrence inside the next `withinDays` days — docs/02 §4.14’s "next 30 days" ' +
      'line. A rule with nothing in the window is omitted rather than returned empty.',
  })
  async upcomingRecurring(
    @CurrentHouseholdId() householdId: string,
    @Args('withinDays', { type: () => Int, nullable: true, defaultValue: 30 })
    withinDays?: number | null,
  ): Promise<RecurringRuleModel[]> {
    const days = Math.min(Math.max(withinDays ?? 30, 1), 365);
    const [rules, occurrences] = await Promise.all([
      this.recurringService.list(householdId, true),
      this.recurringService.occurrencesBetween(householdId, days),
    ]);

    const inWindow = new Set(occurrences.filter((entry) => entry.dates.length > 0).map((entry) => entry.ruleId));
    return rules.filter((rule) => inWindow.has(rule.id)).map(toRecurringRuleModel);
  }

  @Mutation(() => RecurringRuleModel, {
    description:
      'Create a standing order. The schedule is parsed and canonicalised, and an unsupported part is ' +
      'refused rather than ignored. The currency is the Household ledger currency (ADR-011).',
  })
  async createRecurringRule(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => RecurringRuleCreateInput }) input: RecurringRuleCreateInput,
  ): Promise<RecurringRuleModel> {
    const rule = await this.recurringService.create(householdId, {
      accountId: input.accountId,
      kind: input.kind === 'INCOME' ? 'INCOME' : 'EXPENSE',
      amountMinor: input.amount.amountMinor,
      description: input.description,
      rrule: input.rrule,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      categoryId: input.categoryId ?? null,
      merchantId: input.merchantId ?? null,
      autoConfirm: input.autoConfirm ?? null,
    });
    return toRecurringRuleModel(rule);
  }

  @Mutation(() => RecurringRuleModel, {
    description:
      'Patch a rule. An absent field is left alone; `clearEndsOn`/`clearCategory` unset one. A changed ' +
      'schedule re-anchors `nextOccurrenceOn` from the new start.',
  })
  async updateRecurringRule(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => RecurringRuleUpdateInput }) input: RecurringRuleUpdateInput,
  ): Promise<RecurringRuleModel> {
    const rule = await this.recurringService.update(householdId, {
      ruleId: input.ruleId,
      amountMinor: input.amount?.amountMinor ?? null,
      description: input.description ?? null,
      rrule: input.rrule ?? null,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      clearEndsOn: input.clearEndsOn ?? null,
      categoryId: input.categoryId ?? null,
      clearCategory: input.clearCategory ?? null,
      autoConfirm: input.autoConfirm ?? null,
      isActive: input.isActive ?? null,
    });
    return toRecurringRuleModel(rule);
  }

  @Mutation(() => Boolean, {
    description: 'Soft-delete a rule. The Transactions it posted are kept — they are the ledger.',
  })
  async deleteRecurringRule(
    @CurrentHouseholdId() householdId: string,
    @Args('id', { type: () => String }) id: string,
  ): Promise<boolean> {
    await this.recurringService.remove(householdId, id);
    return true;
  }

  @Mutation(() => MaterialiseRecurringResultModel, {
    description:
      'Post every due occurrence (docs/06 §5.8). Idempotent per (rule, occurrence) through the ' +
      'Transactions’ own idempotency key, so a retry cannot double-post; `dryRun` shows what would be ' +
      'written and writes nothing. A rule without `autoConfirm` posts PENDING rows flagged for review.',
  })
  async materialiseRecurring(
    @CurrentHouseholdId() householdId: string,
    @Args('input', { type: () => MaterialiseRecurringInput }) input: MaterialiseRecurringInput,
  ): Promise<MaterialiseRecurringResultModel> {
    const result = await this.recurringService.materialise(householdId, {
      ruleIds: input.ruleIds ?? null,
      asOf: input.asOf ?? null,
      dryRun: input.dryRun ?? null,
    });

    return {
      created: [...result.created],
      previewed: result.previewed.map(toPreviewModel),
      skipped: result.skipped.map((skip): RecurringSkipModel => ({ ruleId: skip.ruleId, reason: skip.reason })),
      newNextOccurrences: result.newNextOccurrences.map(toOccurrenceModel),
      wasReplayed: result.wasReplayed,
    };
  }
}
