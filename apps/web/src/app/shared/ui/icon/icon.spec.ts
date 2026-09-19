// @vitest-environment jsdom
import { initAngularTesting, setSignalInput } from '@web-test/angular-testing';

import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { IconComponent } from './icon.component';
import { ICONS, isIconName } from './icon-paths';

initAngularTesting();

/**
 * The icon registry and its component.
 *
 * Two things here are worth a test rather than a glance. First, the set's **uniformity**: one viewBox and
 * no fill, because a single filled or oversized icon is exactly the defect a mockup review cannot see
 * (they all look fine alone). Second, the **accessibility default**: a decorative icon must be hidden
 * from assistive technology and a labelled one must not be, or every nav item announces itself twice.
 *
 * Inputs go in through `setSignalInput`, not `ComponentRef.setInput`: Angular's JIT compiler cannot see
 * signal inputs, so the real setter silently no-ops in this runner (see `@web-test/angular-testing`).
 */
async function mount(name: string, label?: string) {
  const fixture = TestBed.createComponent(IconComponent);
  setSignalInput(fixture.componentInstance, 'name', name);
  if (label !== undefined) setSignalInput(fixture.componentInstance, 'label', label);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

describe('the icon registry', () => {
  it('draws every icon on the same grid, stroked and never filled', () => {
    for (const [name, paths] of Object.entries(ICONS)) {
      expect(paths.length, `${name} has no path`).toBeGreaterThan(0);
      for (const d of paths) {
        expect(d.length, `${name}'s path is empty`).toBeGreaterThan(4);
        // `Z`/`z` closes a shape; a fill would need the component to switch mode and the set would stop
        // being one style. Paths here are open strokes or self-closing outlines.
        expect(d, `${name} must not contain a fill-implying command`).not.toMatch(/[Ff]/);
      }
    }
  });

  it('covers every navigation destination', async () => {
    // The nav renders icons from data (`core/navigation.ts`); a rename there that misses this registry
    // would render an empty box at 320 px, which no type-check catches because the icon is a string.
    const { NAV_ITEMS } = await import('../../../core/navigation');
    for (const item of NAV_ITEMS) {
      expect(isIconName(item.icon), `${item.path} names an icon that does not exist: ${item.icon}`).toBe(
        true,
      );
    }
  });

  it('refuses an unknown name instead of drawing a box', () => {
    expect(isIconName('definitely-not-an-icon')).toBe(false);
  });

  it('has a path for every name a template writes', () => {
    // The dangerous half of "an unknown name renders nothing": a **missing** path is invisible. Two were
    // live when this test was added — chevronDown in the shell's account block and chevronRight in the
    // dashboard's View-all chips — because a name that is never in the registry produces no error, no
    // warning and no glyph. Reading the templates is the only way to catch it, so this does.
    // `src/app/**`: three levels up from `src/app/shared/ui/icon/`. The first attempt used two and
    // matched only the shared folder — 1 name out of 40, i.e. a guard that would have passed forever.
    const sources = import.meta.glob('../../../**/*.ts', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;

    const named = new Set<string>();
    for (const [file, source] of Object.entries(sources)) {
      // The registry itself and its specs are where names are *defined*, not used.
      if (file.includes('icon-paths') || file.includes('icon.spec')) continue;

      // The two ways a template supplies a name that is knowable at rest. A computed name (the theme
      // toggle's sun/moon) is covered by its own spec, because only a runtime branch can see it.
      for (const match of source.matchAll(/<fm-icon[^>]*\bname="([a-zA-Z]+)"/g)) named.add(match[1]!);
      for (const match of source.matchAll(/\[name\]="'([a-zA-Z]+)'"/g)) named.add(match[1]!);
    }

    expect(named.size).toBeGreaterThan(10);
    const missing = [...named].filter((name) => !isIconName(name)).sort();
    expect(missing, 'these names are rendered but have no path in the registry').toEqual([]);
  });
});

describe('fm-icon', () => {
  it('renders one path per entry, with no fill', async () => {
    const fixture = await mount('bell');
    const svg = fixture.nativeElement.querySelector('svg') as SVGElement;

    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.querySelectorAll('path').length).toBe(ICONS.bell.length);
  });

  it('hides a decorative icon from assistive technology', async () => {
    // The default: an icon beside its own text label is decoration, and announcing it makes the nav
    // read "Overview, chart icon".
    const fixture = await mount('overview');
    const svg = fixture.nativeElement.querySelector('svg') as SVGElement;

    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.hasAttribute('aria-label')).toBe(false);
    expect(svg.hasAttribute('role')).toBe(false);
  });

  it('turns a labelled icon into a named image', async () => {
    // Only for controls whose whole meaning is the glyph — the theme toggle, the bell.
    const fixture = await mount('moon', 'Switch to light theme');
    const svg = fixture.nativeElement.querySelector('svg') as SVGElement;

    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('Switch to light theme');
    expect(svg.hasAttribute('aria-hidden')).toBe(false);
  });

  it('renders nothing at all for an unknown name', async () => {
    const fixture = await mount('nope');
    expect(fixture.nativeElement.querySelector('svg')).toBeNull();
  });
});
