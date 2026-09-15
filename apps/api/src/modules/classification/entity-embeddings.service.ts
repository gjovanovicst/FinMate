import { Inject, Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import {
  EMBEDDINGS,
  isEmbeddingProviderUsable,
  isEmbeddingUnavailable,
  type EmbeddingOwnerType,
  type EmbeddingProvider,
} from './embedding-provider';
import {
  EMBEDDING_NEIGHBOUR_LIMIT,
  cosineFromDistance,
  embeddingSourceText,
  pickEmbeddingNeighbour,
  type EmbeddingNeighbour,
} from './embedding-resolver';
import type { EmbeddingEntityCandidate } from './classification.pipeline';

/**
 * Household-local entity vectors — docs/04 §4 rung 5, docs/03 §4's `entity_embeddings`.
 *
 * ## Why this file is raw SQL
 *
 * `entity_embeddings.embedding` is `Unsupported("vector")` in the derived Prisma schema (docs/03 §4),
 * so Prisma can neither write it nor order by it. Every statement here is `$queryRaw`/`$executeRaw`
 * for that reason and **not** for speed — which has one consequence that must not be lost:
 *
 * > **Raw SQL bypasses the tenancy guard.** `household_id = $1` is written out by hand in every
 * > statement below, and it is the *only* thing keeping one Household's vectors out of another's
 * > results. A `nearest()` without it would resolve a name across households, which is exactly the
 * > cross-tenant leak ADR-008 exists to prevent. There is a test for it.
 *
 * ## Vectors are per (entity, model)
 *
 * The table is unique on `(owner_type, owner_id, model)` because a vector is only meaningful inside
 * the space that produced it. Changing the model does not corrupt anything: the old rows stop
 * matching (their dimension or their geometry no longer applies), `syncMissing` writes the new ones,
 * and `nearest` filters on the current model so a mixed table can never be compared.
 *
 * ## Nothing here runs unless a model is configured
 *
 * {@link isAvailable} is the first thing every method checks, and the provider is
 * `UNCONFIGURED_EMBEDDINGS` by default (ADR-021). So in this build the class is inert: no queries, no
 * rows, rung 5 never fires, and the ladder ends at rung 4 exactly as before.
 *
 * @module apps/api/src/modules/classification
 */
@Injectable()
export class EntityEmbeddingsService {
  private readonly logger = new Logger(EntityEmbeddingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMBEDDINGS) private readonly provider: EmbeddingProvider,
  ) {}

  /**
   * Whether a model can answer. A caller checks this before doing any work at all.
   *
   * A provider of the wrong width is **not** available: `entity_embeddings.embedding` is `vector(384)`,
   * so a 768-dimension model would fail every insert with an opaque `expected 384 dimensions` on the
   * sync path. Treating that as "no model" makes rung 5 inert — the honest degradation — rather than
   * broken.
   */
  isAvailable(): boolean {
    return isEmbeddingProviderUsable(this.provider);
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  /**
   * The nearest stored entities to `text`, best first.
   *
   * One statement: pgvector orders by `<=>` (cosine distance) using the table's index, and the
   * `owner_type` filter keeps a Merchant from being compared against a Counterparty's vector — the two
   * are different kinds of thing even when their names are similar.
   *
   * Returns `[]` — not a throw — when no model is configured, because "rung 5 is unavailable" and
   * "rung 5 found nothing" have the same meaning to the caller: fall through.
   */
  async nearest(
    householdId: string,
    ownerType: EmbeddingOwnerType,
    vector: readonly number[],
    limit: number = EMBEDDING_NEIGHBOUR_LIMIT,
  ): Promise<readonly EmbeddingNeighbour[]> {
    if (!this.isAvailable() || vector.length !== this.provider.dims) return [];

    const literal = toVectorLiteral(vector);
    const rows = await this.prisma.client.$queryRaw<
      readonly {
        owner_id: string;
        owner_type: string;
        name: string | null;
        default_category_id: string | null;
        distance: number;
      }[]
    >`
      SELECT e.owner_id,
             e.owner_type,
             COALESCE(m.name, c.name)                             AS name,
             COALESCE(m.default_category_id, c.default_category_id) AS default_category_id,
             (e.embedding <=> ${literal}::vector)                 AS distance
      FROM entity_embeddings e
      LEFT JOIN merchants m      ON e.owner_type = 'MERCHANT'     AND m.id = e.owner_id
      LEFT JOIN counterparties c ON e.owner_type = 'COUNTERPARTY' AND c.id = e.owner_id
      WHERE e.household_id = ${householdId}::uuid
        AND e.model = ${this.provider.model}
        AND e.owner_type = ${ownerType}
      ORDER BY e.embedding <=> ${literal}::vector
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      ownerId: row.owner_id,
      ownerType: row.owner_type as EmbeddingOwnerType,
      // A deleted entity can leave a vector behind; dropping the row is better than resolving to a
      // name that no longer exists (`COALESCE` is null when both joins miss).
      name: row.name ?? '',
      defaultCategoryId: row.default_category_id,
      cosine: cosineFromDistance(Number(row.distance)),
    })).filter((neighbour) => neighbour.name !== '');
  }

  /**
   * Embed one fragment description and return the nearest of the Household's own entities.
   *
   * The entry point rung 5 actually uses. The pipeline reaches it only when rungs 1–4 found nothing,
   * so the cost is paid on the fragments that need it and never on the ones a rule already handled.
   *
   * `null` covers every unhelpful outcome — no model, a model that failed, a vector of the wrong
   * width, and nothing above the threshold. They are indistinguishable *to the pipeline*, which is the
   * point: all of them mean "fall through to rung 6".
   */
  async embedText(
    householdId: string,
    description: string,
  ): Promise<EmbeddingEntityCandidate | null> {
    if (!this.isAvailable()) return null;

    const outcome = await this.provider.embed({ texts: [description] });
    if (isEmbeddingUnavailable(outcome)) return null;

    const vector = outcome.vectors[0];
    if (vector === undefined || vector.length !== this.provider.dims) return null;

    const [merchants, counterparties] = await Promise.all([
      this.nearest(householdId, 'MERCHANT', vector, EMBEDDING_NEIGHBOUR_LIMIT),
      this.nearest(householdId, 'COUNTERPARTY', vector, EMBEDDING_NEIGHBOUR_LIMIT),
    ]);

    // Both tables in one pick, because docs/04 §4's ladder is one ordered ladder over entities rather
    // than one per table; the tie-break's Merchant preference is what keeps it consistent with the
    // entity-default stage.
    const best = pickEmbeddingNeighbour([...merchants, ...counterparties]);
    if (best === null) return null;

    return {
      id: best.ownerId,
      kind: best.ownerType,
      name: best.name,
      defaultCategoryId: best.defaultCategoryId,
      cosine: best.cosine,
      model: this.provider.model,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------

  /**
   * Embed every entity of this Household that has no vector for the current model.
   *
   * Idempotent, and the only writer. Called where the entity set actually changes — onboarding's
   * merchant selection — rather than from a read path: `parse` is on the hot path and a keystroke
   * debounce must never turn into a batch of embedding writes.
   *
   * Returns what it did so a caller can say so. `unavailable` is not an error; it is the state of a
   * deployment with no model.
   */
  async syncMissing(
    householdId: string,
  ): Promise<{ embedded: number; model: string; unavailable: boolean }> {
    if (!this.isAvailable()) {
      return { embedded: 0, model: this.provider.model, unavailable: true };
    }

    const [merchants, counterparties, existing] = await Promise.all([
      this.prisma.client.merchants.findMany({
        where: { household_id: householdId, deleted_at: null },
        select: { id: true, name: true, merchant_aliases: { select: { alias: true } } },
      }),
      this.prisma.client.counterparties.findMany({
        where: { household_id: householdId, deleted_at: null },
        select: { id: true, name: true, counterparty_aliases: { select: { alias: true } } },
      }),
      this.prisma.client.entity_embeddings.findMany({
        where: { household_id: householdId, model: this.provider.model },
        select: { owner_id: true },
      }),
    ]);

    const alreadyEmbedded = new Set(existing.map((row) => row.owner_id));

    const pending: { ownerId: string; ownerType: EmbeddingOwnerType; source: string }[] = [];
    for (const row of merchants) {
      if (alreadyEmbedded.has(row.id)) continue;
      pending.push({
        ownerId: row.id,
        ownerType: 'MERCHANT',
        source: embeddingSourceText(row.name, row.merchant_aliases.map((alias) => alias.alias)),
      });
    }
    for (const row of counterparties) {
      if (alreadyEmbedded.has(row.id)) continue;
      pending.push({
        ownerId: row.id,
        ownerType: 'COUNTERPARTY',
        source: embeddingSourceText(row.name, row.counterparty_aliases.map((alias) => alias.alias)),
      });
    }

    if (pending.length === 0) {
      return { embedded: 0, model: this.provider.model, unavailable: false };
    }

    let embedded = 0;
    // One call per owner type: the provider is told which table the text came from, so an
    // implementation can use a different projection for names than for person names if it wants to.
    for (const ownerType of ['MERCHANT', 'COUNTERPARTY'] as const) {
      const batch = pending.filter((entry) => entry.ownerType === ownerType);
      if (batch.length === 0) continue;

      const outcome = await this.provider.embed({
        texts: batch.map((entry) => entry.source),
        ownerType,
      });
      if (isEmbeddingUnavailable(outcome)) {
        // A provider that answered the availability check and then failed: report it rather than
        // throwing, so a sync never takes down the caller that triggered it.
        this.logger.warn(`embedding sync stopped: ${outcome.reason}`);
        return { embedded, model: this.provider.model, unavailable: true };
      }

      for (const [index, entry] of batch.entries()) {
        const vector = outcome.vectors[index];
        if (vector === undefined || vector.length !== this.provider.dims) continue;
        await this.upsert(householdId, entry.ownerType, entry.ownerId, entry.source, vector);
        embedded += 1;
      }
    }

    return { embedded, model: this.provider.model, unavailable: false };
  }

  /**
   * Write one vector, replacing any previous one for this `(entity, model)`.
   *
   * `ON CONFLICT` on the table's own unique key, so a re-sync of the same entity updates rather than
   * duplicating — and so two concurrent syncs cannot both insert.
   */
  private async upsert(
    householdId: string,
    ownerType: EmbeddingOwnerType,
    ownerId: string,
    sourceText: string,
    vector: readonly number[],
  ): Promise<void> {
    const literal = toVectorLiteral(vector);
    await this.prisma.client.$executeRaw`
      INSERT INTO entity_embeddings (id, household_id, owner_type, owner_id, model, dims, embedding, source_text, updated_at)
      VALUES (gen_random_uuid(), ${householdId}::uuid, ${ownerType}, ${ownerId}::uuid, ${this.provider.model},
              ${this.provider.dims}, ${literal}::vector, ${sourceText}, now())
      ON CONFLICT (owner_type, owner_id, model)
      DO UPDATE SET embedding = EXCLUDED.embedding,
                    source_text = EXCLUDED.source_text,
                    dims = EXCLUDED.dims,
                    updated_at = now()
    `;
  }

  /** Drop an entity's vectors. Called when an entity is removed, so a deleted name stops resolving. */
  async removeFor(ownerType: EmbeddingOwnerType, ownerId: string): Promise<number> {
    const affected = await this.prisma.client.$executeRaw`
      DELETE FROM entity_embeddings WHERE owner_type = ${ownerType} AND owner_id = ${ownerId}::uuid
    `;
    return affected;
  }
}

/**
 * A pgvector literal: `[0.1,0.2,…]`.
 *
 * Six decimal places is what a 384–1536 dimension model needs to stay distinguishable; more would
 * only make the statement longer. These numbers are **not money** — ADR-003 governs `amount_minor`,
 * and a similarity vector is a different kind of value entirely.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => value.toFixed(6)).join(',')}]`;
}
