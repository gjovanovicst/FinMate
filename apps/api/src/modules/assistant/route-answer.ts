/**
 * What a routing answer may become — ADR-036's safety property, in one pure function.
 *
 * The model is shown a list of member names and returns whichever it thinks fits. This is where that
 * string either becomes something the app can act on or is **discarded**: the registries are closed and
 * compiled in, and a name that is not in them is not an error to report but an answer to ignore. That
 * asymmetry is the whole design — a model cannot reach a capability nobody wrote, so the worst it can do
 * is waste a call.
 *
 * ## Why it is separate from the prompt and from the transport
 *
 * It is pure, so it can be tested against every member and every shape of nonsense without a provider,
 * a database or a Nest module — and it is the part a reviewer should read first, because it is the only
 * place an untrusted string turns into a decision.
 *
 * @module apps/api/src/modules/assistant
 */

import type { RouteAnswer } from '@finmate/ai';

import { ACTION_NAME_MAX_LENGTH } from './action-planner';
import { ASSISTANT_ACTIONS, type AssistantAction } from './assistant-actions';
import { ASSISTANT_INTENTS, type AssistantIntent } from './assistant-intents';

/** A member the app can act on, with the free text the sentence carried. */
export type RouteDecision =
  | { readonly kind: 'INTENT'; readonly intent: AssistantIntent }
  | { readonly kind: 'ACTION'; readonly action: AssistantAction; readonly text: string | null };

/**
 * Turn an answer into a decision, or `null`.
 *
 * Three rules, and each one closes a way a model could otherwise widen its own reach:
 *
 * 1. **A name outside the unions is `null`.** Not a near-match, not a case-insensitive hit: the prompt
 *    lists the exact spelling, and a provider that answers `spend_total` has not followed the contract.
 * 2. **A question carries no `text`.** `SPEND_BY_CATEGORY` has no create-style payload, so text beside
 *    it is noise — dropping it here means no later stage can be tempted to use it.
 * 3. **Blank or over-long text reads as "nothing named", never as a truncated guess.** The cap is the
 *    builders' own `ACTION_NAME_MAX_LENGTH`, imported so the two cannot drift: a value past it is
 *    `null`, which routes the write into the refusal the card already phrases as *"tell me what to call
 *    it"*. Truncating would store a name nobody wrote, and throwing would turn a model quirk into an
 *    error page — both worse than asking.
 *
 * `NO_TEMPLATE_MATCH` is deliberately **not** accepted: it is the read planner's own refusal, and
 * letting the rung answer with it would produce a refusal *from a model* where the caller's existing
 * refusal is already honest and free.
 */
export function validateRouteAnswer(answer: RouteAnswer | null | undefined): RouteDecision | null {
  if (answer === null || answer === undefined) return null;
  const route = typeof answer.route === 'string' ? answer.route.trim() : '';

  if (isIntent(route)) {
    return { kind: 'INTENT', intent: route };
  }
  if (isAction(route)) {
    return { kind: 'ACTION', action: route, text: normaliseText(answer.text) };
  }
  return null;
}

function normaliseText(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // Over-long is **absence**, not truncation — see the doc above. The bound is the builders' own.
  return trimmed.length <= ACTION_NAME_MAX_LENGTH ? trimmed : null;
}

function isIntent(value: string): value is AssistantIntent {
  // `NO_TEMPLATE_MATCH` is excluded on purpose — see the doc above.
  return value !== 'NO_TEMPLATE_MATCH' && (ASSISTANT_INTENTS as readonly string[]).includes(value);
}

function isAction(value: string): value is AssistantAction {
  return (ASSISTANT_ACTIONS as readonly string[]).includes(value);
}
