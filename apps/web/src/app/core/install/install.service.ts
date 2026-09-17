import { DestroyRef, DOCUMENT, Injectable, inject, signal } from '@angular/core';

import { isIos, isStandalone } from '../push/push.view';
import { INSTALL_EVENT_SINK } from './install-events';
import {
  EMPTY_INSTALL_STATE,
  INSTALL_STORAGE_KEY,
  installPromptKind,
  parseInstallState,
  platformOf,
  serialiseInstallState,
  type BeforeInstallPromptEvent,
  type InstallPlatform,
  type InstallPromptKind,
  type InstallState,
} from './install.view';

/**
 * The install funnel's one stateful object — docs/07 §4.7, task 4.3.2b.
 *
 * The decisions are in `install.view.ts`; this is the only place that touches the window, the stored
 * record and the two events. It is root-provided and injected by the shell, for a reason that is easy
 * to get wrong: **`beforeinstallprompt` fires early and once**, usually before the user has captured
 * anything at all. A listener installed by the capture screen would miss it on every visit that did not
 * start at `/capture`, and Chromium fires it once per page load unless it is `preventDefault`ed.
 *
 * ## What "confirmed" means, and why the service cannot decide it alone
 *
 * `noteConfirmedCapture()` is called by the capture screen after a commit the server **accepted**. A
 * queued offline capture is not counted and neither is a refusal: a queued batch is a promise, and
 * inviting somebody to install the app on the strength of a promise is exactly the sort of thing that
 * makes a funnel dishonest. The count therefore lives here, but the *fact* comes from the one place
 * that knows the difference.
 *
 * ## Acceptance is measured, never asserted
 *
 * The sheet has no "I installed it" button. On Chromium the browser answers (`userChoice`, then
 * `appinstalled`); on iOS **nothing can answer at all** — Safari has no install API, so the only
 * evidence is a later launch in `display-mode: standalone`, which this constructor records once. That
 * is why the event set has no `install.dismissed`: "shown without accepted" is the gap T3 measures,
 * and a third event would be a claim we cannot make.
 *
 * @module apps/web/src/app/core/install
 */
@Injectable({ providedIn: 'root' })
export class InstallService {
  private readonly document = inject(DOCUMENT);
  private readonly sink = inject(INSTALL_EVENT_SINK);

  private readonly stateSignal = signal<InstallState>(EMPTY_INSTALL_STATE);
  private readonly openSignal = signal<InstallPromptKind | null>(null);
  private readonly onboardingSignal = signal(false);
  private readonly busySignal = signal(false);
  private readonly failedSignal = signal(false);

  /** What the sheet is showing right now, or `null` when it is closed. */
  readonly promptKind = this.openSignal.asReadonly();
  readonly busy = this.busySignal.asReadonly();
  /** The browser refused to open its own prompt — said out loud rather than closing silently. */
  readonly failed = this.failedSignal.asReadonly();

  /**
   * The deferred Chromium prompt, held between the event and the button press.
   *
   * Single-use: after `prompt()` resolves, the event is spent, so it is dropped rather than kept and
   * re-prompted (Chromium throws on a second call, and a sheet that reports success on a throw is
   * worse than one that says the browser would not open).
   */
  private deferred: BeforeInstallPromptEvent | null = null;

  constructor() {
    const state = this.readState();
    this.stateSignal.set(state);

    // A launch in standalone mode is the only *measured* acceptance on iOS, and it is also how an
    // install that never saw the sheet (the browser's own menu) is recognised. The first case is an
    // event; the second is not, because nothing was shown to attribute it to.
    if (this.isStandaloneNow()) {
      if (state.offeredAt !== null && !state.installed) {
        this.markAccepted(this.isIosNow() ? 'IOS' : 'CHROMIUM');
      } else if (!state.installed) {
        this.patch({ installed: true });
      }
    }

    const view = this.document.defaultView;
    if (view !== null && typeof view.addEventListener === 'function') {
      view.addEventListener('beforeinstallprompt', this.onBeforeInstallPrompt);
      view.addEventListener('appinstalled', this.onAppInstalled);
    }
    inject(DestroyRef).onDestroy(() => {
      if (view !== null && typeof view.removeEventListener === 'function') {
        view.removeEventListener('beforeinstallprompt', this.onBeforeInstallPrompt);
        view.removeEventListener('appinstalled', this.onAppInstalled);
      }
    });
  }

  /**
   * §4.7's trigger: the second capture that **landed**.
   *
   * Called from the capture screen, and cheap when nothing will happen — a signal read, a write only
   * when the count changes, and no environment read unless the count just reached the threshold.
   */
  noteConfirmedCapture(): void {
    const state = this.stateSignal();
    const next: InstallState = { ...state, captures: state.captures + 1 };
    this.writeState(next);
    if (this.openSignal() !== null) return;

    const kind = installPromptKind({
      state: next,
      standalone: this.isStandaloneNow(),
      ios: this.isIosNow(),
      hasNativePrompt: this.deferred !== null,
      onboarding: this.onboardingSignal(),
      now: Date.now(),
    });
    if (kind === null) return;

    this.openSignal.set(kind);
    this.failedSignal.set(false);
    // Recorded with the *display*, not with the dismissal: T3's denominator is how often the offer was
    // put in front of somebody, and it must survive a reload that tears the sheet down. Clearing the
    // previous dismissal re-arms the "offered, unanswered" rule above — see `install.view.ts`.
    this.writeState({ ...next, offeredAt: new Date().toISOString(), dismissedAt: null });
    this.sink.record({ name: 'install.prompt_shown', platform: platformOf(kind), at: new Date().toISOString() });
  }

  /**
   * Run the browser's own prompt — Chromium only.
   *
   * A no-op for the iOS instructions, whose only verb is *understood*: there is nothing to call, and
   * the acceptance arrives later as a standalone launch, if it arrives at all.
   */
  async accept(): Promise<void> {
    if (this.openSignal() !== 'NATIVE') return;
    const deferred = this.deferred;
    if (deferred === null) {
      // The prompt was consumed (or the browser withdrew it) between render and click. Saying so is
      // the honest outcome; the sheet stays open with the sentence that names the browser menu.
      this.failedSignal.set(true);
      return;
    }

    this.busySignal.set(true);
    this.failedSignal.set(false);
    try {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      this.deferred = null;
      if (choice.outcome === 'accepted') {
        this.markAccepted('CHROMIUM');
        this.openSignal.set(null);
      } else {
        // The browser's own dismissal is a dismissal: §4.7's 30 days apply to it too.
        this.dismiss();
      }
    } catch {
      this.failedSignal.set(true);
    } finally {
      this.busySignal.set(false);
    }
  }

  /** Close the sheet and start the 30-day suppression. */
  dismiss(): void {
    if (this.openSignal() === null) return;
    this.openSignal.set(null);
    this.writeState({ ...this.stateSignal(), dismissedAt: new Date().toISOString() });
  }

  /**
   * The router's answer to "is the wizard running", which §4.7 forbids prompting over.
   *
   * Entering onboarding closes a sheet that is already open **without** recording a dismissal: the
   * person did not decline, they walked into the one flow the sheet must not cover, and the recorded
   * offer already keeps it from coming back uninvited.
   */
  setOnboarding(onboarding: boolean): void {
    if (this.onboardingSignal() === onboarding) return;
    this.onboardingSignal.set(onboarding);
    if (onboarding) this.openSignal.set(null);
  }

  /**
   * Record an acceptance the browser told us about, once.
   *
   * Idempotent on purpose: Chromium fires both `userChoice` and `appinstalled` for one install, and a
   * second `install.accepted` would double-count T3's numerator.
   */
  private markAccepted(platform: InstallPlatform): void {
    const state = this.stateSignal();
    if (state.installed) return;
    this.writeState({ ...state, installed: true });
    this.sink.record({ name: 'install.accepted', platform, at: new Date().toISOString() });
  }

  private patch(change: Partial<InstallState>): void {
    this.writeState({ ...this.stateSignal(), ...change });
  }

  private onBeforeInstallPrompt = (event: Event): void => {
    // The whole point of our own sheet: without this, Chromium shows its own mini-infobar and the
    // deferred event is never usable by us afterwards.
    event.preventDefault();
    this.deferred = event as BeforeInstallPromptEvent;
  };

  private onAppInstalled = (): void => {
    this.deferred = null;
    this.openSignal.set(null);
    this.markAccepted('CHROMIUM');
  };

  /** The stored record, or the empty one. Storage unavailable is "never asked", not a failure. */
  private readState(): InstallState {
    try {
      return parseInstallState(this.document.defaultView?.localStorage.getItem(INSTALL_STORAGE_KEY) ?? null);
    } catch {
      return EMPTY_INSTALL_STATE;
    }
  }

  private writeState(state: InstallState): void {
    this.stateSignal.set(state);
    try {
      this.document.defaultView?.localStorage.setItem(INSTALL_STORAGE_KEY, serialiseInstallState(state));
    } catch {
      // The session keeps the state; only the memory of it across reloads is lost.
    }
  }

  /** Reused from `core/push` rather than copied: a second standalone check is a second answer. */
  private isStandaloneNow(): boolean {
    return isStandalone(
      (globalThis.navigator as { standalone?: boolean } | undefined)?.standalone === true,
      globalThis.matchMedia?.('(display-mode: standalone)')?.matches === true,
    );
  }

  private isIosNow(): boolean {
    return isIos(
      globalThis.navigator?.userAgent ?? '',
      globalThis.navigator?.maxTouchPoints ?? 0,
      globalThis.navigator?.platform ?? '',
    );
  }
}
