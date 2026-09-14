import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * API tests use **Vitest**, not Jest.
 *
 * Deviation from docs/10 §2, forced by NestJS 12: its packages (`@nestjs/common`, `@nestjs/jwt`)
 * ship **ESM only**, and Jest's CommonJS transform cannot `require()` them —
 * "Must use import to load ES Module". Making Jest work would mean ESM mode plus a
 * transformed-node_modules allowlist, which is fragile and slow.
 *
 * `unplugin-swc` is what makes NestJS viable here: it emits **decorator metadata**, so
 * `Test.createTestingModule` can resolve constructor dependencies. Plain esbuild (Vitest's default
 * transform) cannot, which is the same limitation that rules out tsx for the dev runtime (ADR-020).
 */
export default defineConfig({
  // Vitest's root defaults to the process cwd, which Nx sets to the workspace root. Pin it to
  // this project so `include` and the generated-client exclusion resolve as written.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
        keepClassNames: true,
      },
      module: { type: 'es6' },
    }),
  ],
  resolve: {
    alias: {
      '@finmate/domain': new URL('../../packages/domain/src/index.ts', import.meta.url).pathname,
      '@finmate/contracts': new URL('../../packages/contracts/src/index.ts', import.meta.url).pathname,
      '@finmate/nlp': new URL('../../packages/nlp/src/index.ts', import.meta.url).pathname,
      '@finmate/rules-engine': new URL('../../packages/rules-engine/src/index.ts', import.meta.url).pathname,
      '@finmate/ai': new URL('../../packages/ai/src/index.ts', import.meta.url).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['test/setup-env.ts'],
    // Generated Prisma client is large and not worth instrumenting.
    exclude: ['src/generated/**'],
    passWithNoTests: true,
  },
});
