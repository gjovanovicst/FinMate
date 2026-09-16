/**
 * What the pending tray renders, as pure functions.
 *
 * The queue stores a whole `captureCommit` call plus a client-only preview; a tray row has to get back
 * to "what did I type" and a diff row to "what did the server decide instead". Both are derivations
 * over stored data with a silent failure mode — a row that renders blank because a field moved, or a
 * diff that names the wrong category — so they live here, without a DOM, and are asserted directly
 * (docs/10 §8.3's retry-tray and conflict-diff rows).
 *
 * See ADR-026 decisions 2 and 5, docs/02 §4.3 and docs/07 §6.
 *
 * @module apps/web/src/app/core/offline
 */
import type { TranslationKey } from '../i18n/translations';
import type { OutboxEntry } from './outbox';
import type { CaptureCommitInput, CapturePreviewRow } from './sync.types';

/** The local preview a queue entry carries in `meta`, or an empty list when it carries none. */
export function previewRows(entry: OutboxEntry): readonly CapturePreviewRow[] {
  const preview = entry.meta?.['preview'];
  if (!Array.isArray(preview)) return [];
  return preview.filter(isPreviewRow);
}

/** One queued preview row together with the entry it was queued in. */
export interface QueuedPreview {
  readonly seq: number;
  readonly row: CapturePreviewRow;
}

/**
 * Every preview row in the queue, keyed by `clientRowId`.
 *
 * The diff is built while the outbox's transport is sending, and that transport is handed only a
 * `document` and `variables` — never the entry's `meta` (ADR-026: `meta` is stored and never sent).
 * So the preview is indexed before the flush and looked up afterwards by the id the server echoes
 * back, which is also what survives a reload: the ids are in the stored entry, not in this tab's memory.
 */
export function previewIndex(entries: readonly OutboxEntry[]): ReadonlyMap<string, QueuedPreview> {
  const index = new Map<string, QueuedPreview>();
  for (const entry of entries) {
    for (const row of previewRows(entry)) {
      index.set(row.clientRowId, { seq: entry.seq, row });
    }
  }
  return index;
}

/**
 * What the user typed, per row.
 *
 * The preview is preferred and the queued variables are the fallback: `rawText` is the verbatim input,
 * while `description` is what the parser made of it, so an entry queued by an older build (or one whose
 * meta was lost) still renders something a person recognises.
 */
export function rawInputs(entry: OutboxEntry): readonly string[] {
  const preview = previewRows(entry);
  if (preview.length > 0) return preview.map((row) => row.rawText);
  return queuedInput(entry)
    .rows.map((row) => row.description)
    .filter((description): description is string => typeof description === 'string' && description !== '');
}

/**
 * The `captureCommit` input a queue entry carries, read defensively.
 *
 * The store hands back `unknown` by design — it is a sealed record, not a typed table — so a shape
 * mismatch must degrade to an empty row list rather than throw on the render path.
 */
export function queuedInput(entry: OutboxEntry): {
  readonly rows: readonly { readonly clientRowId?: unknown; readonly description?: unknown }[];
} {
  const input = entry.variables['input'];
  if (typeof input !== 'object' || input === null) return { rows: [] };
  const rows = (input as { readonly rows?: unknown }).rows;
  if (!Array.isArray(rows)) return { rows: [] };
  return {
    rows: rows.filter(
      (row): row is { readonly clientRowId?: unknown; readonly description?: unknown } =>
        typeof row === 'object' && row !== null,
    ),
  };
}

/** The input as a typed value, for a caller that needs the batch itself (the export dump). */
export function captureInput(entry: OutboxEntry): CaptureCommitInput | null {
  const input = entry.variables['input'];
  if (typeof input !== 'object' || input === null) return null;
  return input as CaptureCommitInput;
}

/**
 * The `capture.provenance.*` word for a server decision source.
 *
 * `null` means the source is not one the catalogue has a word for, and the caller renders the server's
 * own token instead of guessing — the same rule the capture preview follows for its provenance line.
 */
export function whyKey(why: string): TranslationKey | null {
  const keys: Record<string, TranslationKey> = {
    USER: 'capture.provenance.USER',
    RULE: 'capture.provenance.RULE',
    KEYWORD: 'capture.provenance.KEYWORD',
    MERCHANT_DEFAULT: 'capture.provenance.MERCHANT_DEFAULT',
    COUNTERPARTY_DEFAULT: 'capture.provenance.COUNTERPARTY_DEFAULT',
    AI: 'capture.provenance.AI',
    FALLBACK: 'capture.provenance.FALLBACK',
    NONE: 'capture.provenance.NONE',
  };
  return keys[why] ?? null;
}

/** The category a diff shows on one side, with the id as the fallback when no name was resolvable. */
export function categoryLabel(id: string | null, name: string | null): string | null {
  if (id === null && name === null) return null;
  return name ?? id;
}

/**
 * The whole queue as plain text — docs/07 §6's last-resort escape hatch.
 *
 * Deliberately a data dump rather than a translated letter: it exists for the case where the queue
 * cannot be sent and the user needs the content out, so fidelity matters more than prose, and the
 * preview (which is never sent) is included because it is part of what the queue holds.
 */
export function queueDump(
  pending: readonly OutboxEntry[],
  rejected: readonly OutboxEntry[],
  exportedAt: string,
): string {
  return JSON.stringify(
    {
      exportedAt,
      pending: pending.map(toDump),
      rejected: rejected.map(toDump),
    },
    null,
    2,
  );
}

function toDump(entry: OutboxEntry): Record<string, unknown> {
  return {
    seq: entry.seq,
    status: entry.status,
    enqueuedAt: entry.enqueuedAt,
    attempts: entry.attempts,
    error: entry.error ?? null,
    input: captureInput(entry),
    preview: previewRows(entry),
  };
}

function isPreviewRow(value: unknown): value is CapturePreviewRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row['clientRowId'] === 'string' &&
    typeof row['rawText'] === 'string' &&
    isNullableString(row['localCategoryId']) &&
    isNullableString(row['localCategoryName'])
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}
