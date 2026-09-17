import { DOCUMENT, Injectable, InjectionToken, inject } from '@angular/core';

import type { InstallPlatform } from './install.view';

/**
 * docs/07 §4.7's two events, and the honest state of their sink — task 4.3.2b.
 *
 * §4.7 asks to "record `install.prompt_shown` / `install.accepted` so T3 is measurable", where T3 is
 * *"iOS users never install, so never get push"* with a bar of **75 % conversion within 14 days**. Two
 * events, and — as of this task — **nothing on the other end of them**: the web client has no telemetry
 * transport at all (docs/05 §10 lists `sync.pending_age` for the web and that hook is unwired too), and
 * there is no analytics endpoint in the API.
 *
 * So this module does the two things that are honest and none of the things that would pretend:
 *
 * 1. the two events are **a type**, with the payload T3 needs (which platform, and when), emitted at
 *    exactly the moment §4.7 names; and
 * 2. they are written to a **bounded local log** that a real transport can drain, because a
 *    definition with no destination is a comment and a `console.info` is not a sink.
 *
 * What is deliberately **not** here: a network call, a retry queue, an offline outbox entry, a
 * dependency. The residual is recorded in docs/07 §4.7 and docs/09's 4.3.2 row, and plugging a
 * transport in is one provider override — {@link INSTALL_EVENT_SINK} is the seam.
 *
 * ## Privacy
 *
 * The payload is the event name, the platform and a timestamp. No Household, no Member, no device
 * identifier, nothing from a capture. It stays on the device until something is wired to collect it,
 * which is also why it is safe in `localStorage` beside the install state.
 *
 * @module apps/web/src/app/core/install
 */

/** Exactly the two names docs/07 §4.7 asks for — no third, so "shown but not accepted" is the gap. */
export type InstallEventName = 'install.prompt_shown' | 'install.accepted';

export interface InstallEvent {
  readonly name: InstallEventName;
  readonly platform: InstallPlatform;
  /** ISO timestamp. */
  readonly at: string;
}

export interface InstallEventSink {
  record(event: InstallEvent): void;
}

/** The local log's key, and its bound: a preference-sized ring, not a database. */
export const INSTALL_EVENT_LOG_KEY = 'finmate.install.events.v1';
export const INSTALL_EVENT_LOG_LIMIT = 50;

/**
 * The seam. Override this provider to ship the events somewhere; the default keeps them on the device.
 */
export const INSTALL_EVENT_SINK = new InjectionToken<InstallEventSink>('INSTALL_EVENT_SINK', {
  providedIn: 'root',
  factory: () => inject(LocalInstallEventSink),
});

/**
 * The default sink: a bounded, append-only local log.
 *
 * Every failure is swallowed. An event about a promotion is never worth an exception in the middle of
 * a capture, and storage being unavailable (private mode, blocked cookies) must cost the event and
 * nothing else.
 */
@Injectable({ providedIn: 'root' })
export class LocalInstallEventSink implements InstallEventSink {
  private readonly document = inject(DOCUMENT);

  record(event: InstallEvent): void {
    const existing = this.read();
    const next = [...existing, event].slice(-INSTALL_EVENT_LOG_LIMIT);
    try {
      this.document.defaultView?.localStorage.setItem(INSTALL_EVENT_LOG_KEY, JSON.stringify(next));
    } catch {
      // Storage unavailable: the event is lost, and that is the whole cost.
    }
  }

  /** The log as it stands. Public because the live verification and any future drain both read it. */
  read(): readonly InstallEvent[] {
    let raw: string | null = null;
    try {
      raw = this.document.defaultView?.localStorage.getItem(INSTALL_EVENT_LOG_KEY) ?? null;
    } catch {
      return [];
    }
    if (raw === null || raw === '') return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isInstallEvent);
    } catch {
      return [];
    }
  }
}

/** A structurally valid entry, so a hand-edited log cannot break the next drain. */
function isInstallEvent(value: unknown): value is InstallEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  const name = record['name'];
  const platform = record['platform'];
  const at = record['at'];
  return (
    (name === 'install.prompt_shown' || name === 'install.accepted') &&
    (platform === 'IOS' || platform === 'CHROMIUM') &&
    typeof at === 'string' &&
    Number.isFinite(Date.parse(at))
  );
}
