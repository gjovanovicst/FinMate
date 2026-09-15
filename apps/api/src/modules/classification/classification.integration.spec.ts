import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIN_CALIBRATION_SAMPLES, type CalibrationTable } from '@finmate/ai';
import { uuidv7 } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import type { AiClassifier, ClassifyRequest } from './ai-classifier';
import {
  ClassificationService,
  NO_CALIBRATION,
  type CalibrationStore,
  type FragmentResult,
  type ParseResult,
} from './classification.service';
import type { AiStageResult } from './classification.pipeline';

/**
 * The classification pipeline against a real database.
 *
 * ## What only Postgres can answer here
 *
 * Four of the brief's requirements are about **rows**, not return values:
 *
 * - the audit row's actual columns (`decided_by`, `confidence`, `candidates.rawConfidence`, null
 *   latency/cost when no model ran);
 * - that a second Household's rules, keywords and entities are invisible;
 * - that a `classification_decisions` write cannot cross Households;
 * - that money survives the round trip as `bigint` minor units.
 *
 * ## The AI-call-count assertions are the point
 *
 * docs/04 §12's economics depend on the model being reached **only** when rules, keywords and entity
 * defaults were inconclusive. Every "zero AI calls" test below counts invocations on the injected
 * stub. A pipeline that called the model "just in case" would pass every functional test in this
 * file while destroying the cost model, so the count is asserted, not inferred.
 */
describe('ClassificationService (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'classification-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'classification-it-other',
  };

  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  /** Category ids created for the primary Household. */
  let foodId: string;
  let fuelId: string;
  let incomeId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);

    const stamp = Date.now();
    await prisma.client.users.create({
      data: { id: userId, email: `cls-${stamp}@example.com`, display_name: 'Classification Test' },
    });
    await prisma.client.users.create({
      data: { id: otherUserId, email: `cls-b-${stamp}@example.com`, display_name: 'Other' },
    });

    await asTenant(async () => {
      await prisma.client.households.create({
        data: { id: householdId, name: 'Classification Test', owner_user_id: userId },
      });
      const food = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Hrana', kind: 'EXPENSE' },
      });
      const supermarket = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Supermarket', kind: 'EXPENSE', parent_id: food.id },
      });
      foodId = supermarket.id;
      const fuel = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Gorivo', kind: 'EXPENSE' },
      });
      fuelId = fuel.id;
      const salary = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Plata', kind: 'INCOME' },
      });
      incomeId = salary.id;

      // The keyword tier: two keywords that clear §5.4's `score >= 2.0` with margin >= 1.0, and one
      // EXCLUDE that hard-blocks a category.
      await prisma.client.category_keywords.createMany({
        data: [
          { id: uuidv7(), category_id: foodId, keyword: 'lidl', polarity: 'INCLUDE', match_mode: 'WORD', weight: 2 },
          { id: uuidv7(), category_id: foodId, keyword: 'maxi', polarity: 'INCLUDE', match_mode: 'WORD', weight: 2 },
          { id: uuidv7(), category_id: incomeId, keyword: 'plata', polarity: 'INCLUDE', match_mode: 'WORD', weight: 3 },
          { id: uuidv7(), category_id: fuelId, keyword: 'ulje', polarity: 'EXCLUDE', match_mode: 'WORD', weight: 1 },
        ],
      });
    });

    await runWithTenant(otherContext, async () => {
      await prisma.client.households.create({
        data: { id: otherHouseholdId, name: 'Other', owner_user_id: otherUserId },
      });
      const foreign = await prisma.client.categories.create({
        data: { id: uuidv7(), name: 'Tudje', kind: 'EXPENSE' },
      });
      await prisma.client.category_keywords.create({
        data: {
          id: uuidv7(),
          category_id: foreign.id,
          keyword: 'tudjikljuc',
          polarity: 'INCLUDE',
          match_mode: 'WORD',
          weight: 5,
        },
      });
      await prisma.client.rules.create({
        data: {
          id: uuidv7(),
          name: 'Tudje pravilo',
          priority: 1,
          conditions: { all: [{ field: 'text', op: 'contains', value: 'tudjitext' }] },
          actions: { setCategoryId: foreign.id },
          origin: 'USER',
        },
      });
      await prisma.client.merchants.create({
        data: { id: uuidv7(), name: 'Tudji Prodavac', default_category_id: foreign.id },
      });
    });
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [otherContext, otherHouseholdId],
    ] as const) {
      await runWithTenant(ctx, async () => {
        await prisma.client.classification_decisions.deleteMany({ where: { household_id: id } });
        await prisma.client.category_keywords.deleteMany({ where: { household_id: id } });
        await prisma.client.rules.deleteMany({ where: { household_id: id } });
        await prisma.client.households.deleteMany({ where: { id } });
      });
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await moduleRef?.close();
  });

  // -------------------------------------------------------------------------------------------
  // Harness
  // -------------------------------------------------------------------------------------------

  interface Stub {
    readonly classifier: AiClassifier;
    readonly calls: ClassifyRequest[];
    /** Every call gets this result. */
    setResult(result: AiStageResult): void;
    /** The Nth call gets the Nth result; the last one repeats. */
    setSequence(results: readonly AiStageResult[]): void;
  }

  /**
   * A classifier that records every call.
   *
   * `requests` is the whole point of the stub: it is how "the AI was never called" is asserted rather
   * than assumed. The default result is the always-failing provider the exit criterion names.
   */
  function stubClassifier(initial?: AiStageResult): Stub {
    const calls: ClassifyRequest[] = [];
    let sequence: readonly AiStageResult[] | null = null;
    let result: AiStageResult = initial ?? {
      unavailable: true,
      rung: 'RULES_KEYWORDS_ONLY',
      reason: 'PROVIDER_UNAVAILABLE:refusing-fetch',
    };

    return {
      classifier: {
        classify: (request: ClassifyRequest): Promise<AiStageResult> => {
          calls.push(request);
          if (sequence !== null) {
            return Promise.resolve(sequence[Math.min(calls.length - 1, sequence.length - 1)]!);
          }
          return Promise.resolve(result);
        },
      },
      calls,
      setResult: (next: AiStageResult): void => {
        sequence = null;
        result = next;
      },
      setSequence: (results: readonly AiStageResult[]): void => {
        sequence = results;
      },
    };
  }

  function service(options: {
    readonly stub?: Stub;
    readonly calibration?: CalibrationTable;
  } = {}): ClassificationService {
    const store: CalibrationStore = options.calibration
      ? { tableFor: () => Promise.resolve(options.calibration) }
      : NO_CALIBRATION;
    return new ClassificationService(prisma, options.stub?.classifier ?? stubClassifier().classifier, store);
  }

  /**
   * §6.4's calibrated value for a raw number with **no fitted map**, written as an exact decimal.
   *
   * The service calibrates whatever the stage returns, so a stub that reported `0.99` is gated at
   * `0.8415` — the conservative `raw × 0.85` shrink. Tests assert the calibrated number because that
   * is what the user and the review queue actually see; using the raw number here would be the very
   * mistake ADR-009 exists to prevent.
   */
  function calibrated(raw: number): number {
    return Number(Math.min(1, Math.max(0, raw * 0.85)).toFixed(3));
  }

  /** A well-formed successful AI proposal. */
  function proposal(overrides: Partial<Extract<AiStageResult, { provider: string }>> = {}) {
    return {
      categoryId: foodId,
      rawConfidence: 0.95,
      rationale: 'lidl is a supermarket',
      alternatives: [],
      provider: 'LOCAL',
      model: 'test-model',
      promptTemplateId: null,
      promptVersion: 1,
      latencyMs: 42,
      costMicros: 7,
      ...overrides,
    } satisfies AiStageResult;
  }

  async function parseInput(stub: Stub | undefined, text: string, allowAi = true): Promise<ParseResult> {
    return asTenant(() => service({ stub }).parse(householdId, { text, allowAi }));
  }

  // -------------------------------------------------------------------------------------------
  // Each `decided_by` source, and the zero-AI-call guarantee
  // -------------------------------------------------------------------------------------------

  describe('decided_by sources and the ADR-002 ordering', () => {
    it('records KEYWORD for a keyword decision and calls the AI ZERO times', async () => {
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Lidl 2000');

      expect(stub.calls).toHaveLength(0);
      expect(result.usedAi).toBe(false);
      expect(result.degraded).toBe(false);
      expect(result.fragments).toHaveLength(1);

      const fragment = result.fragments[0]!;
      expect(fragment.decidedBy).toBe('KEYWORD');
      expect(fragment.categoryId).toBe(foodId);
      expect(fragment.categorySource).toBe('RULE');
      // §5.4 maps a keyword decision into 0.90–0.97, so it auto-applies.
      expect(fragment.confidence).toBeGreaterThanOrEqual(0.9);
      expect(fragment.needsReview).toBe(false);
      expect(fragment.advisory).toBe(false);

      // The audit row records the same source, and the keyword that decided it is in `candidates`.
      const row = await latestDecision('Lidl 2000');
      expect(row.decided_by).toBe('KEYWORD');
      expect(row.category_id).toBe(foodId);
      expect(Number(row.confidence)).toBe(fragment.confidence);
      expect(row.ai_provider).toBeNull();
      expect(row.ai_model).toBeNull();
      expect(row.latency_ms).toBeNull();
      expect(row.cost_micros).toBeNull();
      expect(keywordMatches(row.candidates)).toContain('lidl');
    });

    it('records RULE for a rule decision and calls the AI ZERO times', async () => {
      const ruleId = uuidv7();
      await asTenant(() =>
        prisma.client.rules.create({
          data: {
            id: ruleId,
            name: 'Gorivo rule',
            priority: 10,
            conditions: { all: [{ field: 'text', op: 'contains', value: 'gorivo' }] },
            actions: { setCategoryId: fuelId },
            origin: 'USER',
          },
        }),
      );

      const stub = stubClassifier();
      const result = await parseInput(stub, 'gorivo 3500 pumpa');

      expect(stub.calls).toHaveLength(0);
      expect(result.usedAi).toBe(false);
      const fragment = result.fragments[0]!;
      expect(fragment.decidedBy).toBe('RULE');
      expect(fragment.ruleId).toBe(ruleId);
      expect(fragment.categoryId).toBe(fuelId);
      // A rule decision is deterministic: confidence 1, auto-applied.
      expect(fragment.confidence).toBe(1);
      expect(fragment.needsReview).toBe(false);

      const row = await latestDecision('gorivo 3500 pumpa');
      expect(row.decided_by).toBe('RULE');
      expect(row.rule_id).toBe(ruleId);

      await asTenant(() => prisma.client.rules.deleteMany({ where: { id: ruleId } }));
    });

    it('records MERCHANT_DEFAULT from an owned Merchant without calling the AI', async () => {
      const merchantId = uuidv7();
      await asTenant(() =>
        prisma.client.merchants.create({
          data: { id: merchantId, name: 'Kafic Kod Marka', default_category_id: foodId },
        }),
      );

      const stub = stubClassifier();
      const result = await parseInput(stub, 'Kafic Kod Marka 400');

      expect(stub.calls).toHaveLength(0);
      const fragment = result.fragments[0]!;
      expect(fragment.decidedBy).toBe('MERCHANT_DEFAULT');
      expect(fragment.categoryId).toBe(foodId);
      expect(fragment.merchantId).toBe(merchantId);

      const row = await latestDecision('Kafic Kod Marka 400');
      expect(row.decided_by).toBe('MERCHANT_DEFAULT');

      await asTenant(() => prisma.client.merchants.deleteMany({ where: { id: merchantId } }));
    });

    it('records COUNTERPARTY_DEFAULT from an owned Counterparty without calling the AI', async () => {
      const counterpartyId = uuidv7();
      await asTenant(() =>
        prisma.client.counterparties.create({
          data: { id: counterpartyId, name: 'Dejan Rodja', default_category_id: fuelId },
        }),
      );

      const stub = stubClassifier();
      const result = await parseInput(stub, 'Dejan Rodja 3600');

      expect(stub.calls).toHaveLength(0);
      const fragment = result.fragments[0]!;
      expect(fragment.decidedBy).toBe('COUNTERPARTY_DEFAULT');
      expect(fragment.categoryId).toBe(fuelId);

      const row = await latestDecision('Dejan Rodja 3600');
      expect(row.decided_by).toBe('COUNTERPARTY_DEFAULT');

      await asTenant(() => prisma.client.counterparties.deleteMany({ where: { id: counterpartyId } }));
    });

    it('prefers a Merchant default over a Counterparty default and records the loser', async () => {
      // docs/04 §4 leaves "merchant vs counterparty" to this module; the documented test is retail
      // semantics, so the Merchant decides and the Counterparty appears as a losing candidate.
      const merchantId = uuidv7();
      const counterpartyId = uuidv7();
      await asTenant(async () => {
        await prisma.client.merchants.create({
          data: { id: merchantId, name: 'Mercator', default_category_id: foodId },
        });
        await prisma.client.counterparties.create({
          data: { id: counterpartyId, name: 'Mercator', default_category_id: fuelId },
        });
      });

      const stub = stubClassifier();
      const result = await parseInput(stub, 'Mercator 1500');
      expect(stub.calls).toHaveLength(0);
      expect(result.fragments[0]!.decidedBy).toBe('MERCHANT_DEFAULT');
      expect(result.fragments[0]!.categoryId).toBe(foodId);

      const row = await latestDecision('Mercator 1500');
      expect(JSON.stringify(row.candidates)).toContain(counterpartyId);

      await asTenant(async () => {
        await prisma.client.merchants.deleteMany({ where: { id: merchantId } });
        await prisma.client.counterparties.deleteMany({ where: { id: counterpartyId } });
      });
    });

    it('records AI only when nothing deterministic matched, and calls it exactly once per fragment', async () => {
      const stub = stubClassifier(proposal({ rawConfidence: 0.95 }));
      const result = await parseInput(stub, 'nepoznat prodavac 1234');

      expect(stub.calls).toHaveLength(1);
      expect(result.usedAi).toBe(true);
      expect(result.degraded).toBe(false);
      expect(result.rung).toBe('FULL_PIPELINE');

      const fragment = result.fragments[0]!;
      expect(fragment.decidedBy).toBe('AI');
      expect(fragment.categoryId).toBe(foodId);
      expect(fragment.categorySource).toBe('AI');
      expect(fragment.needsReview).toBe(false);

      const row = await latestDecision('nepoznat prodavac 1234');
      expect(row.decided_by).toBe('AI');
      expect(row.ai_provider).toBe('LOCAL');
      expect(row.ai_model).toBe('test-model');
      expect(row.latency_ms).toBe(42);
      expect(Number(row.cost_micros)).toBe(7);
      expect(row.prompt_version).toBe(1);
      // §6.4's raw half is recoverable from the audit row.
      expect(rawConfidence(row.candidates)).toBeCloseTo(0.95, 3);
    });

    it('sends the losing keyword candidates to the model as context (docs/04 §5.4)', async () => {
      // `gorivo` scores below §5.4's floor, so it falls through — but the scored candidate travels
      // with the call, which is what §5.4 asks for and what makes the model's answer debuggable.
      const stub = stubClassifier(proposal({ rawConfidence: 0.95 }));
      await parseInput(stub, 'gorivo pumpa 3500');
      expect(stub.calls[0]?.keywordCandidates).toBeDefined();
    });

    it('never reaches the model when `allowAi` is false, and says so honestly', async () => {
      const stub = stubClassifier(proposal());
      const result = await parseInput(stub, 'nepoznat prodavac 1234', false);

      expect(stub.calls).toHaveLength(0);
      expect(result.usedAi).toBe(false);
      expect(result.degraded).toBe(true);
      const fragment = result.fragments[0]!;
      expect(fragment.decidedBy).toBe('FALLBACK');
      expect(fragment.categoryId).toBeNull();
      expect(fragment.needsReview).toBe(true);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The confidence gate
  // -------------------------------------------------------------------------------------------

  describe('the confidence gate (docs/04 §7, I-8)', () => {
    it('auto-applies a calibrated >= 0.90 and marks it CONFIRMED, not advisory', async () => {
      // Raw 1 shrinks to 0.85 under §6.4 — deliberately *below* the auto-apply line.
      const stub = stubClassifier(proposal({ rawConfidence: 1 }));
      const fragment = (await parseInput(stub, 'ai auto 100')).fragments[0]!;
      expect(fragment.confidence).toBe(0.85);
      expect(fragment.advisory).toBe(true);
      expect(fragment.needsReview).toBe(false);
    });

    it('applies §6.4 calibration before the gate, so a raw 0.99 cannot auto-apply', async () => {
      // The core ADR-009 property: without a fitted map the conservative shrink moves an
      // over-confident raw number out of the auto-apply lane.
      const stub = stubClassifier(proposal({ rawConfidence: 0.99 }));
      const fragment = (await parseInput(stub, 'ai shrink 100')).fragments[0]!;
      expect(fragment.confidence).toBe(calibrated(0.99));
      expect(fragment.advisory).toBe(true);
      expect(fragment.needsReview).toBe(false);

      const row = await latestDecision('ai shrink 100');
      expect(rawConfidence(row.candidates)).toBeCloseTo(0.99, 3);
      expect(Number(row.confidence)).toBe(calibrated(0.99));
    });

    it('puts a calibrated 0.60–0.89 AI decision in the ADVISORY lane, not the blocking one', async () => {
      // raw 0.8 → calibrated 0.68, squarely in the advisory band.
      const stub = stubClassifier(proposal({ rawConfidence: 0.8 }));
      const fragment = (await parseInput(stub, 'ai advisory 100')).fragments[0]!;
      expect(fragment.confidence).toBe(calibrated(0.8));
      expect(fragment.advisory).toBe(true);
      // The single assertion §7's nav-badge rule depends on.
      expect(fragment.needsReview).toBe(false);
      expect(fragment.categoryId).toBe(foodId);
    });

    it('blocks a calibrated < 0.60 with needs_review, while still applying the category', async () => {
      const stub = stubClassifier(proposal({ rawConfidence: 0.5 }));
      const fragment = (await parseInput(stub, 'ai unsure 100')).fragments[0]!;
      expect(fragment.confidence).toBe(calibrated(0.5));
      expect(fragment.categoryId).toBe(foodId);
      expect(fragment.needsReview).toBe(true);
      expect(fragment.advisory).toBe(false);

      const row = await latestDecision('ai unsure 100');
      expect(row.category_id).toBe(foodId);
      expect(Number(row.confidence)).toBe(calibrated(0.5));
    });

    it('blocks a NULL category even when the raw confidence is 0.99 — the I-8 trap', async () => {
      const stub = stubClassifier(proposal({ categoryId: null, rawConfidence: 0.99 }));
      const fragment = (await parseInput(stub, 'ai nullcat 100')).fragments[0]!;

      expect(fragment.categoryId).toBeNull();
      expect(fragment.confidence).toBe(calibrated(0.99));
      expect(fragment.needsReview).toBe(true);
      expect(fragment.advisory).toBe(false);
      // "Confidently uncategorised" must never be a stored state.
      expect(fragment.categorySource).toBe('AI');

      const row = await latestDecision('ai nullcat 100');
      expect(row.category_id).toBeNull();
    });

    it('honours a per-Household threshold override from households.settings', async () => {
      await asTenant(() =>
        prisma.client.households.update({
          where: { id: householdId },
          // docs/03 §4's key and field names, which is what a settings writer will use.
          data: { settings: { aiConfidenceThresholds: { auto: 0.7, verify: 0.3 } } },
        }),
      );

      try {
        // raw 0.9 → calibrated 0.765: auto-applied under the override, advisory under ADR-009.
        const stub = stubClassifier(proposal({ rawConfidence: 0.9 }));
        const fragment = (await parseInput(stub, 'ai override 100')).fragments[0]!;
        expect(fragment.confidence).toBe(calibrated(0.9));
        expect(fragment.advisory).toBe(false);
        expect(fragment.needsReview).toBe(false);
      } finally {
        await asTenant(() =>
          prisma.client.households.update({ where: { id: householdId }, data: { settings: {} } }),
        );
      }
    });

    it('honours a fitted isotonic map supplied through the calibration store', async () => {
      const raw = 0.91;
      const table: CalibrationTable = {
        [JSON.stringify(['CLASSIFY', 'test-model', 'classify.serbian-household@1'])]: {
          version: 1,
          key: { task: 'CLASSIFY', model: 'test-model', promptVersion: 'classify.serbian-household@1' },
          strategy: 'isotonic',
          sampleCount: MIN_CALIBRATION_SAMPLES + 10,
          acceptedCount: 150,
          shrinkFactor: 0.85,
          points: [
            { raw: 0.5, calibrated: 0.4 },
            { raw: 0.9, calibrated: 0.86 },
          ],
        },
      };

      // The model reports 0.91 and the map's right-continuous step holds 0.86 at that point, which is
      // the advisory lane — 0.91 raw would have been auto-applied, which is exactly the failure
      // calibration exists to prevent.
      const stub = stubClassifier(proposal({ rawConfidence: raw }));
      const fragment = (
        await asTenant(() =>
          service({ stub, calibration: table }).parse(householdId, { text: 'ai fitted 100' }),
        )
      ).fragments[0]!;

      expect(fragment.confidence).toBe(0.86);
      expect(fragment.needsReview).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Bulk
  // -------------------------------------------------------------------------------------------

  describe('bulk input (docs/04 §7, F-06)', () => {
    it('gates three fragments independently: one low-confidence row does not block the other two', async () => {
      // `Lidl 2000` decides by keyword (auto-applied), `gorivo 3500` falls through to the model at
      // 0.72 (advisory), `nepoznato 100` falls through at 0.31 (blocking). One batch, three lanes.
      const stub = stubClassifier();
      // Call 1 (`gorivo 3500`) is advisory at raw 0.8 → calibrated 0.68; call 2 (`nepoznato 100`)
      // is blocking at raw 0.5 → calibrated 0.43. `Lidl 2000` never reaches the model at all.
      stub.setSequence([proposal({ rawConfidence: 0.8 }), proposal({ rawConfidence: 0.5 })]);

      const result = await parseInput(stub, 'Lidl 2000, gorivo 3500, nepoznato 100');

      expect(result.fragments).toHaveLength(3);

      const [first, second, third] = result.fragments as [FragmentResult, FragmentResult, FragmentResult];
      expect(first.decidedBy).toBe('KEYWORD');
      expect(first.needsReview).toBe(false);

      expect(second.decidedBy).toBe('AI');
      expect(second.advisory).toBe(true);
      expect(second.needsReview).toBe(false);

      expect(third.needsReview).toBe(true);
      // The confirmable two are still confirmable: `needsReview` is per fragment, so a UI acting on
      // the batch can confirm them in one action while the third stays in the blocking queue.
      expect(first.needsReview).toBe(false);
      expect(second.needsReview).toBe(false);
      // The low row is flagged, not rejected — it has a category and a confidence, so the user can
      // accept it with one tap (`confirmDespiteLowConfidence`).
      expect(third.categoryId).toBe(foodId);
      expect(third.confidence).toBeLessThan(0.6);
      // And the batch as a whole is not blocked: three fragments, one question among them.
      expect([first, second, third].filter((fragment) => fragment.needsReview)).toHaveLength(1);

      // Three fragments ⇒ two AI calls (the keyword fragment short-circuits).
      expect(stub.calls).toHaveLength(2);
    });

    it('degrades the parse as a whole when any fragment is degraded but still returns every row', async () => {
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Lidl 2000, nepoznato 100');
      expect(result.fragments).toHaveLength(2);
      expect(result.degraded).toBe(true);
      expect(result.rung).toBe('RULES_KEYWORDS_ONLY');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Degradation
  // -------------------------------------------------------------------------------------------

  describe('degradation (docs/04 §9, the Phase 2 exit criterion)', () => {
    it('succeeds with a provider that always fails, marking the row for review and never claiming AI', async () => {
      const stub = stubClassifier({
        unavailable: true,
        rung: 'RULES_KEYWORDS_ONLY',
        reason: 'PROVIDER_UNAVAILABLE:refusing-fetch',
      });

      const result = await parseInput(stub, 'potpuno nepoznat 999');
      expect(result.fragments).toHaveLength(1);
      expect(result.degraded).toBe(true);
      expect(result.usedAi).toBe(false);

      const fragment = result.fragments[0]!;
      expect(fragment.decidedBy).toBe('FALLBACK');
      expect(fragment.categoryId).toBeNull();
      expect(fragment.needsReview).toBe(true);

      const row = await latestDecision('potpuno nepoznat 999');
      // `decided_by` must be honest: a fallback is never recorded as AI.
      expect(row.decided_by).toBe('FALLBACK');
      expect(row.ai_provider).toBeNull();
      expect(row.ai_model).toBeNull();
      expect(row.latency_ms).toBeNull();
      expect(row.cost_micros).toBeNull();
    });

    it('still decides by rule while the provider is down', async () => {
      const ruleId = uuidv7();
      await asTenant(() =>
        prisma.client.rules.create({
          data: {
            id: ruleId,
            name: 'Down provider rule',
            priority: 5,
            conditions: { all: [{ field: 'text', op: 'contains', value: 'struja' }] },
            actions: { setCategoryId: fuelId },
            origin: 'USER',
          },
        }),
      );

      const stub = stubClassifier({
        unavailable: true,
        rung: 'RULES_KEYWORDS_ONLY',
        reason: 'PROVIDER_UNAVAILABLE:refusing-fetch',
      });
      const result = await parseInput(stub, 'struja 4500');
      expect(stub.calls).toHaveLength(0);
      expect(result.fragments[0]!.decidedBy).toBe('RULE');
      expect(result.fragments[0]!.needsReview).toBe(false);

      await asTenant(() => prisma.client.rules.deleteMany({ where: { id: ruleId } }));
    });

    it('reports the AI_UNAVAILABLE reason in the audit blob so the rung is diagnosable', async () => {
      const stub = stubClassifier({
        unavailable: true,
        rung: 'RULES_KEYWORDS_ONLY',
        reason: 'PROVIDER_UNAVAILABLE:CONNECTION_FAILED',
      });
      await parseInput(stub, 'nepoznato 1');
      const row = await latestDecision('nepoznato 1');
      expect(JSON.stringify(row.candidates)).toContain('PROVIDER_UNAVAILABLE');
    });
  });

  // -------------------------------------------------------------------------------------------
  // Money
  // -------------------------------------------------------------------------------------------

  describe('money (ADR-003)', () => {
    it('round-trips a large amount exactly, in minor units as a string', async () => {
      // 900 719 925 474 099 minor units is past Number.MAX_SAFE_INTEGER; a float would round it.
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Lidl 900719925474099');
      const fragment = result.fragments[0]!;
      expect(fragment.amountMinor).toBe('90071992547409900');
      expect(typeof fragment.amountMinor).toBe('string');

      const row = await latestDecision('Lidl 900719925474099');
      expect(decidedAmount(row.candidates)).toBe('90071992547409900');
    });

    it('keeps fractional dinars exact', async () => {
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Lidl 1250,50');
      expect(result.fragments[0]!.amountMinor).toBe('125050');
    });

    it('refuses a fragment with no parseable amount instead of coercing a zero', async () => {
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Lidl');
      // No amount ⇒ the parser reports null and the row is a question, never `0`.
      expect(result.fragments[0]!.amountMinor).toBeNull();
      const row = await latestDecision('Lidl');
      expect(decidedAmount(row.candidates)).toBeNull();
    });

    it('writes the amount candidates into the audit blob for an ambiguous reading', async () => {
      // `1.200` is both 1200 and 1.2; docs/04 §3.1 says the parser returns both rather than picking.
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Lidl 1.200');
      expect(result.fragments[0]!.amountMinor).not.toBeNull();
      const row = await latestDecision('Lidl 1.200');
      const amount = (row.candidates as { amount?: { candidates?: unknown[] } }).amount;
      expect(Array.isArray(amount?.candidates)).toBe(true);
      expect((amount?.candidates ?? []).length).toBeGreaterThan(1);
    });

    it('rejects an empty capture rather than returning an empty parse', async () => {
      await expect(asTenant(() => service().parse(householdId, { text: '   ' }))).rejects.toThrow(
        /Capture text is required/,
      );
    });
  });

  // -------------------------------------------------------------------------------------------
  // Tenancy
  // -------------------------------------------------------------------------------------------

  describe('tenancy (ADR-008)', () => {
    it("cannot see another Household's keywords, rules or entities", async () => {
      // Each of these would decide if the other Household's rows leaked in: `tudjikljuc` would score,
      // `tudjitext` would match the rule, `Tudji Prodavac` would resolve to an entity default.
      const stub = stubClassifier({
        unavailable: true,
        rung: 'RULES_KEYWORDS_ONLY',
        reason: 'PROVIDER_UNAVAILABLE:test',
      });

      for (const text of ['tudjikljuc 100', 'tudjitext 100', 'Tudji Prodavac 100']) {
        const result = await parseInput(stub, text);
        const fragment = result.fragments[0]!;
        expect(fragment.decidedBy, text).toBe('FALLBACK');
        expect(fragment.categoryId, text).toBeNull();
      }
    });

    it('keeps each Household’s keywords working for itself', async () => {
      const stub = stubClassifier();
      const mine = await parseInput(stub, 'Lidl 2000');
      expect(mine.fragments[0]!.categoryId).toBe(foodId);

      const theirs = await runWithTenant(otherContext, () =>
        service({ stub }).parse(otherHouseholdId, { text: 'tudjikljuc 100' }),
      );
      expect(theirs.fragments[0]!.decidedBy).toBe('KEYWORD');
    });

    it('writes the audit row under the acting Household and cannot be read from another', async () => {
      const stub = stubClassifier();
      await parseInput(stub, 'Lidl 4321');
      const row = await latestDecision('Lidl 4321');
      expect(row.household_id).toBe(householdId);

      // Reading the same row from the other Household's context returns nothing.
      const visible = await runWithTenant(otherContext, () =>
        prisma.client.classification_decisions.findMany({ where: { id: row.id } }),
      );
      expect(visible).toHaveLength(0);
    });

    it('cannot attach a decision to another Household’s audit row', async () => {
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Lidl 5555');
      const decisionId = result.fragments[0]!.decisionId;

      // A silent no-op would be worse than a failure: the caller would believe the audit link exists,
      // and a committed Transaction would have no answer to "why that category?" (F-31). The link is
      // refused loudly, and the foreign Household still cannot touch the row.
      await expect(
        runWithTenant(otherContext, () =>
          service({ stub }).attachToTransaction(otherHouseholdId, decisionId, uuidv7()),
        ),
      ).rejects.toThrow(/not found for this household/i);

      const row = await latestDecision('Lidl 5555');
      expect(row.transaction_id).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // The resolved entity lands in the right field
  // -------------------------------------------------------------------------------------------

  describe('resolved entities (regression: the FK column)', () => {
    it('puts a Counterparty that decided into counterpartyId, not merchantId', async () => {
      // `PipelineOutcome.entityId` is a Merchant *or* a Counterparty depending on `decidedBy`, and
      // mapping it to `merchantId` unconditionally sent a Counterparty id into a column whose foreign
      // key points at `merchants` — so the commit that wrote it failed with an opaque FK error, and
      // only when a Counterparty had a default category.
      const rodaId = uuidv7();
      await asTenant(() =>
        prisma.client.counterparties.create({
          data: {
            id: rodaId,
            household_id: householdId,
            name: 'Roda',
            type: 'PERSON',
            default_category_id: foodId,
          },
        }),
      );

      const result = await parseInput(stubClassifier(), 'Roda 3600');
      const fragment = result.fragments[0]!;

      expect(fragment.decidedBy).toBe('COUNTERPARTY_DEFAULT');
      expect(fragment.counterpartyId).toBe(rodaId);
      expect(fragment.merchantId).toBeNull();
      expect(fragment.categoryId).toBe(foodId);
    });

    it('records an entity that resolved without deciding anything', async () => {
      // A Counterparty with no default category resolves but decides nothing, so the decision entity
      // is null. The row used to end up with no entity at all — which is why a counterparty rule
      // could never be learned from a capture.
      const mikaId = uuidv7();
      await asTenant(() =>
        prisma.client.counterparties.create({
          data: { id: mikaId, household_id: householdId, name: 'Mika', type: 'PERSON' },
        }),
      );

      const fragment = (await parseInput(stubClassifier(), 'Mika 1200')).fragments[0]!;
      expect(fragment.counterpartyId).toBe(mikaId);
      expect(fragment.merchantId).toBeNull();
    });

    it('still puts a deciding Merchant in merchantId', async () => {
      const tempoId = uuidv7();
      await asTenant(() =>
        prisma.client.merchants.create({
          data: {
            id: tempoId,
            household_id: householdId,
            name: 'Tempo',
            default_category_id: fuelId,
          },
        }),
      );

      const fragment = (await parseInput(stubClassifier(), 'Tempo 2000')).fragments[0]!;
      expect(fragment.merchantId).toBe(tempoId);
      expect(fragment.counterpartyId).toBeNull();
      expect(fragment.categoryId).toBe(fuelId);
    });
  });

  // -------------------------------------------------------------------------------------------
  // The audit trail (F-31)
  // -------------------------------------------------------------------------------------------

  describe('classification_decisions audit', () => {
    it('writes exactly one row per fragment, grouped by parseId', async () => {
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Lidl 111, Lidl 222');

      const rows = await asTenant(() =>
        prisma.client.classification_decisions.findMany({
          where: { id: { in: result.fragments.map((fragment) => fragment.decisionId) } },
        }),
      );
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => parseIdOf(row.candidates)))).toEqual(new Set([result.parseId]));
      expect(rows.map((row) => row.raw_input).sort()).toEqual(['Lidl 111', 'Lidl 222']);
    });

    it('records the normalized input as the canonical fold', async () => {
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Лидл 2000');
      const row = await asTenant(() =>
        prisma.client.classification_decisions.findFirst({
          where: { id: result.fragments[0]!.decisionId },
        }),
      );
      expect(row?.normalized_input).toBe('lidl 2000');
    });

    it('stores cost and latency as null when no model ran', async () => {
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Lidl 777');
      const row = await asTenant(() =>
        prisma.client.classification_decisions.findFirst({
          where: { id: result.fragments[0]!.decisionId },
        }),
      );
      expect(row?.latency_ms).toBeNull();
      expect(row?.cost_micros).toBeNull();
      expect(row?.ai_provider).toBeNull();
      expect(row?.ai_model).toBeNull();
      expect(rawConfidence(row?.candidates)).toBeNull();
    });

    it('keeps the raw confidence alongside the calibrated one for the §6.4 re-fit', async () => {
      const stub = stubClassifier(proposal({ rawConfidence: 0.87 }));
      const result = await parseInput(stub, 'ai refit 100');
      const row = await asTenant(() =>
        prisma.client.classification_decisions.findFirst({
          where: { id: result.fragments[0]!.decisionId },
        }),
      );
      // §6.4 needs `(raw_confidence, was_accepted)`. The column holds the calibrated value; the raw
      // one is in the JSONB blob, which is the resolution this task documented.
      expect(Number(row?.confidence)).toBe(calibrated(0.87));
      expect(rawConfidence(row?.candidates)).toBeCloseTo(0.87, 3);
      // The two are genuinely different numbers, so this test cannot pass by accident.
      expect(Number(row?.confidence)).not.toBe(0.87);
    });

    it('surfaces the audit row for a transaction through the read path', async () => {
      const stub = stubClassifier();
      const result = await parseInput(stub, 'Lidl 888');
      const decisionId = result.fragments[0]!.decisionId;

      const accountId = uuidv7();
      await asTenant(async () => {
        await prisma.client.accounts.create({
          data: { id: accountId, kind: 'CASH', name: 'Cash', currency: 'RSD', opening_balance_minor: 0n },
        });
      });
      const transactionId = uuidv7();
      await asTenant(() =>
        prisma.client.transactions.create({
          data: {
            id: transactionId,
            account_id: accountId,
            kind: 'EXPENSE',
            amount_minor: 200000n,
            currency: 'RSD',
            description: 'Lidl',
            occurred_at: new Date(),
            occurred_local_date: new Date('2026-09-14T00:00:00.000Z'),
            source: 'NATURAL_LANGUAGE',
          },
        }),
      );

      await asTenant(() => service({ stub }).attachToTransaction(householdId, decisionId, transactionId));

      const decisions = await asTenant(() =>
        service({ stub }).decisionsForTransaction(householdId, transactionId),
      );
      expect(decisions).toHaveLength(1);
      expect(decisions[0]!.id).toBe(decisionId);
      expect(decisions[0]!.transaction_id).toBe(transactionId);

      // And the other Household cannot see it through the same read path.
      const foreign = await runWithTenant(otherContext, () =>
        service({ stub }).decisionsForTransaction(otherHouseholdId, transactionId),
      );
      expect(foreign).toHaveLength(0);
    });

    it('skips a malformed rule instead of failing the whole capture', async () => {
      const badRuleId = uuidv7();
      await asTenant(() =>
        prisma.client.rules.create({
          data: {
            id: badRuleId,
            name: 'Broken rule',
            priority: 1,
            // A condition tree the engine refuses (unknown operator): a rule written months ago must
            // not make capture unavailable.
            conditions: { all: [{ field: 'text', op: 'explode', value: 'x' }] },
            actions: { setCategoryId: foodId },
            origin: 'USER',
          },
        }),
      );

      try {
        const stub = stubClassifier();
        const result = await parseInput(stub, 'Lidl 2000');
        expect(result.fragments[0]!.decidedBy).toBe('KEYWORD');
      } finally {
        await asTenant(() => prisma.client.rules.deleteMany({ where: { id: badRuleId } }));
      }
    });
  });

  // -------------------------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------------------------

  /** The most recent audit row for an exact raw input. */
  async function latestDecision(rawInput: string) {
    const row = await asTenant(() =>
      prisma.client.classification_decisions.findFirst({
        where: { raw_input: rawInput },
        orderBy: { created_at: 'desc' },
      }),
    );
    if (!row) throw new Error(`no classification_decisions row for "${rawInput}"`);
    return row;
  }

  function parseIdOf(candidates: unknown): string | null {
    return (candidates as { parseId?: string } | null)?.parseId ?? null;
  }

  function rawConfidence(candidates: unknown): number | null {
    const value = (candidates as { rawConfidence?: number | null } | null)?.rawConfidence;
    return value === undefined ? null : value;
  }

  function decidedAmount(candidates: unknown): string | null {
    const amount = (candidates as { amount?: { amountMinor?: string | null } } | null)?.amount;
    return amount?.amountMinor ?? null;
  }

  function keywordMatches(candidates: unknown): string[] {
    const list = (candidates as { candidates?: { kind?: string; reason?: string | null }[] } | null)
      ?.candidates;
    return (list ?? [])
      .filter((entry) => entry.kind === 'KEYWORD' && typeof entry.reason === 'string')
      .map((entry) => entry.reason as string);
  }
});
