/**
 * BullMQ background jobs.
 *
 * Owner: docs/05-architecture.md §8 (job table) and docs/11-devops-and-observability.md §12
 *
 * Jobs land in Phase 3+: recurring.materialise, insights.generate, notifications.dispatch,
 * budget.rollups, ledger.reconcile, classification.calibrate, files.purge, gdpr.purge.
 *
 * Every job must be idempotent and have a dead-letter path.
 */
export {};
