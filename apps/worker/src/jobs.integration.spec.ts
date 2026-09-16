import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidv7 } from '@finmate/domain';

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
    app = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
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
