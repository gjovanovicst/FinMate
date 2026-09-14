/**
 * Golden dataset v1 — the Vitest entry point (docs/10-testing-and-quality.md §5.1, docs/09 §4
 * task 2.1.2).
 *
 * This file exists so the dataset is part of `pnpm nx run nlp:test` — and therefore part of
 * `pnpm test` in CI — rather than an opt-in script that rots. One `it` per slice: each runs **all**
 * of its cases, aggregates every difference and fails once with a full report (a dataset that stops
 * at difference #1 cannot show drift).
 *
 * The fixtures are JSON with minor units as strings, so `bigint` survives the round trip
 * (ADR-003). They are generated from hand-derived tables by `generate-fixtures.mjs`, which never
 * imports the parser — see that file's header.
 *
 * Owner: docs/04 §11.1 for the composition, docs/10 §1 for why this is a deterministic layer-1
 * suite and not the statistical evaluation of §5.
 */

import { afterAll, describe, it } from 'vitest';

import amountFormatFixture from './fixtures/amount-format.json';
import bulkFixture from './fixtures/bulk.json';
import merchantFixture from './fixtures/merchant.json';
import { printSummary, runSlice } from './harness';
import type { GoldenCase, GoldenSlice } from './types';

interface Suite {
  readonly slice: GoldenSlice;
  readonly cases: readonly GoldenCase[];
}

const SUITES: readonly Suite[] = [
  { slice: 'AMOUNT_FORMAT', cases: amountFormatFixture as unknown as readonly GoldenCase[] },
  { slice: 'MERCHANT', cases: merchantFixture as unknown as readonly GoldenCase[] },
  { slice: 'BULK', cases: bulkFixture as unknown as readonly GoldenCase[] },
];

describe('golden dataset v1 — parsing', () => {
  for (const suite of SUITES) {
    it(`parses the ${suite.slice} slice (${suite.cases.length} cases)`, () => {
      runSlice(suite.slice, suite.cases);
    });
  }

  afterAll(() => {
    printSummary();
  });
});
