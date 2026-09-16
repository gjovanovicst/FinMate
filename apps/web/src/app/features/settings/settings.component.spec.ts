// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { CUSTOM_ELEMENTS_SCHEMA, computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLockService } from '../../core/app-lock/app-lock.service';
import { AuthStore } from '../../core/auth/auth.store';
import { ConsentService } from '../../core/consent/consent.service';
import type { AiEgressEntry, ConsentRecord } from '../../core/consent/consent.view';
import { purposeToAsk, stateOf } from '../../core/consent/consent.view';
import { SyncService } from '../../core/offline/sync.service';
import { ConsentPurposeComponent } from '../../shared/ui/consent-purpose/consent-purpose.component';
import { SettingsComponent } from './settings.component';

initAngularTesting();

/**
 * The settings shell's first section: arming the app lock (task 4.2.6b).
 *
 * The decisions are `app-lock.service.spec.ts`'s subject; what a rendered screen must prove is that
 * the **right controls** are offered for the state — an armed install cannot arm again, an install
 * with a queue is told to drain it first rather than being refused silently, and turning the lock off
 * says that it deletes what is stored, because that is what it does.
 */
interface Mounted {
  readonly fixture: ReturnType<typeof TestBed.createComponent<SettingsComponent>>;
  readonly component: SettingsComponent;
  readonly consent: ReturnType<typeof consentStub>;
  readonly lock: {
    state: ReturnType<typeof vi.fn>;
    webauthnPossible: boolean;
    busy: ReturnType<typeof vi.fn>;
    failure: ReturnType<typeof vi.fn>;
    enableWithPin: ReturnType<typeof vi.fn>;
    enableWithWebAuthn: ReturnType<typeof vi.fn>;
    lock: ReturnType<typeof vi.fn>;
    purge: ReturnType<typeof vi.fn>;
  };
}

/**
 * A stand-in for {@link ConsentService}.
 *
 * Faithful about the one thing the section depends on: the component reads `state(kind)`, `routes()` and
 * `saving()`, so the stub exposes those as the real service does — over signals, so a test can change the
 * answer and see the screen follow. `record` records the call rather than performing it; what a *write*
 * does is the service's own spec.
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

async function mount(
  state: 'OFF' | 'LOCKED' | 'UNLOCKED',
  options: {
    pending?: number;
    webauthn?: boolean;
    failure?: string | null;
    role?: string | null;
    consent?: ReturnType<typeof consentStub>;
  } = {},
): Promise<Mounted> {
  const lock = {
    state: vi.fn(() => state),
    webauthnPossible: options.webauthn ?? true,
    busy: vi.fn(() => false),
    failure: vi.fn(() => options.failure ?? null),
    enableWithPin: vi.fn(() => Promise.resolve(true)),
    enableWithWebAuthn: vi.fn(() => Promise.resolve(true)),
    lock: vi.fn(),
    purge: vi.fn(() => Promise.resolve()),
  };

  TestBed.configureTestingModule({
    imports: [SettingsComponent],
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AppLockService, useValue: lock },
      { provide: ConsentService, useValue: options.consent ?? consentStub([]) },
      { provide: AuthStore, useValue: { role: signal(options.role ?? 'OWNER') } },
      {
        provide: SyncService,
        useValue: { pendingCount: signal(options.pending ?? 0), refresh: vi.fn(() => Promise.resolve()) },
      },
    ],
  });
  // The purpose card is opaque in this spec; see the AI-section suite's header below.
  TestBed.overrideComponent(SettingsComponent, {
    remove: { imports: [ConsentPurposeComponent] },
    add: { schemas: [CUSTOM_ELEMENTS_SCHEMA] },
  });
  const fixture = TestBed.createComponent(SettingsComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return {
    fixture,
    component: fixture.componentInstance,
    lock,
    consent: options.consent ?? consentStub([]),
  };
}

function text(fixture: { nativeElement: unknown }): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

function button(fixture: { nativeElement: unknown }, label: string): HTMLButtonElement | undefined {
  return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((entry) =>
    entry.textContent?.includes(label),
  );
}

/**
 * The purpose cards the section rendered, in document order.
 *
 * The card is opaque here (see the AI-section suite), so a card is an element and not a tree: the
 * sentences *inside* one — the provider, the region, the state, the verbs — are pinned in
 * `consent-purpose.component.spec.ts`, which mounts it directly. What this spec proves is that the
 * section asks for the right cards and offers none of its own.
 */
function cards(fixture: { nativeElement: unknown }): readonly HTMLElement[] {
  return Array.from(
    (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLElement>('fm-consent-purpose'),
  );
}

afterEach(() => TestBed.resetTestingModule());

describe('SettingsComponent (mounted)', () => {
  it('offers both ways to arm when the device has a platform authenticator', async () => {
    const { fixture } = await mount('OFF');

    expect(text(fixture)).toContain('App lock');
    expect(button(fixture, 'Use this device’s lock')).toBeDefined();
    expect(button(fixture, 'Use a PIN')).toBeDefined();
    // The panel has to say what arming buys, because it is the reason to do it at all.
    expect(text(fixture)).toContain('survive closing the app');
  });

  it('offers only the PIN when the browser has no credential API', async () => {
    const { fixture } = await mount('OFF', { webauthn: false });

    expect(button(fixture, 'Use this device’s lock')).toBeUndefined();
    expect(button(fixture, 'Use a PIN')).toBeDefined();
  });

  it('tells the user to drain the queue first instead of refusing silently', async () => {
    const { fixture, lock } = await mount('OFF', { pending: 2 });

    expect(text(fixture)).toContain('2 captures waiting to send');
    // The link is the way to act on that sentence.
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('a[href="/pending"]'),
    ).not.toBeNull();
    // And nothing was attempted behind the user's back.
    expect(lock.enableWithPin).not.toHaveBeenCalled();
  });

  it('arms with a PIN and clears the field', async () => {
    const { fixture, lock } = await mount('OFF');
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('#new-pin')!;
    input.value = '246810';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    button(fixture, 'Use a PIN')!.click();
    await fixture.whenStable();

    expect(lock.enableWithPin).toHaveBeenCalledWith('246810', 0);
    expect(input.value).toBe('');
  });

  it('offers Lock now and a plainly-named delete once the lock is armed', async () => {
    const { fixture } = await mount('UNLOCKED');

    expect(button(fixture, 'Lock now')).toBeDefined();
    // The label says what the button does: turning the lock off wipes the store (ADR-029 decision 9).
    expect(button(fixture, 'Turn off and delete stored data')).toBeDefined();
    expect(text(fixture)).toContain('deletes everything stored on this device');
    // Nothing to arm again.
    expect(button(fixture, 'Use a PIN')).toBeUndefined();
  });

  it('shows the reason a lock could not be armed', async () => {
    const { fixture } = await mount('OFF', { failure: 'WEBAUTHN_UNAVAILABLE' });

    expect(text(fixture)).toContain('cannot use its screen lock');
  });

  it('links to the screen that owns notifications rather than duplicating it', async () => {
    const { fixture } = await mount('OFF');

    // docs/02 §4.18 puts preferences in this shell; until the rest of it exists, the row is a link.
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('a[href="/notifications"]'),
    ).not.toBeNull();
  });
});

/**
 * The AI section — the consent surface's deliberate half (task R-25a, docs/08 §6.6).
 *
 * What a rendered screen has to prove here is not that a mutation fires: it is that the **decision is
 * informed** and that the **wrong people cannot make it**. So the assertions are about the copy beside
 * the buttons — the provider and region the server would use, what is never sent, what declining costs —
 * and about a MEMBER seeing the state without a control.
 */
/**
 * `/settings`' AI consent section — docs/02 §4.18, docs/08 §6.6, task 4.2.6b's follow-up.
 *
 * The section is a *list of purposes plus its own framing*: which purposes exist, that the deployment
 * routes nothing, the §6.4 never-sent list, the §6.1 trade, the MEMBER line and a refused write. The
 * disclosure inside a card is the card's, and it is asserted where it renders.
 */
describe('SettingsComponent — the AI consent section', () => {
  it('frames the section with what it is for and what never leaves the device', async () => {
    const { fixture } = await mount('OFF', { consent: consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]) });

    const section = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('#ai-heading')!.parentElement!;
    expect(section.querySelector('h2')?.textContent).toBe('AI');
    expect(text(fixture)).toContain('Some of the app can use an AI model');
    // The §6.4 assertion list and the §6.1 trade, both required by §6.6.
    expect(text(fixture)).toContain('Never sent:');
    expect(text(fixture)).toContain('If you decline');
  });

  it('asks about every purpose the deployment needs, and offers no control of its own', async () => {
    const { fixture } = await mount('OFF', { consent: consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]) });

    // One card per purpose, so a purpose added to `CONSENT_KINDS` cannot be silently unaskable.
    expect(cards(fixture)).toHaveLength(3);
    // The section frames; the cards decide. A button here would be a second, undated place to consent.
    const section = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>('#ai-heading')!.parentElement!;
    expect(section.querySelectorAll('button')).toHaveLength(0);
  });

  it('hands each card the purpose"s own stored record, and nothing when there is none', async () => {
    const { fixture, component } = await mount('OFF', {
      consent: consentStub([record('AI_DATA_PROCESSING', 'GRANTED')]),
    });

    expect(component.recordFor('AI_DATA_PROCESSING')?.state).toBe('GRANTED');
    // The absence of a row is the question being open, not an error.
    expect(component.recordFor('CLOUD_OCR')).toBeNull();
    expect(cards(fixture)).toHaveLength(3);
  });

  it('records a card"s answer on the settings surface', async () => {
    const { component, consent } = await mount('OFF', {
      consent: consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]),
    });

    await component.record('AI_DATA_PROCESSING', 'GRANTED');

    // The surface is recorded as evidence, so a record can be traced to the screen that showed the copy.
    expect(consent.record).toHaveBeenCalledWith('AI_DATA_PROCESSING', 'GRANTED', 'settings');
  });

  it('says there is nothing to allow when the deployment routes nothing', async () => {
    // The inert deployment: three Allow buttons would advertise a decision that does not exist.
    const { fixture } = await mount('OFF', { consent: consentStub([], []) });

    expect(text(fixture)).toContain('no AI model configured');
    expect(cards(fixture)).toHaveLength(0);
    expect(button(fixture, 'Allow')).toBeUndefined();
  });

  it('tells a MEMBER whose decision it is, and asks them nothing', async () => {
    // docs/08 §3.7 and Q-11: granting or withdrawing consent is an OWNER act, because the record is the
    // lawful-basis evidence. A MEMBER is entitled to know what their Household decided.
    const { fixture, component, consent } = await mount('OFF', {
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
    const { fixture } = await mount('OFF', { consent: stub });

    expect(text(fixture)).toContain('Your role does not permit this action.');
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('still offers the cards while the first read is in flight', async () => {
    // The section is not gated on the read: `routes()` is empty until it lands, so gating on it would
    // flash "no AI model configured" — a claim about the deployment — before the answer arrives.
    const stub = consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]);
    stub.loading.set(true);
    const { fixture } = await mount('OFF', { consent: stub });

    expect(text(fixture)).not.toContain('no AI model configured');
  });
});
