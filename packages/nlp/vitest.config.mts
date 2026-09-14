import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest resolves workspace packages through aliases, not tsconfig paths, so `@finmate/domain` is
 * mapped explicitly here. This is the only dependency `@finmate/nlp` is allowed to have (docs/05 §2).
 */
export default defineConfig({
  resolve: {
    alias: {
      '@finmate/domain': fileURLToPath(new URL('../domain/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
  },
});
