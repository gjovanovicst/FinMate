import { describe, expect, it } from 'vitest';

import type { OutboxEntry } from './outbox';
import type { CapturePreviewRow } from './sync.types';
import {
  captureInput,
  categoryLabel,
  previewIndex,
  previewRows,
  queueDump,
  rawInputs,
  syncedAtLabel,
  whyKey,
} from './sync.view';

/**
 * The tray's derivations, without a DOM (docs/10 §8.3's retry-tray and conflict-diff rows).
 *
 * Every one of these is a read of stored, untyped data: the queue hands back a sealed record, so a
 * field that moved must degrade visibly rather than throw on the render path — and a diff that named
 * the wrong side of a comparison would be worse than no diff at all.
 */
function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    seq: 1,
    enqueuedAt: '2026-09-14T10:00:00.000Z',
    document: 'mutation CaptureCommit',
    variables: {
      input: {
        rows: [
          { clientRowId: 'r1', description: 'Lidl' },
          { clientRowId: 'r2', description: 'gorivo' },
        ],
      },
    },
    status: 'pending',
    attempts: 0,
    ...overrides,
  };
}

const PREVIEW: readonly CapturePreviewRow[] = [
  { clientRowId: 'r1', rawText: 'Lidl 2000', localCategoryId: 'cat-food', localCategoryName: 'Hrana' },
  { clientRowId: 'r2', rawText: 'gorivo 3500', localCategoryId: null, localCategoryName: null },
];

describe('rawInputs', () => {
  it('prefers the verbatim raw text the preview carries', () => {
    expect(rawInputs(entry({ meta: { preview: PREVIEW } }))).toEqual(['Lidl 2000', 'gorivo 3500']);
  });

  it('falls back to the queued descriptions when there is no preview', () => {
    expect(rawInputs(entry())).toEqual(['Lidl', 'gorivo']);
  });

  it('survives a malformed meta without throwing', () => {
    expect(previewRows(entry({ meta: { preview: 'not a list' } }))).toEqual([]);
    expect(previewRows(entry({ meta: { preview: [{ clientRowId: 1 }] } }))).toEqual([]);
    expect(rawInputs(entry({ meta: { preview: [{}] } }))).toEqual(['Lidl', 'gorivo']);
  });
});

describe('previewIndex', () => {
  it('keys every preview row by the id the server echoes back, with its entry seq', () => {
    const index = previewIndex([entry({ meta: { preview: PREVIEW } }), entry({ seq: 7 })]);

    expect(index.get('r1')).toEqual({ seq: 1, row: PREVIEW[0] });
    expect(index.get('r2')).toEqual({ seq: 1, row: PREVIEW[1] });
    expect(index.size).toBe(2);
  });
});

describe('whyKey', () => {
  it('maps the server decision sources the catalogue has words for', () => {
    expect(whyKey('KEYWORD')).toBe('capture.provenance.KEYWORD');
    expect(whyKey('RULE')).toBe('capture.provenance.RULE');
    expect(whyKey('MERCHANT_DEFAULT')).toBe('capture.provenance.MERCHANT_DEFAULT');
  });

  it('returns null for a source with no word, so the caller shows the server token', () => {
    expect(whyKey('DEFAULT')).toBeNull();
    expect(whyKey('WHATEVER')).toBeNull();
  });
});

describe('categoryLabel', () => {
  it('prefers the name and falls back to the id', () => {
    expect(categoryLabel('c1', 'Hrana')).toBe('Hrana');
    expect(categoryLabel('c1', null)).toBe('c1');
    expect(categoryLabel(null, null)).toBeNull();
  });
});

describe('captureInput', () => {
  it('reads the stored batch back, and gives up quietly on a foreign shape', () => {
    expect(captureInput(entry())?.rows).toHaveLength(2);
    expect(captureInput(entry({ variables: {} }))).toBeNull();
  });
});

describe('syncedAtLabel', () => {
  it('formats an instant the way the tray already formats a moment, in the given locale', () => {
    const at = '2026-09-14T10:00:00.000Z';
    const expected = new Intl.DateTimeFormat('en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(at));

    expect(syncedAtLabel(at, 'en-US')).toBe(expected);
  });

  it('shows an unparseable value verbatim rather than inventing a time', () => {
    expect(syncedAtLabel('not-a-date', 'en-US')).toBe('not-a-date');
  });
});

describe('queueDump', () => {
  it('dumps the queue as parseable text, with the preview and without the mutation document', () => {
    const dumped = queueDump([entry({ meta: { preview: PREVIEW } })], [], '2026-09-14T12:00:00.000Z');
    const parsed = JSON.parse(dumped) as {
      readonly exportedAt: string;
      readonly pending: readonly { readonly seq: number; readonly preview: readonly unknown[] }[];
      readonly rejected: readonly unknown[];
    };

    expect(parsed.exportedAt).toBe('2026-09-14T12:00:00.000Z');
    expect(parsed.pending[0]?.seq).toBe(1);
    expect(parsed.pending[0]?.preview).toHaveLength(2);
    expect(parsed.rejected).toEqual([]);
    expect(dumped).not.toContain('mutation CaptureCommit');
  });
});
