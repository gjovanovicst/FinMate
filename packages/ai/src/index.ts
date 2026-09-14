/**
 * AI provider abstraction: `AiProvider`, adapters, prompt templates, routing.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §9 (ADR-007)
 *
 * Two rules that shape this package:
 *  - It returns **only Proposal types**. It never writes to the database and never computes money
 *    (ADR-001). The boundary rule enforces the second half: the database lives in `scope:api`,
 *    which this package may not import.
 *  - Routing is **LOCAL or EEA-endpoint only** for PARSE/CLASSIFY/NARRATE/OCR. An endpoint without
 *    an explicit `_EU` suffix is a GDPR Chapter V transfer and needs recorded consent.
 *
 * Implemented in Phase 2 task 2.2.1.
 */
export {};
