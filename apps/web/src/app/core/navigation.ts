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

import type { IconName } from '../shared/ui/icon/icon-paths';
import type { TranslationKey } from './i18n/translations';

export interface NavItem {
  readonly path: string;
  /** A translation key, not a label: the nav re-renders when the language changes. */
  readonly labelKey: TranslationKey;
  /**
   * A name from the icon registry, not a glyph.
   *
   * This was an emoji (`📊`, `🧾`, …) until ADR-039. An emoji is drawn in colour by the platform, at the
   * platform's own size and style, so the sidebar could not tint it for the active state, its weight did
   * not match the rest of the icon set, and it looked like a different product on every OS. Typing it as
   * {@link IconName} is what makes a rename fail the build instead of rendering an empty box.
   */
  readonly icon: IconName;
  /**
   * Whether the item sits in the compact bottom bar. Non-primary items live behind **More** on
   * compact screens and are listed in full in the sidebar, so the sidebar is never a reduced view.
   */
  readonly primary: boolean;
  /** The only badged slot (docs/02 §2.2). */
  readonly badged?: boolean;
  /**
   * Whether the active highlight must match the **whole** URL rather than its beginning.
   *
   * `routerLinkActive` defaults to a prefix match, which is what makes `/transactions` stay lit on
   * `/transactions/:id`. It is wrong for the root for the same reason it is right everywhere else:
   * `/` is a prefix of *every* URL, so the dashboard entry — **Overview** — was highlighted on all
   * 16 destinations and carried `aria-current="page"` on each of them. Only that one entry sets this.
   */
  readonly exact?: boolean;
}

/**
 * The full destination list, in the order docs/02 §2 reads: today, the ledger, entry, review, then
 * the plan, the account and the library. The compact bar renders the `primary` head of this list and
 * the sidebar renders all of it — one array, so the two layouts can never disagree about where a
 * screen lives.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  // The root is the one destination whose path is a prefix of the others, so it is the one that
  // asks for an exact match (see `NavItem.exact`).
  { path: '/', labelKey: 'nav.dashboard', icon: 'overview', primary: true, exact: true },
  { path: '/transactions', labelKey: 'nav.transactions', icon: 'transactions', primary: true },
  { path: '/capture', labelKey: 'nav.capture', icon: 'capture', primary: true },
  { path: '/review', labelKey: 'nav.review', icon: 'review', primary: true, badged: true },
  { path: '/budgets', labelKey: 'nav.budgets', icon: 'budgets', primary: false },
  // docs/02 §2.1 files goals, budgets and recurring rules under `Više › Plan`.
  { path: '/goals', labelKey: 'nav.goals', icon: 'piggy', primary: false },
  { path: '/recurring', labelKey: 'nav.recurring', icon: 'recurring', primary: false },
  // docs/02 §2.2's **Uvid** group (Analitika, Asistent), right after Plan and before the library.
  { path: '/analytics', labelKey: 'nav.analytics', icon: 'analytics', primary: false },
  { path: '/assistant', labelKey: 'nav.assistant', icon: 'assistant', primary: false },
  { path: '/accounts', labelKey: 'nav.accounts', icon: 'accounts', primary: false },
  { path: '/categories', labelKey: 'nav.categories', icon: 'categories', primary: false },
  { path: '/merchants', labelKey: 'nav.merchants', icon: 'merchants', primary: false },
  { path: '/counterparties', labelKey: 'nav.counterparties', icon: 'people', primary: false },
  { path: '/tags', labelKey: 'nav.tags', icon: 'tags', primary: false },
  { path: '/rules', labelKey: 'nav.rules', icon: 'rules', primary: false },
  // docs/02 §2.2's **Biblioteka** group ends with Prijemi (Kategorije, Prodavci, Osobe, Pravila,
  // Prijemi), so the receipt library sits last in the list rather than beside the ledger it feeds.
  { path: '/receipts', labelKey: 'nav.receipts', icon: 'receipts', primary: false },
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
