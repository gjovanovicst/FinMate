/**
 * The arithmetic behind dragging a sheet down to dismiss it — docs/07 §4.2, task 4.3.1b.
 *
 * Pure, and separated from the pointer events that feed it, for two reasons. A gesture recogniser is the
 * one thing a jsdom test cannot exercise (there is no layout, no `setPointerCapture`, and no real
 * `clientY`), so the *decision* is kept where it can be asserted — the component below is then thin
 * enough to be verified live instead. And the threshold is a product decision (§4.2's "draggable"), not
 * an implementation detail, so it is a named constant rather than a magic number in a listener.
 *
 * The gesture is always a **shortcut, never the only route** (docs/07 §4.1, WCAG 2.2 SC 2.5.7): the
 * sheet keeps its visible close button and its `Esc` handler, and all three go through the same guard.
 *
 * @module apps/web/src/app/shared/ui/sheet-drag
 */

/**
 * How far a sheet must be dragged before letting go dismisses it.
 *
 * A twentieth of a 1080 px-tall phone is ~54 px; 96 px is comfortably past the "I meant to scroll"
 * range and still under a third of the shortest viewport we support, so the gesture stays a
 * deliberate flick rather than an accidental one.
 */
export const DRAG_DISMISS_PX = 96;

/** How far the sheet follows the finger, in px. Upward drags do not move it — a sheet has nowhere to go. */
export function dragOffset(startY: number, currentY: number): number {
  return Math.max(0, Math.round(currentY - startY));
}

/**
 * Whether releasing at this offset should dismiss.
 *
 * Called with the offset rather than the raw coordinates so a caller cannot compare the wrong pair, and
 * so a *tap* (offset 0) is never a dismissal — a mis-tap on the header must do nothing.
 */
export function dragShouldDismiss(offset: number): boolean {
  return offset >= DRAG_DISMISS_PX;
}
