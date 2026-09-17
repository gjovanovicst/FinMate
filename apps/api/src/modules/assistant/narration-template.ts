/**
 * The template answer — docs/06 §8.5's `TEMPLATE_FALLBACK`, docs/04 §10's "template-rendered answer
 * with no LLM at all".
 *
 * ## Why this exists at all
 *
 * Two paths reach it, and neither is an error:
 *
 * 1. **No provider is configured** (the state of this build, and the state of any household whose
 *    provider is unreachable). The facts are already computed, so refusing to answer because a model
 *    is down would be a self-inflicted outage.
 * 2. **The model narrated a number the payload does not contain.** docs/06 §8.5 regenerates once
 *    with a stricter instruction and then renders deterministically — the user still gets the correct
 *    answer, and the UI is expected to make the fallback invisible.
 *
 * ## The rule this file obeys
 *
 * It **cannot** invent a numeral: every figure it prints is read from `facts.formatted`,
 * `facts.rows[].formatted` or `facts.totals[].formatted`, and the provenance it prints is the count
 * and the range the payload already carries. A unit test runs `validateNarration` over the rendered
 * answer for every intent, so that is an assertion rather than an intention.
 *
 * ## The gap it inherits
 *
 * The connective copy below is **English**, like every other server-rendered string in this API
 * (docs/06 §5.14 records the DoD breach for notification copy; this is the same one). A Household's
 * own names — `Hrana`, `Lidl` — appear untranslated because they are the user's own words. The money
 * is formatted in the household's locale. Fixing this properly means the API gains a catalogue, or
 * the client renders the fallback from `facts` — both are §5.14's decision, not this file's.
 *
 * @module apps/api/src/modules/assistant
 */

import type { AssistantIntent, IntentTemplate } from './assistant-intents';
import type { AssistantFactsView, ProvenanceView } from './fact-assembly.service';

export interface TemplateAnswerInput {
  readonly intent: AssistantIntent;
  readonly template: IntentTemplate;
  readonly facts: AssistantFactsView;
  readonly provenance: ProvenanceView;
}

/**
 * Which sentence an intent's fallback uses.
 *
 * A `Record<AssistantIntent, Frame>` rather than a `switch` with a default arm: adding an intent then
 * fails `tsc` until somebody decides how it reads, which is the same reason the intent registry and
 * the builder registry are records. The arm names the **shape of the sentence**, not the intent, so
 * the prose lives in a handful of renderers instead of twenty-nine.
 */
type Frame =
  | 'TOTAL_AMOUNT'
  | 'AVERAGE'
  | 'COUNT'
  | 'NET'
  | 'STATE'
  | 'BUDGET'
  | 'SAFE'
  | 'PROJECTION'
  | 'ROWS'
  | 'LIST'
  | 'TREND_PREVIOUS'
  | 'TREND_AVERAGE'
  | 'PROPOSAL'
  | 'GOAL'
  | 'GOAL_MONTHLY'
  | 'SCHEDULE'
  | 'DUE'
  | 'REFUSAL';

const FRAMES: Readonly<Record<AssistantIntent, Frame>> = {
  SPEND_TOTAL: 'TOTAL_AMOUNT',
  SPEND_BY_CATEGORY: 'TOTAL_AMOUNT',
  SPEND_BY_MERCHANT: 'TOTAL_AMOUNT',
  SPEND_BY_ACCOUNT: 'TOTAL_AMOUNT',
  SPEND_BY_TAG: 'TOTAL_AMOUNT',
  TOP_CATEGORIES: 'ROWS',
  TOP_MERCHANTS: 'ROWS',
  LARGEST_TRANSACTIONS: 'LIST',
  AVERAGE_DAILY_SPEND: 'AVERAGE',
  TRANSACTION_COUNT: 'COUNT',
  TRANSACTION_LIST: 'LIST',
  UNCATEGORISED_REVIEW: 'LIST',
  INCOME_TOTAL: 'TOTAL_AMOUNT',
  NET_CASHFLOW: 'NET',
  ACCOUNT_BALANCE: 'STATE',
  ACCOUNT_BALANCE_ALL: 'STATE',
  BUDGET_STATUS: 'BUDGET',
  BUDGET_LIST: 'ROWS',
  SAFE_TO_SPEND: 'SAFE',
  MONTH_PROJECTION: 'PROJECTION',
  BUDGET_PACE_VS_PLAN: 'ROWS',
  TREND_VS_LAST_MONTH: 'TREND_PREVIOUS',
  COMPARE_PERIODS: 'REFUSAL',
  TREND_VS_AVERAGE: 'TREND_AVERAGE',
  GOAL_PROGRESS: 'GOAL',
  GOAL_REQUIRED_MONTHLY: 'GOAL_MONTHLY',
  SAVINGS_PROPOSAL: 'PROPOSAL',
  RECURRING_UPCOMING: 'DUE',
  RECURRING_LIST: 'SCHEDULE',
  NO_TEMPLATE_MATCH: 'REFUSAL',
};

/** How many rows a fallback sentence names before it stops reading them out. */
const MAX_NAMED_ROWS = 3;

/**
 * Render the deterministic answer for an assembled plan.
 *
 * Unavailable templates are not rendered here at all — the service returns {@link renderRefusal}
 * for those, because an answer with no facts must carry no figure.
 */
export function renderTemplateAnswer(input: TemplateAnswerInput): string {
  const { facts, provenance, template } = input;
  const frame = FRAMES[input.intent];
  const headline = facts.formatted['headline'] ?? '';
  const at = facts.totals.find((total) => total.label === 'This period')?.formatted ?? headline;

  switch (frame) {
    case 'TOTAL_AMOUNT': {
      // The scope the question named, when the builder could phrase it (docs/06 §8.2). Without it a
      // scoped answer reads "You spent 4.000,00 RSD." — a true figure answering a question nobody can
      // check against the one that was asked (docs/15).
      const scope = facts.formatted['scope'];
      const of = scope === undefined || scope === '' ? '' : ` ${scope}`;
      return template.kind === 'INCOME'
        ? `You received ${headline}${of}.`
        : `You spent ${headline}${of}.`;
    }

    case 'AVERAGE': {
      const days = facts.formatted['days'];
      const total = facts.formatted['total'];
      return days === undefined
        ? `You spent ${headline} a day on average.`
        : `You spent ${headline} a day on average over ${days} days${total === undefined ? '' : `, ${total} in total`}.`;
    }

    case 'COUNT': {
      const count = provenance.transactionCount;
      return count === 1 ? 'You have 1 transaction in that period.' : `You have ${headline} transactions in that period.`;
    }

    case 'NET':
      return `Income ${facts.formatted['income'] ?? ''}, spending ${facts.formatted['spending'] ?? ''}, net ${headline}.`;

    case 'STATE': {
      const asOf = facts.formatted['asOf'];
      const named = namedRows(facts);
      const subject = named.length === 0 ? 'Your balance' : `Your balance on ${named[0]?.label ?? ''}`;
      return asOf === undefined ? `${subject} is ${headline}.` : `${subject} is ${headline}, as of ${asOf}.`;
    }

    case 'BUDGET': {
      const limit = facts.formatted['limit'];
      const spent = facts.formatted['spent'];
      return limit === '' || limit === undefined
        ? `You have ${headline} left of that budget${spent === undefined ? '' : ` after ${spent}`}.`
        : `You have ${headline} left of ${limit}${spent === undefined ? '' : `, with ${spent} spent`}.`;
    }

    case 'SAFE': {
      const spent = facts.formatted['spent'];
      return spent === undefined
        ? `You can spend ${headline} safely today.`
        : `You can spend ${headline} safely today; ${spent} is spent this month.`;
    }

    case 'PROJECTION': {
      const overrun = facts.totals.find((total) => total.label === 'Projected overrun')?.formatted;
      const reliable = facts.formatted['reliable'] === 'true';
      const caveat = reliable ? '' : ' The month is early, so this is a rough figure.';
      return overrun === undefined
        ? `You are on track for ${headline} this month.${caveat}`
        : `You are on track for ${headline} this month, over by ${overrun}.${caveat}`;
    }

    case 'ROWS': {
      const named = namedRows(facts);
      // No rows means nothing to rank — and printing the zero headline the builder left behind
      // ("Nothing to report there (0,00 RSD)") is a figure the answer does not need. The sentence
      // carries no numeral at all, which is also the most honest thing a ranked list can say.
      if (named.length === 0) return 'Nothing stands out in that period.';
      return `${named.map((row) => `${row.label} ${row.formatted}`).join(', then ')}.`;
    }

    case 'LIST': {
      const named = namedRows(facts);
      const count = provenance.transactionCount;
      const lead = count === 1 ? '1 transaction' : `${headline} transactions`;
      return named.length === 0
        ? `Nothing matched (${lead}).`
        : `${lead}: ${named.map((row) => `${row.label} ${row.formatted}`).join(', then ')}.`;
    }

    case 'TREND_PREVIOUS': {
      const previous = facts.formatted['previous'];
      return previous === undefined
        ? `This period ${at}.`
        : `This period ${at}, against ${previous} in the previous period — a change of ${headline}.`;
    }

    case 'TREND_AVERAGE': {
      const average = facts.formatted['average'];
      return average === undefined
        ? `This period ${at}.`
        : `This period ${at}, against a usual ${average} — a difference of ${headline}.`;
    }

    case 'GOAL': {
      // F-18. Contributed / target / the percentage, all from `formatted`, and the percentage comes
      // from the domain calculator rather than being divided here.
      const goal = facts.formatted['goal'];
      const target = facts.formatted['target'] ?? '';
      const remaining = facts.formatted['remaining'];
      const percent = facts.formatted['progressPercent'] ?? '';
      const subject = goal === undefined ? 'That goal' : `“${goal}”`;
      const bar = percent === '' ? '' : ` (${percent}%)`;
      return remaining === undefined
        ? `${subject} stands at ${headline} of ${target}${bar}.`
        : `${subject} stands at ${headline} of ${target}${bar}, with ${remaining} to go.`;
    }

    case 'GOAL_MONTHLY': {
      const months = facts.formatted['monthsRemaining'];
      const date = facts.formatted['targetDate'];
      const goal = facts.formatted['goal'];
      const subject = goal === undefined ? 'that goal' : `“${goal}”`;
      const by = date === undefined ? '' : ` by ${date}`;
      return months === undefined
        ? `Reaching ${subject} needs ${headline} a month${by}.`
        : `Reaching ${subject}${by} needs ${headline} a month for ${months} months.`;
    }

    case 'SCHEDULE': {
      // F-16. The count is `formatted.count`, not `provenance.transactionCount`: these rows are
      // **rules**, and no Transaction was aggregated (the same reason the builder reports 0 there).
      const count = facts.formatted['count'] ?? headline;
      const paused = facts.formatted['pausedCount'];
      const named = namedRows(facts);
      if (named.length === 0) return 'There are no recurring charges on this ledger.';
      const list = named.map((row) => `${row.label} ${row.formatted}`).join(', then ');
      const rest = paused === undefined || paused === '0' ? '' : ` ${paused} of them are paused.`;
      return count === '1'
        ? `You have 1 recurring charge: ${list}.${rest}`
        : `You have ${count} recurring charges: ${list}.${rest}`;
    }

    case 'DUE': {
      const count = facts.formatted['count'] ?? headline;
      const days = facts.formatted['days'];
      const window = days === undefined ? 'soon' : `in the next ${days} days`;
      const named = namedRows(facts);
      if (named.length === 0) return `Nothing is due ${window}.`;
      const list = named.map((row) => `${row.label} ${row.formatted}`).join(', then ');
      return count === '1'
        ? `1 charge is due ${window}: ${list}.`
        : `${count} charges are due ${window}: ${list}.`;
    }

    case 'PROPOSAL': {
      // F-30. The sentence names the target, what the plan covers and what it cannot — all three from
      // `formatted`, so the fallback says the same thing the table shows.
      const target = facts.formatted['target'];
      const shortfall = facts.formatted['shortfall'];
      const named = namedRows(facts);
      if (named.length === 0) {
        return target === undefined
          ? 'There is nothing in that period to cut.'
          : `I cannot reach ${target} from that period's spending — there is nothing to cut.`;
      }
      // One verb for the list, not one per item: "cut X by A, then cut Y by B" reads like a form.
      const plan = named
        .map((row, index) => `${index === 0 ? 'cut ' : ''}${row.label} by ${row.formatted}`)
        .join(', then ');
      const short =
        shortfall === undefined || facts.formatted['meetsTarget'] === 'true'
          ? ''
          : ` That still leaves ${shortfall} short.`;
      return target === undefined ? `${plan}.${short}` : `To save ${target}: ${plan}.${short}`;
    }

    case 'REFUSAL':
      // The service refuses before it renders (no facts are assembled for an unavailable template);
      // this arm exists so the `Record` stays total and says so rather than throwing.
      return renderRefusal('NO_TEMPLATE_MATCH');
  }
}

/**
 * The copy for an answer the ledger cannot give.
 *
 * It is deliberately a **value** rather than an exception (docs/06 §8.5: `answered = false`, no
 * figure, suggestions offered), and it says which kind of "cannot" it is, because "we do not have
 * goals yet" and "I could not tell which Category you meant" are different problems for the user.
 */
export function renderRefusal(reason: string): string {
  if (reason === 'NO_TEMPLATE_MATCH') {
    return 'I cannot answer that from your ledger. Try one of the questions below.';
  }
  if (reason === 'NEEDS_TWO_PERIODS') {
    return 'Comparing two periods needs both of them, which is not built yet.';
  }
  if (reason === 'NO_TARGET_DATE') {
    return 'That goal has no target date, so there is no monthly amount that reaches it. Give it a date and I can work one out.';
  }
  if (reason.startsWith('NOT_BUILT:')) {
    // Generic since A-2 built the last four templates that refused this way: the arm names the missing
    // piece from the reason rather than carrying prose for a template nobody has written, so a new
    // declaration fails loudly at the builder and reads sensibly here.
    return `I cannot answer that yet: ${reason.slice('NOT_BUILT:'.length)} is not part of the ledger.`;
  }
  if (reason.startsWith('UNRUNNABLE:')) {
    const missing = reason.slice('UNRUNNABLE:'.length);
    const nouns: Readonly<Record<string, string>> = {
      categoryId: 'which Category you meant',
      merchantId: 'which Merchant you meant',
      accountId: 'which Account you meant',
      tagId: 'which Tag you meant',
      goalId: 'which goal you meant',
      recurringRuleId: 'which recurring rule you meant',
      limit: 'how many rows you wanted',
      targetMinor: 'how much you want to save',
      period: 'which period you meant',
    };
    return `I could not tell ${nouns[missing] ?? 'what you meant'}. Try naming it.`;
  }
  return 'I cannot answer that from your ledger yet.';
}

/** The rows a sentence may name, capped so a fallback stays a sentence. */
function namedRows(facts: AssistantFactsView): readonly { readonly label: string; readonly formatted: string }[] {
  return facts.rows.filter((row) => row.label.length > 0).slice(0, MAX_NAMED_ROWS);
}
