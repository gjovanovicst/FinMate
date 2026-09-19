// @vitest-environment jsdom
import { initAngularTesting } from '@web-test/angular-testing';

import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeService } from './theme.service';
import { THEME_COLOR, THEME_STORAGE_KEY, type ThemePreference } from './theme.view';

initAngularTesting();

/**
 * The theme's effectful half (ADR-039).
 *
 * The service is the **only** writer of `data-theme`, so what is asserted here is what no component spec
 * can see: that the attribute on `<html>` follows the preference, that a stored preference survives a
 * reload, that the toggle stores the theme it landed on rather than `system`, and that the browser-chrome
 * meta tag is repainted — a phone's status bar is otherwise the one part of the UI that stays the wrong
 * colour.
 *
 * Effects only run when change detection does, so the service is injected inside a throwaway component
 * and every assertion follows a `detectChanges()`.
 */

@Component({ selector: 'fm-theme-probe', template: '' })
class ProbeComponent {
  readonly theme = inject(ThemeService);
}

/** `matchMedia` as jsdom provides none: an OS preference stated per test, with a listener we can fire. */
function stubMatchMedia(prefersDark: boolean | null): {
  listeners: ((event: MediaQueryListEvent) => void)[];
} {
  const listeners: ((event: MediaQueryListEvent) => void)[] = [];

  vi.stubGlobal('matchMedia', (query: string) => {
    const isDark = query.includes('prefers-color-scheme: dark');
    const isLight = query.includes('prefers-color-scheme: light');
    return {
      // `null` is the browser saying "no preference": neither query matches.
      matches: prefersDark === null ? false : isDark ? prefersDark : isLight ? !prefersDark : false,
      media: query,
      // Typed loosely on purpose: a `Partial<MediaQueryList>` cannot satisfy the overloaded DOM
      // signature, and the shape only has to be what the service actually calls.
      addEventListener: (_type: string, handler: EventListenerOrEventListenerObject) => {
        if (isDark && typeof handler === 'function') {
          listeners.push(handler as (event: MediaQueryListEvent) => void);
        }
      },
      removeEventListener: () => undefined,
    } satisfies Partial<MediaQueryList>;
  });

  return { listeners };
}

function mount(): { service: ThemeService; detectChanges: () => void } {
  const fixture = TestBed.createComponent(ProbeComponent);
  fixture.detectChanges();
  return { service: fixture.componentInstance.theme, detectChanges: () => fixture.detectChanges() };
}

const attribute = (): string | null => document.documentElement.getAttribute('data-theme');

describe('ThemeService', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.colorScheme = '';
    document.head.innerHTML = '<meta name="theme-color" content="#0a0e18" />';
    TestBed.resetTestingModule();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('paints the stored theme on boot and writes the attribute itself', () => {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    stubMatchMedia(true);

    const { service, detectChanges } = mount();
    detectChanges();

    expect(service.resolved()).toBe('light');
    expect(attribute()).toBe('light');
    // `color-scheme` is what makes native scrollbars and autofill follow the theme; without it a light
    // theme still paints dark ones.
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('resolves system against the OS, and repaints the browser chrome', () => {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    stubMatchMedia(false);

    const { service, detectChanges } = mount();
    detectChanges();

    expect(service.resolved()).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      THEME_COLOR.light,
    );
  });

  it('repaints when the OS flips while the preference is system', () => {
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    const { listeners } = stubMatchMedia(false);

    const { service, detectChanges } = mount();
    detectChanges();
    expect(service.resolved()).toBe('light');

    // Sunset, or the person switching their laptop to dark.
    for (const listener of listeners) listener({ matches: true } as MediaQueryListEvent);
    detectChanges();

    expect(service.resolved()).toBe('dark');
    expect(attribute()).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
      THEME_COLOR.dark,
    );
  });

  it('stores the theme the toggle landed on, not system', () => {
    // A person who taps a sun icon is asking for light. Staying on `system` would flip them back at
    // sunset and make the button look broken.
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'system');
    stubMatchMedia(true);

    const { service, detectChanges } = mount();
    detectChanges();
    expect(service.resolved()).toBe('dark');

    service.toggle();
    detectChanges();

    expect(service.resolved()).toBe('light');
    expect(service.preference()).toBe('light');
    expect(globalThis.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('remembers an explicit choice across a reload', () => {
    stubMatchMedia(true);
    globalThis.localStorage.setItem(THEME_STORAGE_KEY, 'light');

    const first = mount();
    first.detectChanges();
    first.service.set('light');
    TestBed.resetTestingModule();

    const second = mount();
    second.detectChanges();
    expect(second.service.preference()).toBe('light');
    expect(second.service.resolved()).toBe('light');
  });

  it('offers an explicit three-way choice, and follows the OS again when asked to', () => {
    stubMatchMedia(false);
    const { service, detectChanges } = mount();
    detectChanges();

    for (const preference of ['light', 'dark', 'system'] satisfies ThemePreference[]) {
      service.set(preference);
      detectChanges();
      expect(service.preference()).toBe(preference);
    }

    // Back on `system`, the OS answer is what paints — and it was never stale, because the listener
    // stays attached while an explicit choice is in force.
    expect(service.resolved()).toBe('light');
  });

  it('does not throw when storage is blocked', () => {
    // Private mode and locked-down profiles throw on access rather than returning null; the theme must
    // still apply for the visit.
    stubMatchMedia(true);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });

    const { service, detectChanges } = mount();
    detectChanges();
    expect(() => {
      service.toggle();
      detectChanges();
    }).not.toThrow();
    expect(attribute()).toBe('light');

    getItem.mockRestore();
    setItem.mockRestore();
  });
});
