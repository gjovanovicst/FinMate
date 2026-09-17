// @vitest-environment jsdom
// FIRST import, deliberately — see `notifications.component.spec.ts` for why the JIT compiler must be
// loaded before anything that touches `@angular/router`. This service touches no router, but it does
// mount through `TestBed` like every other injected service here.
import { initAngularTesting } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  INSTALL_EVENT_LOG_KEY,
  INSTALL_EVENT_SINK,
  LocalInstallEventSink,
  type InstallEvent,
} from './install-events';
import { InstallService } from './install.service';
import { INSTALL_STORAGE_KEY, parseInstallState, type InstallState } from './install.view';

initAngularTesting();

/**
 * The install funnel's behaviour against a real `window` (docs/07 §4.7, task 4.3.2b).
 *
 * What a mounted screen cannot show, and what this asserts instead: that the Chromium event is taken
 * over and `preventDefault`ed, that the browser's own prompt runs only from the button, that a
 * dismissal is a date rather than a flag, that an installed launch is recognised as the *only*
 * measurable acceptance on iOS, and that the two events §4.7 asks for are emitted exactly once each.
 */

const IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

interface PromptEvent extends Event {
  prompt: ReturnType<typeof vi.fn>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

/** The window the service listens on. Not necessarily `globalThis` — `document.defaultView` is the fact. */
function view(): Window {
  const found = globalThis.document.defaultView;
  if (found === null) throw new Error('no window');
  return found;
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(globalThis.navigator, 'userAgent', { value: userAgent, configurable: true });
}

/** Standalone detection reads `matchMedia`; jsdom's stub always says false, so it is stated per test. */
function setStandalone(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matches && query.includes('display-mode: standalone'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

/** The state the service starts from, written straight into `localStorage` before it is constructed. */
function seed(state: Partial<InstallState>): void {
  globalThis.localStorage.setItem(INSTALL_STORAGE_KEY, JSON.stringify({ ...state }));
}

function fireBeforeInstallPrompt(
  outcome: 'accepted' | 'dismissed' | 'reject' = 'accepted',
): PromptEvent {
  // `cancelable: true` is not decoration: `Event` defaults to non-cancelable, and `preventDefault()` on
  // one is a silent no-op — so `defaultPrevented` would read false and look like a service defect. The
  // real Chromium event is cancelable.
  const event = new Event('beforeinstallprompt', { cancelable: true }) as PromptEvent;
  // The real event carries both; `Object.assign` on an `Event` instance is how a spec supplies them
  // without a Chromium.
  Object.assign(event, {
    platforms: ['web'],
    prompt:
      outcome === 'reject'
        ? vi.fn(() => Promise.reject(new Error('the prompt is no longer available')))
        : vi.fn(() => Promise.resolve()),
    userChoice: Promise.resolve({ outcome: outcome === 'reject' ? 'dismissed' : outcome, platform: 'web' }),
  });
  view().dispatchEvent(event);
  return event;
}

function makeService(events: InstallEvent[] = []): { service: InstallService; events: InstallEvent[] } {
  TestBed.configureTestingModule({
    providers: [
      // The default sink keeps events on the device; a stub records what was emitted. Its own storage
      // is `LocalInstallEventSink`'s behaviour, asserted in its own block below.
      { provide: INSTALL_EVENT_SINK, useValue: { record: (event: InstallEvent) => events.push(event) } },
    ],
  });
  return { service: TestBed.inject(InstallService), events };
}

beforeEach(() => {
  globalThis.localStorage.clear();
  setUserAgent(DESKTOP_UA);
  setStandalone(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  TestBed.resetTestingModule();
  globalThis.localStorage.clear();
});

describe('InstallService', () => {
  it('says nothing on the first capture and opens on the second', () => {
    const { service, events } = makeService();
    fireBeforeInstallPrompt();

    service.noteConfirmedCapture();
    expect(service.promptKind()).toBeNull();

    service.noteConfirmedCapture();
    expect(service.promptKind()).toBe('NATIVE');
    // §4.7's denominator: one `install.prompt_shown`, carrying the platform T3 needs.
    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('install.prompt_shown');
    expect(events[0]?.platform).toBe('CHROMIUM');
    // Remembered across a reload, which is where an in-memory count would fail.
    expect(parseInstallState(globalThis.localStorage.getItem(INSTALL_STORAGE_KEY)).offeredAt).not.toBeNull();
  });

  it('takes the browser event over and stops Chromium showing its own mini-infobar', () => {
    makeService();
    const event = fireBeforeInstallPrompt();

    expect(event.defaultPrevented).toBe(true);
  });

  it('runs the browser prompt only from the button, and records the acceptance it reports', async () => {
    const { service, events } = makeService();
    const event = fireBeforeInstallPrompt('accepted');
    service.noteConfirmedCapture();
    service.noteConfirmedCapture();

    // Nothing prompted until the person pressed the sheet's own button. The gesture rule is docs/07
    // §4.8's, applied to install for the same reason: an unprompted dialog is how a permanent "no" happens.
    expect(event.prompt).not.toHaveBeenCalled();

    await service.accept();

    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(service.promptKind()).toBeNull();
    expect(events.map((entry) => entry.name)).toEqual(['install.prompt_shown', 'install.accepted']);
    expect(parseInstallState(globalThis.localStorage.getItem(INSTALL_STORAGE_KEY)).installed).toBe(true);
  });

  it('records a browser dismissal as a dismissal, with no accepted event', async () => {
    const { service, events } = makeService();
    fireBeforeInstallPrompt('dismissed');
    service.noteConfirmedCapture();
    service.noteConfirmedCapture();

    await service.accept();

    expect(service.promptKind()).toBeNull();
    expect(events.map((entry) => entry.name)).toEqual(['install.prompt_shown']);
    const stored = parseInstallState(globalThis.localStorage.getItem(INSTALL_STORAGE_KEY));
    expect(stored.dismissedAt).not.toBeNull();
    expect(stored.installed).toBe(false);
  });

  it('keeps the sheet open and says so when the browser refuses to prompt', async () => {
    const { service, events } = makeService();
    fireBeforeInstallPrompt('reject');
    service.noteConfirmedCapture();
    service.noteConfirmedCapture();

    await service.accept();

    // Not silently closed: somebody pressed *Install* and nothing was installed, so the sheet stays and
    // offers the browser menu instead.
    expect(service.failed()).toBe(true);
    expect(service.promptKind()).toBe('NATIVE');
    expect(events.map((entry) => entry.name)).toEqual(['install.prompt_shown']);
  });

  it('closes on a dismissal and does not ask again for thirty days', () => {
    const { service } = makeService();
    fireBeforeInstallPrompt();
    service.noteConfirmedCapture();
    service.noteConfirmedCapture();

    service.dismiss();
    expect(service.promptKind()).toBeNull();

    // A third capture inside the window asks nothing…
    service.noteConfirmedCapture();
    expect(service.promptKind()).toBeNull();

    // …and a stored dismissal older than the window is the only thing that reopens the funnel.
    TestBed.resetTestingModule();
    seed({
      captures: 3,
      offeredAt: '2026-01-01T00:00:00.000Z',
      dismissedAt: '2026-01-01T00:00:00.000Z',
      installed: false,
    });
    const reloaded = makeService();
    fireBeforeInstallPrompt();
    reloaded.service.noteConfirmedCapture();
    expect(reloaded.service.promptKind()).toBe('NATIVE');
  });

  it('does not reopen on a reload when the offer was never answered', () => {
    seed({ captures: 2, offeredAt: '2026-09-01T00:00:00.000Z', installed: false, dismissedAt: null });
    const { service } = makeService();
    fireBeforeInstallPrompt();

    service.noteConfirmedCapture();

    expect(service.promptKind()).toBeNull();
  });

  it('gives iOS the instructions, where there is no API to call and nothing to accept', async () => {
    setUserAgent(IOS_UA);
    const { service, events } = makeService();

    service.noteConfirmedCapture();
    service.noteConfirmedCapture();

    expect(service.promptKind()).toBe('IOS_INSTRUCTIONS');
    expect(events[0]?.platform).toBe('IOS');

    // There is no button that could install anything on iOS, so `accept` is not a path the sheet offers;
    // calling it anyway must not close the sheet or claim a failure.
    await service.accept();
    expect(service.promptKind()).toBe('IOS_INSTRUCTIONS');
    expect(service.failed()).toBe(false);
  });

  it('treats a standalone launch as the acceptance iOS can never report', () => {
    setUserAgent(IOS_UA);
    setStandalone(true);
    seed({ captures: 2, offeredAt: '2026-09-01T00:00:00.000Z', installed: false, dismissedAt: null });

    const { events } = makeService();

    expect(events.map((entry) => entry.name)).toEqual(['install.accepted']);
    expect(events[0]?.platform).toBe('IOS');
    expect(parseInstallState(globalThis.localStorage.getItem(INSTALL_STORAGE_KEY)).installed).toBe(true);
  });

  it('recognises an install it never offered, without inventing an event for it', () => {
    setStandalone(true);
    const { events } = makeService();

    expect(events).toEqual([]);
    expect(parseInstallState(globalThis.localStorage.getItem(INSTALL_STORAGE_KEY)).installed).toBe(true);
  });

  it('never offers anything to a standalone app, whatever the count says', () => {
    setStandalone(true);
    const { service } = makeService();
    fireBeforeInstallPrompt();

    service.noteConfirmedCapture();
    service.noteConfirmedCapture();

    expect(service.promptKind()).toBeNull();
  });

  it('records `appinstalled` once, even though it arrives beside the accepted choice', async () => {
    const { service, events } = makeService();
    fireBeforeInstallPrompt('accepted');
    service.noteConfirmedCapture();
    service.noteConfirmedCapture();
    await service.accept();

    view().dispatchEvent(new Event('appinstalled'));

    expect(events.filter((entry) => entry.name === 'install.accepted')).toHaveLength(1);
    expect(service.promptKind()).toBeNull();
  });

  it('closes an open sheet when the wizard starts, without recording a dismissal', () => {
    const { service } = makeService();
    fireBeforeInstallPrompt();
    service.noteConfirmedCapture();
    service.noteConfirmedCapture();
    expect(service.promptKind()).toBe('NATIVE');

    service.setOnboarding(true);

    expect(service.promptKind()).toBeNull();
    // Not a decline: the person walked into the one flow §4.7 forbids covering, so the 30-day clock
    // must not start.
    expect(parseInstallState(globalThis.localStorage.getItem(INSTALL_STORAGE_KEY)).dismissedAt).toBeNull();
  });

  it('never opens while the wizard is running', () => {
    const { service } = makeService();
    fireBeforeInstallPrompt();
    service.setOnboarding(true);

    service.noteConfirmedCapture();
    service.noteConfirmedCapture();

    expect(service.promptKind()).toBeNull();
  });

  it('survives a corrupt stored record rather than refusing to offer', () => {
    globalThis.localStorage.setItem(INSTALL_STORAGE_KEY, '{not json');
    const { service, events } = makeService();
    fireBeforeInstallPrompt();

    service.noteConfirmedCapture();
    service.noteConfirmedCapture();

    expect(service.promptKind()).toBe('NATIVE');
    expect(events).toHaveLength(1);
  });
});

describe('LocalInstallEventSink', () => {
  it('keeps the events on the device in a bounded log a transport can drain', () => {
    const sink = TestBed.configureTestingModule({}).inject(LocalInstallEventSink);
    for (let index = 0; index < 60; index += 1) {
      sink.record({ name: 'install.prompt_shown', platform: 'IOS', at: new Date().toISOString() });
    }

    const log = sink.read();
    expect(log).toHaveLength(50);
    expect(log[0]?.name).toBe('install.prompt_shown');
  });

  it('ignores a hand-edited entry rather than failing the next drain', () => {
    const sink = TestBed.configureTestingModule({}).inject(LocalInstallEventSink);
    globalThis.localStorage.setItem(
      INSTALL_EVENT_LOG_KEY,
      JSON.stringify([
        { name: 'nonsense' },
        { name: 'install.accepted', platform: 'CHROMIUM', at: '2026-09-17T10:00:00.000Z' },
      ]),
    );

    expect(sink.read()).toHaveLength(1);
  });
});
