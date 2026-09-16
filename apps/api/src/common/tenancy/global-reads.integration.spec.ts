import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

import { requireShippedGlobals } from '../../../test/shipped-globals';

import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { runWithTenant } from './tenant-context';

/**
 * The tenancy guard against a real database, for the global-readable case.
 *
 * `tenancy.extension.spec.ts` proves the guard builds the right `where`. That is not the same claim:
 * Prisma could reject the composed `AND: [{ OR: … }]`, or resolve it differently, and the unit test
 * would stay green. docs/08 puts global rows on the allow-list, and the seeded merchant catalogue is
 * the only such data that exists today — if these reads are wrong, Phase 2's classifier is blind to
 * its own seed and nobody finds out until accuracy is inexplicably bad.
 */
describe('global-readable models (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  const householdId = uuidv7();
  const userId = uuidv7();
  let ownMerchantId: string;
  let seededGlobalMerchantId: string | null = null;

  const context = { householdId, userId, role: 'OWNER' as const, requestId: 'test' };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    // The precondition this spec's own note names: the shipped catalogue is data, not fixture.
    await requireShippedGlobals(prisma);

    await runWithTenant(context, async () => {
      await prisma.client.users.create({
        data: { id: userId, email: `global-${Date.now()}@example.com`, display_name: 'Global Test' },
      });
      await prisma.client.households.create({
        data: { id: householdId, name: 'Global Test', owner_user_id: userId },
      });
      const own = await prisma.client.merchants.create({ data: { id: uuidv7(), name: 'Moj Prodavac' } });
      ownMerchantId = own.id;
    });

    // The platform seed is a precondition, not something this test creates. Read via raw SQL
    // because there is deliberately no unguarded client: the guard is applied in PrismaService, and
    // `$queryRaw` is the only escape hatch (the model-level hook does not intercept it).
    const seeded = await prisma.client.$queryRaw<{ id: string }[]>`
      SELECT id FROM merchants WHERE household_id IS NULL AND is_global = true LIMIT 1
    `;
    seededGlobalMerchantId = seeded[0]?.id ?? null;
  });

  afterAll(async () => {
    // Deleting the Household cascades to its merchants, so the created rows go with it.
    await runWithTenant(context, async () => {
      await prisma.client.households.deleteMany({ where: { id: householdId } });
    });
    await prisma.client.users.deleteMany({ where: { id: userId } });
    await moduleRef?.close();
  });

  it('has the platform merchant seed to read', () => {
    expect(seededGlobalMerchantId).not.toBeNull();
  });

  it('returns the Household-owned merchants AND the seeded global ones', async () => {
    const rows = await runWithTenant(context, () =>
      prisma.client.merchants.findMany({ select: { id: true, household_id: true } }),
    );

    const ids = rows.map((row) => row.id);
    expect(ids).toContain(ownMerchantId);
    expect(ids).toContain(seededGlobalMerchantId as string);
    // Every row is either ours or global — never another Household's.
    for (const row of rows) {
      expect(row.household_id === null || row.household_id === householdId).toBe(true);
    }
  });

  it('counts both, so an aggregate is not silently short', async () => {
    const total = await runWithTenant(context, () => prisma.client.merchants.count());
    const [{ count }] = await prisma.client.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM merchants WHERE household_id IS NULL AND is_global = true
    `;
    expect(total).toBe(Number(count) + 1);
  });

  it('cannot rename a global merchant: the write predicate excludes NULL', async () => {
    const result = await runWithTenant(context, () =>
      prisma.client.merchants.updateMany({
        where: { id: seededGlobalMerchantId as string },
        data: { name: 'Hijacked' },
      }),
    );
    expect(result.count).toBe(0);

    const [after] = await prisma.client.$queryRaw<{ name: string }[]>`
      SELECT name FROM merchants WHERE id = ${seededGlobalMerchantId}::uuid
    `;
    expect(after?.name).not.toBe('Hijacked');
  });

  it('cannot delete a global merchant', async () => {
    const result = await runWithTenant(context, () =>
      prisma.client.merchants.deleteMany({ where: { id: seededGlobalMerchantId as string } }),
    );
    expect(result.count).toBe(0);
    const [still] = await prisma.client.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM merchants WHERE id = ${seededGlobalMerchantId}::uuid
    `;
    expect(Number(still?.count)).toBe(1);
  });

  it('creates household-owned rows even when asked for a global one', async () => {
    const created = await runWithTenant(context, () =>
      prisma.client.merchants.create({
        data: { id: uuidv7(), name: 'Sneaky Global', is_global: true },
      }),
    );
    expect(created.household_id).toBe(householdId);
    expect(created.is_global).toBe(false);
  });
});
