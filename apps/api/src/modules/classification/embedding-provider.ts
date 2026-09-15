/**
 * The embedding seam — docs/04 §4 rung 5, ADR-007, ADR-021.
 *
 * ## Why this is an interface with an inert default
 *
 * docs/04 §4 puts rung 5 last ("cheapest first, stopping when a confident hit is found") and says
 * *"a free local embedding model is sufficient"*. The model is a **deployment** choice, not a
 * pipeline one, so the pipeline takes a callback and the module decides what — if anything — answers
 * it. That is the same shape as {@link AiClassifier}, and it is deliberate: a feature module never
 * calls a vendor (AGENTS.md rule 10), and a test can count invocations.
 *
 * `UNCONFIGURED_EMBEDDINGS` is the honest default. No local model is running in this environment, so
 * rung 5 is **inert**: the ladder simply ends at rung 4 exactly as it did before this task. That is
 * the true state, and it is better than shipping a "semantic" stand-in that only looks like one — see
 * ADR-021 for the alternative that was rejected and why.
 *
 * ## Residency is satisfied by construction, not by a check
 *
 * ADR-007 allows `LOCAL` egress and requires an explicit `_EU` suffix otherwise. Rung 5's vectors are
 * built from a Household's own entity names, which are personal data, so an embedding call is a
 * `PARSE`-class egress. Two things keep this honest:
 *
 * 1. the only provider this build can be configured with is local (in-process, or an endpoint on the
 *    same host) — which is why the interface has no `endpoint`/`apiKey`, unlike `packages/ai`'s
 *    adapters. A non-local embedding provider would need a consent-gated exception first, and that is
 *    a change to this file rather than a configuration value;
 * 2. an **unavailable** provider is a value, not a throw, so a missing model degrades to rungs 1–4
 *    instead of failing a capture.
 *
 * @module apps/api/src/modules/classification
 */

/** DI token. Injected as a callback, so no caller imports a provider. */
export const EMBEDDINGS = Symbol('EMBEDDINGS');

/**
 * The width the **schema** requires: `entity_embeddings.embedding` is `vector(384)` (docs/03 §4).
 *
 * This is not a preference — it is a `CHECK` Postgres enforces, and it is worth being loud about
 * because it means the column has already narrowed the model choice to the 384-dimension family
 * (multilingual MiniLM, E5-small, LaBSE-small all qualify). A provider of another width does not
 * merely compare badly; every `INSERT` fails with `expected 384 dimensions`, on the sync path, one row
 * at a time.
 *
 * So the width is checked here and a mismatched provider reports itself **unavailable**, which makes
 * rung 5 inert instead of broken — the same degradation as no model at all. ADR-021 records the
 * constraint and the family it admits.
 */
export const EMBEDDING_DIMS = 384;

/** Which table an embedding belongs to. Mirrors `entity_embeddings.owner_type` (docs/03 §4). */
export type EmbeddingOwnerType = 'MERCHANT' | 'COUNTERPARTY';

export interface EmbeddingRequest {
  /** The texts to embed, in order. One vector per entry comes back. */
  readonly texts: readonly string[];
  /**
   * Which table the texts came from, when they came from one.
   *
   * Absent for a **query** — a fragment's description belongs to no table — and present when a batch
   * of entities is being indexed, so an implementation may project names and person names differently.
   */
  readonly ownerType?: EmbeddingOwnerType;
}

export interface EmbeddingVector {
  readonly vectors: readonly (readonly number[])[];
  /** Identifies the vector space. Stored per row, because a model change invalidates every vector. */
  readonly model: string;
  readonly dims: number;
}

/** No model answered. A value, so the caller falls back rather than throwing. */
export interface EmbeddingUnavailable {
  readonly unavailable: true;
  readonly reason: string;
}

export type EmbeddingOutcome = EmbeddingVector | EmbeddingUnavailable;

/**
 * What the pipeline needs from a model.
 *
 * `model` and `dims` are on the provider rather than only on a result because they are what a
 * *stored* vector is keyed by: `entity_embeddings` is unique on `(owner_type, owner_id, model)`, so a
 * vector written by one model must never be compared against a query embedded by another.
 */
export interface EmbeddingProvider {
  readonly model: string;
  /** Must equal {@link EMBEDDING_DIMS}. A mismatch is treated as "no provider", not as a crash. */
  readonly dims: number;
  embed(request: EmbeddingRequest): Promise<EmbeddingOutcome>;
}

/**
 * Whether a provider can be used at all: it names a real model and matches the column's width.
 *
 * The one place that rule lives, so a provider cannot be "available" in one caller and not another.
 */
export function isEmbeddingProviderUsable(provider: EmbeddingProvider): boolean {
  return provider.model !== 'none' && provider.dims === EMBEDDING_DIMS;
}

export function isEmbeddingUnavailable(outcome: EmbeddingOutcome): outcome is EmbeddingUnavailable {
  return 'unavailable' in outcome;
}

/**
 * The default: no local model, so rung 5 never fires.
 *
 * Named rather than anonymous so a log or a test failure says which state the process is in. The
 * `model` is `'none'` and `dims` is `0` — not a plausible-looking name, because a row written under a
 * fake model name would be indistinguishable from a real one in the table.
 */
export const UNCONFIGURED_EMBEDDINGS: EmbeddingProvider = {
  model: 'none',
  dims: 0,
  embed: (request: EmbeddingRequest): Promise<EmbeddingOutcome> =>
    Promise.resolve({
      unavailable: true,
      reason: `NO_EMBEDDING_PROVIDER: no local model configured, ${request.texts.length} text(s) not embedded`,
    }),
};
