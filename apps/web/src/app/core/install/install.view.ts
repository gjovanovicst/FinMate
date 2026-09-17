/**
 * The install funnel as decisions rather than a component — docs/07 §4.7, task 4.3.2b.
 *
 * §4.7's table is the whole specification, and it is a table and not a boolean because the two
 * platforms differ in what is *possible*, not in what is desirable:
 *
 * | Platform | Mechanism | When we ask |
 * |---|---|---|
 * | Android Chromium | `beforeinstallprompt` → our own sheet with a real "Instaliraj" button | After the **2nd** confirmed capture, never on first load |
 * | iOS Safari | No API — instructional sheet with Share → "Add to Home Screen" steps | After the **2nd** confirmed capture; suppressed 30 days if dismissed |
 * | Already installed | `display-mode: standalone` match | Never shown |
 *
 * Everything below is pure: it takes the facts as arguments and returns a decision, so every gate in
 * that table is asserted in `install.view.spec.ts` instead of being observable only by installing the
 * app on a phone.
 *
 * ## The three gates that are easy to get wrong
 *
 * 1. **"Offered" is not the same as *open*.** A sheet that is on screen is not a sheet that should be
 *    offered again; the offer decision and the visibility are two different questions, and collapsing
 *    them makes the sheet vanish the instant it renders (`offeredAt` is written, the gate closes, the
 *    `@if` tears it down). The state machine answers "may we offer", the service holds "are we showing".
 * 2. **A dismissal is a *date*, not a flag, and `offeredAt` is a date for the same reason.** §4.7 says
 *    "suppressed 30 days", so a flag can only be wrong — it either suppresses for ever or never. And a
 *    boolean *offered* cannot be re-armed: after the thirty days and a second offer there would be no
 *    state that means "offered again this time, still unanswered", and the sheet would start reappearing
 *    on every capture. Two timestamps make the four states the table's prose actually describes.
 * 3. **Already installed is checked before the count.** Somebody who installed the app from the
 *    browser's own menu has no `beforeinstallprompt` to consume and no reason to be offered anything.
 *
 * ## What is stored, and why `localStorage` is the right place
 *
 * Four facts — how many captures have landed, when the sheet was last shown, whether the app is
 * installed and when it was last dismissed. None of them is confidential and none of them is a
 * credential, which is the test docs/08 applies to storage: the same reasoning that keeps the access
 * token in memory (`auth.interceptor.ts`) puts this on disk, next to the locale preference
 * (`i18n.service.ts`). A corrupt or absent record degrades to "never asked, nothing captured" rather
 * than to a crash, because a preference is never worth failing a page load over.
 *
 * @module apps/web/src/app/core/install
 */

/**
 * Which sheet §4.7 asks for, or `null` for "ask nothing".
 *
 * Only two of the three table rows produce a sheet: the installed row produces none, and a browser
 * with neither a `beforeinstallprompt` nor iOS gets none either — Firefox and desktop Safari expose no
 * install API, and instructions for a menu that does not exist would be worse than silence.
 */
export type InstallPromptKind = 'NATIVE' | 'IOS_INSTRUCTIONS';

/** Where the sheet was shown, as the event payload needs it. T3 is specifically an iOS metric. */
export type InstallPlatform = 'IOS' | 'CHROMIUM';

/** docs/07 §4.7: "After the **2nd** confirmed capture, never on first load". */
export const INSTALL_TRIGGER_CAPTURES = 2;

/** docs/07 §4.7: "suppressed 30 days if dismissed". */
export const INSTALL_SUPPRESSION_DAYS = 30;

/** The one stored record. Bump the suffix rather than migrating it: it is four preference fields. */
export const INSTALL_STORAGE_KEY = 'finmate.install.v1';

/**
 * What this browser has already been told, or done, about installing.
 *
 * `captures` is a count and not a boolean so the threshold stays in one place: §4.7 asks after the
 * second capture today, and a report that says "after the third" should change one constant.
 */
export interface InstallState {
  /** Confirmed captures that **landed** — a queued or refused batch is not a confirmation. */
  readonly captures: number;
  /** ISO timestamp of the last offer put in front of this person, or `null` for never. */
  readonly offeredAt: string | null;
  /** The app is installed: `appinstalled` fired, or a launch in standalone mode was observed. */
  readonly installed: boolean;
  /** ISO timestamp of the last dismissal, for the 30-day rule. `null` means never dismissed. */
  readonly dismissedAt: string | null;
}

export const EMPTY_INSTALL_STATE: InstallState = {
  captures: 0,
  offeredAt: null,
  installed: false,
  dismissedAt: null,
};

/**
 * Everything {@link installPromptKind} decides from. All environment reads live in the service; this
 * interface is what makes the decision testable without a browser.
 */
export interface InstallOfferFacts {
  /** `display-mode: standalone`, or `navigator.standalone` on iOS. */
  readonly standalone: boolean;
  /** iOS or iPadOS — the platform §4.7 gives the instructional sheet to. */
  readonly ios: boolean;
  /** A `beforeinstallprompt` event is held and has not been consumed by a `prompt()` call. */
  readonly hasNativePrompt: boolean;
  /** The wizard is running: §4.7 forbids prompting there, whatever else is true. */
  readonly onboarding: boolean;
  /** The stored record. */
  readonly state: InstallState;
  /** `Date.now()`, passed in so the 30-day gate is a pure function of it. */
  readonly now: number;
}

/**
 * Which sheet to open, or `null`.
 *
 * The order below is the substance and matches §4.7's table top to bottom, with the extra gates this
 * build needs: **installed** first (nothing to offer), **onboarding** (never, per §4.7's prose), then
 * the two timestamp rules, then the count, and only then the platform.
 *
 * The timestamp pair is the whole of §4.7's "When we ask" column: an offer that was never answered is
 * **not** repeated (that is the "after the 2nd confirmed capture, never on first load" promise kept),
 * while a dismissal is a **30-day** pause and nothing more.
 */
export function installPromptKind(facts: InstallOfferFacts): InstallPromptKind | null {
  if (facts.state.installed || facts.standalone) return null;
  if (facts.onboarding) return null;
  if (facts.state.offeredAt !== null && facts.state.dismissedAt === null) return null;
  if (isSuppressed(facts.state.dismissedAt, facts.now)) return null;
  if (facts.state.captures < INSTALL_TRIGGER_CAPTURES) return null;
  if (facts.hasNativePrompt) return 'NATIVE';
  if (facts.ios) return 'IOS_INSTRUCTIONS';
  return null;
}

/** The platform recorded with an event. Derived from the sheet, because that is the actionable fact. */
export function platformOf(kind: InstallPromptKind): InstallPlatform {
  return kind === 'IOS_INSTRUCTIONS' ? 'IOS' : 'CHROMIUM';
}

/**
 * Whether the current dismissal still suppresses the offer.
 *
 * An unreadable timestamp does **not** suppress: the alternative is that one corrupt write silences
 * the funnel for that device for ever, and the cost of the opposite mistake is one extra offer which
 * the person can dismiss again — which rewrites a valid timestamp.
 */
export function isSuppressed(dismissedAt: string | null, now: number): boolean {
  if (dismissedAt === null) return false;
  const at = Date.parse(dismissedAt);
  if (!Number.isFinite(at)) return false;
  return now - at < INSTALL_SUPPRESSION_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Read the stored record, never throwing.
 *
 * `localStorage` is shared with anything else on the origin and survives upgrades, so this validates
 * every field rather than trusting the JSON: a `captures` of `"two"` must not make the threshold
 * comparison silently false for ever.
 */
export function parseInstallState(raw: string | null): InstallState {
  if (raw === null || raw === '') return EMPTY_INSTALL_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_INSTALL_STATE;
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_INSTALL_STATE;
  const record = parsed as Record<string, unknown>;
  const captures = record['captures'];
  return {
    captures:
      typeof captures === 'number' && Number.isInteger(captures) && captures >= 0 ? captures : 0,
    offeredAt: isoOrNull(record['offeredAt']),
    installed: record['installed'] === true,
    dismissedAt: isoOrNull(record['dismissedAt']),
  };
}

/** A stored timestamp, or `null` when it is absent or unreadable. */
function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** The record as it is stored. Pure, so a spec can assert the round trip. */
export function serialiseInstallState(state: InstallState): string {
  return JSON.stringify({
    captures: state.captures,
    offeredAt: state.offeredAt,
    installed: state.installed,
    dismissedAt: state.dismissedAt,
  });
}

/**
 * A `beforeinstallprompt` event, which TypeScript's DOM lib does not declare.
 *
 * Declared structurally and locally rather than as a global: adding it to `WindowEventMap` would be a
 * claim about every environment this package compiles for, and only Chromium fires it.
 */
export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: readonly string[];
  readonly userChoice: Promise<{ readonly outcome: 'accepted' | 'dismissed'; readonly platform: string }>;
  prompt(): Promise<void>;
}
