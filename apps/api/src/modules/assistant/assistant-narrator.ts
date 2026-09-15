/**
 * The narrator seam — docs/04 §9's `NARRATE` task, ADR-007, AGENTS.md rule 10.
 *
 * ## The same shape as the classifier, for the same reasons
 *
 * `AiClassifier` set the pattern in 2.2.3 and this follows it exactly:
 *
 * - **The call is an injected interface**, so the assistant's tests can script a model that invents a
 *   figure and assert what the product does about it — without a network and without mocking a module.
 * - **A failure is a value, not a throw.** docs/04 §9's degradation ladder ends in a
 *   template-rendered answer, so a provider outage must not unwind the request.
 * - **`available` is declared**, unlike the classifier's implicit "unavailable means the rung says
 *   so", because the *cost guard* depends on it: docs/06 §11.2 limits `assistantAnswer` to 30/min and
 *   500/day **per household** precisely because it is "the one place a user can trigger unbounded LLM
 *   cost". A template answer costs nothing, so it must not consume that budget — an assistant that
 *   refuses a free, correct answer because a paid one hit a quota would be a self-inflicted outage.
 *
 * ## Why this build supplies the unconfigured implementation
 *
 * No AI provider is configured at all (`AI_CLASSIFIER` is `UNCONFIGURED_AI_CLASSIFIER` for the same
 * reason, and ADR-021 records the seam), so every answer in this build is the deterministic template
 * rendering. {@link RoutedNarrator} is built and unit-tested against a stub router, so wiring a
 * provider is a provider-registration change rather than a feature.
 *
 * @module apps/api/src/modules/assistant
 */

import { type AiRouter, type NarrateInput } from '@finmate/ai';

import { capQuestion, narratePrompt, NARRATE_PROMPT, type NarratePrompt } from './narrate-prompt';

export interface NarrateRequest {
  /** The user's question, as typed. */
  readonly question: string;
  /** The pre-formatted fact strings (docs/06 §8.2) — the only numbers the answer may contain. */
  readonly facts: readonly string[];
  readonly locale: string;
  /** The one stricter retry after a rejected answer (docs/06 §8.5 step 4). */
  readonly strict: boolean;
}

export type NarrateOutcome =
  | {
      readonly ok: true;
      readonly text: string;
      readonly provider: string;
      readonly model: string | null;
      readonly latencyMs: number;
      readonly costMicros: string;
      readonly prompt: NarratePrompt;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly latencyMs: number;
      readonly costMicros: string;
    };

export interface AssistantNarrator {
  /**
   * False when no provider is reachable, which the caller uses in two ways: it skips the cost-limited
   * path entirely, and it reports `narrationMode = TEMPLATE_FALLBACK` honestly rather than pretending
   * a model ran (the same honesty `UNCONFIGURED_AI_CLASSIFIER` keeps about `degraded`).
   */
  readonly available: boolean;
  narrate(request: NarrateRequest): Promise<NarrateOutcome>;
}

/** The narrator used when nothing is configured. It never claims a call it did not make. */
export const UNCONFIGURED_NARRATOR: AssistantNarrator = {
  available: false,
  narrate: (): Promise<NarrateOutcome> =>
    Promise.resolve({
      ok: false,
      reason: 'AI_UNAVAILABLE:no-provider-configured',
      latencyMs: 0,
      costMicros: '0',
    }),
};

/** The production narrator: a thin adapter over `@finmate/ai`'s router. Never a vendor SDK. */
export class RoutedNarrator implements AssistantNarrator {
  readonly available = true;

  constructor(
    private readonly router: AiRouter,
    private readonly baseUrl = '',
    private readonly identity = NARRATE_PROMPT,
  ) {}

  async narrate(request: NarrateRequest): Promise<NarrateOutcome> {
    const prompt = narratePrompt({
      question: request.question,
      locale: request.locale,
      strict: request.strict,
    });

    const input: NarrateInput = {
      task: 'NARRATE',
      templateId: this.identity.templateId,
      version: this.identity.version,
      baseUrl: this.baseUrl,
      system: prompt.system,
      user: prompt.user,
      locale: request.locale,
      facts: request.facts,
      question: capQuestion(request.question),
    };

    const result = await this.router.invoke<string>('NARRATE', input);
    if (!result.ok) {
      return {
        ok: false,
        reason: `${result.reason}:${result.failures.map((failure) => failure.reason).join(',') || 'no-attempt'}`,
        latencyMs: 0,
        costMicros: '0',
      };
    }

    const text = typeof result.value === 'string' ? result.value.trim() : '';
    if (text.length === 0) {
      // A provider that returns prose-less output is a failure of the same kind as a malformed
      // response, and the caller's answer is identical: render the template.
      return {
        ok: false,
        reason: 'EMPTY_NARRATION',
        latencyMs: result.telemetry.latencyMs,
        // Micro-units travel as a **string**: the column is BIGINT and the money path never uses a
        // float (ADR-003), so the number stops being a number at this boundary.
        costMicros: String(result.telemetry.costMicros),
      };
    }

    return {
      ok: true,
      text,
      provider: result.provider,
      model: result.telemetry.model ?? null,
      latencyMs: result.telemetry.latencyMs,
      costMicros: String(result.telemetry.costMicros),
      prompt,
    };
  }
}

/** A Nest provider token, so a scripted narrator swaps in without touching the service. */
export const NARRATOR = Symbol('NARRATOR');
