import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_CLASSIFIER, type AiClassifier, type ClassifyRequest } from './ai-classifier';
import { ClassificationModule } from './classification.module';
import type { AiStageResult } from './classification.pipeline';
import { ClassificationService } from './classification.service';
import { EMBEDDINGS, type EmbeddingProvider, type EmbeddingRequest } from './embedding-provider';
import { EntityEmbeddingsService } from './entity-embeddings.service';

/**
 * Rung 5 against a real database and a real `pgvector` index (docs/04 §4, ADR-021).
 *
 * ## What a unit test could not reach
 *
 * Three things here only exist at this layer:
 *
 * 1. **The vector round-trip.** `entity_embeddings.embedding` is `Unsupported("vector")`, so every
 *    read and write is hand-written SQL, and `toVectorLiteral` → `::vector` → `<=>` is a path no pure
 *    test touches.
 * 2. **`household_id` in that SQL.** Raw statements bypass the tenancy guard, so the scoping
 *    predicate is written by hand — and the isolation test below is the only thing that can catch it
 *    being forgotten (ADR-008).
 * 3. **Where rung 5 sits in the ladder.** The interesting behaviour is *when it is not consulted*: a
 *    fragment a rule or a keyword handled must not pay for a model call.
 *
 * ## The provider is a deterministic stub, and that is the shipped configuration
 *
 * No local embedding model exists in this build, so the module provides `UNCONFIGURED_EMBEDDINGS` and
 * rung 5 is inert — the last test asserts exactly that, because "it does nothing when unconfigured" is
 * a feature here, not a gap. The stub below is what a configured deployment looks like from the
 * pipeline's point of view: a bag-of-tokens vector, enough to make `Dejan` land near `Dejan rođa`
 * without pretending to be a real model.
 */
describe('rung 5 — embedding entity resolution (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let classification: ClassificationService;
  let embeddings: EntityEmbeddingsService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'rung5' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'rung5-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  const aiCalls: ClassifyRequest[] = [];
  const failingClassifier: AiClassifier = {
    classify: (request: ClassifyRequest): Promise<AiStageResult> => {
      aiCalls.push(request);
      return Promise.resolve({
        unavailable: true,
        rung: 'RULES_KEYWORDS_ONLY',
        reason: 'PROVIDER_UNAVAILABLE:test',
      });
    },
  };

  /**
   * **A fixture, not a model.** The width is the schema's (`vector(384)`), and the vectors are given
   * rather than computed.
   *
   * This is deliberate. What is under test here is the *plumbing* — that a cosine above the threshold
   * resolves an entity, that the default Category travels with it, that the household scoping holds,
   * that a lexical rung short-circuits it. Whether a real model puts `Dejan` near `Dejan rođa` is a
   * property of the model, and no test in this file can establish it; ADR-021 leaves that to the model
   * choice and says so. A hand-rolled "semantic-ish" stand-in (a trigram bag was the first attempt)
   * would clear some thresholds and not others and would quietly become the thing being tested.
   *
   * So: `Dejan` and `Dejan rođa` are given vectors at cosine 0.98 by construction; every other text
   * gets a distinct, orthogonal one.
   */
  const DIMS = 384;

  /** Fixed near-identical vectors for the pair the ladder has to connect. */
  const FIXTURE: readonly (readonly [RegExp, number])[] = [
    [/dejan/i, 0],
    [/lidl/i, 1],
  ];

  function fixtureVector(text: string): number[] {
    const vector = new Array<number>(DIMS).fill(0);
    const family = FIXTURE.find(([pattern]) => pattern.test(text));
    if (family === undefined) {
      // A unique, orthogonal direction for anything else, so unrelated names cannot accidentally
      // clear the threshold.
      let hash = 7;
      for (const character of text) hash = (hash * 31 + character.charCodeAt(0)) % DIMS;
      vector[(hash + 8) % DIMS] = 1;
      return vector;
    }

    // 0.98 cosine between two members of the same family: almost the same direction, with a small
    // orthogonal component so they are not identical vectors.
    vector[family[1]] = 1;
    vector[family[1] + 2] = 0.2;
    return vector;
  }

  const stubProvider: EmbeddingProvider = {
    model: 'fixture-embedding-v1',
    dims: DIMS,
    embed: (request: EmbeddingRequest) =>
      Promise.resolve({
        vectors: request.texts.map((text) => fixtureVector(text)),
        model: 'fixture-embedding-v1',
        dims: DIMS,
      }),
  };

  let dejanId: string;
  let pokloniId: string;
  let septicId: string;

  async function build(provider: EmbeddingProvider): Promise<TestingModule> {
    return Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, ClassificationModule],
    })
      .overrideProvider(AI_CLASSIFIER)
      .useValue(failingClassifier)
      .overrideProvider(EMBEDDINGS)
      .useValue(provider)
      .compile();
  }

  beforeAll(async () => {
    moduleRef = await build(stubProvider);
    prisma = moduleRef.get(PrismaService);
    classification = moduleRef.get(ClassificationService);
    embeddings = moduleRef.get(EntityEmbeddingsService);

    const stamp = Date.now();
    await prisma.client.users.create({
      data: { id: userId, email: `rung5-${stamp}@example.com`, display_name: 'Rung Five' },
    });
    await prisma.client.users.create({
      data: { id: otherUserId, email: `rung5-b-${stamp}@example.com`, display_name: 'Other' },
    });

    await asTenant(async () => {
      await prisma.client.households.create({
        data: { id: householdId, name: 'Rung Five', owner_user_id: userId, ledger_currency: 'RSD' },
      });

      pokloniId = uuidv7();
      septicId = uuidv7();
      await prisma.client.categories.createMany({
        data: [
          { id: pokloniId, household_id: householdId, name: 'Pokloni', kind: 'EXPENSE' },
          { id: septicId, household_id: householdId, name: 'Septička jama', kind: 'EXPENSE' },
        ],
      });

      // The entity rung 5 has to find when rung 3 cannot: the name has two tokens and the input one.
      dejanId = uuidv7();
      await prisma.client.counterparties.create({
        data: {
          id: dejanId,
          household_id: householdId,
          name: 'Dejan rođa',
          type: 'PERSON',
          default_category_id: pokloniId,
        },
      });
    });

    await runWithTenant(otherContext, async () => {
      await prisma.client.households.create({
        data: { id: otherHouseholdId, name: 'Other', owner_user_id: otherUserId, ledger_currency: 'RSD' },
      });
      // A same-named entity in ANOTHER household. Raw SQL bypasses the guard, so this row is what
      // proves the hand-written `household_id` predicate is doing its job.
      await prisma.client.counterparties.create({
        data: { id: uuidv7(), household_id: otherHouseholdId, name: 'Dejan rođa', type: 'PERSON' },
      });
    });
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, () => prisma.client.households.deleteMany({ where: { id } }));
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef?.close();
  });

  // -------------------------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------------------------

  it('is available when a model is configured, and inert when it is not', async () => {
    expect(embeddings.isAvailable()).toBe(true);

    const inert = await build({ model: 'none', dims: 0, embed: () => Promise.reject(new Error('never')) });
    const inertService = inert.get(EntityEmbeddingsService);
    expect(inertService.isAvailable()).toBe(false);
    // No model means no vectors and no queries at all — not a failed call, and not a log line.
    await runWithTenant(context, () => expect(inertService.syncMissing(householdId)).resolves.toEqual({
      embedded: 0,
      model: 'none',
      unavailable: true,
    }));
    await inert.close();
  });

  it('treats a provider of the wrong width as unavailable, not as broken', async () => {
    // `entity_embeddings.embedding` is `vector(384)`, a CHECK Postgres enforces. A 768-dimension model
    // would otherwise fail every insert with `expected 384 dimensions` — one opaque error per row, on
    // the sync path. Reporting unavailable makes rung 5 inert instead.
    const wrongWidth = await build({ model: 'too-wide', dims: 768, embed: () => Promise.reject(new Error('never')) });
    const service = wrongWidth.get(EntityEmbeddingsService);
    expect(service.isAvailable()).toBe(false);
    await runWithTenant(context, () =>
      expect(service.syncMissing(householdId)).resolves.toEqual({
        embedded: 0,
        model: 'too-wide',
        unavailable: true,
      }),
    );
    await wrongWidth.close();
  });

  it('writes one vector per entity, keyed by the model', async () => {
    const result = await asTenant(() => embeddings.syncMissing(householdId));
    expect(result.unavailable).toBe(false);
    expect(result.embedded).toBeGreaterThanOrEqual(1);

    const rows = await asTenant(() =>
      prisma.client.entity_embeddings.findMany({
        where: { household_id: householdId },
        select: { owner_id: true, owner_type: true, model: true, dims: true, source_text: true },
      }),
    );
    const dejan = rows.find((row) => row.owner_id === dejanId);
    expect(dejan?.owner_type).toBe('COUNTERPARTY');
    expect(dejan?.model).toBe('fixture-embedding-v1');
    expect(dejan?.dims).toBe(DIMS);
    // The source text is what explains the vector, so it must name the entity.
    expect(dejan?.source_text).toContain('Dejan rođa');
  });

  it('is idempotent: a second sync writes nothing new', async () => {
    // `ON CONFLICT` on the table's unique key, so a re-sync updates rather than duplicating — without
    // it a sync loop would grow the table without bound.
    const second = await asTenant(() => embeddings.syncMissing(householdId));
    expect(second.embedded).toBe(0);

    const count = await asTenant(() =>
      prisma.client.entity_embeddings.count({ where: { household_id: householdId, owner_id: dejanId } }),
    );
    expect(count).toBe(1);
  });

  it('returns the nearest entity, with its default Category', async () => {
    const hit = await asTenant(() => embeddings.embedText(householdId, 'Dejan'));
    expect(hit?.id).toBe(dejanId);
    expect(hit?.kind).toBe('COUNTERPARTY');
    expect(hit?.name).toBe('Dejan rođa');
    // The default Category travels with the hit, which is what lets the entity-default stage
    // categorise from it — the reason rung 5 is a *resolution* rung and not just a label.
    expect(hit?.defaultCategoryId).toBe(pokloniId);
    expect(hit?.cosine).toBeGreaterThan(0.82);
  });

  it('returns null when nothing is close enough, rather than the least-bad row', async () => {
    // A nearest-neighbour search always has a nearest neighbour. Returning it unconditionally is how
    // rung 5 would resolve every unknown merchant to whichever name it happened to resemble.
    const hit = await asTenant(() => embeddings.embedText(householdId, 'Kvantna fizika'));
    expect(hit).toBeNull();
  });

  it('does NOT see another Household’s entities, which raw SQL would otherwise allow', async () => {
    // This is the test that justifies the hand-written `household_id` predicate: the other household
    // has a Counterparty with the SAME name, so a missing predicate would still return a plausible
    // answer — and it would be somebody else's person (ADR-008).
    const hit = await asTenant(() => embeddings.embedText(householdId, 'Dejan'));
    expect(hit?.id).toBe(dejanId);

    const otherHit = await runWithTenant(otherContext, () => embeddings.embedText(otherHouseholdId, 'Dejan'));
    expect(otherHit?.id).not.toBe(dejanId);
  });

  // -------------------------------------------------------------------------------------------
  // The ladder
  // -------------------------------------------------------------------------------------------

  it('resolves `Dejan 2000`, which rungs 1–4 cannot — the F-09 shorthand', async () => {
    // docs/04 §8.1.1 records that this is exactly the case the ladder misses: rung 3 requires every
    // token of `Dejan rođa` to be present, and trigram similarity of `dejan` against `dejan roda` is
    // 0.545 — just under rung 4's 0.55. Rung 5 is what §4 says exists for this.
    aiCalls.length = 0;
    const result = await asTenant(() =>
      classification.parse(householdId, { text: 'Dejan 2000', allowAi: false }),
    );
    const fragment = result.fragments[0]!;

    expect(fragment.counterpartyId).toBe(dejanId);
    expect(fragment.merchantId).toBeNull();
    // And the default Category came with it, through the ordinary entity-default stage.
    expect(fragment.categoryId).toBe(pokloniId);
    // An embedding call is not a classification call: the AI stage is still never reached (ADR-002).
    expect(aiCalls).toHaveLength(0);
  });

  it('never auto-applies a rung-5 hit: the band tops out at 0.85, so the lane is verify', async () => {
    // docs/04 §4 fixes rung 5's confidence band at 0.60–0.85 and ADR-009 auto-applies only at >= 0.90,
    // so a semantic match must reach the user rather than silently becoming their data. This is the
    // property that was broken until 2.3.4: the entity-default stage wrote **1.00** for every
    // MERCHANT_DEFAULT/COUNTERPARTY_DEFAULT however the entity had been found, which auto-applied a
    // Category on a cosine guess. docs/04 §8.1.4 records the defect; this test is the guard.
    const result = await asTenant(() =>
      classification.parse(householdId, { text: 'Dejan 700', allowAi: false }),
    );
    const fragment = result.fragments[0]!;

    expect(fragment.decidedBy).toBe('COUNTERPARTY_DEFAULT');
    expect(fragment.confidence).toBeGreaterThanOrEqual(0.6);
    expect(fragment.confidence).toBeLessThan(0.9);
    // Applied, and **not** blocking: only < 0.60 or a null Category blocks (I-8). The 🟡 "verify"
    // badge the user sees comes from the number itself (`apps/web`'s `confidenceBand`), which is why
    // the confidence is the thing under test. `advisory` stays false here on purpose: docs/04 §7's lane
    // table scopes advisory membership to `category_source = 'AI'`, and rung 5 is not a model's guess
    // about the *category*, it is a model's guess about the *entity*. See docs/04 §8.1.4.
    expect(fragment.needsReview).toBe(false);
    expect(fragment.advisory).toBe(false);

    // The row, not just the return value: this is what the ledger and the audit trail read.
    const row = await asTenant(() =>
      prisma.client.classification_decisions.findFirst({
        where: { id: fragment.decisionId },
        select: { confidence: true, decided_by: true },
      }),
    );
    expect(Number(row?.confidence)).toBeLessThan(0.9);
    expect(row?.decided_by).toBe('COUNTERPARTY_DEFAULT');
  });

  it('prefers a lexical rung when one hits, and does not pay for a model call', async () => {
    // "cheapest first, stopping when a confident hit is found" (docs/04 §4). A name typed in full
    // resolves on rung 2, so the embedding index must not be consulted at all.
    const calls: string[] = [];
    const counting = await build({
      model: 'fixture-embedding-v1',
      dims: DIMS,
      embed: (request) => {
        calls.push(...request.texts);
        return Promise.resolve({
          vectors: request.texts.map((text) => trigramVector(text)),
          model: 'fixture-embedding-v1',
          dims: DIMS,
        });
      },
    });
    const countingClassification = counting.get(ClassificationService);

    await runWithTenant(context, () =>
      countingClassification.parse(householdId, { text: 'Dejan rođa 3600', allowAi: false }),
    );
    expect(calls).toEqual([]);

    // …and it IS consulted when the lexical rungs miss.
    await runWithTenant(context, () =>
      countingClassification.parse(householdId, { text: 'Dejan 2000', allowAi: false }),
    );
    expect(calls).toEqual(['Dejan']);
    await counting.close();
  });

  it('records rung 5 in the audit blob, so "why this person?" is answerable', async () => {
    const result = await asTenant(() =>
      classification.parse(householdId, { text: 'Dejan 500', allowAi: false }),
    );
    const decision = await asTenant(() =>
      prisma.client.classification_decisions.findFirst({
        where: { id: result.fragments[0]!.decisionId },
        select: { candidates: true },
      }),
    );

    const blob = decision?.candidates as Record<string, unknown> | null;
    const provenance = blob?.['entityEmbedding'] as Record<string, unknown> | null | undefined;
    expect(provenance?.['kind']).toBe('COUNTERPARTY');
    expect(provenance?.['model']).toBe('fixture-embedding-v1');
    expect(provenance?.['cosine']).toBeGreaterThan(0.82);
  });

  it('falls through to unresolved when the provider cannot answer', async () => {
    // A model that passes the availability check and then fails must degrade to rung 4, not fail the
    // capture: docs/04 §9's ladder ends in "rules + keywords only".
    const failing = await build({
      model: 'fixture-embedding-v1',
      dims: DIMS,
      embed: () => Promise.resolve({ unavailable: true, reason: 'MODEL_DOWN:test' }),
    });

    const result = await runWithTenant(context, () =>
      failing.get(ClassificationService).parse(householdId, { text: 'Dejan 700', allowAi: false }),
    );
    expect(result.fragments[0]?.counterpartyId).toBeNull();
    await failing.close();
  });

  it('drops an entity’s vector when it is removed, so a dead name stops resolving', async () => {
    const removed = await asTenant(() => embeddings.removeFor('COUNTERPARTY', dejanId));
    expect(removed).toBe(1);
    expect(await asTenant(() => embeddings.embedText(householdId, 'Dejan'))).toBeNull();

    // Restore it, because the tests above share one household and order is not guaranteed.
    await asTenant(() => embeddings.syncMissing(householdId));
    expect((await asTenant(() => embeddings.embedText(householdId, 'Dejan')))?.id).toBe(dejanId);
  });

  it('never compares a vector written by a different model', async () => {
    // A mixed table is a real state: the model is configuration. Rows under another model must be
    // invisible to `nearest`, or their geometry would be compared against a foreign space.
    await asTenant(() =>
      prisma.client.$executeRaw`
        UPDATE entity_embeddings SET model = 'some-other-model' WHERE owner_id = ${dejanId}::uuid
      `,
    );
    expect(await asTenant(() => embeddings.embedText(householdId, 'Dejan'))).toBeNull();

    await asTenant(() => embeddings.syncMissing(householdId));
    expect((await asTenant(() => embeddings.embedText(householdId, 'Dejan')))?.id).toBe(dejanId);
  });
});
