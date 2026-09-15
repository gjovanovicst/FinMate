/**
 * Development seed (docs/09 task 0.3, docs/11 §2.3).
 *
 * Two layers, both idempotent:
 *
 *  - **globals** (always): the shipped merchant catalogue as `merchants` rows with
 *    `household_id IS NULL, is_global = true`, readable by every Household;
 *  - **the demo fixture** (only with `SEED_HOUSEHOLD_ID`): one Household with a category tree, its
 *    keywords, and Household-owned merchants carrying default categories.
 *
 * ## The content is not here any more
 *
 * Task 2.3.3 moved the starter tree and the merchant catalogue into `@finmate/domain` (`src/seed/`),
 * because the onboarding wizard seeds the very same document for a real signup. Two copies of a
 * 40-node tree is how the demo Household and a new user end up with different category names, and
 * docs/11 §2.3 asks for content that ships *versioned*, so it lives with the code that shares it.
 *
 * ## Why this does not call `OnboardingService`
 *
 * Reusing the service is the obvious deduplication and the wrong one here: this script runs outside
 * Nest with a **bare** `PrismaClient`, so there is no `TenantContext` and the tenancy guard is not in
 * play — every write below sets `household_id` explicitly. The service runs *inside* the guard, where
 * a create to a household-scoped model gets its `household_id` injected and where merchants must go
 * through copy-on-write so a global row is never mutated. Same content, two legitimate write paths;
 * the part that must not drift — the document — is shared.
 *
 *   pnpm db:seed
 */
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import {
  SEED_VERSION,
  SHIPPED_MERCHANTS,
  flattenStarterCategories,
  uuidv7,
  type FlatStarterKeyword,
} from '@finmate/domain';

import { normaliseForMatching } from '../src/common/text/normalise';
import { PrismaClient } from '../src/generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL'] });
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const householdId = process.env['SEED_HOUSEHOLD_ID'];

  if (!householdId) {
    console.log('SEED_HOUSEHOLD_ID is not set: seeding global merchant reference data only.');
    await seedGlobalMerchants();
    return;
  }

  const ownerUserId = process.env['SEED_OWNER_USER_ID'];
  if (!ownerUserId) throw new Error('SEED_OWNER_USER_ID is required alongside SEED_HOUSEHOLD_ID.');

  await seedGlobalMerchants();
  await seedHousehold(householdId, ownerUserId);
}

async function seedGlobalMerchants(): Promise<void> {
  console.log(`seeding ${SHIPPED_MERCHANTS.length} global merchants (seed v${SEED_VERSION})...`);
  // Category defaults are household-specific, so a global merchant carries only its name, its
  // aliases and the seed key as a hint: `default_category_id` could only ever point at one
  // Household's category.
  for (const merchant of SHIPPED_MERCHANTS) {
    const existing = await prisma.merchants.findFirst({ where: { name: merchant.name, is_global: true } });
    const merchantId = existing?.id ?? uuidv7();
    if (!existing) {
      await prisma.merchants.create({
        data: { id: merchantId, name: merchant.name, is_global: true, ai_hint: merchant.categoryKey },
      });
    }
    for (const alias of new Set([merchant.name, ...merchant.aliases].map(normaliseForMatching))) {
      if (alias === '') continue;
      const clash = await prisma.merchant_aliases.findFirst({ where: { merchant_id: merchantId, alias } });
      if (!clash) {
        await prisma.merchant_aliases.create({ data: { id: uuidv7(), merchant_id: merchantId, alias } });
      }
    }
  }
  console.log(`done: ${SHIPPED_MERCHANTS.length} merchants and their aliases.`);
}

async function seedHousehold(householdId: string, ownerUserId: string): Promise<void> {
  console.log(`seeding household ${householdId}...`);

  const existingHousehold = await prisma.households.findFirst({ where: { id: householdId } });
  if (!existingHousehold) {
    await prisma.households.create({
      data: {
        id: householdId,
        name: 'Demo domaćinstvo',
        ledger_currency: 'RSD',
        iana_timezone: 'Europe/Belgrade',
        owner_user_id: ownerUserId,
        // Marked onboarded, so the demo Household is not sent through the wizard it exists to skip.
        settings: {
          onboarding: { step: 7, completedAt: new Date().toISOString(), seedVersion: SEED_VERSION },
        },
      },
    });
  }

  // --- accounts ---
  const accounts: readonly { name: string; kind: 'CASH' | 'BANK' | 'CARD' }[] = [
    { name: 'Keš', kind: 'CASH' },
    { name: 'Tekući račun', kind: 'BANK' },
    { name: 'Kartica', kind: 'CARD' },
  ];
  for (const account of accounts) {
    const found = await prisma.accounts.findFirst({ where: { household_id: householdId, name: account.name } });
    if (!found) {
      await prisma.accounts.create({
        data: { id: uuidv7(), household_id: householdId, name: account.name, kind: account.kind, currency: 'RSD' },
      });
    }
  }

  // --- category tree, parents before children ---
  // `flattenStarterCategories` guarantees the order, which is what lets this be a single pass: a
  // child's parent has always been written by the time the child is reached.
  const bySeedKey = new Map<string, string>();
  const bySeedPath = new Map<string, string>();
  let createdCategories = 0;
  let createdKeywords = 0;

  for (const node of flattenStarterCategories()) {
    const parentId = node.parentPath.length === 0 ? null : (bySeedPath.get(pathKey(node.parentPath)) ?? null);

    const existing = await prisma.categories.findFirst({
      where: { household_id: householdId, name: node.name, parent_id: parentId },
    });
    const id = existing?.id ?? uuidv7();

    if (!existing) {
      await prisma.categories.create({
        data: {
          id,
          household_id: householdId,
          parent_id: parentId,
          name: node.name,
          kind: node.kind,
          icon: node.icon ?? null,
          ai_description: node.aiDescription ?? null,
          is_system: true,
        },
      });
      createdCategories += 1;
    }

    // Both keys: the seed key is what a merchant suggests, and the path is what a *child* needs to
    // find the id of the parent the document names (the document names paths, not ids).
    bySeedKey.set(node.key, id);
    bySeedPath.set(pathKey([...node.parentPath, node.name]), id);

    for (const entry of node.keywords) {
      createdKeywords += await seedKeyword(householdId, id, entry);
    }
  }

  // --- this Household's own merchants, with the default categories the catalogue suggests ---
  let linked = 0;
  for (const seed of SHIPPED_MERCHANTS) {
    const categoryId = bySeedKey.get(seed.categoryKey);
    const existing = await prisma.merchants.findFirst({
      where: { household_id: householdId, name: seed.name, deleted_at: null },
    });
    const merchantId = existing?.id ?? uuidv7();

    if (!existing) {
      await prisma.merchants.create({
        data: {
          id: merchantId,
          household_id: householdId,
          name: seed.name,
          default_category_id: categoryId ?? null,
          is_global: false,
        },
      });
    } else if (categoryId !== undefined && existing.default_category_id === null) {
      // Fill an empty default; never overwrite one the user set.
      await prisma.merchants.update({ where: { id: merchantId }, data: { default_category_id: categoryId } });
    }
    linked += 1;

    for (const alias of new Set([seed.name, ...seed.aliases].map(normaliseForMatching))) {
      if (alias === '') continue;
      const clash = await prisma.merchant_aliases.findFirst({ where: { merchant_id: merchantId, alias } });
      if (!clash) {
        await prisma.merchant_aliases.create({ data: { id: uuidv7(), merchant_id: merchantId, alias } });
      }
    }
  }

  const categoryCount = await prisma.categories.count({ where: { household_id: householdId, deleted_at: null } });
  const keywordCount = await prisma.category_keywords.count({ where: { household_id: householdId } });
  console.log(
    `done: 3 accounts, ${categoryCount} categories (+${createdCategories} new), ` +
      `${keywordCount} keywords (+${createdKeywords} new), ${linked} household merchants.`,
  );
}

/**
 * Write one keyword, correcting its weight if the row is already there at the wrong one.
 *
 * The weight is load-bearing (docs/04 §5.4 decides at a score of 2.0), so an existing row seeded
 * before task 2.3.3 at the schema default must be raised rather than skipped — otherwise a Household
 * that ran the old seed keeps a tree that cannot categorise anything.
 */
async function seedKeyword(
  householdId: string,
  categoryId: string,
  entry: FlatStarterKeyword,
): Promise<number> {
  // The same fold `addKeyword` and the onboarding service use, so a seeded keyword and an
  // editor-typed one are stored identically (docs/05 §5.3 — one definition of the fold).
  const keyword = normaliseForMatching(entry.word);
  if (keyword === '') return 0;

  const existing = await prisma.category_keywords.findFirst({
    where: { household_id: householdId, category_id: categoryId, keyword, polarity: entry.polarity },
  });
  if (existing === null) {
    await prisma.category_keywords.create({
      data: {
        id: uuidv7(),
        household_id: householdId,
        category_id: categoryId,
        keyword,
        polarity: entry.polarity,
        weight: entry.weight,
      },
    });
    return 1;
  }
  if (Number(existing.weight) !== entry.weight) {
    await prisma.category_keywords.update({ where: { id: existing.id }, data: { weight: entry.weight } });
  }
  return 0;
}

/** A stable key for a path of names, used only inside this script to find a parent's id. */
function pathKey(names: readonly string[]): string {
  return names.join('\u0000');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error('SEED FAILED:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
