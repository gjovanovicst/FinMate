import { describe, expect, it } from 'vitest';

import { DRAG_DISMISS_PX, dragOffset, dragShouldDismiss } from './sheet-drag';

/**
 * The drag decision — task 4.3.1b, docs/07 §4.2.
 *
 * The pointer wiring is verified live (Playwright), because jsdom has no layout and no pointer capture.
 * What is asserted here is the part that is silently wrong when it is wrong: when a release dismisses.
 */
describe('sheet-drag', () => {
  it('follows the finger downwards only', () => {
    expect(dragOffset(100, 160)).toBe(60);
    // Upward: a sheet has nowhere to go, so it does not move rather than moving off the top.
    expect(dragOffset(100, 40)).toBe(0);
    expect(dragOffset(100, 100)).toBe(0);
    // Fractional pointer coordinates must not leak into a transform.
    expect(dragOffset(10.4, 40.9)).toBe(31);
  });

  it('dismisses at the threshold and not a pixel before', () => {
    expect(dragShouldDismiss(DRAG_DISMISS_PX - 1)).toBe(false);
    expect(dragShouldDismiss(DRAG_DISMISS_PX)).toBe(true);
    expect(dragShouldDismiss(DRAG_DISMISS_PX * 3)).toBe(true);
  });

  it('never dismisses on a tap', () => {
    // A tap on the header is the most common thing that happens to it, and it must be inert.
    expect(dragShouldDismiss(dragOffset(100, 100))).toBe(false);
    expect(dragShouldDismiss(dragOffset(100, 100.4))).toBe(false);
  });

  it('keeps the threshold inside the shortest viewport we support', () => {
    // docs/02 §9: 320 px wide is the floor, and the shortest phone viewport is ~568 px tall. A threshold
    // at or above a third of that would make the gesture unreachable for a thumb resting at the bottom.
    expect(DRAG_DISMISS_PX).toBeLessThan(568 / 3);
  });
});
