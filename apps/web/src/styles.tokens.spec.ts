import { describe, expect, it } from 'vitest';

// The stylesheet's own bytes. A raw import rather than `node:fs` because this project is a browser
// program with no Node types (see `test/raw.d.ts`).
import CSS from './styles.css?raw';

import { THEME_COLOR } from './app/core/theme/theme.view';

/**
 * Contrast is a **regression class** in this app, not a one-off audit.
 *
 * 4.3.1d found `--color-text-subtle` at 3.31:1 across 153 element-route pairs — after the screens had
 * shipped — and 4.3.4b then found the brand colour as text at 3.85:1 on the active nav item, which
 * 4.3.1d's browser instrument had missed. Both were single token values, and both were invisible to
 * every other test in the repository: nothing fails to compile when text becomes unreadable.
 *
 * So the tokens themselves are asserted here, by reading `styles.css` and measuring the pairs the file
 * names. This is deliberately a *token* test rather than a rendered-DOM test: it runs in milliseconds,
 * it needs no browser, and it catches the exact failure mode that shipped twice.
 *
 * Thresholds are WCAG 2.2 AA: **4.5:1** for body-sized text (SC 1.4.3). Nothing in this app renders
 * large enough to qualify for the 3:1 large-text allowance, so no text pair is exempt.
 */

type Rgb = readonly [number, number, number];

/** Every `--token: value` in the first block whose selector is `selector`. */
function tokensFor(selector: string): Record<string, string> {
  // Anchored to the start of a line on purpose: the file's own header comment names both selectors, so
  // a bare `indexOf` finds the prose first and silently parses the wrong theme's block.
  const start = CSS.indexOf(`\n${selector}`);
  expect(start, `${selector} not found as a top-level rule in styles.css`).toBeGreaterThan(-1);

  const open = CSS.indexOf('{', start);
  const block = CSS.slice(open + 1, CSS.indexOf('\n}', open));

  const tokens: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const match = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/i.exec(line);
    if (match) tokens[match[1]!] = match[2]!.trim();
  }
  return tokens;
}

function fromHex(value: string): Rgb {
  const body = value.trim().replace('#', '');
  const full =
    body.length === 3
      ? body
          .split('')
          .map((c) => c + c)
          .join('')
      : body;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** A token value as drawn **over** `background`: opaque hex as-is, an `rgb(r g b / n%)` tint composited. */
function resolve(value: string, background: Rgb): Rgb {
  if (value.trim().startsWith('#')) return fromHex(value);

  const match = /rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)%\s*\)/.exec(value);
  expect(match, `expected a hex colour or an rgb(... / n%) tint, got ${value}`).not.toBeNull();
  if (match === null) throw new Error('unreachable');

  const alpha = Number(match[4]) / 100;
  return [0, 1, 2].map(
    (i) => Number(match[i + 1]) * alpha + (background[i] as number) * (1 - alpha),
  ) as unknown as Rgb;
}

function luminance(rgb: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0] as number) + 0.7152 * channel(rgb[1] as number) + 0.0722 * channel(rgb[2] as number);
}

/** WCAG 2.x contrast ratio between two resolved colours. */
function ratio(fg: Rgb, bg: Rgb): number {
  const sorted = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return ((sorted[0] as number) + 0.05) / ((sorted[1] as number) + 0.05);
}

/** A token's value, or a test failure naming the missing role. */
function token(tokens: Record<string, string>, name: string): string {
  const value = tokens[name];
  expect(value, `${name} is missing from the theme`).toBeDefined();
  return value!;
}

const THEMES = [
  { name: 'dark', tokens: tokensFor(':root {') },
  { name: 'light', tokens: tokensFor(":root[data-theme='light']") },
];

describe.each(THEMES)('$name theme tokens', ({ name, tokens }) => {
  const surfaceNames = [
    '--color-surface',
    '--color-bg',
    '--color-chrome',
    '--color-surface-raised',
  ] as const;
  const surface = (name: string): Rgb => resolve(token(tokens, name), fromHex('#000000'));

  /** The colour a token paints when it is drawn on `name`. */
  const inkOn = (role: string, name: string): Rgb => resolve(token(tokens, role), surface(name));

  it('defines every colour role the components reference', () => {
    // A role that exists in one theme and not the other is an undefined value in CSS: the declaration
    // is dropped, the property inherits or falls back to the UA default, and the result is unreadable
    // text only in the theme nobody tested.
    const required = [
      '--color-bg',
      '--color-chrome',
      '--color-surface',
      '--color-surface-raised',
      '--color-surface-sunken',
      '--color-border',
      '--color-border-strong',
      '--color-text',
      '--color-text-muted',
      '--color-text-subtle',
      '--color-primary',
      '--color-primary-hover',
      '--color-primary-soft',
      '--color-primary-text',
      '--color-primary-contrast',
      '--color-on-danger',
      '--color-danger',
      '--color-warning',
      '--color-success',
      '--color-info',
      '--gradient-hero',
      '--gradient-hero-ink',
      '--gradient-hero-ink-muted',
      '--chart-axis',
      '--chart-tooltip-bg',
      '--chart-tooltip-ink',
    ];
    for (const role of required) {
      expect(token(tokens, role), `${role} is missing`).toBeDefined();
    }
  });

  it.each(['--color-text', '--color-text-muted', '--color-text-subtle'])(
    '%s clears 4.5:1 on every surface it is used on',
    (role) => {
      for (const name of surfaceNames) {
        const measured = ratio(inkOn(role, name), surface(name));
        expect(measured, `${role} on ${name} = ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('brand text clears 4.5:1 on every surface and on the tinted active state', () => {
    for (const name of surfaceNames) {
      const measured = ratio(inkOn('--color-primary-text', name), surface(name));
      expect(measured, `--color-primary-text on ${name} = ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    }

    // 4.3.4b's failure: the active nav item is brand-coloured text on a 10–14 % brand tint. The tint
    // is composited over the surface first, because that composited colour is what the text sits on.
    for (const name of ['--color-surface', '--color-bg', '--color-chrome']) {
      const tinted = resolve(token(tokens, '--color-primary-soft'), surface(name));
      const measured = ratio(resolve(token(tokens, '--color-primary-text'), tinted), tinted);
      expect(measured, `--color-primary-text on tinted ${name} = ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it('text on a primary fill clears 4.5:1', () => {
    const fill = fromHex(token(tokens, '--color-primary'));
    const measured = ratio(resolve(token(tokens, '--color-primary-contrast'), fill), fill);
    expect(measured, `--color-primary-contrast on --color-primary = ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('a badge count on a danger fill clears 4.5:1', () => {
    // The nav and bell badges are ~10 px text on `--color-danger`; that pair was never measured.
    const fill = fromHex(token(tokens, '--color-danger'));
    const measured = ratio(resolve(token(tokens, '--color-on-danger'), fill), fill);
    expect(measured, `--color-on-danger on --color-danger = ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it.each(['--color-danger', '--color-warning', '--color-success', '--color-info'])(
    '%s is legible as text on a card and on a page',
    (role) => {
      for (const name of ['--color-surface', '--color-bg']) {
        const measured = ratio(inkOn(role, name), surface(name));
        expect(measured, `${role} on ${name} = ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it('chart ink is legible on what it is drawn on', () => {
    // Axis labels and the tooltip are real text: same 4.5:1 bar as everything else.
    const axis = ratio(inkOn('--chart-axis', '--color-surface'), surface('--color-surface'));
    expect(axis, `--chart-axis on a card = ${axis.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);

    const tooltipBg = fromHex(token(tokens, '--chart-tooltip-bg'));
    const tooltip = ratio(resolve(token(tokens, '--chart-tooltip-ink'), tooltipBg), tooltipBg);
    expect(tooltip, `tooltip ink on tooltip bg = ${tooltip.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('the hero card two inks are legible on its own gradient', () => {
    // A gradient has no single background colour, so **every** stop is measured and every one must
    // pass: the ink sits over whichever stop it lands on.
    const stops = [...token(tokens, '--gradient-hero').matchAll(/#[0-9a-f]{6}/gi)].map((m) => fromHex(m[0]));
    expect(stops.length, '--gradient-hero must declare at least two stops').toBeGreaterThanOrEqual(2);

    for (const [index, stop] of stops.entries()) {
      for (const role of ['--gradient-hero-ink', '--gradient-hero-ink-muted']) {
        const measured = ratio(resolve(token(tokens, role), stop), stop);
        expect(
          measured,
          `${role} on gradient stop ${index} = ${measured.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('agrees with the browser-chrome colour the theme service publishes', () => {
    // `<meta name="theme-color">` cannot read a custom property, so `THEME_COLOR` repeats `--color-bg`
    // for each theme. This is the assertion that keeps the copy honest: a token change that forgets the
    // meta tag shows up as a phone status bar in the wrong colour, which nothing else here would catch.
    expect(THEME_COLOR[name as 'dark' | 'light']).toBe(token(tokens, '--color-bg').toLowerCase());
  });
});
