/**
 * Development seed (docs/09 task 0.3).
 *
 * Seeds the **starter knowledge** that a new Household needs before it has any history of its own:
 * a Serbian category tree, the merchants people actually shop at, and a couple of Counterparties.
 *
 * This is not throwaway fixture data — it is a first implementation of the F-13 onboarding seed
 * (docs/01 §5), which exists to mitigate the cold-start risk R-01: the AI cannot be impressive
 * until it knows the household, so we ship that knowledge rather than making the user type it.
 *
 * Idempotent: safe to re-run. It keys off stable ids and upserts.
 *
 *   pnpm db:seed
 */
import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';

import { uuidv7 } from '@finmate/domain';

import { PrismaClient } from '../src/generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL'] });
const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------------------------
// Starter category tree. Derived from the shape discussed in the concept conversation
// (docs/01 §5, docs/04 §5.4) — deliberately shallow where the user is unlikely to drill in, and
// specific where the product's differentiator lives (e.g. Kuća / Septička jama).
// ---------------------------------------------------------------------------------------------
interface CategorySeed {
  readonly key: string;
  readonly name: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly icon?: string;
  readonly aiDescription?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly children?: readonly CategorySeed[];
}

const CATEGORY_TREE: readonly CategorySeed[] = [
  {
    key: 'hrana',
    name: 'Hrana',
    kind: 'EXPENSE',
    icon: '🛒',
    aiDescription: 'Namirnice, marketi, pekare i restorani.',
    include: ['hrana', 'namirnice', 'market', 'prodavnica'],
    children: [
      { key: 'hrana-supermarket', name: 'Supermarket', kind: 'EXPENSE', include: ['lidl', 'maxi', 'idea', 'dis', 'univerexport', 'shopgo'] },
      { key: 'hrana-pekara', name: 'Pekara', kind: 'EXPENSE', include: ['pekara', 'hleb', 'burek'] },
      { key: 'hrana-restoran', name: 'Restoran', kind: 'EXPENSE', include: ['restoran', 'kafana', 'ručak', 'večera', 'dostava'] },
      { key: 'hrana-kafa', name: 'Kafa i kolači', kind: 'EXPENSE', include: ['kafa', 'kafić', 'poslastičarnica'] },
    ],
  },
  {
    key: 'auto',
    name: 'Automobil',
    kind: 'EXPENSE',
    icon: '🚗',
    children: [
      {
        key: 'auto-gorivo',
        name: 'Gorivo',
        kind: 'EXPENSE',
        include: ['gorivo', 'benzin', 'dizel', 'nafta', 'pumpa'],
        // Exclude is not decoration: without it "ulje" would route engine oil into fuel.
        exclude: ['ulje', 'filter', 'servis', 'gume', 'registracija'],
      },
      { key: 'auto-servis', name: 'Servis', kind: 'EXPENSE', include: ['servis', 'majstor', 'popravka'] },
      { key: 'auto-delovi', name: 'Delovi', kind: 'EXPENSE', include: ['delovi', 'filter', 'ulje', 'gume'] },
      { key: 'auto-registracija', name: 'Registracija', kind: 'EXPENSE', include: ['registracija', 'tehnički pregled', 'osiguranje'] },
      { key: 'auto-parking', name: 'Parking i putarine', kind: 'EXPENSE', include: ['parking', 'putarina', 'mostarina'] },
    ],
  },
  {
    key: 'kuca',
    name: 'Kuća',
    kind: 'EXPENSE',
    icon: '🏠',
    children: [
      { key: 'kuca-struja', name: 'Struja', kind: 'EXPENSE', include: ['struja', 'eps', 'elektro'] },
      { key: 'kuca-voda', name: 'Voda', kind: 'EXPENSE', include: ['voda', 'vodovod', 'kanalizacija'] },
      { key: 'kuca-grejanje', name: 'Grejanje', kind: 'EXPENSE', include: ['grejanje', 'gas', 'toplana', 'drva', 'pelet'] },
      { key: 'kuca-internet', name: 'Internet i TV', kind: 'EXPENSE', include: ['internet', 'sbb', 'mts', 'orion', 'yettel'] },
      { key: 'kuca-telefon', name: 'Telefon', kind: 'EXPENSE', include: ['telefon', 'telekom', 'mobilni', 'a1'] },
      {
        key: 'kuca-septicka',
        name: 'Septička jama',
        kind: 'EXPENSE',
        aiDescription: 'Pražnjenje, čišćenje i održavanje septičke jame.',
        include: ['septička', 'septicka', 'jama', 'pražnjenje jame', 'cisterna', 'feKalna'],
      },
      { key: 'kuca-odrzavanje', name: 'Održavanje', kind: 'EXPENSE', include: ['održavanje', 'majstor', 'popravka', 'renoviranje'] },
    ],
  },
  {
    key: 'porodica',
    name: 'Porodica',
    kind: 'EXPENSE',
    icon: '👨‍👩‍👧',
    children: [
      { key: 'porodica-deca', name: 'Deca', kind: 'EXPENSE', include: ['deca', 'vrtić', 'škola', 'igračke'] },
      { key: 'porodica-pokloni', name: 'Pokloni', kind: 'EXPENSE', include: ['poklon', 'rođendan', 'rodjendan', 'svadba', 'krštenje'] },
      { key: 'porodica-zdravlje', name: 'Zdravlje', kind: 'EXPENSE', include: ['apoteka', 'lekar', 'zdravlje', 'pregled', 'zubar'] },
    ],
  },
  {
    key: 'higijena',
    name: 'Higijena',
    kind: 'EXPENSE',
    icon: '🧴',
    aiDescription: 'Lična higijena i sredstva za čišćenje — često na istom računu kao hrana.',
    include: ['higijena', 'šampon', 'sampon', 'sapun', 'pasta za zube', 'deterdžent', 'sredstvo za sudove'],
  },
  {
    key: 'odeca',
    name: 'Odeća i obuća',
    kind: 'EXPENSE',
    icon: '👕',
    include: ['odeća', 'obuca', 'obuća', 'patike', 'jakna'],
  },
  {
    key: 'zabava',
    name: 'Zabava',
    kind: 'EXPENSE',
    icon: '🎬',
    children: [
      { key: 'zabava-pretplate', name: 'Pretplate', kind: 'EXPENSE', include: ['netflix', 'spotify', 'hbo', 'disney', 'pretplata', 'youtube'] },
      { key: 'zabava-izlasci', name: 'Izlasci', kind: 'EXPENSE', include: ['izlazak', 'bioskop', 'koncert', 'karte'] },
      { key: 'zabava-sport', name: 'Sport', kind: 'EXPENSE', include: ['teretana', 'bazen', 'sport', 'trening'] },
    ],
  },
  {
    key: 'finansije',
    name: 'Finansije',
    kind: 'EXPENSE',
    icon: '🏦',
    children: [
      { key: 'finansije-kredit', name: 'Kredit', kind: 'EXPENSE', include: ['kredit', 'rata', 'anuitet'] },
      { key: 'finansije-stednja', name: 'Štednja', kind: 'EXPENSE', include: ['štednja', 'stednja', 'štek'] },
      { key: 'finansije-naknade', name: 'Bankovne naknade', kind: 'EXPENSE', include: ['naknada', 'provizija', 'održavanje računa'] },
    ],
  },
  { key: 'ostalo', name: 'Ostalo', kind: 'EXPENSE', icon: '📦', aiDescription: 'Nekategorizovani troškovi.' },

  // ---- income ----
  { key: 'prihod-plata', name: 'Plata', kind: 'INCOME', icon: '💰', include: ['plata', 'zarada', 'honorar'] },
  { key: 'prihod-penzija', name: 'Penzija', kind: 'INCOME', icon: '👴', include: ['penzija'] },
  { key: 'prihod-uplata', name: 'Uplata', kind: 'INCOME', icon: '⬆️', include: ['uplata', 'primio', 'leglo'] },
  { key: 'prihod-povracaj', name: 'Povraćaj', kind: 'INCOME', icon: '↩️', include: ['povraćaj', 'povracaj', 'refundacija', 'reklamacija'] },
];

// ---------------------------------------------------------------------------------------------
// Local merchants shipped with onboarding (docs/01 §5 step 4). `category` refers to a category
// key above; aliases cover how people actually type the name.
// ---------------------------------------------------------------------------------------------
interface MerchantSeed {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly category: string;
}

const MERCHANTS: readonly MerchantSeed[] = [
  { name: 'Lidl', aliases: ['lidl', 'lidle', 'лидл'], category: 'hrana-supermarket' },
  { name: 'Maxi', aliases: ['maxi', 'maksi'], category: 'hrana-supermarket' },
  { name: 'Idea', aliases: ['idea', 'idea market'], category: 'hrana-supermarket' },
  { name: 'DIS', aliases: ['dis', 'dis market'], category: 'hrana-supermarket' },
  { name: 'Univerexport', aliases: ['univerexport', 'univereksport'], category: 'hrana-supermarket' },
  { name: 'Shop&Go', aliases: ['shop&go', 'shop and go', 'shopgo'], category: 'hrana-supermarket' },
  { name: 'Aman', aliases: ['aman'], category: 'hrana-supermarket' },
  { name: 'Roda', aliases: ['roda'], category: 'hrana-supermarket' },
  { name: 'Mere', aliases: ['mere'], category: 'hrana-supermarket' },
  { name: 'Lilly', aliases: ['lilly', 'lili'], category: 'hrana-supermarket' },
  { name: 'Pekara Trpković', aliases: ['trpkovic', 'trpković'], category: 'hrana-pekara' },
  { name: 'Hleb & Kifle', aliases: ['hleb i kifle', 'hleb & kifle'], category: 'hrana-pekara' },
  { name: 'NIS Petrol', aliases: ['nis', 'nis petrol', 'газпром'], category: 'auto-gorivo' },
  { name: 'Lukoil', aliases: ['lukoil', 'лукоил'], category: 'auto-gorivo' },
  { name: 'OMV', aliases: ['omv'], category: 'auto-gorivo' },
  { name: 'Shell', aliases: ['shell', 'šel'], category: 'auto-gorivo' },
  { name: 'MOL', aliases: ['mol'], category: 'auto-gorivo' },
  { name: 'EPS', aliases: ['eps', 'elektroprivreda', 'struja'], category: 'kuca-struja' },
  { name: 'Vodovod', aliases: ['vodovod', 'voda'], category: 'kuca-voda' },
  { name: 'Srbijagas', aliases: ['srbijagas', 'gas'], category: 'kuca-grejanje' },
  { name: 'Beogradske elektrane', aliases: ['elektrane', 'toplana'], category: 'kuca-grejanje' },
  { name: 'SBB', aliases: ['sbb', 'sbb internet'], category: 'kuca-internet' },
  { name: 'MTS', aliases: ['mts', 'telekom srbija', 'telekom'], category: 'kuca-internet' },
  { name: 'Yettel', aliases: ['yettel', 'telenor'], category: 'kuca-telefon' },
  { name: 'A1', aliases: ['a1', 'vip mobile', 'vip'], category: 'kuca-telefon' },
  { name: 'Orion Telekom', aliases: ['orion'], category: 'kuca-internet' },
  { name: 'Netflix', aliases: ['netflix'], category: 'zabava-pretplate' },
  { name: 'Spotify', aliases: ['spotify'], category: 'zabava-pretplate' },
  { name: 'HBO Max', aliases: ['hbo', 'hbo max', 'max'], category: 'zabava-pretplate' },
  { name: 'Disney+', aliases: ['disney', 'disney+'], category: 'zabava-pretplate' },
  { name: 'YouTube Premium', aliases: ['youtube', 'yt premium'], category: 'zabava-pretplate' },
  { name: 'Apoteka Benu', aliases: ['benu', 'apoteka benu'], category: 'porodica-zdravlje' },
  { name: 'Apoteka Lilly', aliases: ['apoteka lilly'], category: 'porodica-zdravlje' },
  { name: 'DM', aliases: ['dm', 'dm drogerie'], category: 'higijena' },
  { name: 'Lilly Drogerie', aliases: ['lilly drogerie'], category: 'higijena' },
  { name: 'Sport Vision', aliases: ['sport vision'], category: 'odeca' },
  { name: 'Đak Sport', aliases: ['djak', 'đak sport'], category: 'odeca' },
  { name: 'Teretana', aliases: ['teretana', 'gym'], category: 'zabava-sport' },
];

async function main(): Promise<void> {
  const householdId = process.env['SEED_HOUSEHOLD_ID'];

  if (!householdId) {
    console.log('SEED_HOUSEHOLD_ID is not set: seeding global merchant reference data only.');
    // Merchants with a NULL household_id are the shipped global seed (docs/03 §4).
    await seedGlobalMerchants();
    return;
  }

  const ownerUserId = process.env['SEED_OWNER_USER_ID'];
  if (!ownerUserId) throw new Error('SEED_OWNER_USER_ID is required alongside SEED_HOUSEHOLD_ID.');

  await seedHousehold(householdId, ownerUserId);
}

async function seedGlobalMerchants(): Promise<void> {
  console.log(`seeding ${MERCHANTS.length} global merchants...`);
  // Category defaults are household-specific, so global merchants carry only names and aliases.
  for (const merchant of MERCHANTS) {
    const existing = await prisma.merchants.findFirst({ where: { name: merchant.name, is_global: true } });
    const merchantId = existing?.id ?? uuidv7();
    if (!existing) {
      await prisma.merchants.create({
        data: { id: merchantId, name: merchant.name, is_global: true, ai_hint: merchant.category },
      });
    }
    for (const alias of merchant.aliases) {
      const clash = await prisma.merchant_aliases.findFirst({ where: { merchant_id: merchantId, alias } });
      if (!clash) {
        await prisma.merchant_aliases.create({ data: { id: uuidv7(), merchant_id: merchantId, alias } });
      }
    }
  }
  console.log(`done: ${MERCHANTS.length} merchants and their aliases.`);
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

  // --- category tree ---
  const categoryIds = new Map<string, string>();

  const insertCategory = async (
    seed: CategorySeed,
    parentId: string | null,
    sortOrder: number,
  ): Promise<void> => {
    const existing = await prisma.categories.findFirst({
      where: { household_id: householdId, name: seed.name, parent_id: parentId },
    });
    const id = existing?.id ?? uuidv7();

    if (!existing) {
      await prisma.categories.create({
        data: {
          id,
          household_id: householdId,
          parent_id: parentId,
          name: seed.name,
          kind: seed.kind,
          icon: seed.icon ?? null,
          ai_description: seed.aiDescription ?? null,
          is_system: true,
          sort_order: sortOrder,
        },
      });
    }
    categoryIds.set(seed.key, id);

    await seedKeywords(id, seed);
    for (const [index, child] of (seed.children ?? []).entries()) {
      await insertCategory(child, id, index);
    }
  };

  const seedKeywords = async (categoryId: string, seed: CategorySeed): Promise<void> => {
    for (const [polarity, words] of [
      ['INCLUDE', seed.include ?? []],
      ['EXCLUDE', seed.exclude ?? []],
    ] as const) {
      for (const keyword of words) {
        const normalized = keyword.toLocaleLowerCase('sr-Latn-RS');
        const clash = await prisma.category_keywords.findFirst({
          where: { household_id: householdId, category_id: categoryId, keyword: normalized, polarity },
        });
        if (!clash) {
          await prisma.category_keywords.create({
            data: { id: uuidv7(), household_id: householdId, category_id: categoryId, keyword: normalized, polarity },
          });
        }
      }
    }
  };

  for (const [index, root] of CATEGORY_TREE.entries()) {
    await insertCategory(root, null, index);
  }

  // --- link this household's merchants to categories ---
  for (const seed of MERCHANTS) {
    const categoryId = categoryIds.get(seed.category);
    if (!categoryId) continue;
    for (const alias of new Set([seed.name.toLocaleLowerCase('sr-Latn-RS'), ...seed.aliases])) {
      const merchant = await prisma.merchants.findFirst({
        where: { household_id: householdId, name: seed.name },
      });
      const merchantId = merchant?.id ?? uuidv7();
      if (!merchant) {
        await prisma.merchants.create({
          data: { id: merchantId, household_id: householdId, name: seed.name, default_category_id: categoryId },
        });
      } else {
        await prisma.merchants.update({
          where: { id: merchantId },
          data: { default_category_id: categoryId },
        });
      }
      const clash = await prisma.merchant_aliases.findFirst({ where: { merchant_id: merchantId, alias } });
      if (!clash) {
        await prisma.merchant_aliases.create({ data: { id: uuidv7(), merchant_id: merchantId, alias } });
      }
    }
  }

  const categoryCount = await prisma.categories.count({ where: { household_id: householdId } });
  const keywordCount = await prisma.category_keywords.count({ where: { household_id: householdId } });
  console.log(
    `done: 3 accounts, ${categoryCount} categories, ${keywordCount} category keywords, ${MERCHANTS.length} merchants.`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error('SEED FAILED:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
