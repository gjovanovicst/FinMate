// @vitest-environment jsdom
// FIRST import, deliberately: it loads the JIT compiler before any Angular import (docs/15 §9).
import { initAngularTesting } from '@web-test/angular-testing';

import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { TitleStrategy, type RouterStateSnapshot } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';

import { I18nService } from './i18n.service';
import { LOCALE_STORAGE_KEY } from './locales';
import { LocalizedTitleStrategy } from './title.strategy';

initAngularTesting();

/**
 * A stand-in for the activated-route tree, carrying one route `title`.
 *
 * `TitleStrategy.buildTitle` reads the title out of `snapshot.data` under a **module-private symbol**
 * (`RouteTitleKey`), which the router writes during navigation. The symbol is deliberately not exported,
 * so the `data` object here answers any symbol lookup with the title — which is exactly the value the
 * real router would have put there, without reproducing the navigation that produces it.
 */
function snapshotWithTitle(title: string | undefined): RouterStateSnapshot {
  const data = new Proxy(
    {},
    {
      get: (_target, property) => (typeof property === 'symbol' ? title : undefined),
      has: () => true,
    },
  );
  return { root: { data, children: [] } } as unknown as RouterStateSnapshot;
}

function mount(): {
  readonly strategy: TitleStrategy;
  readonly title: Title;
  readonly i18n: I18nService;
} {
  // A stored choice wins over the browser's, so this pins the initial locale to English.
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: TitleStrategy, useClass: LocalizedTitleStrategy },
    ],
  });
  return {
    strategy: TestBed.inject(TitleStrategy),
    title: TestBed.inject(Title),
    i18n: TestBed.inject(I18nService),
  };
}

describe('LocalizedTitleStrategy', () => {
  // The browser tab follows the language switcher. This is the piece a visual review cannot see: the tab
  // title is not on the page, so a Serbian title survived in English mode unnoticed.
  afterEach(() => {
    localStorage.clear();
    TestBed.resetTestingModule();
  });

  it('renders a route title in the active language', () => {
    const { strategy, title } = mount();

    strategy.updateTitle(snapshotWithTitle('route.dashboard'));

    expect(title.getTitle()).toBe('Overview');
  });

  it('renames the tab when the language changes, with no navigation', () => {
    const { strategy, title, i18n } = mount();
    strategy.updateTitle(snapshotWithTitle('route.dashboard'));

    i18n.setLocale('sr-Latn');
    TestBed.tick();
    expect(title.getTitle()).toBe('Pregled');

    i18n.setLocale('sr-Cyrl');
    TestBed.tick();
    // `sr-Cyrl` is derived from `sr-Latn` at runtime (ADR-019), so this proves the whole chain.
    expect(title.getTitle()).toMatch(/[\u0400-\u04FF]/);
  });

  it('falls back to the product name for a route with no title', () => {
    const { strategy, title } = mount();

    strategy.updateTitle(snapshotWithTitle(undefined));

    expect(title.getTitle()).toBe('FinMate');
  });
});
