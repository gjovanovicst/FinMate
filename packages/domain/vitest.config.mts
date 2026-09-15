import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    passWithNoTests: true,
    /**
     * 30 s, not Vitest's 5 s default.
     *
     * This package's test style is deliberately exhaustive over ranges rather than example-based —
     * that is the whole point of 100 % branch coverage on money math, so it is not something to
     * trade away. Two of its tests are consequently multi-second: the I-1 allocation loop (5001
     * totals × 6 ratio sets) and the `instantForLocalNoon` round-trip (every day of 2026 × 5 zones).
     * Measured under `pnpm test`, where seven projects run in parallel, they have come in at
     * 4886–5881 ms against the 5000 ms default — so they failed intermittently, on the money path,
     * for reasons that had nothing to do with money.
     *
     * Set here rather than per test because the next exhaustive test someone adds would otherwise
     * reintroduce the same flake. 30 s is only reached by a test that is genuinely hung, which still
     * fails the run.
     */
    testTimeout: 30_000,
  },
});
