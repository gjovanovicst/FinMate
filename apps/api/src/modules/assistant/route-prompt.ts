/**
 * The routing prompt — ADR-036's `ROUTE` task, and the place the **closed registry becomes words**.
 *
 * ## Why this file exists at all
 *
 * A model cannot choose from a set it has not been shown, and `packages/ai` must not know the set: the
 * unions live in `assistant-intents.ts` and `assistant-actions.ts`, and a copy of them inside the AI
 * package is exactly the drift ADR-017's closed `Record` exists to prevent. So the caller — this file —
 * renders the members into the instruction, and the package transports it.
 *
 * ## Two things are deliberately here, and one is deliberately not
 *
 * - **The field names are named.** DeepSeek runs in `json_object` mode, which constrains syntax and not
 *   keys, so a prompt that never says `route`/`text` is how the first live provider made the classifier
 *   invent its own keys (docs/15). `routePrompt.spec.ts` asserts those bytes.
 * - **The rule list is short and total.** Anything not on the list is a refusal, and the prompt says so
 *   in those words: a member the model invents is dropped by `validateRouteAnswer`, and the point of
 *   saying it here is to make that rare rather than merely survivable.
 * - **The question is not here.** `@finmate/ai`'s adapter appends it inside an untrusted span
 *   (`asUntrusted(sanitiseText(…))`), so rendering it here would put untrusted text in the instruction
 *   half of the prompt — the separation docs/08 §6.9 is about. This file owns the instructions; the
 *   adapter owns the data.
 *
 * @module apps/api/src/modules/assistant
 */

import { ASSISTANT_ACTIONS, type AssistantAction } from './assistant-actions';
import { ASSISTANT_INTENTS, type AssistantIntent } from './assistant-intents';

/** The identity recorded on every routing call (docs/04 §9's prompt versioning). */
export const ROUTE_PROMPT = Object.freeze({ templateId: 'route.closed-registry', version: '1' });

/**
 * One member the model may answer with, as a line of the prompt.
 *
 * The **description is what makes this work in any language**: a word list cannot cover languages we
 * have never seen, but a sentence saying what `SPEND_BY_CATEGORY` *means* can be matched by any model
 * that reads it (ADR-036's whole argument).
 */
interface RouteMember {
  readonly name: string;
  readonly description: string;
}

/**
 * What each intent means, in one line — the vocabulary of the rung.
 *
 * ⚠️ **This is the one place a new intent or action must be described**, and an exhaustive `Record`
 * makes forgetting it a compile error. The description is written to be *recognised*, not to be
 * poetic: it names the shape of the sentence a person would say, including words from more than one
 * language where that is what makes it click.
 */
const INTENT_MEANINGS: Readonly<Record<AssistantIntent, string>> = {
  SPEND_TOTAL: 'how much was spent in total over a period ("koliko sam potrošio ovog meseca")',
  SPEND_BY_CATEGORY: 'how much was spent on one category ("koliko na hranu")',
  SPEND_BY_MERCHANT: 'how much was spent at one merchant or shop',
  SPEND_BY_ACCOUNT: 'how much was spent from one account',
  SPEND_BY_TAG: 'how much was spent under one tag or label',
  TOP_CATEGORIES: 'which categories cost the most',
  TOP_MERCHANTS: 'which merchants or shops cost the most',
  LARGEST_TRANSACTIONS: 'the biggest single transactions',
  AVERAGE_DAILY_SPEND: 'the average spent per day',
  TRANSACTION_COUNT: 'how many transactions there were',
  TRANSACTION_LIST: 'list or show the transactions themselves',
  UNCATEGORISED_REVIEW: 'what still needs a category or is waiting for review',
  INCOME_TOTAL: 'how much income there was',
  INCOME_BY_CATEGORY: 'how much income of one kind, such as a salary or pension',
  NET_CASHFLOW: 'income minus spending',
  ACCOUNT_BALANCE: "one account's current balance",
  ACCOUNT_BALANCE_ALL: 'the balances of all accounts',
  BUDGET_STATUS: 'how much of a budget is left',
  BUDGET_LIST: 'list the budgets',
  SAFE_TO_SPEND: 'how much can still be spent safely today',
  MONTH_PROJECTION: 'what this month will end up costing',
  BUDGET_PACE_VS_PLAN: 'whether spending is ahead of or behind plan',
  TREND_VS_LAST_MONTH: 'a comparison with last month',
  COMPARE_PERIODS: 'a comparison of two periods',
  TREND_VS_AVERAGE: 'a comparison with the usual or average amount',
  GOAL_PROGRESS: 'how far along a savings goal is',
  GOAL_REQUIRED_MONTHLY: 'how much must be set aside each month for a goal',
  SAVINGS_PROPOSAL: 'a proposal for how to save a target amount',
  RECURRING_UPCOMING: 'which bills or payments are coming up',
  RECURRING_LIST: 'list the recurring payments',
  NO_TEMPLATE_MATCH: 'nothing in the list above fits',
};

/** What each write does, in one line, plus what its `text` should contain. */
const ACTION_MEANINGS: Readonly<Record<AssistantAction, string>> = {
  ADD_TRANSACTION: 'record a purchase or income ("dodaj trošak kafa 180"); text = the entry without its amount',
  ADD_CATEGORY: 'create a category ("dodaj kategoriju Putovanja"); text = the name',
  SET_BUDGET: 'set a monthly spending limit ("postavi budžet za hranu na 20000"); text = the whole phrase, amount included',
  ADD_GOAL: 'create a savings goal ("napravi cilj Letovanje 200000"); text = the name and the target',
  ADD_TAG: 'create a tag or label ("dodaj tag Odmor"); text = the name',
  CREATE_RULE_FROM_CORRECTION: 'turn the most recent correction into a rule ("zapamti ovu ispravku"); text = null',
};

/**
 * The members, as the prompt lists them. Derived from the registries, never hand-written, so a member
 * added to a union cannot be missing here — and one left without a meaning fails `tsc` above.
 */
export function routeMembers(): readonly RouteMember[] {
  return [
    ...ASSISTANT_INTENTS.filter((intent) => intent !== 'NO_TEMPLATE_MATCH').map((intent) => ({
      name: intent,
      description: INTENT_MEANINGS[intent],
    })),
    ...ASSISTANT_ACTIONS.map((action) => ({
      name: action,
      description: ACTION_MEANINGS[action],
    })),
  ];
}

export interface RoutePrompt {
  readonly system: string;
  readonly user: string;
}

/**
 * Both halves. `user` carries the member list; the question is appended by the adapter.
 *
 * `locale` is named rather than depended on: the model must recognise a sentence in **any** language
 * (that is the point of the rung), so the locale only tells it which language an answer's `text` is
 * most likely to be in — `text` is copied from the question either way.
 */
export function routePrompt(input: { readonly locale: string }): RoutePrompt {
  const members = routeMembers();
  const system = [
    'You map one sentence from a household budgeting application to one action or question the',
    'application already supports. You are a router, not an assistant: you never answer the question,',
    'never explain, never advise, and never invent a capability.',
    '',
    'Answer with a JSON object with exactly two fields:',
    '- "route": exactly one name copied from the list below, or null when none of them fits.',
    '- "text": for a create-style action, the words from the sentence that name or describe what it',
    '  acts on, copied as the user wrote them. For a question, or when nothing is named, null.',
    '',
    'Rules, most important first:',
    '- "route" must be one of the names in the list, spelled exactly. If nothing in the list is what the',
    '  sentence means, use null. Never invent a name, never return a URL, a function, a query or an id.',
    '- Never put an amount, a date, an id or a computed number in "route"; that field is a name only.',
    '- The sentence may be in any language. Match its meaning, not its words.',
    '- If two members could fit, choose the more specific one.',
    '- Do not answer the sentence, and do not add any field other than "route" and "text".',
    '',
    `The user's interface language is ${input.locale.length > 0 ? input.locale : 'sr-Latn'}.`,
  ].join('\n');

  const user = [
    'Members you may answer with:',
    ...members.map((member) => `- ${member.name}: ${member.description}`),
  ].join('\n');

  return { system, user };
}
