/**
 * Provider list prices, and the per-call cost that goes into `classification_decisions`.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §9 — "Cost and latency recorded per call into
 * `classification_decisions` (`cost_micros`, `latency_ms`), which makes per-household unit
 * economics measurable rather than guessed."
 *
 * ## Micros, not floats
 *
 * `cost_micros` is an **integer**: millionths of one unit of the account's billing currency (USD
 * for both OpenAI and DeepSeek). It is computed as
 * `round((promptTokens * promptUsdPerMillion + completionTokens * completionUsdPerMillion))`,
 * because a price quoted per *million* tokens over a token count yields millionths directly.
 * Integer micros keep a running total exact; the money path proper (`transactions.amount_minor`)
 * never sees a model's cost at all (ADR-003).
 *
 * ## Prices move; this table is deliberately conservative
 *
 * These are list prices captured for cost *attribution*, not billing. A price that is stale by a
 * factor of two still answers "which Household is expensive and why", which is the question §12
 * asks. A model with no entry costs `0` and is reported as `priced: false`, so an unknown model is
 * visible as a hole rather than silently priced as free.
 *
 * @module @finmate/ai
 */

/** USD per million tokens, both directions. */
export interface ModelPrice {
  readonly promptUsdPerMillion: number;
  readonly completionUsdPerMillion: number;
}

/**
 * List prices, USD per million tokens.
 *
 * Only models this package can actually address appear here. Adding an entry is a data edit, not a
 * dependency — which is the point of keeping the pricing table in-package rather than reaching for
 * a vendor pricing SDK.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // OpenAI (docs/04 §9's OPENAI_EU route).
  'gpt-4o-mini': { promptUsdPerMillion: 0.15, completionUsdPerMillion: 0.6 },
  'gpt-4o': { promptUsdPerMillion: 2.5, completionUsdPerMillion: 10 },
  // DeepSeek (the CLASSIFY/PARSE EEA fallback). Cache-miss list price.
  'deepseek-chat': { promptUsdPerMillion: 0.27, completionUsdPerMillion: 1.1 },
});

export interface CallCost {
  /** Integer micro-units; `0` when either token count is unknown or the model is unpriced. */
  readonly costMicros: number;
  /** False when the model has no entry in {@link MODEL_PRICES}, so the `0` is a gap, not a price. */
  readonly priced: boolean;
}

/**
 * The cost of one call.
 *
 * An unknown token count yields `0` rather than a guess: attributing a made-up cost is worse than
 * attributing none, because the first is invisible and the second is a hole a dashboard shows.
 */
export function costMicros(
  model: string | null,
  promptTokens: number | null,
  completionTokens: number | null,
): CallCost {
  if (model === null) return { costMicros: 0, priced: false };
  const price = MODEL_PRICES[model];
  if (price === undefined) return { costMicros: 0, priced: false };
  if (promptTokens === null && completionTokens === null) return { costMicros: 0, priced: true };

  const micros =
    (promptTokens ?? 0) * price.promptUsdPerMillion +
    (completionTokens ?? 0) * price.completionUsdPerMillion;
  return { costMicros: Math.round(micros), priced: true };
}
