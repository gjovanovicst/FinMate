/**
 * The endpoint vocabulary, the routing table, and the residency predicate that guards it.
 *
 * Owner: docs/04-categorization-and-ai-engine.md §9 — "Residency rule (canonical, hard constraint)"
 *
 * ## The rule, and why it is enforced here rather than documented
 *
 * `PARSE`, `CLASSIFY`, `NARRATE` and `OCR` carry the Household's own free text or an image of a
 * Receipt. AGENTS.md rule 5 and ADR-007 say they may only reach a `LOCAL` model or a provider
 * endpoint **inside an adequacy-covered region (EEA)**. Anything else is a GDPR Chapter V transfer
 * that needs the Household's explicit, recorded consent (docs/08 §6.6) — and that consent is a
 * deliberate product decision, not something a config typo may substitute for.
 *
 * So a misconfigured route does not warn, and it does not "try anyway". {@link validateRouting}
 * refuses it with a typed {@link AiRoutingError} before any adapter exists, and
 * {@link assertAllowedRoute} refuses it again on the per-call path. The failure mode we are
 * defending against is specifically *silent*: a table that looks fine, boots fine, and egresses.
 *
 * `EMBED` is stricter still: it may **only** be `LOCAL`. The vectors are built from the Household's
 * own merchant and counterparty names, so there is no EEA cloud option that is acceptable
 * (docs/08 §6.2, §6.5).
 *
 * @module @finmate/ai
 */

import { AiRoutingError } from './errors';
import { TASKS, type Task } from './provider';

/**
 * docs/04 §9's `Endpoint` union, verbatim.
 *
 * The `_EU` suffix is the machine-checkable form of "adequacy-covered region". It is mandatory on
 * every non-`LOCAL` endpoint a sensitive task may reach; a provider that cannot offer one cannot
 * serve those tasks at all (§9).
 */
export type Endpoint =
  | 'LOCAL'
  | 'DEEPSEEK_EU'
  | 'OPENAI_EU'
  | 'ANTHROPIC_EU'
  | 'GEMINI_EU'
  /**
   * DeepSeek's **own** platform (`api.deepseek.com`), which is hosted in China.
   *
   * Added by ADR-031 because the alternative was a lie: this host was registered as `DEEPSEEK_EU`,
   * so the suffix rule — the machine-checkable half of ADR-007 — reported EEA compliance for traffic
   * that leaves the EEA. A non-EEA endpoint may exist; it may not be *called* EEA.
   */
  | 'DEEPSEEK_GLOBAL';

/** Every endpoint, for iteration and for a runtime membership check on configuration input. */
export const ENDPOINTS: readonly Endpoint[] = [
  'LOCAL',
  'DEEPSEEK_EU',
  'OPENAI_EU',
  'ANTHROPIC_EU',
  'GEMINI_EU',
  'DEEPSEEK_GLOBAL',
];

/**
 * Endpoints that are **not** inside the EEA, and may therefore only serve a Household that has
 * recorded its consent (ADR-007's consent-gated exception, ADR-031).
 *
 * The list exists so the rule is a runtime fact rather than a naming convention: `isEeaOrLocal` reads
 * a suffix, and a suffix is a claim. Anything here is refused for a sensitive task unless the caller
 * can show consent, whatever it is called.
 */
export const NON_EEA_ENDPOINTS: readonly Endpoint[] = ['DEEPSEEK_GLOBAL'];

/** Is this endpoint outside the EEA? The half of the residency rule a suffix cannot express. */
export function isNonEea(endpoint: string): boolean {
  return (NON_EEA_ENDPOINTS as readonly string[]).includes(endpoint);
}

/**
 * May a sensitive task carry Household free text to this endpoint *given* consent?
 *
 * Two separate questions, deliberately: `isEeaOrLocal` answers "does this need consent?" and this
 * answers "is it allowed at all?". A `_EU` endpoint with a non-EEA host behind it would pass the
 * first and must still fail the second — which is what ADR-031's configured-base-URL rule makes
 * impossible rather than unlikely.
 */
export function isAdmissible(endpoint: string, consentRecorded: boolean): boolean {
  if (isEeaOrLocal(endpoint)) return true;
  return isNonEea(endpoint) && consentRecorded;
}

/** The suffix that makes an endpoint admissible for a sensitive task. */
export const EEA_ENDPOINT_SUFFIX = '_EU';

/**
 * Is this string a member of docs/04 §9's `Endpoint` union?
 *
 * The suffix predicate below is the *residency* rule; this is the separate question of whether the
 * endpoint exists at all. Both are needed: `"_EU"` satisfies the suffix rule while naming nothing,
 * and a provider spelling that is not a member (`"DEEPSEEK"`) would otherwise be admitted by
 * nothing but its own luck. Configuration is strings, so both checks are runtime checks.
 */
export function isKnownEndpoint(endpoint: string): endpoint is Endpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint);
}

/** Residency predicate for a non-`EMBED` task: `LOCAL`, or an explicit EEA endpoint. */
export function isEeaOrLocal(endpoint: string): boolean {
  return endpoint === 'LOCAL' || endpoint.endsWith(EEA_ENDPOINT_SUFFIX);
}

/** The residency predicate for `EMBED`: `LOCAL` and nothing else. */
export function isLocalOnly(endpoint: string): boolean {
  return endpoint === 'LOCAL';
}

/** A task's route: a primary endpoint, and the endpoint to fall through to, or `null`. */
export interface TaskRoute {
  readonly primary: Endpoint;
  readonly fallback: Endpoint | null;
}

/**
 * The whole routing table. `Partial` because a caller may deliberately leave a task unrouted —
 * `EMBED`'s documented fallback is `null`, and a Household that declines all egress is served by
 * `LOCAL` primary / `null` fallback for every task.
 */
export type RoutingTable = Readonly<Partial<Record<Task, TaskRoute>>>;

/**
 * docs/04 §9's platform default, verbatim.
 *
 * `PARSE`/`CLASSIFY` lead with `LOCAL`: high volume, latency-sensitive, cheapest and
 * privacy-maximising — "a happy coincidence rather than a trade-off". `NARRATE` leads with a
 * stronger EEA-hosted model because volume is low and quality is user-visible.
 */
export const DEFAULT_ROUTING: RoutingTable = Object.freeze({
  // ADR-031: these three fallbacks used to name `*_EU` endpoints that resolved to non-EEA hosts
  // (`api.deepseek.com`, `api.generativelanguage.googleapis.com`) — and `ANTHROPIC_EU` was not
  // implemented at all. A fallback that cannot be honoured without an explicitly configured EEA base
  // URL is `null` here, which the degradation ladder already handles: the task stays `LOCAL`, and a
  // deployment that has a real EEA host configures one.
  PARSE: { primary: 'LOCAL', fallback: null },
  CLASSIFY: { primary: 'LOCAL', fallback: null },
  NARRATE: { primary: 'LOCAL', fallback: null },
  OCR: { primary: 'LOCAL', fallback: null },
  // ADR-036's routing rung defaults exactly like the rest: a local model, no fallback. That is what
  // makes the rung *dark* rather than merely off — with no local model running there is nothing to
  // call, and a deployment reaches a cloud endpoint only by naming it in config (and consenting).
  ROUTE: { primary: 'LOCAL', fallback: null },
  EMBED: { primary: 'LOCAL', fallback: null },
}) satisfies RoutingTable;

/** The ordered endpoints a task will be tried against, dropping a `null` fallback. */
export function endpointsForTask(table: RoutingTable, task: Task): readonly Endpoint[] {
  const route = table[task];
  if (route === undefined) return [];
  return route.fallback === null ? [route.primary] : [route.primary, route.fallback];
}

/**
 * Validate one route against the residency rule.
 *
 * @param consentRecorded Whether a **consent gate is in place** for this route. It defaults to
 *   `false`, so the safe answer is the one you get by not thinking about it. Two callers pass `true`:
 *   {@link validateRouting} when the router was constructed with a gate (the table then names a
 *   *gated exception* rather than an unguarded transfer), and a test asserting the opposite side of
 *   the predicate. Passing `true` does not admit an endpoint for a Household — that decision is made
 *   per call, by the gate, against the Household's own record (docs/08 §6.6).
 * @throws {AiRoutingError} `RESIDENCY_VIOLATION` when a sensitive task would leave the EEA, or
 *   `EMBED_MUST_BE_LOCAL` when `EMBED` is pointed at a cloud endpoint.
 */
export function assertAllowedRoute(task: Task, route: TaskRoute, consentRecorded = false): void {
  const chain = route.fallback === null ? [route.primary] : [route.primary, route.fallback];

  for (const endpoint of chain) {
    // 1. Fail closed on an endpoint this package does not know. A typo must not be treated as
    //    "some other provider" and shipped: `"_EU"` satisfies the suffix rule while naming nothing.
    if (!isKnownEndpoint(endpoint)) {
      throw new AiRoutingError(
        'RESIDENCY_VIOLATION',
        `"${endpoint}" is not one of the known endpoints (${ENDPOINTS.join(', ')}). An ` +
          `unrecognised endpoint cannot be shown to be inside the EEA, so the route is refused ` +
          `rather than attempted (AGENTS.md rule 5, ADR-007).`,
        task,
        endpoint,
      );
    }

    // 2. `EMBED` may only ever be LOCAL — even an EEA cloud endpoint is refused, because the
    //    vectors are built from the Household's own entity names (docs/08 §6.5). Consent cannot
    //    buy this one: there is no non-EEA embedding option that is acceptable, so the predicate
    //    is not consulted at all.
    if (task === 'EMBED') {
      if (!isLocalOnly(endpoint)) {
        throw new AiRoutingError(
          'EMBED_MUST_BE_LOCAL',
          `EMBED builds its vectors from the Household's own entity names and may never leave ` +
            `this node. "${endpoint}" is refused; only LOCAL is accepted, including for the ` +
            `fallback slot (docs/04 §9, docs/08 §6.5).`,
          task,
          endpoint,
        );
      }
      continue;
    }

    // 3. Every other task may reach LOCAL or an explicit `_EU` endpoint, and nothing else —
    //    unless a consent gate is in place and the endpoint is one of the names
    //    NON_EEA_ENDPOINTS lists, which is ADR-007's consent-gated exception (ADR-031).
    if (!isAdmissible(endpoint, consentRecorded)) {
      throw new AiRoutingError(
        'RESIDENCY_VIOLATION',
        `"${endpoint}" is neither LOCAL nor an EEA endpoint, and no consent gate admits it. ` +
          `${task} carries the Household's own text (or, for OCR, an image) and routing it there ` +
          `is a GDPR Chapter V transfer requiring the Household's explicit recorded consent ` +
          `(AGENTS.md rule 5, ADR-007, docs/08 §6.6). A config typo must not become a data ` +
          `transfer, so this route is refused.`,
        task,
        endpoint,
      );
    }
  }
}

/**
 * Validate a whole routing table, up-front.
 *
 * Call this once at startup with whatever the caller assembled (platform default merged with
 * `ai_provider_configs`). It throws on the **first** offending route rather than collecting
 * issues: the table is small, and a residency violation is a stop-the-line configuration error,
 * not a list of niceties to report together.
 *
 * An unrouted task is not an error. `EMBED` with no local model running is a legitimate
 * configuration that degrades to keyword-only resolution (docs/04 §4 step 5).
 *
 * @param consentRecorded Passed straight through to {@link assertAllowedRoute}: `true` when a
 *   per-call consent gate is installed, which is what makes a non-EEA endpoint a *gated exception*
 *   instead of a violation. The gate is a runtime predicate the router consults on every call, so
 *   this flag alone never lets a byte leave.
 * @throws {AiRoutingError}
 */
export function validateRouting(table: RoutingTable, consentRecorded = false): void {
  for (const task of TASKS) {
    const route = table[task];
    if (route === undefined) continue;
    assertAllowedRoute(task, route, consentRecorded);
  }
}

/**
 * The default table, validated. Throws on a broken module constant, which can only mean someone
 * edited {@link DEFAULT_ROUTING} into an unsafe shape — a programming error worth failing loudly
 * on, at import time, rather than at the first user request.
 */
export const VALIDATED_DEFAULT_ROUTING: RoutingTable = (() => {
  validateRouting(DEFAULT_ROUTING);
  return DEFAULT_ROUTING;
})();
