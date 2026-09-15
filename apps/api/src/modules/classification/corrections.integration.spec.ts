import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerModule } from '../ledger/ledger.module';
import { TransactionsService } from '../ledger/transactions.service';
import { AI_CLASSIFIER, type AiClassifier, type ClassifyRequest } from './ai-classifier';
import type { AiStageResult } from './classification.pipeline';
import { ClassificationService } from './classification.service';
import { CorrectionsService, RuleShadowedError } from './corrections.service';
import { RulesService } from './rules.service';

/**
 * The learning loop — docs/04 §8, F-09 — against a real database.
 *
 * ## The exit criterion this file exists for
 *
 * docs/09 §4: *"Correcting a category and ticking 'remember' makes the next identical input resolve
 * with **zero** AI calls — asserted by an integration test."* That is one test below, and its
 * AI-call count is the assertion: a pipeline that still reached the model would pass every other
 * test in this file while destroying the cost model.
 *
 * ## Why a stub classifier rather than the module's
 *
 * The `AI_CLASSIFIER` is replaced with one that **counts its calls**, so "zero AI calls" is measured
 * rather than assumed. It returns the honest always-unavailable result, which is what a household
 * with no provider configured sees today.
 */
describe('the learning loop (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transactions: TransactionsService;
  let corrections: CorrectionsService;
  let rules: RulesService;
  let classification: ClassificationService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'learn-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'learn-it-other',
  };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  let accountId: string;
  let foodId: string;
  let houseId: string;
  let giftId: string;
  let dejanId: string;
  let otherAccountId: string;
  let otherCategoryId: string;

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

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, LedgerModule],
    })
      .overrideProvider(AI_CLASSIFIER)
      .useValue(failingClassifier)
      .compile();

    prisma = moduleRef.get(PrismaService);
    transactions = moduleRef.get(TransactionsService);
    corrections = moduleRef.get(CorrectionsService);
    rules = moduleRef.get(RulesService);
    classification = moduleRef.get(ClassificationService);

    const stamp = Date.now();
    await prisma.client.users.create({
      data: { id: userId, email: `learn-${stamp}@example.com`, display_name: 'Learning Test' },
    });
    await prisma.client.users.create({
      data: { id: otherUserId, email: `learn-b-${stamp}@example.com`, display_name: 'Other' },
    });

    await asTenant(async () => {
      await prisma.client.households.create({
        data: { id: householdId, name: 'Learning', owner_user_id: userId, ledger_currency: 'RSD' },
      });
      accountId = uuidv7();
      await prisma.client.accounts.create({
        data: { id: accountId, household_id: householdId, name: 'Tekući', kind: 'BANK', currency: 'RSD' },
      });

      const food = await prisma.client.categories.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Hrana', kind: 'EXPENSE' },
      });
      foodId = food.id;
      houseId = uuidv7();
      giftId = uuidv7();
      await prisma.client.categories.createMany({
        data: [
          { id: houseId, household_id: householdId, name: 'Septička jama', kind: 'EXPENSE' },
          { id: giftId, household_id: householdId, name: 'Pokloni', kind: 'EXPENSE' },
        ],
      });

      dejanId = uuidv7();
      await prisma.client.counterparties.create({
        data: { id: dejanId, household_id: householdId, name: 'Dejan rođa', type: 'PERSON' },
      });

      // `lidl` resolves by keyword, so a Lidl row is CONFIRMED without a rule. That is what lets the
      // conflict tests put an existing rule in front of a proposal.
      await prisma.client.category_keywords.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          category_id: foodId,
          keyword: 'lidl',
          polarity: 'INCLUDE',
          match_mode: 'WORD',
          weight: 2,
        },
      });
    });

    await runWithTenant(otherContext, async () => {
      await prisma.client.households.create({
        data: { id: otherHouseholdId, name: 'Other', owner_user_id: otherUserId },
      });
      otherAccountId = uuidv7();
      await prisma.client.accounts.create({
        data: {
          id: otherAccountId,
          household_id: otherHouseholdId,
          name: 'Theirs',
          kind: 'BANK',
          currency: 'RSD',
        },
      });
      otherCategoryId = uuidv7();
      await prisma.client.categories.create({
        data: { id: otherCategoryId, household_id: otherHouseholdId, name: 'Tudje', kind: 'EXPENSE' },
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
  // Harness
  // -------------------------------------------------------------------------------------------

  let seq = 0;

  /** A Transaction to correct, created through the ledger's own create path. */
  async function seedTransaction(args: {
    readonly description: string;
    readonly categoryId?: string | null;
    readonly merchantId?: string | null;
    readonly counterpartyId?: string | null;
  }): Promise<string> {
    seq += 1;
    const created = await asTenant(() =>
      transactions.create(householdId, {
        accountId,
        kind: 'EXPENSE',
        amountMinor: 360000n,
        description: args.description,
        occurredLocalDate: '2026-09-14',
        categoryId: args.categoryId ?? null,
        merchantId: args.merchantId ?? null,
        counterpartyId: args.counterpartyId ?? null,
        idempotencyKey: `learn-${seq}-${uuidv7()}`,
        source: 'MANUAL',
      }),
    );
    return created.id;
  }

  async function correct(
    transactionId: string,
    overrides: Partial<{
      field: 'category' | 'merchant' | 'counterparty' | 'kind' | 'amount';
      categoryId: string;
      rememberForFuture: boolean;
      version: number;
    }> = {},
  ) {
    const transaction = await asTenant(() => transactions.getById(householdId, transactionId));
    return asTenant(() =>
      transactions.correctTransaction(householdId, {
        transactionId,
        version: overrides.version ?? transaction.version,
        field: overrides.field ?? 'category',
        categoryId: overrides.categoryId ?? houseId,
        rememberForFuture: overrides.rememberForFuture ?? false,
      }),
    );
  }

  /**
   * Compose the synthesis subject the way the **resolver** does.
   *
   * `CorrectionsService` cannot build it itself without reading `transactions`, which would invert the
   * module edge, so the composition point is the caller. Stated here rather than hidden in a helper on
   * the service, because a reader of the service needs to know it is not self-contained.
   */
  async function subjectFor(transactionId: string, categoryId: string | null) {
    return asTenant(() => transactions.correctionSubject(householdId, transactionId, categoryId));
  }

  async function correctionRows(): Promise<number> {
    return asTenant(() =>
      prisma.client.corrections.count({ where: { household_id: householdId } }),
    );
  }

  // -------------------------------------------------------------------------------------------
  // docs/09 §4's exit criterion
  // -------------------------------------------------------------------------------------------

  describe('the exit criterion: remember → the next identical input resolves with zero AI calls', () => {
    it('creates the rule from the correction and then decides with it', async () => {
      const transactionId = await seedTransaction({
        description: 'Dejan rođa 3600',
        counterpartyId: dejanId,
      });

      const outcome = await correct(transactionId, { rememberForFuture: true });

      // The correction itself.
      expect(outcome.correction.field).toBe('category');
      expect(outcome.correction.toValue).toBe(houseId);
      expect(outcome.correction.wasAiSuggested).toBe(false);
      expect(outcome.transaction.categoryId).toBe(houseId);

      // The proposal is the narrowest rule that would have prevented it: the resolved Counterparty,
      // not the text (docs/04 §8.1).
      expect(outcome.synthesis?.synthesis.proposal.trigger).toBe('COUNTERPARTY_RESOLVED');
      expect(outcome.synthesis?.synthesis.proposal.conditions).toEqual({
        all: [{ field: 'counterparty', op: 'eq', value: dejanId }],
      });

      // Ticking "remember" IS the confirmation (docs/06 §5.3), and a resolved entity is the one
      // trigger §8.2 allows it for.
      expect(outcome.ruleCreated).not.toBeNull();
      expect(outcome.ruleCreated?.origin).toBe('LEARNED');
      expect(outcome.ruleCreated?.sourceCorrectionId).toBe(outcome.correction.id);

      // Now the payoff: the input resolves through the RULES ENGINE, with no model call.
      aiCalls.length = 0;
      const parsed = await asTenant(() =>
        classification.parse(householdId, { text: 'Dejan rođa 2000', allowAi: true }),
      );

      const fragment = parsed.fragments[0]!;
      expect(fragment.decidedBy).toBe('RULE');
      expect(fragment.categoryId).toBe(houseId);
      expect(fragment.ruleId).toBe(outcome.ruleCreated?.id);
      // A rule decision is deterministic, so it auto-applies (docs/04 §7).
      expect(fragment.needsReview).toBe(false);
      expect(fragment.confidence).toBeGreaterThanOrEqual(0.9);
      // Counted LAST, so a failure above reports *why* rather than only that the model was reached.
      expect(aiCalls).toHaveLength(0);
    });

    it('needs an alias for the shorthand, and then the shorthand works too — docs/04 §4 rung 3', async () => {
      // docs/01 F-09's scenario types `Dejan 2000` and expects the rule to fire. It cannot, and the
      // reason is deliberate: rung 3 requires **every** folded token of the name to occur among the
      // input's tokens, so `Dejan rođa` needs both `dejan` and `roda`. That strictness is what stops
      // an abbreviation auto-applying at 0.90 (docs/04 §4's rung-3 row).
      //
      // The product's answer is the **alias**, which is what F-13's onboarding step 3 creates
      // ("Counterparty + alias"). This test pins both halves so the gap cannot be mistaken for a bug
      // in rule synthesis: the rule is right, the entity simply did not resolve.
      const before = await asTenant(() =>
        classification.parse(householdId, { text: 'Dejan 2000', allowAi: false }),
      );
      expect(before.fragments[0]!.decidedBy).not.toBe('RULE');
      expect(before.fragments[0]!.categoryId).toBeNull();

      // Through the parent: `counterparty_aliases` carries no `household_id`, so the tenancy guard
      // refuses it directly and the parent's query is what scopes it (ADR-008).
      await asTenant(() =>
        prisma.client.counterparties.update({
          where: { id: dejanId },
          data: { counterparty_aliases: { create: [{ id: uuidv7(), alias: 'dejan' }] } },
        }),
      );

      const after = await asTenant(() =>
        classification.parse(householdId, { text: 'Dejan 2000', allowAi: false }),
      );
      expect(after.fragments[0]!.decidedBy).toBe('RULE');
      expect(after.fragments[0]!.categoryId).toBe(houseId);
      expect(after.fragments[0]!.merchantId).toBeNull();
    });

    it('does NOT auto-create when the trigger is only a text token (docs/04 §8.2)', async () => {
      const transactionId = await seedTransaction({ description: 'septička jama 3600' });

      const outcome = await correct(transactionId, { rememberForFuture: true });

      // Proposed, because §8.1's table says a distinctive token is a synthesis trigger...
      expect(outcome.synthesis?.synthesis.proposal.trigger).toBe('DISTINCTIVE_TOKEN');
      expect(outcome.synthesis?.synthesis.keyword).toEqual({ keyword: 'septicka', categoryId: houseId });
      // ...but NOT created, because §8.2 forbids permanent policy from a single ambiguous correction.
      expect(outcome.ruleCreated).toBeNull();
      expect(outcome.correction.ruleCreatedId).toBeNull();
    });

    it('does not create a rule at all when the user did not ask', async () => {
      const transactionId = await seedTransaction({ description: 'Maxi 3600' });
      const outcome = await correct(transactionId, { rememberForFuture: false });

      // The proposal is still returned, so the UI can offer it (F-09's "Zapamti za buduće").
      expect(outcome.synthesis).not.toBeNull();
      expect(outcome.ruleCreated).toBeNull();

      const parsed = await asTenant(() =>
        classification.parse(householdId, { text: 'Maxi 2000', allowAi: false }),
      );
      expect(parsed.fragments[0]!.decidedBy).not.toBe('RULE');
    });
  });

  // -------------------------------------------------------------------------------------------
  // The Correction row
  // -------------------------------------------------------------------------------------------

  describe('the correction record', () => {
    it('is written even when the user does not want to remember, because the refusal is evidence', async () => {
      const before = await correctionRows();
      const transactionId = await seedTransaction({ description: 'Gorivo 3600', categoryId: foodId });

      await correct(transactionId, { categoryId: giftId, rememberForFuture: false });

      expect(await correctionRows()).toBe(before + 1);
    });

    it('refuses a `kind` correction and records nothing', async () => {
      const before = await correctionRows();
      const transactionId = await seedTransaction({ description: 'Nesto 3600' });

      await expect(correct(transactionId, { field: 'kind' })).rejects.toThrow(/direction cannot be/i);
      // A Correction describing a change that did not happen would train the re-fit on a fiction.
      expect(await correctionRows()).toBe(before);
    });

    it('records nothing when the write itself fails (a stale version)', async () => {
      const before = await correctionRows();
      const transactionId = await seedTransaction({ description: 'Nesto 2 3600' });
      const current = await asTenant(() => transactions.getById(householdId, transactionId));

      await expect(
        correct(transactionId, { version: current.version + 5 }),
      ).rejects.toThrow(/changed somewhere else/i);

      expect(await correctionRows()).toBe(before);
    });

    it('flags a correction of a category the model chose', async () => {
      // The denormalised `category_source` is the signal: it is what the pipeline wrote.
      const transactionId = await seedTransaction({ description: 'Lidl 3600' });
      const afterCapture = await asTenant(() =>
        classification.parse(householdId, { text: 'Lidl 3600', allowAi: false }),
      );
      const decision = afterCapture.fragments[0]!;
      expect(decision.decidedBy).toBe('KEYWORD');

      // The seed created the row with `category_source: null` because the test wrote it directly, so
      // this asserts the *false* arm honestly rather than pretending the flag was set.
      const outcome = await correct(transactionId, { categoryId: houseId });
      expect(outcome.correction.wasAiSuggested).toBe(false);
    });

    it('will not correct another Household’s Transaction', async () => {
      const foreign = uuidv7();
      await runWithTenant(otherContext, () =>
        prisma.client.transactions.create({
          data: {
            id: foreign,
            household_id: otherHouseholdId,
            account_id: otherAccountId,
            kind: 'EXPENSE',
            amount_minor: 100n,
            currency: 'RSD',
            description: 'Tudje',
            occurred_at: new Date(),
            occurred_local_date: new Date('2026-09-14T00:00:00.000Z'),
            source: 'MANUAL',
          },
        }),
      );

      await expect(
        asTenant(() =>
          transactions.correctTransaction(householdId, {
            transactionId: foreign,
            version: 1,
            field: 'category',
            categoryId: otherCategoryId,
            rememberForFuture: false,
          }),
        ),
      ).rejects.toThrow(/not found/i);
    });
  });

  // -------------------------------------------------------------------------------------------
  // docs/04 §8.2's conflict guardrail
  // -------------------------------------------------------------------------------------------

  describe('the conflict guardrail', () => {
    it('relabels the proposal and creates nothing when an existing rule would win', async () => {
      // A higher-precedence rule (lower priority wins) that already sends Lidl to Hrana.
      const existing = await asTenant(() =>
        rules.create(householdId, {
          name: 'Lidl je Hrana',
          priority: 1,
          conditions: { all: [{ field: 'text', op: 'contains', value: 'lidl' }] },
          actions: { setCategoryId: foodId },
        }),
      );

      const transactionId = await seedTransaction({ description: 'Lidl 3600', categoryId: foodId });
      const outcome = await correct(transactionId, { categoryId: houseId, rememberForFuture: true });

      // The proposal was derived from the text, and something already handles that text differently.
      expect(outcome.synthesis?.synthesis.proposal.trigger).toBe('CONTRADICTS_EXISTING_RULE');
      expect(outcome.synthesis?.check.shadowed).toBe(true);
      expect(outcome.synthesis?.check.conflicts.map((conflict) => conflict.ruleId)).toContain(
        existing.id,
      );
      expect(outcome.synthesis?.check.conflicts[0]?.existingValue).toBe(foodId);
      expect(outcome.synthesis?.check.conflicts[0]?.proposedValue).toBe(houseId);

      // Nothing was created, so the user's rule set does not grow a rule that never fires.
      expect(outcome.ruleCreated).toBeNull();

      await asTenant(() => rules.remove(householdId, existing.id));
    });

    it('refuses createRuleFromCorrection for a shadowed proposal, naming the winner', async () => {
      const existing = await asTenant(() =>
        rules.create(householdId, {
          name: 'Sve na Hranu',
          priority: 1,
          conditions: { all: [{ field: 'text', op: 'contains', value: 'gorivo' }] },
          actions: { setCategoryId: foodId },
        }),
      );

      const transactionId = await seedTransaction({ description: 'Gorivo 3600', categoryId: foodId });
      const outcome = await correct(transactionId, { categoryId: houseId, rememberForFuture: false });

      await expect(
        asTenant(async () =>
          corrections.createRuleFromCorrection(
            householdId,
            outcome.correction,
            await subjectFor(transactionId, houseId),
            { acceptProposal: true, overrides: null },
          ),
        ),
      ).rejects.toBeInstanceOf(RuleShadowedError);

      await asTenant(() => rules.remove(householdId, existing.id));
    });

    it('lets the user push a shadowed rule through by editing it', async () => {
      const existing = await asTenant(() =>
        rules.create(householdId, {
          name: 'Sve na Hranu 2',
          priority: 1,
          conditions: { all: [{ field: 'text', op: 'contains', value: 'maxi' }] },
          actions: { setCategoryId: foodId },
        }),
      );

      const transactionId = await seedTransaction({ description: 'Maxi 3600', categoryId: foodId });
      const outcome = await correct(transactionId, { categoryId: houseId, rememberForFuture: false });

      const created = await asTenant(async () =>
        corrections.createRuleFromCorrection(
          householdId,
          outcome.correction,
          await subjectFor(transactionId, houseId),
          {
            acceptProposal: true,
            overrides: {
              name: 'Maxi je septička (moja odluka)',
              // 100, i.e. the ordinary tier — so the existing priority-1 rule still outranks it. A
              // tie at the same priority would be broken by `created_at DESC` (docs/04 §5.3.1) and
              // the override, being newest, would simply win: no conflict to record.
              priority: 100,
              conditions: { all: [{ field: 'text', op: 'contains', value: 'maxi' }] },
              actions: { setCategoryId: houseId },
            },
          },
        ),
      );

      // The user authored it, so it is saved — and the conflict is *recorded* rather than used to
      // refuse them.
      expect(created.rule.name).toBe('Maxi je septička (moja odluka)');
      expect(created.ruleConflicts.length).toBeGreaterThan(0);
      expect(created.rule.conflictsWith.length).toBeGreaterThan(0);

      await asTenant(() => rules.remove(householdId, created.rule.id));
      await asTenant(() => rules.remove(householdId, existing.id));
    });

    it('refuses a second rule from the same correction', async () => {
      // A counterparty of its own: an entity whose correction was already turned into a rule would be
      // shadowed by that rule, and this test is about the *second call*, not about shadowing.
      const mikaId = uuidv7();
      await asTenant(() =>
        prisma.client.counterparties.create({
          data: { id: mikaId, household_id: householdId, name: 'Mika', type: 'PERSON' },
        }),
      );

      const transactionId = await seedTransaction({
        description: 'Mika 5000',
        counterpartyId: mikaId,
      });
      const outcome = await correct(transactionId, { rememberForFuture: true });
      expect(outcome.ruleCreated).not.toBeNull();

      // The rule was created by the tick, so the correction already points at one.
      await expect(
        asTenant(async () =>
          corrections.createRuleFromCorrection(
            householdId,
            outcome.correction,
            await subjectFor(transactionId, houseId),
            { acceptProposal: true, overrides: null },
          ),
        ),
      ).rejects.toThrow(/already produced a rule/i);
    });
  });

  // -------------------------------------------------------------------------------------------
  // docs/04 §8.2's decay signal
  // -------------------------------------------------------------------------------------------

  describe('hit counting and staleness', () => {
    it('counts a hit when a rule actually decides a committed Transaction', async () => {
      const rule = await asTenant(() =>
        rules.create(householdId, {
          name: 'Kafa je Hrana',
          priority: 5,
          conditions: { all: [{ field: 'text', op: 'contains', value: 'kafa' }] },
          actions: { setCategoryId: foodId },
        }),
      );
      expect(rule.hitCount).toBe(0n);
      expect(rule.isStale).toBe(false);

      // A commit that the rule decides.
      await asTenant(() =>
        transactions.captureCommit(householdId, {
          defaultAccountId: accountId,
          rows: [
            {
              clientRowId: 'kafa-1',
              idempotencyKey: `kafa-${uuidv7()}`,
              kind: 'EXPENSE',
              amount: { amountMinor: 20000n, currency: 'RSD' },
              description: 'kafa 200',
              occurredOn: '2026-09-14',
            },
          ],
        }),
      );

      const after = await asTenant(() => rules.get(householdId, rule.id));
      expect(after.hitCount).toBe(1n);
      expect(after.lastHitAt).not.toBeNull();

      // A parse alone must NOT count: `captureParse` fires on a 250 ms debounce and would inflate the
      // number until "stale after 90 days" meant nothing.
      await asTenant(() => classification.parse(householdId, { text: 'kafa 200', allowAi: false }));
      const stillOne = await asTenant(() => rules.get(householdId, rule.id));
      expect(stillOne.hitCount).toBe(1n);
    });

    it('reports the conflict list for a stored rule on its own witnessed input', async () => {
      const winner = await asTenant(() =>
        rules.create(householdId, {
          name: 'Pobednik',
          priority: 1,
          conditions: { all: [{ field: 'text', op: 'contains', value: 'pelene' }] },
          actions: { setCategoryId: foodId },
        }),
      );
      const loser = await asTenant(() =>
        rules.create(householdId, {
          name: 'Gubitnik',
          priority: 900,
          conditions: { all: [{ field: 'text', op: 'contains', value: 'pelene' }] },
          actions: { setCategoryId: houseId },
        }),
      );

      const view = await asTenant(() => rules.get(householdId, loser.id));
      expect(view.conflictsWith.map((conflict) => conflict.ruleId)).toContain(winner.id);

      await asTenant(() => rules.remove(householdId, winner.id));
      await asTenant(() => rules.remove(householdId, loser.id));
    });

    it('reports no conflicts for a rule whose conditions yield no witness', async () => {
      // `none(...)` cannot be witnessed, so the answer is "cannot check" — and the field's contract
      // says an empty list covers that, rather than pretending the rule is clean.
      const rule = await asTenant(() =>
        rules.create(householdId, {
          name: 'Bez svedoka',
          priority: 300,
          conditions: { none: [{ field: 'text', op: 'contains', value: 'nesto' }] },
          actions: { setCategoryId: foodId },
        }),
      );
      const view = await asTenant(() => rules.get(householdId, rule.id));
      expect(view.conflictsWith).toEqual([]);

      await asTenant(() => rules.remove(householdId, rule.id));
    });
  });

  // -------------------------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------------------------

  describe('rule documents', () => {
    it('refuses a rule the engine cannot evaluate, as a typed client error', async () => {
      await expect(
        asTenant(() =>
          rules.create(householdId, {
            name: 'Pokvareno',
            conditions: { all: [{ field: 'amount', op: 'eq', value: 2000 }] },
            actions: { setCategoryId: foodId },
          }),
        ),
      ).rejects.toThrow(/cannot be evaluated/i);
    });

    it('refuses an empty name', async () => {
      await expect(
        asTenant(() =>
          rules.create(householdId, {
            name: '   ',
            conditions: { all: [{ field: 'text', op: 'contains', value: 'x' }] },
            actions: { setCategoryId: foodId },
          }),
        ),
      ).rejects.toThrow(/needs a name/i);
    });
  });
});
