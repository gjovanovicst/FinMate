/**
 * DI tokens for the AI composition root.
 *
 * In its own file so the module and the resolver that consumes the seams can both import it without a
 * `module → resolver → module` cycle: a token defined in `ai.module.ts` and imported by a resolver that
 * `ai.module.ts` registers is a cycle that happens to work until a bundler or a load order says
 * otherwise.
 *
 * @module apps/api/src/modules/ai
 */

/** The assembled seams, before they are projected onto the per-task tokens. */
export const AI_SEAMS = Symbol('AI_SEAMS');

/**
 * ADR-036's routing rung, as its own token.
 *
 * ⚠️ Named for the *seam* (`AssistantRouter`), not for `AiSeams.router` — that field is
 * `packages/ai`'s `AiRouter`, a different object. Two things called "router" one import apart is how a
 * composition root ends up injecting the wrong one; this one answers a **decision**, that one performs
 * the provider call.
 */
export const AI_ROUTER = Symbol('AI_ROUTER');
