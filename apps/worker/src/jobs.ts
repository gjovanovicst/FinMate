import type { INestApplicationContext } from '@nestjs/common';

import { runAsSystem, runWithTenant, type TenantContext } from '@finmate/api/common/tenancy/tenant-context';
import { PrismaService } from '@finmate/api/prisma/prisma.service';
import { InsightsService } from '@finmate/api/modules/insights/insights.service';
import { NotificationsService } from '@finmate/api/modules/notifications/notifications.service';
import { RecurringService } from '@finmate/api/modules/recurring/recurring.service';

/**
 * The job registry — docs/05 §8, ADR-022.
 *
 * ## One implementation per job
 *
 * Every processor calls the **same service method the corresponding mutation calls**. That is not a
 * convenience: it is the property that keeps a scheduled run and a user-triggered run from drifting,
 * and it is why each job's idempotency story was written before this file existed (insight dedupe
 * keys, `notifications.dedupe_key`, the per-occurrence `recurring:{rule}:{date}` key, detection by
 * identity).
 *
 * ## The shape of a job
 *
 * 1. `runAsSystem` enumerates the Households — the one sanctioned cross-Household read (ADR-022),
 *    because ADR-008 otherwise refuses every query without a tenant.
 * 2. Each Household's work then runs inside `runWithTenant`, so the service sees exactly the context
 *    a request would give it and every query is scoped by the guard.
 * 3. A Household that throws is **skipped for this run** and reported; the rest proceed. One broken
 *    Household must not stop the nightly feed for everybody else.
 *
 * ## Adding a job
 *
 * A new entry needs two things written down: the schedule (docs/05 §8) and **what makes it
 * idempotent** (ADR-022, decision 3). A job that cannot answer the second question is not ready to be
 * scheduled.
 *
 * @module @finmate/worker
 */

export type JobName =
  | 'insights.generate'
  | 'notifications.dispatch'
  | 'recurring.materialise'
  | 'recurring.detect';

export interface JobDefinition {
  readonly name: JobName;
  /** Cron expression, from docs/05 §8's table. */
  readonly schedule: string;
  readonly description: string;
  /** What makes a second run safe. Required reading for the next job author. */
  readonly idempotentBecause: string;
  /** Do the work for one Household. */
  readonly perHousehold: (app: INestApplicationContext, householdId: string) => Promise<unknown>;
}

export interface HouseholdOutcome {
  readonly householdId: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface JobRunResult {
  readonly job: JobName;
  readonly households: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly outcomes: readonly HouseholdOutcome[];
}

/** A Household-directory row, as much as a job needs to build a tenant context for it. */
interface HouseholdRow {
  readonly id: string;
  readonly owner_user_id: string;
}

export const JOBS: readonly JobDefinition[] = [
  {
    name: 'recurring.materialise',
    schedule: '0 * * * *',
    description: 'Post every due occurrence of every active recurring rule.',
    idempotentBecause:
      'each occurrence is written through TransactionsService with the derived key ' +
      '`recurring:{rule}:{date}`, so a second run of the same hour posts nothing',
    perHousehold: (app, householdId) => app.get(RecurringService).materialise(householdId, {}),
  },
  {
    name: 'recurring.detect',
    schedule: '30 3 * * *',
    description: 'Propose probable subscriptions from history — never auto-create them.',
    idempotentBecause:
      'a proposal is skipped when the identity already has a rule, an open proposal or a dismissal',
    perHousehold: (app, householdId) => app.get(RecurringService).detect(householdId),
  },
  {
    name: 'insights.generate',
    schedule: '0 6 * * *',
    description: 'Deterministic insight generation for the Household, once a day.',
    idempotentBecause: 'the writer looks the dedupe key up before inserting, so a re-run is a no-op',
    perHousehold: (app, householdId) => app.get(InsightsService).generate(householdId),
  },
  {
    name: 'notifications.dispatch',
    schedule: '* * * * *',
    description: 'Drain queued notifications, respecting quiet hours and the daily cap.',
    idempotentBecause: 'a delivery is a status transition on a row that already carries `dedupe_key`',
    perHousehold: (app, householdId) => app.get(NotificationsService).dispatch(householdId),
  },
];

/** The Household directory: the only thing a job scope may read (ADR-022). */
export async function householdDirectory(
  app: INestApplicationContext,
  requestId: string,
): Promise<readonly HouseholdRow[]> {
  const prisma = app.get(PrismaService);
  return runAsSystem({ requestId }, () =>
    // `select` rather than the whole row: a job needs an id and an owner, and reading the rest of a
    // Household's settings into a worker process is surface with no purpose.
    prisma.client.households.findMany({ select: { id: true, owner_user_id: true } }),
  );
}

/**
 * Run one job across every Household.
 *
 * `householdIds` narrows the run, which is what the tests and a manual replay use.
 */
export async function runJob(
  app: INestApplicationContext,
  name: JobName,
  options: { readonly requestId?: string; readonly householdIds?: readonly string[] } = {},
): Promise<JobRunResult> {
  const definition = JOBS.find((job) => job.name === name);
  if (definition === undefined) throw new Error(`Unknown job "${name}"`);

  const requestId = options.requestId ?? `job:${name}:${Date.now()}`;
  const all = await householdDirectory(app, requestId);
  const rows =
    options.householdIds === undefined
      ? all
      : all.filter((row) => options.householdIds?.includes(row.id) === true);

  const outcomes: HouseholdOutcome[] = [];
  for (const row of rows) {
    // A synthetic context, exactly the shape a request would build: the job acts as the Household's
    // owner, is marked as background work by its `requestId`, and carries no session (there is none).
    const context: TenantContext = {
      householdId: row.id,
      userId: row.owner_user_id,
      role: 'OWNER',
      requestId,
    };

    try {
      await runWithTenant(context, () => definition.perHousehold(app, row.id));
      outcomes.push({ householdId: row.id, ok: true });
    } catch (error) {
      // One Household failing must not stop the run: the others still need their nightly work, and
      // BullMQ records the attempt so a retry covers this Household too.
      outcomes.push({
        householdId: row.id,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const failed = outcomes.filter((outcome) => !outcome.ok).length;
  return {
    job: name,
    households: rows.length,
    succeeded: outcomes.length - failed,
    failed,
    outcomes,
  };
}
