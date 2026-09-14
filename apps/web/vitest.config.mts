import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Web unit tests.
 *
 * These cover pure client logic — money rendering, error mapping — rather than components. Angular
 * DOM tests need a TestBed harness; that lands with the first component that has real behaviour
 * worth asserting (Phase 1). Testing a thin template wrapper would add ceremony without coverage.
 *
 * No `unplugin-swc` here: Angular compiles its own templates, and the code under test in Phase 0 is
 * plain TypeScript that esbuild handles.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      // scope:web may depend on scope:domain (docs/05 §2) — the money formatter is shared so the
      // client and server cannot disagree about how an amount is rendered.
      '@finmate/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
  },
});
