/**
 * Serbian natural-language normalization, segmentation and extraction.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §3
 *
 * **Pure and dependency-free** (no database, no AI provider). It runs on BOTH the server and the
 * browser — docs/05 §5.3 uses it client-side so the capture preview is instant — which is why the
 * boundary rule forbids any import from `@finmate/ai` or `@finmate/rules-engine` here.
 *
 * Must handle: latin and cyrillic scripts, diacritic folding, `.`/space as thousands separators,
 * `,` as the decimal separator, `2k` shorthand, and income markers (plata, penzija, uplata).
 *
 * Implemented in Phase 2 task 2.1.1.
 */
export {};
