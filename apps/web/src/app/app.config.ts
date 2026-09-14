import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  type ApplicationConfig,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';

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
  ],
};
