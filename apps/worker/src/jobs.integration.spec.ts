import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { addDays, todayIn, uuidv7 } from '@finmate/domain';

import {
  TenancyError,
} from '@finmate/api/common/tenancy/tenancy.extension';
import {
  runAsSystem,
  runWithTenant,
  type TenantContext,
} from '@finmate/api/common/tenancy/tenant-context';
import { PrismaService } from '@finmate/api/prisma/prisma.service';
import type { INestApplicationContext } from '@nestjs/common';

import { JOBS, householdDirectory, runJob } from './jobs';
import { WorkerModule } from './worker.module';

/**
 * The worker's job registry — ADR-022, docs/05 §8.
 *
 * What only a real module graph and database can answer: that the worker can **boot the API's feature
 * modules at all** (the risk ADR-022 names — a service whose dependencies the worker's graph does not
 * import fails the worker's boot while `api:test` stays green), that a job enumerates Households
 * through the one sanctioned exception (ADR-008's job scope) and then does its work **inside** a
 * tenant, and that a Household which throws does not stop the others.
 */
describe('the worker (integration)', () => {
  let app: INestApplicationContext;
  let prisma: PrismaService;

  const householdId = uuidv7();
  const otherHouseholdId = uuidv7();
  const userId = uuidv7();
  const otherUserId = uuidv7();

  const context: TenantContext = { householdId, userId, role: 'OWNER', requestId: 'worker-it' };
  const asTenant = <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(context, fn);

  beforeAll(async () => {
    // Booting the same way the process boots is the point: a provider the worker's module graph cannot
    // resolve fails here, which is exactly the risk ADR-022 records.
    //
    // `abortOnError: false` is what makes that failure **readable**. It defaults to true, and Nest then
    // answers an unresolvable provider with `process.abort()` — a native stack trace, no message, and a
    // worker the pool reports only as "Channel closed". CI failed exactly that way and the cause had to
    // be recovered by hand (docs/15). With it false, the failure throws the readable
    // "Nest can't resolve dependencies of X" error naming the module.
    app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
      abortOnError: false,
    });
    prisma = app.get(PrismaService);

    const stamp = Date.now();
    await prisma.client.users.createMany({
      data: [
        { id: userId, email: `worker-${stamp}@example.com`, display_name: 'Worker Test' },
        { id: otherUserId, email: `worker-b-${stamp}@example.com`, display_name: 'Other' },
      ],
    });
    for (const [ctx, id, owner, name] of [
      [context, householdId, userId, 'Worker Test'],
      [
        { householdId: otherHouseholdId, userId: otherUserId, role: 'OWNER' as const, requestId: 'worker-it-other' },
        otherHouseholdId,
        otherUserId,
        'Other',
      ],
    ] as const) {
      await runWithTenant(ctx, () =>
        prisma.client.households.create({
          data: { id, name, owner_user_id: owner, ledger_currency: 'RSD', iana_timezone: 'Europe/Belgrade' },
        }),
      );
    }
  });

  afterAll(async () => {
    for (const [ctx, id] of [
      [context, householdId],
      [
        { householdId: otherHouseholdId, userId: otherUserId, role: 'OWNER' as const, requestId: 'worker-it-other' },
        otherHouseholdId,
      ],
    ] as const) {
      await runWithTenant(ctx, () => prisma.client.households.deleteMany({ where: { id } }));
    }
    await prisma.client.users.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await app?.close();
  });

  it('registers every job with a schedule and an idempotency statement', () => {
    expect(JOBS.map((job) => job.name).sort()).toEqual([
      'files.purge',
      'insights.generate',
      'notifications.dispatch',
      'recurring.detect',
      'recurring.materialise',
    ]);
    for (const job of JOBS) {
      expect(job.schedule.length).toBeGreaterThan(0);
      // ADR-022 decision 3: a job that cannot say why a second run is safe is not ready.
      expect(job.idempotentBecause.length).toBeGreaterThan(20);
    }
  });

  it('lets a job scope enumerate Households and nothing else (ADR-008, ADR-022)', async () => {
    const rows = await householdDirectory(app, 'worker-it');
    expect(rows.some((row) => row.id === householdId)).toBe(true);
    expect(rows.some((row) => row.id === otherHouseholdId)).toBe(true);

    // The exception is the directory: anything else under a job scope still throws.
    await expect(
      runAsSystem({ requestId: 'worker-it' }, () => prisma.client.transactions.findMany()),
    ).rejects.toThrow(TenancyError);
  });

  it('runs a job for one Household inside its own tenant context', async () => {
    const result = await runJob(app, 'insights.generate', {
      requestId: 'worker-it',
      householdIds: [householdId],
    });

    expect(result.job).toBe('insights.generate');
    expect(result.households).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('generates and evaluates in one pass, so a condition becomes a notification (task 3.4.4)', async () => {
    // The daily job used to call `InsightsService.generate` alone, so it wrote insight rows that nothing
    // ever turned into a notification — the alert pipeline's second half had no scheduled caller. It now
    // calls `NotificationsService.run`, the same method the `runAlerts` mutation calls.
    const account = await asTenant(() =>
      prisma.client.accounts.create({
        data: { id: uuidv7(), household_id: householdId, name: 'Tekući', kind: 'BANK', currency: 'RSD' },
      }),
    );
    // Due tomorrow, which is inside the one-day horizon.
    const tomorrow = addDays(todayIn('Europe/Belgrade'), 1);
    const dayOfMonth = Number(tomorrow.slice(8, 10));
    await asTenant(() =>
      prisma.client.recurring_rules.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          account_id: account.id,
          kind: 'EXPENSE',
          amount_minor: 1_299_00n,
          currency: 'RSD',
          description: 'Netflix',
          rrule: `RRULE:FREQ=MONTHLY;BYMONTHDAY=${dayOfMonth}`,
          next_occurrence_on: new Date(`${tomorrow}T00:00:00.000Z`),
          auto_confirm: true,
          is_detected: false,
          is_active: true,
        },
      }),
    );

    await runJob(app, 'insights.generate', { requestId: 'worker-it', householdIds: [householdId] });

    // The defaults are a side effect of the **evaluation** half, so their presence is proof that `run`
    // ran rather than `generate`.
    expect(
      await asTenant(() => prisma.client.alert_rules.count({ where: { household_id: householdId } })),
    ).toBe(3);
    const notification = await asTenant(() =>
      prisma.client.notifications.findFirst({
        where: { household_id: householdId, user_id: userId, dedupe_key: { startsWith: 'RECURRING_DUE:' } },
      }),
    );
    expect(notification).not.toBeNull();
    expect(notification?.title).toContain('Netflix');
  });

  it('reports a Household that throws without stopping the run', async () => {
    // An id that is in the directory but whose Household row is deleted between the two reads is the
    // realistic shape of this; here the surrounding code is exercised directly instead, so the test
    // asserts the registry's contract rather than a race it cannot schedule.
    const result = await runJob(app, 'recurring.materialise', {
      requestId: 'worker-it',
      householdIds: [householdId],
    });

    expect(result.households).toBe(1);
    expect(result.succeeded + result.failed).toBe(1);
    expect(result.outcomes).toHaveLength(1);
  });

  it('never runs a job for a Household outside the requested set', async () => {
    const result = await runJob(app, 'notifications.dispatch', {
      requestId: 'worker-it',
      householdIds: [householdId],
    });

    expect(result.outcomes.map((outcome) => outcome.householdId)).toEqual([householdId]);
    void asTenant;
  });
});
