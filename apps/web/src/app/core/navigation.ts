/**
 * The shell's destinations, as data.
 *
 * docs/02 §2.2 is the specification: *"Five destinations only — Danas · Transakcije · ➕ Unos ·
 * Provera · Više — and the review slot is the only badged one."* Four primary links plus the
 * overflow control is exactly five slots; a sixth is what pushed the compact bottom bar into
 * horizontal scroll at 320 px, which is why Budgets and Accounts moved behind **More** when the
 * review queue landed (docs/02 §2.1 files both under `Više › Plan` and `Više › Nalog`).
 *
 * The list lives here rather than inside the component because the **order and the primary/overflow
 * split are the information architecture**, not styling: a screen silently losing its primary slot
 * is a navigation change, and it should fail a test rather than need a human to notice.
 *
 * @module apps/web/src/app/core
 */

import type { TranslationKey } from './i18n/translations';

export interface NavItem {
  readonly path: string;
  /** A translation key, not a label: the nav re-renders when the language changes. */
  readonly labelKey: TranslationKey;
  readonly icon: string;
  /**
   * Whether the item sits in the compact bottom bar. Non-primary items live behind **More** on
   * compact screens and are listed in full in the sidebar, so the sidebar is never a reduced view.
   */
  readonly primary: boolean;
  /** The only badged slot (docs/02 §2.2). */
  readonly badged?: boolean;
}

/**
 * The full destination list, in the order docs/02 §2 reads: today, the ledger, entry, review, then
 * the plan, the account and the library. The compact bar renders the `primary` head of this list and
 * the sidebar renders all of it — one array, so the two layouts can never disagree about where a
 * screen lives.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/', labelKey: 'nav.dashboard', icon: '📊', primary: true },
  { path: '/transactions', labelKey: 'nav.transactions', icon: '🧾', primary: true },
  { path: '/capture', labelKey: 'nav.capture', icon: '➕', primary: true },
  { path: '/review', labelKey: 'nav.review', icon: '🔎', primary: true, badged: true },
  { path: '/budgets', labelKey: 'nav.budgets', icon: '🎯', primary: false },
  // docs/02 §2.1 files goals, budgets and recurring rules under `Više › Plan`.
  { path: '/goals', labelKey: 'nav.goals', icon: '🐖', primary: false },
  { path: '/recurring', labelKey: 'nav.recurring', icon: '🔁', primary: false },
  // docs/02 §2.2's **Uvid** group (Analitika, Asistent), right after Plan and before the library.
  { path: '/analytics', labelKey: 'nav.analytics', icon: '📈', primary: false },
  { path: '/assistant', labelKey: 'nav.assistant', icon: '💬', primary: false },
  { path: '/accounts', labelKey: 'nav.accounts', icon: '🏦', primary: false },
  { path: '/categories', labelKey: 'nav.categories', icon: '🗂️', primary: false },
  { path: '/merchants', labelKey: 'nav.merchants', icon: '🏪', primary: false },
  { path: '/counterparties', labelKey: 'nav.counterparties', icon: '👤', primary: false },
  { path: '/tags', labelKey: 'nav.tags', icon: '🏷️', primary: false },
  { path: '/rules', labelKey: 'nav.rules', icon: '⚙️', primary: false },
];

export const PRIMARY_ITEMS: readonly NavItem[] = NAV_ITEMS.filter((item) => item.primary);
export const OVERFLOW_ITEMS: readonly NavItem[] = NAV_ITEMS.filter((item) => !item.primary);

/** docs/02 §2.3: the badge is "hidden at 0, `1`–`9` literal, `9+` above. Never `99+`." */
export const BADGE_MAX = 9;

/**
 * The drawn badge text: `''` at zero, the literal count up to {@link BADGE_MAX}, then `9+`.
 *
 * `''` rather than `'0'` because the caller renders on emptiness — a zero badge drawn as a zero is
 * the "to-do list becomes a metric" failure docs/02 §2.3 warns about.
 */
export function badgeText(count: number): string {
  if (count <= 0) return '';
  return count > BADGE_MAX ? `${BADGE_MAX}+` : String(count);
}

/**
 * The badge's **accessible name**, or `null` when there is nothing to say.
 *
 * docs/02 §2.3: *"Accessible name is Provera, 3 stavke čekaju — the count is spoken, not only
 * drawn."* A `<span>` glyph read out as "nine plus" would tell a screen-reader user that something
 * needs attention but not what or how much, so the count is a sentence.
 *
 * Two wordings rather than one because the catalogue has no plural machinery (ADR-019): Serbian
 * agrees the verb with the number (`1 stavka čeka` / `3 stavke čekaju`), which one template cannot
 * do. Both are passed in **already interpolated** — this function picks, it does not format, so a
 * `{count}` placeholder reaching the DOM is impossible.
 */
export function badgeAccessibleName(
  count: number,
  one: string,
  many: string,
): string | null {
  if (count <= 0) return null;
  return count === 1 ? one : many;
}
