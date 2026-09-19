/**
 * The icon set, as path data.
 *
 * ## Why hand-drawn paths instead of a font or a package
 *
 * The app shipped **emoji** for every icon (`📊 🧾 ➕ 🔎 …`, in `core/navigation.ts`). Emoji are the one
 * glyph set the platform renders in colour, at its own size, in its own style, and differently on every
 * OS — so the nav's active state, the alert rows and the KPI tiles could never share a stroke weight,
 * and the same screen looked like a different product on a Mac and on Windows. They also cannot inherit
 * `currentColor`, which is what makes an icon follow the theme.
 *
 * A package would fix that at the cost of a dependency, and ADR-004 requires an ADR first. Everything
 * here is on one 24×24 grid with one stroke weight and one set of caps, which is all the mockup's icons
 * have in common — so ~40 paths is the whole cost, and the icons stay three kilobytes rather than thirty.
 *
 * ## Rules for adding one
 *
 * - **24×24 viewBox, stroke only** — never fill, because a filled shape cannot be recoloured by weight
 *   and the set would stop being uniform.
 * - **Integer-ish coordinates on the grid**, radius 2 corners, round caps and joins (`fm-icon` sets
 *   these once). An icon drawn at half-pixel offsets looks blurry at 16 px next to the others.
 * - **Never encode meaning in colour.** A role colour comes from the caller's CSS, so the same icon works
 *   in both themes and inside the gradient hero card.
 *
 * @module apps/web/src/app/shared/ui/icon
 */

/** One icon: the `d` of every path it is drawn from, in paint order. */
export type IconPaths = readonly string[];

/**
 * The registry, keyed by the name a screen writes in its template.
 *
 * Grouped by where they are used, because the groups are what reviewers check against the mockup.
 */
export const ICONS = {
  // ---- navigation (one per destination in core/navigation.ts) ----
  overview: ['M3.5 10.5 12 3.8l8.5 6.7M5.8 9.6V19a1 1 0 0 0 1 1h3.4v-4.6h3.6V20h3.4a1 1 0 0 0 1-1V9.6'],
  transactions: ['M5.5 3.8h13V20l-2.3-1.4L14 20l-2-1.4L10 20l-2.2-1.4L5.5 20z', 'M9 8.5h6M9 12h6'],
  capture: ['M12 5.5v13M5.5 12h13'],
  review: ['M10.8 4.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6z', 'm15.8 15.8 4.4 4.4'],
  budgets: ['M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2z', 'M12 7.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4z'],
  recurring: [
    'M4.2 11.4V9.2a2.6 2.6 0 0 1 2.6-2.6h11.4l-2.6-2.6',
    'M19.8 12.6v2.2a2.6 2.6 0 0 1-2.6 2.6H5.8l2.6 2.6',
  ],
  analytics: ['M3.6 20.4h16.8', 'M6.8 20.4v-7.6M12 20.4V5.6M17.2 20.4v-5.2'],
  assistant: [
    'M4.2 6.4A2.6 2.6 0 0 1 6.8 3.8h10.4a2.6 2.6 0 0 1 2.6 2.6v7.2a2.6 2.6 0 0 1-2.6 2.6H9.4L4.2 20z',
  ],
  accounts: [
    'M3.2 9.6 12 4.2l8.8 5.4',
    'M5.8 10.4v7.8M10 10.4v7.8M14 10.4v7.8M18.2 10.4v7.8',
    'M3.6 20.4h16.8',
  ],
  categories: [
    'M3.4 6.8a2 2 0 0 1 2-2h3.4l1.8 2.4h8a2 2 0 0 1 2 2v8.4a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2z',
  ],
  merchants: [
    'M4 9.8V18a1.6 1.6 0 0 0 1.6 1.6h12.8A1.6 1.6 0 0 0 20 18V9.8',
    'M3.4 9.8 5.6 4.2h12.8l2.2 5.6',
    'M3.4 9.8a2.7 2.7 0 0 0 5.4.6 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.4-.6',
  ],
  people: ['M12 4.2a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z', 'M5.2 20.2c0-3.3 3-5.4 6.8-5.4s6.8 2.1 6.8 5.4'],
  tags: [
    'M11.2 3.4H5.6a2.2 2.2 0 0 0-2.2 2.2v5.6l9.4 9.4a2.2 2.2 0 0 0 3.1 0l5.6-5.6a2.2 2.2 0 0 0 0-3.1z',
    'M7.6 7.6h.01',
  ],
  rules: ['M4.2 7.8h8M16.2 7.8h3.6M4.2 16.2h3.6M11.8 16.2h8', 'M14.2 5.4v4.8M9.8 13.8v4.8'],
  receipts: [
    'M4.2 8.8a2.2 2.2 0 0 1 2.2-2.2h1.8l1.6-2.2h4.4l1.6 2.2h1.8a2.2 2.2 0 0 1 2.2 2.2v8.6a2.2 2.2 0 0 1-2.2 2.2H6.4a2.2 2.2 0 0 1-2.2-2.2z',
    'M12 9.4a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z',
  ],
  settings: [
    'M12 8.6a3.4 3.4 0 1 0 0 6.8 3.4 3.4 0 0 0 0-6.8z',
    'M19.5 14.6a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.6v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.6 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z',
  ],

  // ---- shell chrome ----
  // (a `lock` for the app-lock section lives with the other chrome icons below)
  search: ['M10.8 4.2a6.8 6.8 0 1 0 0 13.6 6.8 6.8 0 0 0 0-13.6z', 'm15.8 15.8 4.4 4.4'],
  calendar: [
    'M4.2 7.4a2 2 0 0 1 2-2h11.6a2 2 0 0 1 2 2v11.2a2 2 0 0 1-2 2H6.2a2 2 0 0 1-2-2z',
    'M4.2 10.4h16M8.6 3.4v3.2M15.4 3.4v3.2',
  ],
  globe: [
    'M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8z',
    'M3.8 12h16.4M12 3.6a12.6 12.6 0 0 1 0 16.8 12.6 12.6 0 0 1 0-16.8',
  ],
  logout: ['M15.4 4.2h2.4a2 2 0 0 1 2 2v11.6a2 2 0 0 1-2 2h-2.4', 'M10 8.4 6.4 12l3.6 3.6', 'M6.4 12h9.4'],
  bell: ['M18 9.4a6 6 0 1 0-12 0c0 4.6-2 6-2 6h16s-2-1.4-2-6z', 'M10.2 18.6a2 2 0 0 0 3.6 0'],
  sun: [
    'M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6z',
    'M12 2.6v2.2M12 19.2v2.2M4.4 12H2.2M21.8 12h-2.2M6.6 6.6 5 5M19 19l-1.6-1.6M17.4 6.6 19 5M5 19l1.6-1.6',
  ],
  moon: ['M20 14.6A8.6 8.6 0 0 1 9.4 4a8.6 8.6 0 1 0 10.6 10.6z'],
  chevronLeft: ['m14.2 6.4-5.6 5.6 5.6 5.6'],
  chevronRight: ['m9.8 6.4 5.6 5.6-5.6 5.6'],
  chevronDown: ['m6.4 9.8 5.6 5.6 5.6-5.6'],
  close: ['M6.4 6.4l11.2 11.2M17.6 6.4 6.4 17.6'],
  more: ['M6 12h.01M12 12h.01M18 12h.01'],
  lock: [
    'M6.4 10.4h11.2a1.6 1.6 0 0 1 1.6 1.6v6.4a1.6 1.6 0 0 1-1.6 1.6H6.4a1.6 1.6 0 0 1-1.6-1.6v-6.4a1.6 1.6 0 0 1 1.6-1.6z',
    'M8.4 10.4V7.8a3.6 3.6 0 0 1 7.2 0v2.6',
  ],
  sparkles: [
    'M11 3.6l1.7 4.5 4.5 1.7-4.5 1.7L11 16l-1.7-4.5L4.8 9.8l4.5-1.7z',
    'M18.4 14.8l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z',
  ],
  send: ['m4.4 11.8 15.2-7.6-5.6 15.2-2.4-6.2z'],

  // ---- feedback and status (the alert rail, the KPI tiles) ----
  alert: [
    'M10.3 4.4 3 17a2 2 0 0 0 1.7 3h14.6a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z',
    'M12 9.4v4M12 16.8h.01',
  ],
  info: ['M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8z', 'M12 11.2v5M12 8.2h.01'],
  check: ['M12 3.6a8.4 8.4 0 1 0 0 16.8 8.4 8.4 0 0 0 0-16.8z', 'm8.4 12.4 2.6 2.6 4.6-5.2'],
  trending: ['m3.6 16.4 4.8-4.8 3.2 3.2 6-6', 'M17.6 8.8h3.2v3.2'],
  arrowUp: ['M12 19.4V4.6M6.4 10.2 12 4.6l5.6 5.6'],
  arrowDown: ['M12 4.6v14.8M6.4 13.8 12 19.4l5.6-5.6'],

  // ---- dashboard panels ----
  chartPie: ['M12 3.6a8.4 8.4 0 1 0 8.4 8.4H12z', 'M14.4 3.9v6.9h6.3a8.4 8.4 0 0 0-6.3-6.9z'],
  chartBars: ['M3.6 20.4h16.8', 'M6.8 20.4v-7.6M12 20.4V5.6M17.2 20.4v-5.2'],
  piggy: [
    'M4.4 13.6a5.6 5.6 0 0 1 5.6-5.6h4.6l2-2v2.6a5.6 5.6 0 0 1 2.6 4.6c0 2.6-1.7 4.6-4 5.2v1.4h-3v-1h-3.4v1h-3v-1.6a5.5 5.5 0 0 1-1.4-4.6z',
    'M9.6 12.6h.01',
  ],
} as const satisfies Record<string, IconPaths>;

/** Every icon name, so a template's `name` can be typed rather than free text. */
export type IconName = keyof typeof ICONS;

/**
 * Whether a string is a known icon.
 *
 * Navigation stores its icon as data (`core/navigation.ts`), so the value arrives as a `string` and the
 * component must refuse an unknown one rather than render an empty box.
 */
export function isIconName(value: string): value is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, value);
}
