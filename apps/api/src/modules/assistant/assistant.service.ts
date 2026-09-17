import { Inject, Injectable, Logger } from '@nestjs/common';

import { todayIn, uuidv7, DEFAULT_TIME_ZONE, type CurrencyCode, type LocalDate } from '@finmate/domain';

import { ApiError } from '../../common/filters/all-exceptions.filter';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { CONFIG, type AppConfig } from '../../config/config';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountsService } from '../accounts/accounts.service';
import { GoalsService } from '../goals/goals.service';
import { RecurringService } from '../recurring/recurring.service';
import { CategoriesService } from '../taxonomy/categories.service';
import { MerchantsService } from '../taxonomy/merchants.service';
import { TagsService } from '../taxonomy/tags.service';
import { NARRATOR, type AssistantNarrator } from './assistant-narrator';
import { SUGGESTED_QUESTIONS, type AssistantIntent } from './assistant-intents';
import { FactAssemblyService, type AssistantFactsView, type ProvenanceView } from './fact-assembly.service';
import { renderRefusal, renderTemplateAnswer, type TemplateAnswerInput } from './narration-template';
import { validateNarration, type NumericPayload } from './numeric-validator';
import { planQuestion, type PlannerContext, type Plan } from './query-planner';

/**
 * The assistant — docs/06 §8, docs/04 §10, ADR-017.
 *
 * > **The backend computes. The LLM narrates.**
 *
 * This service is the pipeline that keeps that promise true in code rather than in prose:
 *
 * ```text
 * question → planner → fact assembly → [narrator] → numeric validator → answer
 *                                          │                │
 *                                          └── one stricter retry, then the template rendering
 * ```
 *
 * ## Three properties, each enforced rather than documented
 *
 * 1. **No figure without facts.** A refusal never reaches the narrator: `NO_TEMPLATE_MATCH` and an
 *    unavailable template both return `answered: false` with the assembled (empty) payload, so there
 *    is nothing for a model to narrate even if somebody later changed the order by mistake.
 * 2. **No figure outside the payload.** Every narration passes {@link validateNarration}; a rejection
 *    regenerates **once** with the stricter prompt and then falls back to a deterministic rendering
 *    that cannot invent anything (docs/06 §8.5).
 * 3. **No unguarded cost.** The provider call consumes docs/06 §11.2's `AI_NARRATE` budget
 *    (30/min, 500/day per household) — but only when a provider is actually reachable. A template
 *    answer costs nothing, so it is not rationed; see {@link AssistantNarrator.available}.
 *
 * @module apps/api/src/modules/assistant
 */

export type NarrationMode = 'LLM' | 'TEMPLATE_FALLBACK';

/** docs/06 §4.4's `DrillThrough`: where the user can check the answer for themselves. */
export interface DrillThroughView {
  readonly route: string;
  readonly transactionIds: readonly string[];
  /**
   * The same argument names the `transactions` query takes, so the client maps it one-to-one.
   *
   * It is a JSON bag rather than a GraphQL input type because the query's own arguments are flat and
   * named exactly these — a `TransactionFilterInput` that only this field uses would be a second
   * vocabulary for one shape (docs/06 §4.4 records the correction).
   */
  readonly filter: Readonly<Record<string, string>>;
}

export interface AssistantAnswerView {
  readonly id: string;
  readonly question: string;
  readonly intent: AssistantIntent;
  readonly answered: boolean;
  readonly answerText: string;
  readonly facts: AssistantFactsView;
  readonly provenance: ProvenanceView;
  readonly drillThrough: DrillThroughView | null;
  readonly suggestions: readonly string[];
  readonly narrationMode: NarrationMode;
  readonly latencyMs: number;
  readonly costMicros: string | null;
  /** Why the answer is a refusal or a fallback. Audit and UI hint, never an error message. */
  readonly reason: string | null;
}

/** docs/06 §11.2's `AI_NARRATE` class: the one place a user can trigger unbounded LLM cost. */
export const NARRATE_PER_MINUTE = 30;
export const NARRATE_PER_DAY = 500;

/** The rows the planner matches a question's names against. The maximum the page helpers allow. */
const PLANNER_PAGE_SIZE = 200;

/**
 * A drill-through route per intent, or `null` when no route can reproduce the answer's scope.
 *
 * `null` is a decision, not an omission: **a link that cannot reproduce the scope must not be
 * offered.** `transactions(...)` takes `categoryId`, `accountId`, `kind`, `from`, `to` and
 * `needsReview` — not `merchantId` or `tagId` — so a "Lidl" answer has no filtered list to link to
 * today, and linking to an unfiltered one would show the user figures the answer did not come from.
 * Adding those two arguments is a ledger change (docs/06 §4.1); until then the merchant- and
 * tag-scoped templates return no link at all.
 */
interface DrillRoute {
  readonly route: string;
  readonly kind?: 'EXPENSE' | 'INCOME';
  /** Whether the plan's period belongs in the filter. A balance or a budget has no range to pass. */
  readonly period: 'plan' | 'none';
  readonly needsReview?: boolean;
}

const DRILL_ROUTES: Readonly<Record<AssistantIntent, DrillRoute | null>> = {
  SPEND_TOTAL: { route: '/transactions', kind: 'EXPENSE', period: 'plan' },
  SPEND_BY_CATEGORY: { route: '/transactions', kind: 'EXPENSE', period: 'plan' },
  SPEND_BY_MERCHANT: null,
  SPEND_BY_ACCOUNT: { route: '/transactions', kind: 'EXPENSE', period: 'plan' },
  SPEND_BY_TAG: null,
  TOP_CATEGORIES: { route: '/transactions', kind: 'EXPENSE', period: 'plan' },
  TOP_MERCHANTS: null,
  LARGEST_TRANSACTIONS: { route: '/transactions', period: 'plan' },
  AVERAGE_DAILY_SPEND: { route: '/transactions', kind: 'EXPENSE', period: 'plan' },
  TRANSACTION_COUNT: { route: '/transactions', period: 'plan' },
  TRANSACTION_LIST: { route: '/transactions', period: 'plan' },
  UNCATEGORISED_REVIEW: { route: '/review', period: 'none', needsReview: true },
  INCOME_TOTAL: { route: '/transactions', kind: 'INCOME', period: 'plan' },
  NET_CASHFLOW: { route: '/transactions', period: 'plan' },
  ACCOUNT_BALANCE: { route: '/accounts', period: 'none' },
  ACCOUNT_BALANCE_ALL: { route: '/accounts', period: 'none' },
  BUDGET_STATUS: { route: '/budgets', period: 'none' },
  BUDGET_LIST: { route: '/budgets', period: 'none' },
  SAFE_TO_SPEND: { route: '/budgets', period: 'none' },
  MONTH_PROJECTION: { route: '/budgets', period: 'none' },
  BUDGET_PACE_VS_PLAN: { route: '/budgets', period: 'none' },
  TREND_VS_LAST_MONTH: { route: '/transactions', kind: 'EXPENSE', period: 'plan' },
  COMPARE_PERIODS: null,
  TREND_VS_AVERAGE: { route: '/transactions', kind: 'EXPENSE', period: 'plan' },
  GOAL_PROGRESS: { route: '/goals', period: 'none' },
  GOAL_REQUIRED_MONTHLY: { route: '/goals', period: 'none' },
  SAVINGS_PROPOSAL: null,
  // The `/recurring` screen shows these rules and its own next-30-days line, which is the same window
  // the assembly uses — so the figure is checkable there.
  RECURRING_UPCOMING: { route: '/recurring', period: 'none' },
  RECURRING_LIST: { route: '/recurring', period: 'none' },
  NO_TEMPLATE_MATCH: null,
};

@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly facts: FactAssemblyService,
    private readonly categories: CategoriesService,
    private readonly merchants: MerchantsService,
    private readonly accounts: AccountsService,
    private readonly tags: TagsService,
    // A goal and a recurring rule are matched by **name**, which is the only way a question can refer to
    // one; the figures come from the same services the `/goals` and `/recurring` screens read.
    private readonly goals: GoalsService,
    private readonly recurring: RecurringService,
    // `AuthModule` is `@Global()` and exports this for exactly this reason ("AI quota in Phase 2"), so
    // the assistant needs no import edge to reach it.
    private readonly rateLimit: RateLimitService,
    @Inject(NARRATOR) private readonly narrator: AssistantNarrator,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Answer one question for one Household. The Household comes from the session, never the input. */
  async answer(
    householdId: string,
    // `null` as well as `undefined`: a nullable GraphQL argument arrives as an explicit `null`, and
    // `undefined`-only handling threw an INTERNAL for every question asked without a locale — found
    // live, because the tests passed the field as absent.
    request: { readonly question: string; readonly locale?: string | null },
  ): Promise<AssistantAnswerView> {
    const startedAt = Date.now();
    const question = request.question.trim();
    if (question.length === 0) {
      throw new ApiError('VALIDATION_FAILED', 'A question is required.');
    }

    const household = await this.prisma.client.households.findFirst({
      where: { id: householdId },
      select: { iana_timezone: true, ledger_currency: true },
    });
    if (household === null) throw new ApiError('NOT_FOUND', 'Household not found.');

    const locale = this.resolveLocale(request.locale);
    const today = todayIn(household.iana_timezone || DEFAULT_TIME_ZONE);
    const plan = planQuestion(
      question,
      // The currency is what lets the planner read a savings target out of the question the same way
      // the capture path reads an amount (ADR-003): `20.000` is twenty thousand RSD, not 20.
      await this.plannerContext(householdId, today, household.ledger_currency as CurrencyCode),
    );
    const assembled = await this.facts.assemble(householdId, plan, { today });

    // A refusal is decided **before** the narrator is reached: docs/06 §8.5 forbids a figure for a
    // question the ledger cannot answer, and the way to guarantee that is to have none to narrate.
    if (plan.intent === 'NO_TEMPLATE_MATCH' || !assembled.available) {
      const reason = plan.intent === 'NO_TEMPLATE_MATCH' ? 'NO_TEMPLATE_MATCH' : (assembled.reason ?? 'UNAVAILABLE');
      return {
        id: uuidv7(),
        question,
        intent: plan.intent,
        answered: false,
        answerText: renderRefusal(reason),
        facts: assembled.facts,
        provenance: assembled.provenance,
        drillThrough: null,
        suggestions: SUGGESTED_QUESTIONS.map((suggestion) => suggestion.question),
        narrationMode: 'TEMPLATE_FALLBACK',
        latencyMs: Date.now() - startedAt,
        costMicros: null,
        reason,
      };
    }

    const payload: NumericPayload = { ...assembled.facts, ...assembled.provenance };
    const narration = await this.narrate(householdId, {
      question,
      facts: factStrings(assembled.facts),
      locale,
      payload,
      templateInput: {
        intent: plan.intent,
        template: plan.template,
        facts: assembled.facts,
        provenance: assembled.provenance,
      },
    });

    return {
      id: uuidv7(),
      question,
      intent: plan.intent,
      answered: true,
      answerText: narration.text,
      facts: assembled.facts,
      provenance: assembled.provenance,
      drillThrough: drillThroughFor(plan, assembled.provenance, assembled.transactionIds),
      suggestions: [],
      narrationMode: narration.mode,
      latencyMs: Date.now() - startedAt,
      costMicros: narration.costMicros,
      reason: narration.reason,
    };
  }

  /**
   * Narrate, or render deterministically — docs/06 §8.5's enforcement path, steps 3 to 5.
   *
   * The retry is **one** regeneration, as specified: a model that invents a figure twice is not going
   * to be talked out of it, and every additional attempt is paid for by the household. A *transport*
   * failure does not even get that one retry — the same payload to the same unreachable endpoint is
   * noise — so the loop breaks and the template renders.
   */
  private async narrate(
    householdId: string,
    request: {
      readonly question: string;
      readonly facts: readonly string[];
      readonly locale: string;
      readonly payload: NumericPayload;
      readonly templateInput: TemplateAnswerInput;
    },
  ): Promise<{ text: string; mode: NarrationMode; costMicros: string | null; reason: string | null }> {
    if (!this.narrator.available) {
      return {
        text: renderTemplateAnswer(request.templateInput),
        mode: 'TEMPLATE_FALLBACK',
        costMicros: null,
        reason: 'AI_UNAVAILABLE:no-provider-configured',
      };
    }

    await this.consumeNarrationBudget(householdId);

    let cost = 0n;
    let reason: string | null = null;

    for (const strict of [false, true]) {
      const outcome = await this.narrator.narrate({
        question: request.question,
        facts: request.facts,
        locale: request.locale,
        strict,
      });

      if (!outcome.ok) {
        reason = outcome.reason;
        break;
      }

      cost += BigInt(outcome.costMicros || '0');
      const validation = validateNarration(outcome.text, request.payload, request.locale);
      if (validation.ok) {
        return { text: outcome.text, mode: 'LLM', costMicros: cost.toString(), reason: null };
      }

      reason = `UNACCOUNTED_NUMERALS:${validation.unaccounted.join(',')}`;
      this.logger.warn(
        `narration rejected for ${householdId}: ${validation.unaccounted.length} unaccounted numeral(s)`,
      );
    }

    return {
      text: renderTemplateAnswer(request.templateInput),
      mode: 'TEMPLATE_FALLBACK',
      costMicros: cost.toString(),
      reason,
    };
  }

  /** docs/06 §11.2: 30/min and 500/day per household, consumed only when a call will be made. */
  private async consumeNarrationBudget(householdId: string): Promise<void> {
    for (const [scope, limit, windowSeconds] of [
      ['assistant:narrate:minute', NARRATE_PER_MINUTE, 60],
      ['assistant:narrate:day', NARRATE_PER_DAY, 86_400],
    ] as const) {
      const verdict = await this.rateLimit.consume(scope, householdId, limit, windowSeconds);
      if (!verdict.allowed) {
        throw new ApiError(
          'RATE_LIMITED',
          'Too many assistant questions. Please try again later.',
          true,
        );
      }
    }
  }

  /**
   * The Household's own vocabulary, which is what the planner matches against (docs/06 §8.1).
   *
   * Every list is capped at {@link PLANNER_PAGE_SIZE}, the largest page the GraphQL helpers allow: a
   * Household with more than that many Merchants would have some of them unmatchable. The cap is
   * recorded as a known limitation rather than hidden, because the alternative — a second, unbounded
   * read path — is a decision about the taxonomy module, not about the planner.
   */
  private async plannerContext(
    householdId: string,
    today: LocalDate,
    currency: CurrencyCode,
  ): Promise<PlannerContext> {
    const [categories, merchants, accounts, tags, goals, recurringRules] = await Promise.all([
      this.categories.list(householdId),
      this.merchants.list(householdId, {}, { first: PLANNER_PAGE_SIZE }),
      this.accounts.list({ householdId, first: PLANNER_PAGE_SIZE }),
      this.tags.list(householdId),
      // Both are unbounded by nature — a Household has a handful of goals and subscriptions — and a
      // goal or rule is matched by **name**, which is the only way a question can refer to one.
      this.goals.list(householdId),
      // `activeOnly: false`: a paused rule is still something the Household has, and hiding it would
      // make "koje pretplate imam" answer a shorter list than the `/recurring` screen shows.
      this.recurring.list(householdId, false),
    ]);

    return {
      today,
      currency,
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        path: category.path.join(' / '),
        owned: true,
      })),
      // `merchants` is the one list with shared rows in it (docs/08's global allow-list), and the
      // Household's own copy of a seeded name is the row its Transactions point at.
      merchants: merchants.items.map((merchant) => ({
        id: merchant.id,
        name: merchant.name,
        owned: !merchant.isGlobal,
      })),
      accounts: accounts.items.map((account) => ({ id: account.id, name: account.name, owned: true })),
      tags: tags.map((tag) => ({ id: tag.id, name: tag.name, owned: true })),
      goals: goals.map((goal) => ({ id: goal.id, name: goal.name, owned: true })),
      recurringRules: recurringRules.map((rule) => ({
        id: rule.id,
        name: rule.description,
        owned: true,
      })),
    };
  }

  /**
   * The locale is client input that reaches a prompt, so it is validated rather than trusted.
   *
   * `Intl` would happily accept a *string* that is not a locale tag at all — and that string would be
   * rendered into the system prompt, which is a prompt-injection door with a friendly name. A tag that
   * does not look like one is refused, not sanitised: silently answering in a different language than
   * the one asked for is its own small lie.
   *
   * The grammar is **letters and hyphens only**, which also keeps `narrate-prompt.ts`'s "the prompt
   * contains no numeral" property true — `es-419` is the deliberate cost, and no locale this product
   * offers has a digit in it.
   */
  private resolveLocale(locale: string | null | undefined): string {
    if (locale === undefined || locale === null || locale.length === 0) return this.config.APP_DEFAULT_LOCALE;
    if (locale.length > 35 || !/^[a-z]{2,3}(?:-[A-Za-z]{2,8})*$/.test(locale)) {
      throw new ApiError('VALIDATION_FAILED', 'Unsupported locale.');
    }
    return locale;
  }
}

/**
 * The strings handed to the narrator — docs/06 §8.2's "pre-formatted strings, not raw numbers".
 *
 * Every figure here already carries its currency and grouping, and the machine values (`rows[].value`,
 * `totals[].money.amountMinor`) are deliberately **not** included: the model is not given raw floats or
 * minor units to reformat (docs/04 §10).
 */
export function factStrings(facts: AssistantFactsView): readonly string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(facts.formatted)) {
    if (value.length > 0) lines.push(`${key}: ${value}`);
  }
  for (const row of facts.rows) lines.push(`${row.label}: ${row.formatted}`);
  for (const total of facts.totals) lines.push(`${total.label}: ${total.formatted}`);
  return lines;
}

/** Build the drill-through, or nothing when no route can reproduce the answer's scope. */
export function drillThroughFor(
  plan: Plan,
  provenance: ProvenanceView,
  transactionIds: readonly string[],
): DrillThroughView | null {
  const route = DRILL_ROUTES[plan.intent];
  if (route === null) return null;

  const filter: Record<string, string> = {};
  if (route.period === 'plan') {
    filter['from'] = provenance.periodStart;
    filter['to'] = provenance.periodEnd;
  }
  if (route.kind !== undefined) filter['kind'] = route.kind;
  if (plan.slots.categoryId !== undefined) filter['categoryId'] = plan.slots.categoryId;
  if (plan.slots.accountId !== undefined) filter['accountId'] = plan.slots.accountId;
  if (route.needsReview === true) filter['needsReview'] = 'true';

  return { route: route.route, transactionIds, filter };
}
