/**
 * The assistant's closed intent set and its template registry — docs/06 §8.1, ADR-017.
 *
 * ## Why this is a `Record` and not a lookup with a default
 *
 * ADR-017's whole safety argument is that the planner **selects a template** and never emits SQL:
 *
 * > The model reproduces numbers verbatim and is forbidden from introducing new ones. […] There is no
 * > generic "run this query" escape hatch, deliberately.
 *
 * A registry typed `Record<AssistantIntent, IntentTemplate>` makes "every intent has exactly one
 * template, and every template names a repository method" a **compile-time** property. There is no
 * `default:` arm to fall into, so an intent added to the enum without a template fails `tsc` rather
 * than reaching production as a query nobody wrote.
 *
 * @module apps/api/src/modules/assistant
 */

/** docs/06 §8.1's `AssistantIntent`, verbatim and in the same order. */
export const ASSISTANT_INTENTS = [
  // spending
  'SPEND_TOTAL',
  'SPEND_BY_CATEGORY',
  'SPEND_BY_MERCHANT',
  'SPEND_BY_ACCOUNT',
  'SPEND_BY_TAG',
  'TOP_CATEGORIES',
  'TOP_MERCHANTS',
  'LARGEST_TRANSACTIONS',
  'AVERAGE_DAILY_SPEND',
  'TRANSACTION_COUNT',
  'TRANSACTION_LIST',
  'UNCATEGORISED_REVIEW',
  // income & flow
  'INCOME_TOTAL',
  'NET_CASHFLOW',
  'ACCOUNT_BALANCE',
  'ACCOUNT_BALANCE_ALL',
  // budgets & pace
  'BUDGET_STATUS',
  'BUDGET_LIST',
  'SAFE_TO_SPEND',
  'MONTH_PROJECTION',
  'BUDGET_PACE_VS_PLAN',
  // comparison & trend
  'TREND_VS_LAST_MONTH',
  'COMPARE_PERIODS',
  'TREND_VS_AVERAGE',
  // goals & recurring
  'GOAL_PROGRESS',
  'GOAL_REQUIRED_MONTHLY',
  'SAVINGS_PROPOSAL',
  'RECURRING_UPCOMING',
  'RECURRING_LIST',
  // explicit refusal
  'NO_TEMPLATE_MATCH',
] as const;

export type AssistantIntent = (typeof ASSISTANT_INTENTS)[number];

/**
 * The slots a template can require. A slot is a **scalar or an id**, never a fragment of a query: the
 * repository method takes it as a parameter, which is what keeps the planner out of SQL entirely.
 */
export type SlotName =
  | 'period'
  | 'categoryId'
  | 'merchantId'
  | 'accountId'
  | 'tagId'
  | 'goalId'
  | 'recurringRuleId'
  | 'limit';

export interface IntentTemplate {
  /** The repository method this template calls, e.g. `spend.byCategory.v1` (docs/06 §8.3). */
  readonly sourceQuery: string;
  /** Slots the planner must resolve before the repository method may run. */
  readonly requiredSlots: readonly SlotName[];
  /** Slots the template accepts but does not need (a period default fills `period`). */
  readonly optionalSlots: readonly SlotName[];
  /**
   * What the template aggregates.
   *
   * `BOTH` is not a licence to mix directions: `NET_CASHFLOW` needs both kinds and computes them
   * **separately**, and the fact rows say which is which. Every other template is one-directional, so
   * an income question can never be answered by an expense aggregate.
   */
  readonly kind: 'EXPENSE' | 'INCOME' | 'BOTH' | 'NONE';
  /** How the answer reads, and therefore how the narrator is prompted. */
  readonly shape: 'TOTAL' | 'ROWS' | 'LIST' | 'STATE' | 'REFUSAL';
}

/**
 * **The registry.** One entry per intent, every one naming a parameterised, household-scoped repository
 * method (docs/06 §8.1). Adding an intent is a schema change *and* a repository method — the type
 * system enforces the second half.
 */
export const INTENT_TEMPLATES: Readonly<Record<AssistantIntent, IntentTemplate>> = {
  SPEND_TOTAL: {
    sourceQuery: 'spend.total.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'accountId', 'tagId'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  SPEND_BY_CATEGORY: {
    sourceQuery: 'spend.byCategory.v1',
    requiredSlots: ['categoryId'],
    optionalSlots: ['period'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  SPEND_BY_MERCHANT: {
    sourceQuery: 'spend.byMerchant.v1',
    requiredSlots: ['merchantId'],
    optionalSlots: ['period'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  SPEND_BY_ACCOUNT: {
    sourceQuery: 'spend.byAccount.v1',
    requiredSlots: ['accountId'],
    optionalSlots: ['period'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  SPEND_BY_TAG: {
    sourceQuery: 'spend.byTag.v1',
    requiredSlots: ['tagId'],
    optionalSlots: ['period'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  TOP_CATEGORIES: {
    sourceQuery: 'spend.topCategories.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'limit'],
    kind: 'EXPENSE',
    shape: 'ROWS',
  },
  TOP_MERCHANTS: {
    sourceQuery: 'spend.topMerchants.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'limit'],
    kind: 'EXPENSE',
    shape: 'ROWS',
  },
  LARGEST_TRANSACTIONS: {
    sourceQuery: 'transactions.largest.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'limit', 'categoryId', 'merchantId'],
    kind: 'EXPENSE',
    shape: 'LIST',
  },
  AVERAGE_DAILY_SPEND: {
    sourceQuery: 'spend.averageDaily.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'categoryId'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  TRANSACTION_COUNT: {
    sourceQuery: 'transactions.count.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'categoryId', 'merchantId', 'accountId'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  TRANSACTION_LIST: {
    sourceQuery: 'transactions.list.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'limit', 'categoryId', 'merchantId', 'accountId', 'tagId'],
    kind: 'EXPENSE',
    shape: 'LIST',
  },
  UNCATEGORISED_REVIEW: {
    sourceQuery: 'transactions.needsReview.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'limit'],
    kind: 'NONE',
    shape: 'LIST',
  },
  INCOME_TOTAL: {
    sourceQuery: 'income.total.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'accountId'],
    kind: 'INCOME',
    shape: 'TOTAL',
  },
  NET_CASHFLOW: {
    sourceQuery: 'cashflow.net.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'accountId'],
    kind: 'BOTH',
    shape: 'TOTAL',
  },
  ACCOUNT_BALANCE: {
    sourceQuery: 'accounts.balance.v1',
    requiredSlots: ['accountId'],
    optionalSlots: [],
    kind: 'NONE',
    shape: 'TOTAL',
  },
  ACCOUNT_BALANCE_ALL: {
    sourceQuery: 'accounts.balanceAll.v1',
    requiredSlots: [],
    optionalSlots: [],
    kind: 'NONE',
    shape: 'ROWS',
  },
  BUDGET_STATUS: {
    sourceQuery: 'budgets.status.v1',
    requiredSlots: [],
    optionalSlots: ['categoryId', 'period'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  BUDGET_LIST: {
    sourceQuery: 'budgets.list.v1',
    requiredSlots: [],
    optionalSlots: [],
    kind: 'EXPENSE',
    shape: 'ROWS',
  },
  SAFE_TO_SPEND: {
    sourceQuery: 'budgets.safeToSpend.v1',
    requiredSlots: [],
    optionalSlots: ['period'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  MONTH_PROJECTION: {
    sourceQuery: 'budgets.monthProjection.v1',
    requiredSlots: [],
    optionalSlots: ['period'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  BUDGET_PACE_VS_PLAN: {
    sourceQuery: 'budgets.paceVsPlan.v1',
    requiredSlots: [],
    optionalSlots: ['period', 'categoryId'],
    kind: 'EXPENSE',
    shape: 'ROWS',
  },
  TREND_VS_LAST_MONTH: {
    sourceQuery: 'analytics.trendVsLastMonth.v1',
    requiredSlots: [],
    optionalSlots: ['categoryId', 'merchantId', 'period'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  COMPARE_PERIODS: {
    sourceQuery: 'analytics.comparePeriods.v1',
    requiredSlots: ['period'],
    optionalSlots: ['categoryId'],
    kind: 'EXPENSE',
    shape: 'ROWS',
  },
  TREND_VS_AVERAGE: {
    sourceQuery: 'analytics.trendVsAverage.v1',
    requiredSlots: [],
    optionalSlots: ['categoryId', 'merchantId', 'period'],
    kind: 'EXPENSE',
    shape: 'TOTAL',
  },
  GOAL_PROGRESS: {
    sourceQuery: 'goals.progress.v1',
    requiredSlots: ['goalId'],
    optionalSlots: [],
    kind: 'NONE',
    shape: 'TOTAL',
  },
  GOAL_REQUIRED_MONTHLY: {
    sourceQuery: 'goals.requiredMonthly.v1',
    requiredSlots: ['goalId'],
    optionalSlots: [],
    kind: 'NONE',
    shape: 'TOTAL',
  },
  SAVINGS_PROPOSAL: {
    sourceQuery: 'goals.savingsProposal.v1',
    requiredSlots: [],
    optionalSlots: ['period'],
    kind: 'EXPENSE',
    shape: 'ROWS',
  },
  RECURRING_UPCOMING: {
    sourceQuery: 'recurring.upcoming.v1',
    requiredSlots: [],
    optionalSlots: ['limit'],
    kind: 'BOTH',
    shape: 'LIST',
  },
  RECURRING_LIST: {
    sourceQuery: 'recurring.list.v1',
    requiredSlots: [],
    optionalSlots: ['limit'],
    kind: 'BOTH',
    shape: 'LIST',
  },
  NO_TEMPLATE_MATCH: {
    // The refusal has no repository method because it computes nothing — and naming that here is what
    // stops somebody adding one "to be consistent".
    sourceQuery: 'none',
    requiredSlots: [],
    optionalSlots: [],
    kind: 'NONE',
    shape: 'REFUSAL',
  },
};

/** The intents a Household can be offered as suggestions when nothing matched (docs/06 §8.4). */
export const SUGGESTED_QUESTIONS: readonly { readonly intent: AssistantIntent; readonly question: string }[] =
  [
    { intent: 'SPEND_TOTAL', question: 'Koliko sam potrošio ovog meseca?' },
    { intent: 'SPEND_BY_CATEGORY', question: 'Koliko sam potrošio na hranu ovog meseca?' },
    { intent: 'TOP_CATEGORIES', question: 'Na šta mi odlazi najviše novca ovog meseca?' },
    { intent: 'BUDGET_STATUS', question: 'Koliko mi je ostalo od budžeta?' },
    { intent: 'SAFE_TO_SPEND', question: 'Koliko mogu da potrošim danas?' },
    { intent: 'TREND_VS_LAST_MONTH', question: 'Kako stojim u odnosu na prošli mesec?' },
  ];

/** Every template's repository method, in registry order — the allow-list a reviewer can read. */
export function registeredSourceQueries(): readonly string[] {
  return ASSISTANT_INTENTS.map((intent) => INTENT_TEMPLATES[intent].sourceQuery).filter(
    (sourceQuery) => sourceQuery !== 'none',
  );
}
