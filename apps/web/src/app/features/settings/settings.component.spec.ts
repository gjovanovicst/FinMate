// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { computed, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppLockService } from '../../core/app-lock/app-lock.service';
import { AuthStore } from '../../core/auth/auth.store';
import { ConsentService } from '../../core/consent/consent.service';
import type { AiEgressEntry, ConsentRecord } from '../../core/consent/consent.view';
import { purposeToAsk, stateOf } from '../../core/consent/consent.view';
import { SyncService } from '../../core/offline/sync.service';
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
  const fixture = TestBed.createComponent(SettingsComponent);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, lock, consent: options.consent ?? consentStub([]) };
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
 * One purpose's card, found by the name it renders.
 *
 * Scoping matters here: the section lists **every** purpose the deployment needs permission for, so a
 * screen-wide `querySelector('button')` finds the *other* purposes' buttons and a test that asserts
 * "Decline is gone" passes or fails for reasons that have nothing to do with the purpose under test.
 */
function purpose(fixture: { nativeElement: unknown }, name: string): HTMLElement {
  const card = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('article')).find(
    (entry) => entry.querySelector('h3')?.textContent?.includes(name) === true,
  );
  if (card === undefined) throw new Error(`no purpose card named ${name}`);
  return card as HTMLElement;
}

function purposeButton(card: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(card.querySelectorAll('button')).find((entry) =>
    entry.textContent?.includes(label),
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
describe('SettingsComponent — the AI consent section', () => {
  it('says where the text would go, naming the provider and the region from the server', async () => {
    const { fixture } = await mount('OFF', { consent: consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]) });

    const body = text(fixture);
    expect(body).toContain('Sending text to an AI model');
    // The disclosure is the server's, not client copy: `DEEPSEEK` and "outside the European Economic
    // Area" come from `aiEgress`. A hardcoded provider name would be a claim (ADR-031).
    expect(body).toContain('DEEPSEEK');
    expect(body).toContain('outside the European Economic Area');
    expect(body).toContain('transfer outside the EEA');
    // The §6.4 assertion list and the §6.1 trade, both required by §6.6.
    expect(body).toContain('Never sent:');
    expect(body).toContain('If you decline');
    expect(body).toContain('Not asked');
  });

  it('offers Allow and Decline while the question is open, and records the answer', async () => {
    const { fixture, consent } = await mount('OFF', {
      consent: consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]),
    });

    const card = purpose(fixture, 'Sending text to an AI model');
    expect(purposeButton(card, 'Decline')).toBeDefined();
    purposeButton(card, 'Allow')?.click();
    await fixture.whenStable();

    // The surface is recorded as evidence, so a record can be traced to the screen that showed the copy.
    expect(consent.record).toHaveBeenCalledWith('AI_DATA_PROCESSING', 'GRANTED', 'settings');
  });

  it('replaces the pair with Withdraw once permission is held, and drops Decline', async () => {
    const { fixture, consent } = await mount('OFF', {
      consent: consentStub([record('AI_DATA_PROCESSING', 'GRANTED')]),
    });

    const card = purpose(fixture, 'Sending text to an AI model');
    expect(card.textContent).toContain('Allowed');
    // `Decline` again would set a state this purpose is already in — and the section's other purposes,
    // still unasked, keep theirs.
    expect(purposeButton(card, 'Decline')).toBeUndefined();

    purposeButton(card, 'Withdraw permission')?.click();
    await fixture.whenStable();

    expect(consent.record).toHaveBeenCalledWith('AI_DATA_PROCESSING', 'WITHDRAWN', 'settings');
  });

  it('does not offer Decline again after somebody has declined', async () => {
    // A button that sets a state it is already in is a control that does nothing.
    const { fixture } = await mount('OFF', {
      consent: consentStub([record('AI_DATA_PROCESSING', 'DECLINED')]),
    });

    const card = purpose(fixture, 'Sending text to an AI model');
    expect(card.textContent).toContain('Declined');
    expect(purposeButton(card, 'Decline')).toBeUndefined();
    // …and the way back is still there.
    expect(purposeButton(card, 'Allow')).toBeDefined();
  });

  it('shows a MEMBER the state and whose decision it is, with no control at all', async () => {
    // docs/08 §3.7 and Q-11: granting or withdrawing consent is an OWNER act, because the record is the
    // lawful-basis evidence. A MEMBER is entitled to know what their Household decided.
    const { fixture, consent } = await mount('OFF', {
      role: 'MEMBER',
      consent: consentStub([record('AI_DATA_PROCESSING', 'GRANTED')]),
    });

    expect(text(fixture)).toContain('Allowed');
    expect(text(fixture)).toContain('Only the owner of this household can change these.');
    // No consent control anywhere on the screen — not just on the granted purpose.
    expect(button(fixture, 'Withdraw permission')).toBeUndefined();
    expect(button(fixture, 'Allow')).toBeUndefined();
    expect(button(fixture, 'Decline')).toBeUndefined();
    expect(consent.record).not.toHaveBeenCalled();
  });

  it('says there is nothing to allow when the deployment routes nothing', async () => {
    // The inert deployment: three Allow buttons would advertise a decision that does not exist.
    const { fixture } = await mount('OFF', { consent: consentStub([], []) });

    expect(text(fixture)).toContain('no AI model configured');
    expect(button(fixture, 'Allow')).toBeUndefined();
    expect(button(fixture, 'Decline')).toBeUndefined();
  });

  it('marks the eval opt-in as recorded-but-unused rather than pretending it works', async () => {
    const { fixture } = await mount('OFF', {
      consent: consentStub([
        record('AI_DATA_PROCESSING', 'NOT_ASKED'),
        record('EVAL_DATASET', 'NOT_ASKED'),
      ]),
    });

    expect(text(fixture)).toContain('Helping improve accuracy');
    expect(text(fixture)).toContain('nothing reads it yet');
  });

  it('reports a refused write instead of appearing to have recorded it', async () => {
    const stub = consentStub([record('AI_DATA_PROCESSING', 'NOT_ASKED')]);
    stub.error.set('Your role does not permit this action.');
    const { fixture } = await mount('OFF', { consent: stub });

    expect(text(fixture)).toContain('Your role does not permit this action.');
    expect(fixture.nativeElement.querySelector('[role="alert"]')).not.toBeNull();
  });
});
