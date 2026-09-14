import { Test, type TestingModule } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { toLocalDate, uuidv7 } from '@finmate/domain';

import { runWithTenant } from '../../common/tenancy/tenant-context';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerModule } from './ledger.module';
import { TransactionKind } from './transaction.model';
import { TransactionsService } from './transactions.service';

/**
 * The date columns, against a real database and a real Household timezone.
 *
 * `occurred_local_date` is the calendar day in the Household's zone (invariant I-2). Before
 * `occurredLocalDate` existed a client could only send an instant, so the web client sent noon UTC
 * and an Auckland Household (UTC+12/+13) read it as the *next* day — the month-boundary bug this
 * suite guards. The server must be able to derive the instant from the day instead.
 *
 * The same file covers the I-1 guard on amount updates: a split Transaction's amount is the sum of
 * its splits, and Postgres cannot express that cross-table CHECK, so only the service can refuse it.
 */
describe('TransactionsService dates and split updates (integration)', () => {
  let moduleRef: TestingModule;
  let transactions: TransactionsService;
  let prisma: PrismaService;

  let userId: string;
  let householdId: string;
  let accountId: string;
  let groceriesId: string;
  let transportId: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot(), PrismaModule, LedgerModule],
    }).compile();
    transactions = moduleRef.get(TransactionsService);
    prisma = moduleRef.get(PrismaService);

    userId = uuidv7();
    householdId = uuidv7();
    accountId = uuidv7();
    groceriesId = uuidv7();
    transportId = uuidv7();

    await runWithTenant({ householdId, userId, role: 'OWNER', requestId: 'test-setup' }, async () => {
      await prisma.client.users.create({
        data: { id: userId, email: `ledger-${Date.now()}@example.com`, display_name: 'Ledger Test' },
      });
      // The timezone belongs to the Household, so it is set here rather than assumed by the fixture.
      await prisma.client.households.create({
        data: {
          id: householdId,
          name: 'Ledger Test',
          owner_user_id: userId,
          iana_timezone: 'Pacific/Auckland',
          ledger_currency: 'RSD',
        },
      });
      await prisma.client.accounts.create({
        data: {
          id: accountId,
          household_id: householdId,
          name: 'Everyday',
          kind: 'BANK',
          currency: 'RSD',
        },
      });
      await prisma.client.categories.createMany({
        data: [
          { id: groceriesId, household_id: householdId, name: 'Groceries', kind: 'EXPENSE' },
          { id: transportId, household_id: householdId, name: 'Transport', kind: 'EXPENSE' },
        ],
      });
    });
  });

  afterAll(async () => {
    // Scoped teardown: the tenancy guard refuses an unscoped household delete, which is the correct
    // production behaviour and the reason this is wrapped rather than a bare deleteMany.
    await runWithTenant(
      { householdId, userId, role: 'OWNER', requestId: 'test-teardown' },
      async () => {
        await prisma.client.households.deleteMany({ where: { id: householdId } });
      },
    );
    await prisma.client.users.deleteMany({ where: { id: userId } });
    await moduleRef?.close();
  });

  /** A service call the way a request makes it: the guard throws outside a TenantContext. */
  function asTenant<T>(fn: () => Promise<T>): Promise<T> {
    return runWithTenant({ householdId, userId, role: 'OWNER', requestId: 'test-call' }, fn);
  }

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      accountId,
      kind: TransactionKind.EXPENSE,
      amountMinor: 200_00n,
      description: 'Lidl',
      ...overrides,
    };
  }

  async function createSplitTransaction() {
    return asTenant(() =>
      transactions.create(householdId, {
        accountId,
        kind: TransactionKind.EXPENSE,
        amountMinor: 300_00n,
        description: 'Lidl basket',
        occurredLocalDate: '2026-09-01',
        splits: [
          { categoryId: groceriesId, amountMinor: 200_00n },
          { categoryId: transportId, amountMinor: 100_00n },
        ],
      }),
    );
  }

  describe('occurredLocalDate — the client asserts the day', () => {
    it('files a date-only create on the asserted local day, not the UTC day', async () => {
      const created = await asTenant(() =>
        transactions.create(householdId, baseInput({ occurredLocalDate: '2026-09-01' })),
      );

      expect(created.occurredLocalDate).toBe('2026-09-01');
      // 2026-09-01 is still NZST (UTC+12), so local noon is 00:00 UTC on the same day — NOT noon
      // UTC, which Auckland would read as 2026-09-02.
      expect(created.occurredAt.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(toLocalDate(created.occurredAt, 'Pacific/Auckland')).toBe('2026-09-01');
    });

    it('prefers occurredLocalDate when an occurredAt that disagrees is also sent', async () => {
      const created = await asTenant(() =>
        transactions.create(
          householdId,
          baseInput({
            occurredLocalDate: '2026-09-01',
            // Noon UTC is 2026-09-02T00:00 in Auckland (UTC+12), so on its own it would file the row
            // a day late — the exact client behaviour this argument replaces.
            occurredAt: new Date('2026-09-01T12:00:00.000Z'),
          }),
        ),
      );

      expect(created.occurredLocalDate).toBe('2026-09-01');
      expect(toLocalDate(created.occurredAt, 'Pacific/Auckland')).toBe('2026-09-01');
    });

    it('still derives the local day from occurredAt when only an instant is sent', async () => {
      const created = await asTenant(() =>
        transactions.create(
          householdId,
          baseInput({ occurredAt: new Date('2026-09-01T12:00:00.000Z') }),
        ),
      );

      // Existing behaviour is unchanged: noon UTC is the next day in Auckland.
      expect(created.occurredLocalDate).toBe('2026-09-02');
    });

    it('moves the calendar day on update via occurredLocalDate, across a month boundary', async () => {
      const created = await asTenant(() =>
        transactions.create(householdId, baseInput({ occurredLocalDate: '2026-09-30' })),
      );
      expect(created.version).toBe(1);

      const updated = await asTenant(() =>
        transactions.update(householdId, created.id, {
          version: created.version,
          occurredLocalDate: '2026-10-01',
        }),
      );

      expect(updated.occurredLocalDate).toBe('2026-10-01');
      expect(toLocalDate(updated.occurredAt, 'Pacific/Auckland')).toBe('2026-10-01');
      expect(updated.version).toBe(2);
    });

    it('refuses a create with neither occurredAt nor occurredLocalDate', async () => {
      await expect(
        asTenant(() => transactions.create(householdId, baseInput())),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('refuses a malformed occurredLocalDate as a typed validation error', async () => {
      await expect(
        asTenant(() =>
          transactions.create(householdId, baseInput({ occurredLocalDate: '2026-02-31' })),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('I-1 on update — a split amount cannot be edited away from its splits', () => {
    it('refuses an amount change on a split Transaction', async () => {
      const created = await createSplitTransaction();

      await expect(
        asTenant(() =>
          transactions.update(householdId, created.id, {
            version: created.version,
            amountMinor: 400_00n,
          }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('still allows a non-amount edit on a split Transaction, and bumps version', async () => {
      const created = await createSplitTransaction();

      const updated = await asTenant(() =>
        transactions.update(householdId, created.id, {
          version: created.version,
          note: 'still split',
        }),
      );

      expect(updated.version).toBe(created.version + 1);
      expect(updated.note).toBe('still split');
      expect(updated.splits.reduce((sum, split) => sum + split.amount.amountMinor, 0n)).toBe(300_00n);
    });

    it('allows re-sending the unchanged amount on a split Transaction', async () => {
      const created = await createSplitTransaction();

      const updated = await asTenant(() =>
        transactions.update(householdId, created.id, {
          version: created.version,
          amountMinor: 300_00n,
        }),
      );

      expect(updated.amount.amountMinor).toBe(300_00n);
      expect(updated.version).toBe(created.version + 1);
    });

    it('mutates nothing when the amount change is refused', async () => {
      const created = await createSplitTransaction();

      await expect(
        asTenant(() =>
          transactions.update(householdId, created.id, {
            version: created.version,
            amountMinor: 999_00n,
          }),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

      const reloaded = await asTenant(() => transactions.getById(householdId, created.id));
      expect(reloaded.amount.amountMinor).toBe(300_00n);
      expect(reloaded.splits.reduce((sum, split) => sum + split.amount.amountMinor, 0n)).toBe(300_00n);
      expect(reloaded.version).toBe(created.version);
    });
  });
});
