import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  isDevMode,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  type ApplicationConfig,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth.interceptor';
import { credentialsInterceptor } from './core/auth/credentials.interceptor';

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
    provideHttpClient(
      withFetch(),
      // Order matters: credentials first (so cookies ride along), then bearer-token attachment.
      withInterceptors([credentialsInterceptor, authInterceptor]),
    ),
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      // The default: register once the app settles, but no later than 30 s, so a slow screen cannot
      // postpone the shell cache indefinitely.
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
