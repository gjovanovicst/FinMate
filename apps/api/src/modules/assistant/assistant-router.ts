/**
 * The routing seam — ADR-036's `ROUTE` task, the same shape as the narrator and for the same reasons.
 *
 * ## What the caller gets, and what it does not
 *
 * `route()` answers a **validated decision or `null`**, never a raw string: the model's member name is
 * checked against the closed unions by {@link validateRouteAnswer} before it leaves this file, so no
 * caller has to remember to do it. A failure — no provider, a timeout, a malformed body, a name outside
 * the registry — is the same `null`, because the caller's response to all of them is identical: fall
 * back to the refusal it already had. That is what makes the rung safe to sit on the critical path.
 *
 * ## Why there is an unconfigured implementation
 *
 * Nothing routes unless a deployment configures `AI_ROUTE_PRIMARY` *and* the Household consents. The
 * unconfigured twin is what this build ships, so every code path that calls it exists and is exercised
 * — and `available` is declared so a caller can skip the cost-limited path entirely rather than paying
 * for a call it knows cannot happen (the narrator's argument, verbatim).
 *
 * ## Cost is reported, not persisted
 *
 * `costMicros` and `latencyMs` travel back with the decision. ⚠️ Persisting them is docs/06 §8.8's open
 * gap — narration has the same one — so this seam reports what the provider said and claims nothing
 * about a row that does not exist.
 *
 * The Nest token lives in `ai-tokens.ts` with the others (`AI_ROUTER`), so a consumer and the module
 * can both import it without a module → consumer → module cycle.
 *
 * @module apps/api/src/modules/assistant
 */

import { type AiRouter, type RouteAnswer } from '@finmate/ai';

import { capQuestion, MAX_QUESTION_CHARS } from './narrate-prompt';
import { validateRouteAnswer, type RouteDecision } from './route-answer';
import { routePrompt, ROUTE_PROMPT } from './route-prompt';

export interface RouteRequest {
  /** The user's own words, as typed. Capped here; never redacted away — it is what is being routed. */
  readonly question: string;
  readonly locale: string;
}

export interface RouteOutcome {
  /** The decision, or `null` — which is not an error and needs no sentence of its own. */
  readonly decision: RouteDecision | null;
  /** False when nothing is configured or consented, so the caller can say so honestly. */
  readonly attempted: boolean;
  /** `null` when nothing was attempted; otherwise why the answer was discarded, for the log. */
  readonly reason: string | null;
  readonly latencyMs: number;
  readonly costMicros: string;
}

export interface AssistantRouter {
  /**
   * False when no routing provider is reachable (no endpoint, or no consent). A caller uses it the way
   * the narrator's is used: skip the path rather than spending a call that cannot happen.
   */
  readonly available: boolean;
  route(request: RouteRequest): Promise<RouteOutcome>;
}

/** The router used when nothing is configured. It never claims a call it did not make. */
export const UNCONFIGURED_ROUTER: AssistantRouter = {
  available: false,
  route: (): Promise<RouteOutcome> =>
    Promise.resolve({
      decision: null,
      attempted: false,
      reason: 'AI_UNAVAILABLE:no-provider-configured',
      latencyMs: 0,
      costMicros: '0',
    }),
};

/** The production router: a thin adapter over `@finmate/ai`'s router. Never a vendor SDK. */
export class RoutedQuestionRouter implements AssistantRouter {
  readonly available = true;

  constructor(
    private readonly router: AiRouter,
    private readonly baseUrl = '',
    private readonly identity = ROUTE_PROMPT,
  ) {}

  async route(request: RouteRequest): Promise<RouteOutcome> {
    // Capped exactly as narration's is: the same 280-char rule, applied in the same place, so the two
    // prompts cannot disagree about what a "question" is.
    const question = capQuestion(request.question);
    if (question.length === 0) {
      return { decision: null, attempted: false, reason: 'EMPTY_QUESTION', latencyMs: 0, costMicros: '0' };
    }

    const prompt = routePrompt({ locale: request.locale });
    const result = await this.router.invoke<RouteAnswer>('ROUTE', {
      task: 'ROUTE',
      templateId: this.identity.templateId,
      version: this.identity.version,
      baseUrl: this.baseUrl,
      // The closed member list travels in `user`, rendered by `route-prompt.ts`; the adapter appends
      // the question itself inside the untrusted span.
      system: prompt.system,
      user: prompt.user,
      locale: request.locale,
      question,
    });

    if (!result.ok) {
      return {
        decision: null,
        attempted: true,
        reason: `${result.reason}:${result.failures.map((failure) => failure.reason).join(',') || 'no-attempt'}`,
        latencyMs: 0,
        costMicros: '0',
      };
    }

    const decision = validateRouteAnswer(result.value);
    return {
      decision,
      attempted: true,
      // A discarded answer is reported by the **member** it named, not by the text: the text is the
      // user's own words and this reason string is a log line (docs/08 §6.3).
      reason: decision === null ? `UNREGISTERED_MEMBER:${String(result.value?.route ?? 'null').slice(0, 40)}` : null,
      latencyMs: result.telemetry.latencyMs,
      // Micro-units travel as a **string**: the column is BIGINT and the money path never uses a float
      // (ADR-003), so the number stops being a number at this boundary.
      costMicros: String(result.telemetry.costMicros),
    };
  }
}

/** The cap the request is held to, re-exported so a caller can assert against the same number. */
export { MAX_QUESTION_CHARS };
