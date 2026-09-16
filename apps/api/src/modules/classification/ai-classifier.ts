/**
 * The AI classifier seam — docs/04-categorization-and-ai-engine.md §6 and §9, ADR-007.
 *
 * ## Why this is an interface and not a call site
 *
 * The pipeline must reach the model **only** when every deterministic stage was inconclusive
 * (ADR-002). Two things fall out of that, and both are load-bearing here:
 *
 * 1. **The call is a callback.** {@link AiClassifier} is injected, so a test can count invocations
 *    and prove a rule or keyword decision produced exactly zero (docs/04 §12's cost model).
 * 2. **A provider outage is a value, not a throw.** docs/04 §9's degradation ladder ends in
 *    "rules + keywords only", which means capture still succeeds. So an unavailable model returns
 *    an {@link AiUnavailable} result rather than unwinding a request handler.
 *
 * ## No vendor SDK, no direct provider call
 *
 * AGENTS.md rule 10: a feature module never calls a vendor. {@link RoutedAiClassifier} goes through
 * `@finmate/ai`'s `AiRouter` and never imports an adapter. When no provider is configured the module
 * supplies {@link UNCONFIGURED_AI_CLASSIFIER}, which reports an honest `AI_UNAVAILABLE` instead of
 * pretending a model ran.
 *
 * @module apps/api/src/modules/classification
 */

import {
  calibrate,
  calibrationKeyFromPrompt,
  asRawConfidence,
  validateClassifyProposal,
  type AiRouter,
  type CalibrationTable,
  type ClassifyInput,
  type ClassifyProposal,
} from '@finmate/ai';

import type { TransactionFragment } from '@finmate/nlp';
import type { KeywordCandidate } from '@finmate/rules-engine';

import type { AiClassifyResult, AiStageResult, PipelineCategory, PipelineHousehold } from './classification.pipeline';
import { promptFor, type PromptCategory } from './classify-prompt';

/**
 * Everything the classifier needs for one fragment.
 *
 * It is not `AiStageInput` because the classifier also needs the closed category list and the fitted
 * calibration maps — both owned by the caller (the service), neither of which belongs in the pure
 * pipeline stage.
 *
 * The payload fields (`fragment`, the entity names, `keywordCandidates`) are here because
 * `ClassifyInput` carries them to the adapter, which renders them — not because the prompt in
 * `classify-prompt.ts` does. See that module's header: rendering them twice is how the model came to
 * be offered two different id vocabularies and answered with one the map could not resolve.
 */
export interface ClassifyRequest {
  readonly fragment: TransactionFragment;
  /** The resolved entity names, when stage 3 hit. */
  readonly merchantName?: string;
  readonly counterpartyName?: string;
  /** The scored keyword candidates, attached as context (docs/04 §5.4). */
  readonly keywordCandidates: readonly KeywordCandidate[];
  /** The closed list the model may choose from. An id outside it is nulled by validation (§6.2). */
  readonly categories: readonly PipelineCategory[];
  readonly household: PipelineHousehold;
  readonly locale: string;
  /** Fitted isotonic maps. Empty/absent ⇒ §6.4's conservative shrink. */
  readonly calibration?: CalibrationTable;
}

/** The classifier contract. Implemented by the router-backed class and by test doubles. */
export interface AiClassifier {
  classify(request: ClassifyRequest): Promise<AiStageResult>;
}

/** Re-exported so a caller naming the prompt's category shape does not need a second import. */
export type { PromptCategory };

/**
 * The classifier used when nothing is configured.
 *
 * It reports the `RULES_KEYWORDS_ONLY` rung with a reason naming the configuration gap. It
 * deliberately does **not** fabricate an "AI" decision: `decided_by` must stay honest (docs/04 §9's
 * ladder; `usedAi` / `degraded` on the API derive from it).
 */
export const UNCONFIGURED_AI_CLASSIFIER: AiClassifier = {
  classify: (): Promise<AiStageResult> =>
    Promise.resolve({
      unavailable: true,
      rung: 'RULES_KEYWORDS_ONLY',
      reason: 'AI_UNAVAILABLE:no-provider-configured',
    }),
};

/** The identity of the classify prompt, recorded on every call (docs/04 §9's prompt versioning). */
export interface PromptIdentity {
  readonly templateId: string;
  readonly version: number;
}

/** ADR-009 defaults to the §6.3 template revision this build renders. */
export const CLASSIFY_PROMPT: PromptIdentity = Object.freeze({
  templateId: 'classify.serbian-household',
  version: 1,
});

/**
 * The production classifier: a thin adapter over `@finmate/ai`'s router.
 *
 * It owns the two things a router call cannot do for itself, both of which need data this layer has:
 *
 * - **The closed-list audit** (§6.2). The router returns a proposal whose `categoryId` the model
 *   chose; "any `categoryId` not present in the supplied list is rejected by validation and treated
 *   as `null` + low confidence".
 * - **§6.4 calibration.** The router returns the model's *raw* number; the gate consumes the fitted
 *   value. Both travel out, so the audit row can keep the raw half of the
 *   `(raw_confidence, was_accepted)` pair the weekly re-fit needs.
 */
export class RoutedAiClassifier {
  constructor(
    private readonly router: AiRouter,
    private readonly identity: PromptIdentity = CLASSIFY_PROMPT,
  ) {}

  async classify(request: ClassifyRequest): Promise<AiStageResult> {
    // Instructions only. The adapter renders the payload — the closed list included — because it owns
    // the id substitution the model answers in (see `classify-prompt.ts`).
    const prompt = promptFor();
    const allowedIds = request.categories.map((category) => category.id);

    const input: ClassifyInput = {
      task: 'CLASSIFY',
      templateId: this.identity.templateId,
      version: String(this.identity.version),
      baseUrl: '',
      system: prompt.system,
      user: prompt.user,
      locale: request.locale,
      fragment: {
        text: request.fragment.description || request.fragment.rawText,
        amountMinor: request.fragment.amountMinor?.toString() ?? null,
        currency: request.fragment.currency,
        occurredOn: request.fragment.occurredOn,
        ...(request.merchantName ? { merchantName: request.merchantName } : {}),
        ...(request.counterpartyName ? { counterpartyName: request.counterpartyName } : {}),
      },
      categories: request.categories.map((category) => ({
        id: category.id,
        path: category.name,
        ...(category.aiDescription ? { description: category.aiDescription } : {}),
      })),
    };

    const result = await this.router.invoke<ClassifyProposal>('CLASSIFY', input);
    if (!result.ok) {
      return {
        unavailable: true,
        // A router failure is never `FULL_PIPELINE`; the `!result.ok` arm already excludes it, and the
        // guard keeps that a type-level fact instead of a cast.
        rung: failingRung(result.rung),
        reason: `${result.reason}:${result.failures.map((failure) => failure.reason).join(',') || 'no-attempt'}`,
      };
    }

    const validated = validateClassifyProposal(result.value, allowedIds);
    const model = result.telemetry.model ?? this.identity.templateId;

    return {
      categoryId: validated.proposal.categoryId,
      rawConfidence: validated.proposal.confidence,
      rationale: validated.proposal.rationale,
      alternatives: validated.proposal.alternatives,
      provider: result.provider,
      model,
      promptTemplateId: null,
      promptVersion: this.identity.version,
      latencyMs: result.telemetry.latencyMs,
      costMicros: result.telemetry.costMicros,
    } satisfies AiClassifyResult;
  }
}

/** Narrow a router rung to the failure arms the pipeline's `AiUnavailable` accepts. */
function failingRung(rung: string): 'RULES_KEYWORDS_ONLY' | 'DETERMINISTIC_ONLY' | 'MANUAL_ENTRY' {
  if (rung === 'DETERMINISTIC_ONLY' || rung === 'MANUAL_ENTRY') return rung;
  return 'RULES_KEYWORDS_ONLY';
}

/**
 * Apply §6.4's calibration to a model's raw number.
 *
 * It is a **separate, exported step** rather than something the classifier does internally, for one
 * structural reason: the gate must never see an uncalibrated AI confidence, and the service can only
 * guarantee that if it owns the transition. A stub classifier in a test therefore cannot bypass
 * calibration by returning a convenient number — the service calibrates whatever the stage returned,
 * through the same table the real adapter would have used.
 *
 * The result carries the branded `CalibratedConfidence`, so `laneFor` refuses a raw value at compile
 * time (ADR-009).
 */
export function calibrateAiResult(
  result: AiClassifyResult,
  calibration: CalibrationTable | undefined,
  identity: PromptIdentity = CLASSIFY_PROMPT,
): AiClassifyResult {
  const raw = asRawConfidence(result.rawConfidence);
  const key = calibrationKeyFromPrompt('CLASSIFY', result.model || identity.templateId, {
    templateId: identity.templateId,
    version: String(identity.version),
  });
  return { ...result, calibratedConfidence: calibrate(raw, key, calibration) };
}

/** Kept exported so consumers can name the options bag without reaching into `@finmate/ai`. */
export type { CalibrationTable };

/** A Nest provider token, so a stub swaps in without touching the pipeline. */
export const AI_CLASSIFIER = Symbol('AI_CLASSIFIER');
