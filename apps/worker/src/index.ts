import { Logger, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';

import { CONFIG, type AppConfig } from '@finmate/api/config/config';

import { JOBS, runJob, type JobName } from './jobs';
import { WorkerModule } from './worker.module';

/**
 * The worker process — docs/05 §8, ADR-022.
 *
 * Boots the job module graph as a **Nest application context** (no HTTP), registers one BullMQ queue
 * and one consumer per job from {@link JOBS}, and shuts down cleanly on SIGTERM so a deploy does not
 * kill a job mid-write.
 *
 * Every processor calls `runJob`, which is the only thing that knows how to enumerate Households and
 * establish tenancy per Household — so no job file has to remember ADR-008.
 *
 * @module @finmate/worker
 */

const logger = new Logger('Worker');

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  const config = app.get<AppConfig>(CONFIG);

  // BullMQ needs a connection that is allowed to block (`maxRetriesPerRequest: null`); the short-lived
  // request client the API uses would be reaped mid-job.
  const connection: ConnectionOptions = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });

  const queues: Queue[] = [];
  const workers: Worker[] = [];

  for (const job of JOBS) {
    const queue = new Queue(job.name, { connection });
    queues.push(queue);

    // A **scheduler id** per job name, which is what makes a redeploy replace the schedule instead
    // of stacking a second copy of it — the difference between "hourly" and "hourly, twice". BullMQ 6
    // removed `add({ repeat })` in favour of this call for exactly that reason.
    await queue.upsertJobScheduler(
      job.name,
      { pattern: job.schedule },
      {
        name: job.name,
        data: {},
        opts: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        },
      },
    );

    const worker = new Worker(
      job.name,
      async () => {
        const result = await runJob(app, job.name as JobName);
        logger.log(
          `${job.name}: ${result.succeeded}/${result.households} Household(s) ok` +
            (result.failed > 0 ? `, ${result.failed} failed` : ''),
        );
        for (const outcome of result.outcomes.filter((entry) => !entry.ok)) {
          logger.warn(`${job.name}: Household ${outcome.householdId} failed — ${outcome.detail}`);
        }
        return result;
      },
      {
        connection,
        // One job at a time per queue: these are household-wide sweeps, and running two at once would
        // make the second one's work redundant rather than faster.
        concurrency: 1,
      },
    );
    worker.on('failed', (_job, error) => logger.error(`${job.name} failed: ${error.message}`));
    workers.push(worker);

    logger.log(`${job.name} — ${job.description} (${job.schedule})`);
  }

  logger.log(`Worker ready: ${JOBS.length} job(s) registered.`);

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.log(`${signal} received — closing ${workers.length} consumer(s).`);

    // Stop taking new work first, then let the running job finish: a half-written materialisation is
    // exactly what the occurrence key would have to clean up otherwise.
    await Promise.all(workers.map((worker) => worker.close()));
    await Promise.all(queues.map((queue) => queue.close()));
    await app.close();
    logger.log('Worker stopped.');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  void (app as INestApplicationContext);
}

void bootstrap();
