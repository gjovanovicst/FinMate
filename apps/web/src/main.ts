import { bootstrapApplication } from '@angular/platform-browser';

import { AppComponent } from './app/app.component';
import { appConfig } from './app/app.config';

/**
 * Application entry point.
 *
 * ADR-006: a single responsive SPA, PWA-first, with **no SSR**. The app sits behind
 * authentication, so there is no SEO surface for server rendering to serve — adding it would buy
 * complexity and nothing else.
 */
bootstrapApplication(AppComponent, appConfig).catch((error: unknown) => {
  // Bootstrapping failed before any error handling exists, so this is the one place a raw
  // console write is the right answer.
  console.error('Application failed to start', error);
});
