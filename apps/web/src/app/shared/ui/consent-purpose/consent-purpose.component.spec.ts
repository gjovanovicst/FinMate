// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting, setSignalInput } from '@web-test/angular-testing';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { I18nService } from '../../../core/i18n/i18n.service';
import { syncedAtLabel } from '../../../core/offline/sync.view';
import type { AiEgressEntry, ConsentKind, ConsentRecord, RecordableConsentState } from '../../../core/consent/consent.view';
import { ConsentPurposeComponent } from './consent-purpose.component';

initAngularTesting();

/**
 * One purpose, disclosed — docs/08 §6.6, ADR-032.
 *
 * This is where the **disclosure** is asserted exhaustively, because the two screens that show it cannot
 * both prove it: `/settings` and the first-use sheet mount this component, and the JIT test runner cannot
 * render a signal-input child inside a parent template at all (see `setSignalInput`'s doc). So the
 * parent specs own their own copy and their wiring, and the sentences a person consents to are pinned
 * here — in the one place that renders them.
 */
function mount(inputs: {
  readonly kind: ConsentKind;
  readonly record?: ConsentRecord | null;
  readonly routes: readonly AiEgressEntry[];
  readonly mayChange?: boolean;
  readonly saving?: boolean;
  readonly showActions?: boolean;
}) {
  // `mount` is called more than once in several cases below (one component per route/state), and a
  // configured-but-instantiated TestBed refuses a second `configureTestingModule`.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ConsentPurposeComponent],
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(ConsentPurposeComponent);
  const component = fixture.componentInstance;
  setSignalInput(component, 'kind', inputs.kind);
  setSignalInput(component, 'routes', inputs.routes);
  setSignalInput(component, 'record', inputs.record ?? null);
  setSignalInput(component, 'mayChange', inputs.mayChange ?? true);
  setSignalInput(component, 'saving', inputs.saving ?? false);
  setSignalInput(component, 'showActions', inputs.showActions ?? true);

  const emitted: RecordableConsentState[] = [];
  component.decide.subscribe((state) => emitted.push(state));

  fixture.detectChanges();
  const text = (): string => (fixture.nativeElement as HTMLElement).textContent ?? '';
  const button = (label: string): HTMLButtonElement | undefined =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((entry) =>
      entry.textContent?.includes(label),
    );

  return { fixture, emitted, text, button, component };
}

const NON_EEA: readonly AiEgressEntry[] = [
  {
    purpose: 'AI_DATA_PROCESSING',
    task: 'CLASSIFY',
    endpoint: 'DEEPSEEK_GLOBAL',
    provider: 'DEEPSEEK',
    region: 'NON_EEA',
    requiresConsent: true,
  },
];

function record(state: ConsentRecord['state'], recordedAt: string | null = null): ConsentRecord {
  return { kind: 'AI_DATA_PROCESSING', state, recordedAt, policyVersion: 'x', purposes: [] };
}

afterEach(() => TestBed.resetTestingModule());

describe('ConsentPurposeComponent', () => {
  it('names the purpose, what is sent, and where it goes', () => {
    const { text } = mount({ kind: 'AI_DATA_PROCESSING', routes: NON_EEA });

    expect(text()).toContain('Sending text to an AI model');
    expect(text()).toContain('such as a shop name and an amount');
    // The provider and region come from the route rows, which come from the server's routing table.
    expect(text()).toContain('DEEPSEEK');
    expect(text()).toContain('outside the European Economic Area');
    expect(text()).toContain('transfer outside the EEA');
  });

  it('does not call an EEA or local route a transfer, and says which it is', () => {
    const local = mount({
      kind: 'AI_DATA_PROCESSING',
      routes: [{ ...NON_EEA[0]!, endpoint: 'LOCAL', provider: 'LOCAL', region: 'LOCAL', requiresConsent: false }],
    });
    expect(local.text()).toContain('processed on this server');
    expect(local.text()).not.toContain('transfer outside the EEA');

    const eea = mount({
      kind: 'AI_DATA_PROCESSING',
      routes: [{ ...NON_EEA[0]!, endpoint: 'DEEPSEEK_EU', region: 'EEA', requiresConsent: false }],
    });
    expect(eea.text()).toContain('European Economic Area');
    expect(eea.text()).not.toContain('outside the European Economic Area');
  });

  it('says nothing about egress for a purpose no route carries', () => {
    // OCR is unrouted on this deployment: a disclosure sentence about a route that does not exist would
    // be describing traffic nobody is sending.
    const { text } = mount({ kind: 'CLOUD_OCR', routes: NON_EEA });

    expect(text()).toContain('Sending a receipt photo to an AI model');
    expect(text()).not.toContain('DEEPSEEK');
    expect(text()).not.toContain('transfer outside the EEA');
  });

  it('offers Allow and Decline while the question is open, and emits the answer', () => {
    const { button, emitted, text } = mount({ kind: 'AI_DATA_PROCESSING', routes: NON_EEA });

    expect(text()).toContain('Not asked');
    button('Allow')?.click();
    button('Decline')?.click();

    expect(emitted).toEqual(['GRANTED', 'DECLINED']);
  });

  it('replaces the pair with Withdraw once permission is held', () => {
    const { button, emitted, text } = mount({
      kind: 'AI_DATA_PROCESSING',
      record: record('GRANTED'),
      routes: NON_EEA,
    });

    expect(text()).toContain('Allowed');
    expect(button('Decline')).toBeUndefined();
    button('Withdraw permission')?.click();

    expect(emitted).toEqual(['WITHDRAWN']);
  });

  it('offers only the way back after a decline or a withdrawal', () => {
    for (const state of ['DECLINED', 'WITHDRAWN'] as const) {
      const { button, text } = mount({ kind: 'AI_DATA_PROCESSING', record: record(state), routes: NON_EEA });

      expect(button('Decline')).toBeUndefined();
      expect(button('Allow')).toBeDefined();
      expect(text()).toContain(state === 'DECLINED' ? 'Declined' : 'Withdrawn');
    }
  });

  it('shows the decision and whose it is when the caller may not change it', () => {
    // docs/08 §3.7, Q-11: the record is the lawful-basis evidence, so granting and withdrawing are a
    // controller-level act. The MEMBER still sees what their Household decided.
    const { text, button } = mount({
      kind: 'AI_DATA_PROCESSING',
      record: record('GRANTED'),
      routes: NON_EEA,
      mayChange: false,
    });

    expect(text()).toContain('Allowed');
    expect(text()).toContain('Only the owner of this household can change these.');
    expect(button('Withdraw permission')).toBeUndefined();
    expect(button('Allow')).toBeUndefined();
  });

  it('renders no verbs at all when the caller owns them', () => {
    // The first-use sheet puts Allow/Decline/Not now under the disclosure rather than inside it.
    const { button } = mount({ kind: 'AI_DATA_PROCESSING', routes: NON_EEA, showActions: false });

    expect(button('Allow')).toBeUndefined();
    expect(button('Decline')).toBeUndefined();
  });

  it('marks the eval opt-in as recorded-but-unused, and only that one', () => {
    const evalPurpose = mount({ kind: 'EVAL_DATASET', routes: NON_EEA });
    expect(evalPurpose.text()).toContain('nothing reads it yet');

    const text = mount({ kind: 'AI_DATA_PROCESSING', routes: NON_EEA });
    expect(text.text()).not.toContain('nothing reads it yet');
  });

  it('dates the decision in the household locale, and only when there is one', () => {
    const at = '2026-09-16T18:00:00.000Z';
    const { text } = mount({
      kind: 'AI_DATA_PROCESSING',
      record: record('GRANTED', at),
      routes: NON_EEA,
    });

    // The same formatter the offline lines use, so a consent date and a snapshot date cannot disagree
    // about what a date looks like.
    expect(text()).toContain(syncedAtLabel(at, TestBed.inject(I18nService).tag()));
    expect(text()).not.toContain(at);

    const undated = mount({ kind: 'AI_DATA_PROCESSING', record: record('GRANTED'), routes: NON_EEA });
    expect(undated.text()).not.toContain('Recorded');
  });

  it('disables the verbs while a write is in flight, so one decision cannot be sent twice', () => {
    const { button } = mount({ kind: 'AI_DATA_PROCESSING', routes: NON_EEA, saving: true });

    expect(button('Allow')?.disabled).toBe(true);
    expect(button('Decline')?.disabled).toBe(true);
  });

  it('names every route the purpose actually carries', () => {
    // A purpose can hold more than one task (text and receipts both ride AI_DATA_PROCESSING here), and a
    // disclosure that named one of two providers would be a half-truth.
    const { text } = mount({
      kind: 'AI_DATA_PROCESSING',
      routes: [
        NON_EEA[0]!,
        { ...NON_EEA[0]!, task: 'OCR', endpoint: 'MISTRAL_EU', provider: 'MISTRAL', region: 'EEA' },
      ],
    });

    expect(text()).toContain('DEEPSEEK');
    expect(text()).toContain('MISTRAL');
    // One route is outside the EEA, so the sentence is owed regardless of the EEA sibling.
    expect(text()).toContain('transfer outside the EEA');
  });
});
