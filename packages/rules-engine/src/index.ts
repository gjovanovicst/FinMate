/**
 * Deterministic rule evaluation and keyword scoring.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §5
 *
 * Pure, no I/O, no AI. Rules run BEFORE the model (ADR-002) and are the reason ~70 % of
 * entries cost nothing and resolve in milliseconds. The model is the exception path.
 *
 * Implemented in Phase 2 task 2.1.3.
 */
export {};
