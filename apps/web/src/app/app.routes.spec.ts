// The route table imports guards, which import `@angular/router` — a partially compiled library that
// needs the JIT compiler present even though this spec mounts nothing.
import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import type { Route } from '@angular/router';

import { routes } from './app.routes';
import { LOCALES } from './core/i18n/locales';
import { en, loadCatalogue, type TranslationKey } from './core/i18n/translations';

/**
 * The document-title contract.
 *
 * A route's `title` is a translation key, and `LocalizedTitleStrategy` is the only thing that renders
 * it. Before this spec, the routes carried Serbian literals and nothing translated them, so the browser
 * tab stayed Serbian in English and no test noticed. These two assertions are the guard:
 *
 *  1. every route names a key the primary catalogue actually has — a typo would otherwise render the
 *     raw key, or a stale English fallback, in the tab;
 *  2. every `route.*` key is used by a route — an orphan is a key nobody renders, which is how a
 *     renamed route silently keeps its old title.
 */
function allRoutes(routeList: readonly Route[]): readonly Route[] {
  return routeList.flatMap((route) => [route, ...allRoutes(route.children ?? [])]);
}

const titled = allRoutes(routes).filter(
  (route) => typeof route.title === 'string',
);

describe('route titles', () => {
  it('gives every route that has a title a key the catalogue knows', () => {
    const missing = titled
      .map((route) => route.title as string)
      .filter((key) => !Object.prototype.hasOwnProperty.call(en, key));

    expect(missing).toEqual([]);
  });

  it('names a `route.*` key on every titled route', () => {
    const wrongNamespace = titled
      .map((route) => route.title as string)
      .filter((key) => !key.startsWith('route.'));

    expect(wrongNamespace).toEqual([]);
  });

  it('uses every `route.*` key in the catalogue', () => {
    const declared = (Object.keys(en) as TranslationKey[]).filter((key) =>
      key.startsWith('route.'),
    );
    const used = new Set(titled.map((route) => route.title as string));

    expect(declared.filter((key) => !used.has(key))).toEqual([]);
  });

  it('translates every title in each locale, not only in English', async () => {
    // The strategy renders the key in the active locale, so a title missing from a catalogue would fall
    // back to English mid-page. The key-parity test covers the set; this keeps the titles in view — and
    // since ADR-044 it walks the **registry**, so a newly added language is covered without editing
    // this test.
    for (const locale of LOCALES) {
      const catalogue = locale.code === 'en' ? en : await loadCatalogue(locale.code);
      expect(catalogue, `${locale.code} has no catalogue`).not.toBeNull();
      for (const route of titled) {
        const key = route.title as TranslationKey;
        expect(catalogue![key], `${locale.code} is missing ${key}`).toBeTruthy();
        expect(catalogue![key], `${locale.code} did not translate ${key}`).not.toBe(key);
      }
    }
  });
});
