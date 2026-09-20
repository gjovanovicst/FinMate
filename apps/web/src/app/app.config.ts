import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  type ApplicationConfig,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling, TitleStrategy } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';
import { AppLockService } from './core/app-lock/app-lock.service';
import { authInterceptor } from './core/auth/auth.interceptor';
import { credentialsInterceptor } from './core/auth/credentials.interceptor';
import { I18nService } from './core/i18n/i18n.service';
import { LocalizedTitleStrategy } from './core/i18n/title.strategy';

/**
 * Application providers.
 *
 * **Zoneless** (Angular 20+ stable): change detection is driven by signals rather than by patching
 * every async API. That is a deliberate fit for this app, where the dashboard updates when a
 * transaction is added — a signal write, not an arbitrary timer — and it removes `zone.js` from
 * the bundle entirely.
 *
 * **The service worker is registered in production builds only** (ADR-024): in development it would
 * serve a stale shell and fight the dev server's module graph, so `nx run web:serve` never has one and
 * the worker can only be exercised against a built `dist`. The cache it owns holds the app shell and
 * nothing else — `apps/web/ngsw-config.json` declares no `dataGroups`, so no API response can enter the
 * HTTP cache; a household's data lives in the encrypted IndexedDB snapshot instead (docs/08 §3.9).
 */
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(
      routes,
      // Route params bound straight to component inputs, so a page reads `id` as a signal input
      // instead of subscribing to the param map.
      withComponentInputBinding(),
      // Restore scroll on navigation, and anchor to the top on a fresh route.
      withInMemoryScrolling({ scrollPositionRestoration: 'top', anchorScrolling: 'enabled' }),
    ),
    // Route `title`s are `route.*` translation keys; this is what renders them in the reader's language
    // and what re-renders the tab when the language switcher changes locale (ADR-019).
    { provide: TitleStrategy, useClass: LocalizedTitleStrategy },
    provideHttpClient(
      withFetch(),
      // Order matters: credentials first (so cookies ride along), then bearer-token attachment.
      withInterceptors([credentialsInterceptor, authInterceptor]),
    ),
    // The active locale's catalogue is a **lazy chunk** (ADR-044), and it is awaited here so the first
    // render is already in the reader's language. Without this the shell would paint English and then
    // swap, which for a German or Serbian reader is a visible flicker on every cold load.
    provideAppInitializer(() => inject(I18nService).init()),
    // The app lock is read **before anything renders**: it decides whether this install persists
    // anything at all (ADR-025 decision 3), and a store built before that answer would silently be the
    // in-memory one. One IndexedDB read, awaited once per page load.
    provideAppInitializer(() => inject(AppLockService).refresh()),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      // The default: register once the app settles, but no later than 30 s, so a slow screen cannot
      // postpone the shell cache indefinitely.
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
