import { describe, expect, it } from 'vitest';

import { BADGE_MAX, NAV_ITEMS, OVERFLOW_ITEMS, PRIMARY_ITEMS, badgeAccessibleName, badgeText } from './navigation';

/**
 * The shell's information architecture and its one badge.
 *
 * This is a test about **docs/02 §2.2**, not about the component: *"Five destinations only — Danas ·
 * Transakcije · ➕ Unos · Provera · Više."* Four primary links plus the overflow control is five
 * slots, and a fifth link is what pushed the compact bottom bar into horizontal scroll at 320 px.
 * A screen silently gaining or losing its primary slot is a navigation change, so it fails here.
 */

describe('navigation destinations', () => {
  it('keeps the bottom bar to docs/02 §2.2s four primary links plus More', () => {
    expect(PRIMARY_ITEMS.map((item) => item.path)).toEqual([
      '/',
      '/transactions',
      '/capture',
      '/review',
    ]);
  });

  it('badges exactly one slot, and it is the review queue', () => {
    const badged = NAV_ITEMS.filter((item) => item.badged === true);
    expect(badged).toHaveLength(1);
    expect(badged[0]?.path).toBe('/review');
  });

  it('moves Budgets and Accounts behind More', () => {
    // docs/02 §2.1 files both under `Više` (Plan, Nalog). They were primary before the queue landed;
    // this asserts the move rather than leaving it to a future edit to undo.
    const overflow = OVERFLOW_ITEMS.map((item) => item.path);
    expect(overflow).toContain('/budgets');
    expect(overflow).toContain('/accounts');
    expect(overflow).toEqual([
      '/budgets',
      // docs/02 §2.2's Uvid group sits between Plan and the library; Analitika (3.3.1) is not built,
      // so the assistant is its only member today.
      '/assistant',
      '/accounts',
      '/categories',
      '/merchants',
      '/counterparties',
      '/tags',
      '/rules',
    ]);

    // The notification centre is deliberately **not** here: docs/02 §2.2 draws it as the header bell,
    // and listing it as well put two "Obaveštenja" entries in the sidebar. The shell spec asserts the
    // single link.
  });

  it('splits the full list without dropping anything', () => {
    expect(PRIMARY_ITEMS.length + OVERFLOW_ITEMS.length).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((item) => item.path)).size).toBe(NAV_ITEMS.length);
  });
});

describe('badgeText', () => {
  it('is empty at zero, so nothing is drawn', () => {
    // A zero badge drawn as a zero is the "to-do list becomes a metric" failure docs/02 §2.3 warns
    // about, and the caller renders on emptiness rather than on a boolean.
    expect(badgeText(0)).toBe('');
    expect(badgeText(-1)).toBe('');
  });

  it('is a literal count up to the cap', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(BADGE_MAX)).toBe('9');
  });

  it('caps at 9+, never 99+', () => {
    expect(badgeText(BADGE_MAX + 1)).toBe('9+');
    expect(badgeText(250)).toBe('9+');
  });
});

describe('badgeAccessibleName', () => {
  it('speaks the count rather than only drawing it', () => {
    // The caller interpolates; this function only picks. A `{count}` placeholder must never reach the
    // DOM, which is why the wording arrives already filled in.
    expect(badgeAccessibleName(3, 'Review, 1 item waiting', 'Review, 3 items waiting')).toBe(
      'Review, 3 items waiting',
    );
  });

  it('has nothing to announce at zero', () => {
    // `null` leaves the link's own text as its accessible name, which is what a hidden badge means.
    expect(badgeAccessibleName(0, 'one', 'many')).toBeNull();
  });

  it('picks the singular wording at one', () => {
    // Two wordings rather than one because the catalogue has no plural machinery (ADR-019): Serbian
    // agrees the verb with the number.
    expect(badgeAccessibleName(1, 'Provera, 1 stavka čeka', 'Provera, 1 stavke čekaju')).toBe(
      'Provera, 1 stavka čeka',
    );
  });
});
