import type { TranslationKey } from '../i18n/translations';

/**
 * The consent surface's vocabulary — docs/08 §6.6, ADR-032.
 *
 * These are the shapes the API returns and the pure mappings from them to i18n keys. The **copy** lives
 * in the catalogue, never here: every sentence a person reads on a consent screen goes through
 * `I18nService.t()`, in English and Serbian, like every other string in the app.
 *
 * @module apps/web/src/app/core/consent
 */

/** The stored `kind` vocabulary (docs/03 §4), as the GraphQL enum exposes it. */
export type ConsentKind = 'AI_DATA_PROCESSING' | 'CLOUD_OCR' | 'EVAL_DATASET';

/** The state of one purpose. `NOT_ASKED` is a real value, not a synonym for declined. */
export type ConsentState = 'NOT_ASKED' | 'GRANTED' | 'DECLINED' | 'WITHDRAWN';

/** The states a caller may write. `NOT_ASKED` is the absence of a record. */
export type RecordableConsentState = 'GRANTED' | 'DECLINED' | 'WITHDRAWN';

/** Where a route's traffic goes, as the API derives it from the endpoint registry. */
export type EgressRegion = 'LOCAL' | 'EEA' | 'NON_EEA';

/** One governed route (docs/08 §6.5): what a deployment would send, where, for which purpose. */
export interface AiEgressEntry {
  readonly purpose: ConsentKind;
  readonly task: string;
  readonly endpoint: string;
  readonly provider: string;
  readonly region: EgressRegion;
  /**
   * True when this route needs recorded consent. This is what decides whether a screen asks at all:
   * requesting permission for a route that stays on this server would ask about nothing.
   */
  readonly requiresConsent: boolean;
}

/** One purpose's current state, as stored. */
export interface ConsentRecord {
  readonly kind: ConsentKind;
  readonly state: ConsentState;
  readonly recordedAt: string | null;
  readonly policyVersion: string | null;
  readonly purposes: readonly string[];
}

/**
 * The revision of the consent copy **this build renders**.
 *
 * It travels on every record, and docs/08 §6.6 makes a material change to the copy force re-consent —
 * which only works if the number stored is the number of the text the person actually read. So it is
 * this client's constant, sent with the answer, and it must match the API's `CONSENT_POLICY_VERSION`:
 * both sides pin the literal in a spec, so a drift fails a test rather than recording consent against
 * copy nobody was shown.
 *
 * ⚠️ Two constants until a shared one lands — the same shape as `APP_NAME` today (docs/06 §5.14).
 */
export const AI_CONSENT_POLICY_VERSION = '2026-09-ai-egress-1';

/** The purposes this build's copy covers, in the order a settings screen lists them. */
export const CONSENT_KINDS: readonly ConsentKind[] = [
  'AI_DATA_PROCESSING',
  'CLOUD_OCR',
  'EVAL_DATASET',
];

export function stateKey(state: ConsentState): TranslationKey {
  return `consent.state.${state}` as TranslationKey;
}

export function kindNameKey(kind: ConsentKind): TranslationKey {
  return `consent.kind.${kind}.name` as TranslationKey;
}

export function kindWhatKey(kind: ConsentKind): TranslationKey {
  return `consent.kind.${kind}.what` as TranslationKey;
}

export function regionKey(region: EgressRegion): TranslationKey {
  return `consent.region.${region}` as TranslationKey;
}

/** The purpose's state, with `NOT_ASKED` for a purpose the API did not mention. */
export function stateOf(records: readonly ConsentRecord[], kind: ConsentKind): ConsentState {
  return records.find((record) => record.kind === kind)?.state ?? 'NOT_ASKED';
}

/** The routes that would carry this purpose, in the order the API listed them. */
export function egressFor(
  egress: readonly AiEgressEntry[],
  kind: ConsentKind,
): readonly AiEgressEntry[] {
  return egress.filter((entry) => entry.purpose === kind);
}

/**
 * Does this purpose need permission in this deployment?
 *
 * A purpose with **no** route at all answers `false`: the deployment does not send it anywhere, so there
 * is nothing to permit. A purpose whose routes are all `LOCAL` answers `false` for the same reason.
 */
export function needsConsent(egress: readonly AiEgressEntry[], kind: ConsentKind): boolean {
  return egressFor(egress, kind).some((entry) => entry.requiresConsent);
}

/**
 * The purpose a first-use sheet should ask about, or `null`.
 *
 * `NOT_ASKED` only. A Household that **declined** or **withdrew** has decided, and asking again on the
 * next capture is the nagging docs/08 §6.6 calls out as a dark pattern — the way back is settings, where
 * the decision was made.
 */
export function purposeToAsk(records: readonly ConsentRecord[], egress: readonly AiEgressEntry[]): ConsentKind | null {
  for (const kind of CONSENT_KINDS) {
    if (needsConsent(egress, kind) && stateOf(records, kind) === 'NOT_ASKED') return kind;
  }
  return null;
}

/** Kinds a member without OWNER may not change. Every kind, per docs/08 §3.7 and Q-11. */
export function canChangeConsent(role: string | null): boolean {
  return role === 'OWNER';
}
