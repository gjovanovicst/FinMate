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
    // `test/**` matters: docs/10 §1 puts the golden-dataset harness at `packages/nlp/test/golden/`,
    // and with only `src/**` here nothing would ever collect it — a suite that passes by not running
    // is worse than one that fails.
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    passWithNoTests: true,
  },
});
