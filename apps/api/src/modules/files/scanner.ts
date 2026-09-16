/**
 * The virus/format scan hook — docs/06 §9.2, docs/08 §9.4 (threat T-04), task 4.1.1.
 *
 * ## What this is, and what it deliberately is not
 *
 * `attachments.scan_state` exists so a client can never download an object before it has been checked
 * (docs/06 §9.2: *"`Attachment.downloadUrl` is `null` until `CLEAN`"*). The check itself is a
 * **deployment** choice — ClamAV in a sidecar, a managed scanning API, or a format sniff — so this
 * module takes an injected {@link Scanner} exactly as the classifier takes an injected embeddings
 * provider (ADR-021), and ships **no scanner**.
 *
 * The default therefore answers `SKIPPED`, which is the honest state: `CLEAN` would claim a check that
 * never ran, and leaving every row `PENDING` would make the feature unusable. `SKIPPED` is the value
 * docs/03 §4 already reserves for an attachment the policy does not require scanning, and it is
 * **linkable** — which is exactly why it must not be mistaken for `CLEAN`. A production deployment is
 * expected to configure a scanner; without one, uploads are labelled not-scanned, and that is recorded
 * in docs/08 §9.4 and in AGENTS.md's open gaps rather than hidden behind a green state.
 *
 * Reading a large blob through the API to scan it would also undo ADR-018's central property — bytes
 * never transit the API — so a real scanner is expected to be a sidecar or a provider callback, not a
 * function that returns bytes from `FilesService`.
 *
 * @module apps/api/src/modules/files
 */

/** DI token. */
export const SCANNER = Symbol('SCANNER');

/** Mirrors `attachments.scan_state`'s CHECK constraint (docs/03 §4). */
export type ScanVerdict = 'CLEAN' | 'INFECTED' | 'SKIPPED';

export interface ScanTarget {
  readonly key: string;
  readonly mimeType: string;
  readonly byteSize: number;
}

export interface Scanner {
  /** `false` when no scanner is configured. A value, so the caller degrades instead of throwing. */
  readonly available: boolean;
  /** Identifies the implementation in a log line (`none`, `clamav`, `magic-bytes`). */
  readonly name: string;
  readonly unavailableReason: string | null;
  scan(target: ScanTarget): Promise<ScanVerdict>;
}

export const UNCONFIGURED_SCANNER: Scanner = {
  available: false,
  name: 'none',
  unavailableReason:
    'No virus/format scanner is configured in this build, so an uploaded attachment is recorded ' +
    'SKIPPED — not scanned. docs/08 §9.4 expects a scanner in a deployment; the seam is the SCANNER ' +
    'token.',
  scan: async () => 'SKIPPED',
};

/** The scanner this deployment gets. Replace the body when a scanner exists; the seam does not move. */
export function makeScanner(): Scanner {
  return UNCONFIGURED_SCANNER;
}
