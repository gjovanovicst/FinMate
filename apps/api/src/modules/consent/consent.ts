/**
 * The consent vocabulary — docs/08 §6.6, docs/03 §4, ADR-007, ADR-031.
 *
 * ## Two vocabularies, and why this file exists
 *
 * The two canonical documents do not use the same words, and neither is wrong:
 *
 * - **docs/03 §4** owns the DDL. The shipped `consents` table has a `kind` column with
 *   `CHECK (kind IN ('AI_DATA_PROCESSING','EVAL_DATASET','MARKETING_EMAIL','CLOUD_OCR'))`.
 * - **docs/08 §6.6** owns the *product* purposes: `AI_TEXT_EGRESS`, `AI_RECEIPT_OCR`,
 *   `AI_NARRATION`, `EVAL_DATASET`, presented as four independently granted purposes.
 *
 * A table is not a product surface, so this module keeps both and states the mapping once, here,
 * instead of leaving every caller to invent one. {@link purposeForKind} is the inverse direction, and
 * is what the consent sheet (unbuilt) will read.
 *
 * ## Absence is never permission
 *
 * `NOT_ASKED` and `DECLINED` are distinguished for the *record*, never for the *decision*: the only
 * value {@link ConsentsService.permits} accepts is `GRANTED` (docs/08 §6.6).
 *
 * @module apps/api/src/modules/consent
 */

import type { Task } from '@finmate/ai';

/**
 * The values `consents.kind` may hold — docs/03 §4's CHECK, verbatim.
 *
 * `MARKETING_EMAIL` is in the constraint because the table is the compliance record for every
 * consent the product might ever take. It is deliberately **not** on the GraphQL surface: v1 has no
 * marketing (docs/08 §7), so offering a control for it would be a control that cannot work
 * (docs/02 §2).
 */
export type ConsentKind = 'AI_DATA_PROCESSING' | 'EVAL_DATASET' | 'MARKETING_EMAIL' | 'CLOUD_OCR';

/** Every value the column admits, for iteration and for a runtime membership check. */
export const CONSENT_KINDS: readonly ConsentKind[] = [
  'AI_DATA_PROCESSING',
  'EVAL_DATASET',
  'MARKETING_EMAIL',
  'CLOUD_OCR',
];

/** The kinds this build exposes, in the order a settings screen would list them. */
export const EXPOSED_CONSENT_KINDS: readonly ConsentKind[] = [
  'AI_DATA_PROCESSING',
  'CLOUD_OCR',
  'EVAL_DATASET',
];

/**
 * The kinds whose absence must stop a sensitive task at the router (ADR-007's consent-gated
 * exception). `EVAL_DATASET` is not one: it is an opt-in to *retaining* corrections for evaluation,
 * not an egress permission (docs/08 §8.7), and nothing reads it in this build.
 */
export const AI_EGRESS_KINDS: readonly ConsentKind[] = ['AI_DATA_PROCESSING', 'CLOUD_OCR'];

/**
 * The state of one purpose for one Household, derived from the newest `consents` row.
 *
 * `WITHDRAWN` is its own value rather than "declined after having granted": the two differ in what
 * they say about the past, and the past is the evidence (docs/08 §6.6 says consent records are the
 * lawful-basis proof and are retained for the life of the Household plus three years).
 */
export type ConsentState = 'NOT_ASKED' | 'GRANTED' | 'DECLINED' | 'WITHDRAWN';

export interface ConsentView {
  readonly kind: ConsentKind;
  readonly state: ConsentState;
  /** When the newest row was recorded; `null` when there is no row at all. */
  readonly recordedAt: Date | null;
  /** The revision of the copy the Household was shown, as the row recorded it. */
  readonly policyVersion: string | null;
  /** The docs/08 §6.6 purpose vocabulary, for copy and for a support conversation. */
  readonly purposes: readonly ConsentPurpose[];
}

/** docs/08 §6.6's four purposes, as a value rather than a paragraph. */
export type ConsentPurpose =
  | 'AI_TEXT_EGRESS'
  | 'AI_RECEIPT_OCR'
  | 'AI_NARRATION'
  | 'EVAL_DATASET';

/** The purpose(s) a stored kind stands for. Two kinds: a coarser record, never a lost meaning. */
export function purposesForKind(kind: ConsentKind): readonly ConsentPurpose[] {
  switch (kind) {
    case 'AI_DATA_PROCESSING':
      // One stored kind covers both text purposes because docs/03 §4's CHECK has no third value
      // between them. The consent sheet must therefore ask for them **together** and say so.
      return ['AI_TEXT_EGRESS', 'AI_NARRATION'];
    case 'CLOUD_OCR':
      return ['AI_RECEIPT_OCR'];
    case 'EVAL_DATASET':
      return ['EVAL_DATASET'];
    case 'MARKETING_EMAIL':
      return [];
  }
}

/**
 * Which consent a task's payload needs before it may leave the EEA.
 *
 * `EMBED` returns `null`: it never leaves this node (docs/04 §9, docs/08 §6.5), so there is no
 * consent that could admit it and the router never asks. Returning `null` rather than a kind is what
 * keeps that a fact about the code instead of a comment.
 */
export function consentKindForTask(task: Task): ConsentKind | null {
  switch (task) {
    case 'PARSE':
    case 'CLASSIFY':
    case 'NARRATE':
    // `ROUTE` carries the user's own typed sentence and nothing else (ADR-036), so it is the **same
    // egress** as the other text tasks and reuses `AI_TEXT_EGRESS`/`AI_DATA_PROCESSING` rather than
    // becoming a fifth purpose. A new purpose would mean widening `consents.kind`'s CHECK in a
    // migration and forcing every Household to re-consent — churn for a permission that is, word for
    // word, the one they already gave. The task is new; the *permission* is not.
    case 'ROUTE':
      return 'AI_DATA_PROCESSING';
    case 'OCR':
      return 'CLOUD_OCR';
    case 'EMBED':
      return null;
  }
}

/**
 * The revision of the consent copy this build would show.
 *
 * Bumping it forces re-consent (docs/08 §6.6: "a material change to the copy … bumps the text version
 * and forces re-consent"), which is why it is stored on every row rather than assumed.
 */
export const CONSENT_POLICY_VERSION = '2026-09-ai-egress-1';
