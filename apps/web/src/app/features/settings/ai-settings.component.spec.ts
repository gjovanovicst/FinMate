// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthStore } from '../../core/auth/auth.store';
import { ConsentService } from '../../core/consent/consent.service';
import type { AiEgressEntry, ConsentRecord } from '../../core/consent/consent.view';
import { purposeToAsk, stateOf } from '../../core/consent/consent.view';
import { ConsentPurposeComponent } from '../../shared/ui/consent-purpose/consent-purpose.component';
import { IconComponent } from '../../shared/ui/icon/icon.component';
import { AiSettingsComponent } from './ai-settings.component';

initAngularTesting();

/**
 * The **AI & privacy** pane — docs/02 §4.18, docs/08 §6.6, task R-25a.
 *
 * What a rendered screen has to prove here is not that a mutation fires: it is that the **decision is
 * informed** and that the **wrong people cannot make it**. So the assertions are about the copy beside
 * the buttons — the provider and region the server would use, what is never sent, what declining costs
 * — and about a MEMBER seeing the state without a control.
 *
 * The section is a *list of purposes plus its own framing*: which purposes exist, that the deployment
 * routes nothing, the §6.4 never-sent list, the §6.1 trade, the MEMBER line and a refused write. The
 * disclosure inside a card is the card's, and it is asserted where it renders.
 */

/** The route this deployment actually uses: DeepSeek's own platform, outside the EEA. */
const NON_EEA_ROUTE: readonly AiEgressEntry[] = [
  {
    purpose: 'AI_DATA_PROCESSING',
    task: 'CLASSIFY',
    endpoint: 'DEEPSEEK_GLOBAL',
    provider: 'DEEPSEEK',
    region: 'NON_EEA',
    requiresConsent: true,
  },
];

function record(kind: ConsentRecord['kind'], state: ConsentRecord['state']): ConsentRecord {
  return { kind, state, recordedAt: '2026-09-16T18:00:00.000Z', policyVersion: 'x', purposes: [] };
}

/**
 * A stand-in for {@link ConsentService}.
 *
 * Faithful about the one thing the pane depends on: the component reads `states()`, `routes()` and
 * `saving()`, so the stub exposes those over signals — a test can change the answer and see the screen
 * follow. `record` records the call rather than performing it; what a *write* does is the service's own
 * spec.
 */
function consentStub(
  records: readonly ConsentRecord[],
  routes: readonly AiEgressEntry[] = NON_EEA_ROUTE,
) {
  const state = signal<readonly ConsentRecord[]>(records);
  const routesSignal = signal<readonly AiEgressEntry[]>(routes);
  return {
    load: vi.fn(() => Promise.resolve()),
    record: vi.fn(() => Promise.resolve(true)),
    states: state,
    routes: routesSignal,
    loading: signal(false),
    saving: signal(false),
    error: signal<string | null>(null),
    askable: computed(() => purposeToAsk(state(), routesSignal())),
    state: (kind: ConsentRecord['kind']) => stateOf(state(), kind),
  };
}

async function mount(options: { role?: string; consent?: ReturnType<typeof consentStub> } = {}) {
  const consent = options.consent ?? consentStub([]);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ConsentService, useValue: consent },
      { provide: AuthStore, useValue: { role: signal(options.role ?? 'OWNER') } },
    ],
  });
  // The purpose card is opaque here: its own spec asserts the sentences inside it.
  TestBed.overrideComponent(AiSettingsComponent, {
    remove: { imports: [ConsentPurposeComponent, IconComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(AiSettingsComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, consent };
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function button(fixture: { nativeElement: unknown }, label: string): HTMLButtonElement | undefined {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((entry) =>
    entry.textContent?.includes(label),
  );
}

/** The purpose cards the pane rendered, in document order. */
function cards(fixture: { nativeElement: unknown }): readonly HTMLElement[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('fm-consent-purpose'),
  );
}

afterEach(() => TestBed.resetTestingModule());

describe('AiSettingsComponent', () => {
  it('frames the section with what it is for and what never leaves the device', async () => {
    const { fixture } = await mount({ consent: consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]) });

    const section = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('#ai-heading')!.parentElement!;
    // Trimmed: the card title carries an `fm-icon` before its words, so the heading's text content has
    // the icon element's own whitespace around it.
    expect(section.querySelector('h2')?.textContent?.trim()).toBe('AI');
    expect(text(fixture)).toContain('Some of the app can use an AI model');
    // The §6.4 assertion list and the §6.1 trade, both required by §6.6.
    expect(text(fixture)).toContain('Never sent:');
    expect(text(fixture)).toContain('If you decline');
  });

  it('asks about every purpose the deployment needs, and offers no control of its own', async () => {
    const { fixture } = await mount({ consent: consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]) });

    // One card per purpose, so a purpose added to `CONSENT_KINDS` cannot be silently unaskable.
    expect(cards(fixture)).toHaveLength(3);
    // The section frames; the cards decide. A button here would be a second, undated place to consent.
    const section = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('#ai-heading')!.parentElement!;
    expect(section.querySelectorAll('button')).toHaveLength(0);
  });

  it('hands each card the purpose\u2019s own stored record, and nothing when there is none', async () => {
    const { fixture, component } = await mount({
      consent: consentStub([record('AI_DATA_PROCESSING', 'GRANTED')]),
    });

    expect(component.recordFor('AI_DATA_PROCESSING')?.state).toBe('GRANTED');
    // The absence of a row is the question being open, not an error.
    expect(component.recordFor('CLOUD_OCR')).toBeNull();
    expect(cards(fixture)).toHaveLength(3);
  });

  it('records a card\u2019s answer on the settings surface', async () => {
    const { component, consent } = await mount({
      consent: consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]),
    });

    await component.record('AI_DATA_PROCESSING', 'GRANTED');

    // The surface is recorded as evidence, so a record can be traced to the screen that showed the copy.
    expect(consent.record).toHaveBeenCalledWith('AI_DATA_PROCESSING', 'GRANTED', 'settings');
  });

  it('says there is nothing to allow when the deployment routes nothing', async () => {
    // The inert deployment: three Allow buttons would advertise a decision that does not exist.
    const { fixture } = await mount({ consent: consentStub([], []) });

    expect(text(fixture)).toContain('no AI model configured');
    expect(cards(fixture)).toHaveLength(0);
    expect(button(fixture, 'Allow')).toBeUndefined();
  });

  it('tells a MEMBER whose decision it is, and asks them nothing', async () => {
    // docs/08 §3.7 and Q-11: granting or withdrawing consent is an OWNER act, because the record is the
    // lawful-basis evidence. A MEMBER is entitled to know what their Household decided.
    const { fixture, component, consent } = await mount({
      role: 'MEMBER',
      consent: consentStub([record('AI_DATA_PROCESSING', 'GRANTED')]),
    });

    expect(component.mayChange()).toBe(false);
    expect(text(fixture)).toContain('Only the owner of this household can change these.');
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('reports a refused write instead of appearing to have recorded it', async () => {
    const stub = consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]);
    stub.error.set('Your role does not permit this action.');
    const { fixture } = await mount({ consent: stub });

    expect(text(fixture)).toContain('Your role does not permit this action.');
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('still offers the cards while the first read is in flight', async () => {
    // The section is not gated on the read: `routes()` is empty until it lands, so gating on it would
    // flash "no AI model configured" — a claim about the deployment — before the answer arrives.
    const stub = consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]);
    stub.loading.set(true);
    const { fixture } = await mount({ consent: stub });

    expect(text(fixture)).not.toContain('no AI model configured');
  });
});
