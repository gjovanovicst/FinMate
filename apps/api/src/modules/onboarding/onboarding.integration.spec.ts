import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SHIPPED_MERCHANTS, flattenStarterCategories, uuidv7 } from '@finmate/domain';

import { normaliseForMatching } from '../../common/text/normalise';
import { runWithTenant, type TenantContext } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AI_CLASSIFIER, type AiClassifier, type ClassifyRequest } from '../classification/ai-classifier';
import { ClassificationModule } from '../classification/classification.module';
import type { AiStageResult } from '../classification/classification.pipeline';
import { ClassificationService } from '../classification/classification.service';
import { TaxonomyModule } from '../taxonomy/taxonomy.module';
import { OnboardingModule } from './onboarding.module';
import { CURRENT_SEED_VERSION, OnboardingService } from './onboarding.service';

/**
 * F-13 onboarding against a real database.
 *
 * ## The test this file exists for
 *
 * docs/09 §4's Phase 2 exit criterion is *"`Lidl 2000` works end-to-end"*, and docs/01's product
 * promise is that typing it produces a correctly categorised transaction. Before this task that was
 * **false for every fresh signup** — verified live during 2.3.2b: the classifier resolved neither a
 * Merchant nor a category for `Lidl`, because a new Household has no categories and no merchants. So
 * the headline test here is: after `seedStarterCategories` and nothing else, `Lidl 2000` categorises
 * to `Hrana / Supermarket` through a **keyword** — with the AI call count asserted at zero, because a
 * pipeline that quietly reached for a model would still pass every other assertion in this file.
 *
 * ## Why the classifier is a counting stub
 *
 * The same reason as `corrections.integration.spec.ts`: "zero AI calls" has to be measured. It returns
 * the honest always-unavailable result, which is what a Household with no provider configured sees.
 */
describe('F-13 onboarding (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let onboarding: OnboardingService;
  let classification: ClassificationService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'onboarding-it' };
  const otherContext: TenantContext = {
    householdId: otherHouseholdId,
    userId: otherUserId,
    role: 'OWNER',
    requestId: 'onboarding-it-other',
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

  const tree = flattenStarterCategories();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot(),
        PrismaModule,
        TaxonomyModule,
        OnboardingModule,
        // The classifier, so the promise can be asserted on the real pipeline rather than on a
        // second implementation of it. `AI_CLASSIFIER` is replaced below.
        ClassificationModule,
      ],
    })
      .overrideProvider(AI_CLASSIFIER)
      .useValue(failingClassifier)
      .compile();

    prisma = moduleRef.get(PrismaService);
    onboarding = moduleRef.get(OnboardingService);
    classification = moduleRef.get(ClassificationService);

    const stamp = Date.now();
    await prisma.client.users.create({
      data: { id: userId, email: `onboard-${stamp}@example.com`, display_name: 'Onboarding' },
    });
    await prisma.client.users.create({
      data: { id: otherUserId, email: `onboard-b-${stamp}@example.com`, display_name: 'Other' },
    });

    // A brand-new Household, exactly as signup leaves it: a ledger currency, a timezone, and nothing
    // else. No categories, no keywords, no merchants, no accounts.
    await asTenant(async () => {
      await prisma.client.households.create({
        data: {
          id: householdId,
          name: 'Fresh',
          owner_user_id: userId,
          ledger_currency: 'RSD',
          iana_timezone: 'Europe/Belgrade',
          // A pre-existing unrelated setting, to prove progress writes merge rather than replace.
          settings: { aiConfidenceThresholds: { auto: 0.93, verify: 0.55 } },
        },
      });
    });

    await runWithTenant(otherContext, async () => {
      await prisma.client.households.create({
        data: { id: otherHouseholdId, name: 'Other', owner_user_id: otherUserId, ledger_currency: 'RSD' },
      });
    });
  });

  afterAll(async () => {
    // Each delete is a household-scoped write, so it needs a context even in teardown — the guard
    // does not have a test mode (ADR-008).
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
  // The promise
  // -------------------------------------------------------------------------------------------

  it('makes `Lidl 2000` categorise for a Household that has never seen a transaction', async () => {
    // 1. Before onboarding there is nothing to categorise INTO, and the classifier says so.
    const before = await asTenant(() => classification.parse(householdId, { text: 'Lidl 2000', allowAi: false }));
    expect(before.fragments[0]?.categoryId).toBeNull();

    // 2. Step 1: the starter tree. Nothing else — no merchants, no accounts, no AI.
    const seeded = await asTenant(() => onboarding.seedStarterCategories(householdId));
    expect(seeded.categories).toBe(tree.length);
    expect(seeded.keywords).toBeGreaterThan(100);

    // 3. The product promise, on the same input.
    aiCalls.length = 0;
    const after = await asTenant(() => classification.parse(householdId, { text: 'Lidl 2000', allowAi: false }));
    const fragment = after.fragments[0]!;

    expect(fragment.categoryId).not.toBeNull();
    expect(fragment.decidedBy).toBe('KEYWORD');
    expect(fragment.confidence).toBeGreaterThanOrEqual(0.9);
    expect(fragment.needsReview).toBe(false);
    // The AI was never asked: the keyword tier decided it, which is the whole cost model.
    expect(aiCalls).toHaveLength(0);

    // And it is the *right* category, by path — not merely a category.
    const seededCategory = await asTenant(() =>
      prisma.client.categories.findFirst({ where: { id: fragment.categoryId! }, select: { name: true, parent_id: true } }),
    );
    expect(seededCategory?.name).toBe('Supermarket');
    const parent = await asTenant(() =>
      prisma.client.categories.findFirst({ where: { id: seededCategory!.parent_id! }, select: { name: true } }),
    );
    expect(parent?.name).toBe('Hrana');
  });

  it('decides the other exit-criterion inputs too: income and a word that must not become fuel', async () => {
    const result = await asTenant(() =>
      classification.parse(householdId, { text: 'gorivo 3500, plata 150000', allowAi: false }),
    );
    const byDirection = new Map(result.fragments.map((fragment) => [fragment.kind, fragment]));

    const expense = byDirection.get('EXPENSE')!;
    const income = byDirection.get('INCOME')!;
    expect(expense.categoryId).not.toBeNull();
    expect(income.categoryId).not.toBeNull();

    const names = await asTenant(() =>
      prisma.client.categories.findMany({
        where: { id: { in: [expense.categoryId!, income.categoryId!] } },
        select: { id: true, name: true },
      }),
    );
    const nameOf = new Map(names.map((row) => [row.id, row.name]));
    expect(nameOf.get(expense.categoryId!)).toBe('Gorivo');
    expect(nameOf.get(income.categoryId!)).toBe('Plata');
  });

  // -------------------------------------------------------------------------------------------
  // The tree write
  // -------------------------------------------------------------------------------------------

  it('is idempotent: a second run reuses the whole tree and writes nothing', async () => {
    const second = await asTenant(() => onboarding.seedStarterCategories(householdId));
    expect(second.categories).toBe(0);
    expect(second.keywords).toBe(0);
    expect(second.reused).toBe(tree.length);

    const count = await asTenant(() =>
      prisma.client.categories.count({ where: { household_id: householdId, deleted_at: null } }),
    );
    expect(count).toBe(tree.length);
  });

  it('stores keywords folded, the same way the category editor does', async () => {
    // `septička` and `septicka` are one keyword to the matcher, and the editor stores the folded
    // form. A seed that stored the accent would leave the editor's chips disagreeing with the rows
    // the same feature created — the drift `common/text/normalise` exists to prevent.
    const keywords = await asTenant(() =>
      prisma.client.category_keywords.findMany({
        where: { household_id: householdId },
        select: { keyword: true },
      }),
    );
    const stored = new Set(keywords.map((row) => row.keyword));
    expect(stored.has('septicka')).toBe(true);
    expect(stored.has('septička')).toBe(false);
    for (const keyword of stored) {
      expect(keyword, `${keyword} is not folded`).toBe(normaliseForMatching(keyword));
    }
  });

  it('honours the exclude rules, and does not decide on a corroborating keyword alone', async () => {
    // Two invariants in one input. `ulje` (engine oil) is an INCLUDE under Delovi but an EXCLUDE
    // under Gorivo, and an EXCLUDE match hard-blocks that category (docs/04 §5.4) — so fuel must not
    // win. And `ulje` is deliberately a *corroborating* keyword (weight 1.0), so on its own it does
    // not reach the 2.0 decision threshold: falling through is the correct answer, not a miss.
    const parse = async (text: string) => {
      const result = await asTenant(() => classification.parse(householdId, { text, allowAi: false }));
      const fragment = result.fragments[0]!;
      const category =
        fragment.categoryId === null
          ? null
          : await asTenant(() =>
              prisma.client.categories.findFirst({
                where: { id: fragment.categoryId! },
                select: { name: true },
              }),
            );
      return { fragment, name: category?.name ?? null };
    };

    const oil = await parse('ulje 1200');
    expect(oil.name).not.toBe('Gorivo');
    expect(oil.fragment.decidedBy).not.toBe('KEYWORD');

    // The decisive sibling does decide, which is what makes the weight distinction meaningful.
    const parts = await parse('delovi 3000');
    expect(parts.name).toBe('Delovi');
    expect(parts.fragment.decidedBy).toBe('KEYWORD');
  });

  // -------------------------------------------------------------------------------------------
  // Merchants
  // -------------------------------------------------------------------------------------------

  it('copies a selected global merchant into the Household without touching the global row', async () => {
    const before = await asTenant(() =>
      prisma.client.merchants.findFirst({ where: { name: 'Lidl', household_id: null }, select: { id: true } }),
    );
    expect(before).not.toBeNull();

    const result = await asTenant(() => onboarding.applyMerchantSelection(householdId, ['Lidl', 'Maxi', 'DM']));
    expect(result.applied).toBe(3);
    expect(result.alreadyOwned).toBe(0);
    expect(result.unresolved).toEqual([]);
    expect(result.withoutCategory).toEqual([]);

    // The Household owns its own rows…
    const owned = await asTenant(() =>
      prisma.client.merchants.findMany({
        where: { household_id: householdId, name: { in: ['Lidl', 'Maxi', 'DM'] } },
        select: { id: true, name: true, is_global: true, default_category_id: true },
      }),
    );
    expect(owned).toHaveLength(3);
    for (const merchant of owned) {
      expect(merchant.is_global).toBe(false);
      expect(merchant.default_category_id).not.toBeNull();
    }

    // …and the global row is still there and still global, because other Households read it.
    const after = await asTenant(() =>
      prisma.client.merchants.findFirst({ where: { name: 'Lidl', household_id: null }, select: { id: true } }),
    );
    expect(after?.id).toBe(before?.id);

    // The aliases came along with the copy, so the merchant is reachable by how people type.
    const lidl = owned.find((merchant) => merchant.name === 'Lidl')!;
    // Reached through the parent: `merchant_aliases` has no `household_id` of its own, so the
    // tenancy guard refuses it directly (ADR-008) — that refusal is the design, not an obstacle.
    const withAliases = await asTenant(() =>
      prisma.client.merchants.findFirst({
        where: { id: lidl.id },
        select: { merchant_aliases: { select: { alias: true } } },
      }),
    );
    expect(withAliases?.merchant_aliases.map((row) => row.alias)).toContain('lidl');
  });

  it('resolves the default Category through the seed path, so the copy is categorised', async () => {
    const result = await asTenant(() => classification.parse(householdId, { text: 'Lidl 2000', allowAi: false }));
    const fragment = result.fragments[0]!;
    expect(fragment.merchantId).not.toBeNull();

    const merchant = await asTenant(() =>
      prisma.client.merchants.findFirst({
        where: { id: fragment.merchantId! },
        select: { name: true, default_category_id: true },
      }),
    );
    expect(merchant?.name).toBe('Lidl');
    expect(merchant?.default_category_id).not.toBeNull();
  });

  it('never mints a second copy on a re-run', async () => {
    // Onboarding is re-enterable from settings (docs/01 F-13), so a second pass must be a no-op — a
    // duplicate `Lidl` would split the Household's history across two merchants.
    const result = await asTenant(() => onboarding.applyMerchantSelection(householdId, ['Lidl', 'Maxi', 'DM']));
    expect(result.applied).toBe(0);
    expect(result.alreadyOwned).toBe(3);

    const count = await asTenant(() =>
      prisma.client.merchants.count({ where: { household_id: householdId, name: 'Lidl', deleted_at: null } }),
    );
    expect(count).toBe(1);
  });

  it('treats one name selected twice as one merchant', async () => {
    const result = await asTenant(() => onboarding.applyMerchantSelection(householdId, ['Lidl', 'lidl', ' LIDL ']));
    expect(result.applied + result.alreadyOwned).toBe(1);
  });

  it('reports a name that is not in the shipped catalogue instead of dropping it', async () => {
    const result = await asTenant(() =>
      onboarding.applyMerchantSelection(householdId, ['Lidl', 'Nepostojeći Market']),
    );
    expect(result.unresolved).toEqual(['Nepostojeći Market']);
    expect(result.applied + result.alreadyOwned).toBe(1);
  });

  it('creates the merchant anyway when the tree was skipped, and says it has no category', async () => {
    // Step 1 can be skipped, and step 4 can still be used. The merchant is created — it is useful
    // without a default category — but the wizard is told no suggestion was made.
    await runWithTenant(otherContext, async () => {
      const result = await onboarding.applyMerchantSelection(otherHouseholdId, ['Lidl']);
      expect(result.applied).toBe(1);
      expect(result.withoutCategory).toEqual(['Lidl']);

      const merchant = await prisma.client.merchants.findFirst({
        where: { household_id: otherHouseholdId, name: 'Lidl' },
        select: { default_category_id: true },
      });
      expect(merchant?.default_category_id).toBeNull();
    });
  });

  // -------------------------------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------------------------------

  it('resumes at the recorded step and stamps completion', async () => {
    const initial = await asTenant(() => onboarding.state(householdId));
    expect(initial.step).toBe(1);
    expect(initial.completedAt).toBeNull();

    await asTenant(() => onboarding.setStep(householdId, 4));
    expect((await asTenant(() => onboarding.state(householdId))).step).toBe(4);

    const done = await asTenant(() => onboarding.complete(householdId));
    expect(done.step).toBe(7);
    expect(done.completedAt).toBeInstanceOf(Date);
    // Stamped with the version this build ships, so a later release can tell "completed under v1"
    // from "never asked" — which row counts cannot, because a user may delete the whole tree.
    expect(done.seedVersion).toBe(CURRENT_SEED_VERSION);
  });

  it('clamps a nonsensical step rather than failing the screen', async () => {
    await asTenant(() => onboarding.setStep(householdId, 99));
    expect((await asTenant(() => onboarding.state(householdId))).step).toBe(7);
    await asTenant(() => onboarding.setStep(householdId, -3));
    expect((await asTenant(() => onboarding.state(householdId))).step).toBe(1);
  });

  it('merges progress into settings instead of replacing the document', async () => {
    // `households.settings` already holds `aiConfidenceThresholds`. A progress write that replaced
    // the document would silently reset a Household's ADR-009 thresholds — a bug that would show up
    // as odd review-queue behaviour weeks later.
    const household = await asTenant(() =>
      prisma.client.households.findFirst({ where: { id: householdId }, select: { settings: true } }),
    );
    const settings = household?.settings as Record<string, unknown>;
    expect(settings['aiConfidenceThresholds']).toEqual({ auto: 0.93, verify: 0.55 });
    expect(settings['onboarding']).toBeTruthy();
  });

  it('reports the counts the wizard needs to describe what a re-run would do', async () => {
    const state = await asTenant(() => onboarding.state(householdId));
    expect(state.categories).toBe(tree.length);
    expect(state.keywords).toBeGreaterThan(100);
    // Three owned (Lidl, Maxi, DM) plus the one from the unresolved test's re-run.
    expect(state.merchants).toBe(3);
    expect(state.accounts).toBe(0);
  });

  it('keeps one Household’s onboarding invisible to another', async () => {
    const other = await runWithTenant(otherContext, () => onboarding.state(otherHouseholdId));
    expect(other.step).toBe(1);
    expect(other.categories).toBe(0);
    expect(other.keywords).toBe(0);
    // Its own Lidl, created without a category, and not the first Household's copy.
    expect(other.merchants).toBe(1);
  });

  it('survives a settings document that is not an object', async () => {
    // `settings` is user-editable JSONB (a restore, a hand-edit); progress bookkeeping must not be
    // the thing that takes the wizard down.
    await asTenant(() =>
      prisma.client.households.update({
        where: { id: otherHouseholdId },
        data: { settings: [] as unknown as object },
      }),
    );
    const state = await runWithTenant(otherContext, () => onboarding.state(otherHouseholdId));
    expect(state.step).toBe(1);
  });

  // -------------------------------------------------------------------------------------------
  // The shipped catalogue's own invariants, in the form that decides a match
  // -------------------------------------------------------------------------------------------

  it('has no alias collision after folding, across the whole shipped catalogue', async () => {
    // The domain spec checks raw uniqueness without a dependency. This is the version that matters:
    // two merchants sharing a folded alias would make entity resolution depend on row order, and the
    // symptom would be a merchant that resolves *sometimes*.
    const owners = new Map<string, string>();
    const collisions: string[] = [];
    for (const merchant of SHIPPED_MERCHANTS) {
      for (const alias of [merchant.name, ...merchant.aliases]) {
        const folded = normaliseForMatching(alias);
        if (folded === '') continue;
        const owner = owners.get(folded);
        if (owner !== undefined && owner !== merchant.name) collisions.push(`${folded}: ${owner} / ${merchant.name}`);
        owners.set(folded, merchant.name);
      }
    }
    expect(collisions).toEqual([]);

    // And the database agrees, which is what a live resolution actually consults. Read through the
    // parent again — `merchant_aliases` cannot be queried directly.
    const globals = await asTenant(() =>
      prisma.client.merchants.findMany({
        where: { household_id: null, deleted_at: null },
        select: { id: true, merchant_aliases: { select: { alias: true } } },
      }),
    );
    const byAlias = new Map<string, Set<string>>();
    for (const merchant of globals) {
      for (const row of merchant.merchant_aliases) {
        const set = byAlias.get(row.alias) ?? new Set<string>();
        set.add(merchant.id);
        byAlias.set(row.alias, set);
      }
    }
    const shared = [...byAlias.entries()].filter(([, ids]) => ids.size > 1).map(([alias]) => alias);
    expect(shared).toEqual([]);
  });
});
