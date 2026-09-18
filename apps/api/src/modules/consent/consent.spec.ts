import { describe, expect, it } from 'vitest';

import { TASKS, type Task } from '@finmate/ai';

import {
  AI_EGRESS_KINDS,
  CONSENT_KINDS,
  EXPOSED_CONSENT_KINDS,
  consentKindForTask,
  purposesForKind,
} from './consent';

/**
 * The consent vocabulary's own invariants — docs/08 §6.6, ADR-007, ADR-036.
 *
 * This file existed nowhere until C-1, and the reason it was worth writing is the mapping it covers:
 * `consentKindForTask` is the function that decides **whether a payload may leave the EEA**, and it is
 * the one place where a new AI task can acquire a permission nobody granted it. A total `switch` makes
 * a missing case a compile error; these assertions make the *decision* for each case visible, so the
 * next task added cannot quietly inherit a consent it should not have.
 */
describe('the consent vocabulary', () => {
  it('classifies every task, and only the local one needs no consent', () => {
    // Total over `TASKS`: adding a task to `packages/ai` without deciding its consent fails here (and
    // at `tsc`, which is the stronger of the two).
    for (const task of TASKS) {
      const kind = consentKindForTask(task);
      if (task === 'EMBED') {
        // `EMBED` never leaves this node (docs/04 §9, docs/08 §6.5), so there is no consent that could
        // admit it — a fact about the code, not a comment.
        expect(kind).toBeNull();
      } else {
        expect(AI_EGRESS_KINDS, task).toContain(kind);
      }
    }
  });

  it('gives ROUTE the consent its payload actually needs, and no new purpose (ADR-036)', () => {
    // ⚠️ The payload is the user's own typed sentence and nothing else, so it is the *same* egress as
    // the other text tasks. A fifth purpose would widen `consents.kind`'s CHECK in a migration and force
    // every Household to re-consent for a permission it already gave. If this ever changes to a new
    // purpose, that is a migration and a re-consent — not a one-line edit here.
    const textTasks: readonly Task[] = ['PARSE', 'CLASSIFY', 'NARRATE', 'ROUTE'];
    for (const task of textTasks) {
      expect(consentKindForTask(task), task).toBe('AI_DATA_PROCESSING');
    }
    // …and the purposes that kind stands for are the text-egress pair, which is what the sheet shows.
    expect(purposesForKind('AI_DATA_PROCESSING')).toEqual(['AI_TEXT_EGRESS', 'AI_NARRATION']);
  });

  it('keeps a receipt image on its own purpose, because it is a different permission', () => {
    expect(consentKindForTask('OCR')).toBe('CLOUD_OCR');
    expect(purposesForKind('CLOUD_OCR')).toEqual(['AI_RECEIPT_OCR']);
  });

  it('maps every stored kind to purposes, including the two this build does not expose', () => {
    for (const kind of CONSENT_KINDS) {
      const purposes = purposesForKind(kind);
      // `MARKETING_EMAIL` is deliberately empty: v1 has no marketing (docs/08 §7), so a purpose for it
      // would be a promise nothing keeps. The rest must name at least one.
      if (kind === 'MARKETING_EMAIL') expect(purposes).toEqual([]);
      else expect(purposes.length, kind).toBeGreaterThan(0);
    }
  });

  it('exposes fewer kinds than it stores, and never a kind it cannot honour', () => {
    // A control that cannot work is disabled with a tooltip rather than shown broken (docs/02 §2) — and
    // marketing is not exposed at all, so the settings surface lists a strict subset.
    for (const kind of EXPOSED_CONSENT_KINDS) expect(CONSENT_KINDS).toContain(kind);
    expect(EXPOSED_CONSENT_KINDS).not.toContain('MARKETING_EMAIL');
  });
});
