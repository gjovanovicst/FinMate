import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Web unit tests.
 *
 * These cover pure client logic — money rendering, error mapping — and, since the capture screen,
 * **mounted components** too. That needs Angular's JIT compiler and a DOM, so a component spec opts
 * in with `// @vitest-environment jsdom` plus `initAngularTesting()` from `@web-test/angular-testing`;
 * the global environment stays `node`, because standing up jsdom for a pure function is wasted work.
 *
 * No `unplugin-swc` here: Angular compiles its own templates, and the code under test is plain
 * TypeScript that esbuild handles.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      // The **narrow** domain entry first, because the alias plugin matches a string key by prefix:
      // `@finmate/domain` would otherwise swallow `@finmate/domain/cyrillic` and rewrite it to the
      // barrel, which is the very import the eager path must avoid (see `tsconfig.base.json`).
      '@finmate/domain/cyrillic': fileURLToPath(
        new URL('../../packages/domain/src/cyrillic.ts', import.meta.url),
      ),
      // scope:web may depend on scope:domain (docs/05 §2) — the money formatter is shared so the
      // client and server cannot disagree about how an amount is rendered.
      '@finmate/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
      // ...and on scope:nlp (docs/05 §5.3): the capture parser and the match fold run in the browser
      // so the client and the API fold keywords, aliases and text identically.
      '@finmate/nlp': fileURLToPath(new URL('../../packages/nlp/src/index.ts', import.meta.url)),
      // Test-only helpers live outside `src` so application code cannot import them.
      '@web-test': fileURLToPath(new URL('./test', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    // CSS is not processed by default, because standing up a style pipeline for a suite that hardly
    // imports any is wasted work. `styles.tokens.spec.ts` is the exception, and it is the reason this is
    // a filter rather than `true`: it asserts the contrast of the design tokens **as written**, so it has
    // to read `styles.css` itself — and an unprocessed CSS import resolves to an empty string, which made
    // the first version of that spec pass zero tests against zero bytes.
    css: { include: [/styles\.css/] },
  },
});
