/**
 * Golden-dataset harness — the deterministic parsing gate (docs/10-testing-and-quality.md §5.1,
 * docs/04-categorization-and-ai-engine.md §11.1).
 *
 * What it does: loads the JSON fixtures under `./fixtures/`, runs each case through
 * `extractFragments` with the case's **pinned** `today` and ledger currency, compares the fields the
 * case pins, aggregates **every** failure and reports them together.
 *
 * What it deliberately is not: an accuracy harness. Category accuracy, the overconfident-wrong rate
 * and should-ask recall are §11.2 gates that need a classifier, which does not exist until Sprint
 * 2.2. Until then this harness asserts **parsing** only — see `README.md`.
 *
 * Reporting discipline: a dataset that stops at the first failure cannot be used to diagnose drift,
 * and drift is the only thing it exists to detect. Every case in a slice runs; failures are then
 * printed as one report and asserted at the end.
 *
 * @module golden harness
 */

import { expect } from 'vitest';

import { extractFragments, type ExtractOptions } from '../../src/extract';

import type { GoldenCase, GoldenExpectation, GoldenSlice } from './types';

/**
 * The v1 composition from docs/04 §11.1's staged-delivery note. It is checked, not documented: if a
 * fixture file stops being collected the summary assertion fails instead of the suite going quietly
 * green over a shrunken dataset. Bump this when the remaining §11.1 slices land.
 */
export const EXPECTED_V1_CASES = 300;

/** `'amount-0042'` etc. The prefix ties a case id to its slice, so a mis-filed case is visible. */
const ID_PREFIX: Readonly<Record<GoldenSlice, string>> = Object.freeze({
  AMOUNT_FORMAT: 'amount-',
  MERCHANT: 'merchant-',
  BULK: 'bulk-',
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * docs/10 §5.2: "no household, user, account or real transaction id may appear in any fixture (it
 * greps for UUIDs and fails the PR)". Cheap here, and it keeps a real id from being pasted in later.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface FailureContext {
  readonly caseId: string;
  readonly slice: GoldenSlice;
  readonly input: string;
  readonly where: string;
}

interface Failure extends FailureContext {
  readonly field: string;
  readonly expected: string;
  readonly actual: string;
}

interface SliceRun {
  readonly slice: GoldenSlice;
  cases: number;
  failures: number;
}

const registry: SliceRun[] = [];
const seenIds = new Set<string>();

/**
 * Run one slice's cases, print its summary, and fail the test with a full report if anything
 * disagreed. Called once per slice from `golden.spec.ts`, which is what makes this part of
 * `pnpm nx run nlp:test` and therefore a CI gate rather than an opt-in script.
 */
export function runSlice(slice: GoldenSlice, cases: readonly GoldenCase[]): void {
  lintFixtures(slice, cases);

  const failures: Failure[] = [];
  for (const goldenCase of cases) {
    runCase(goldenCase, failures);
  }

  registry.push({ slice, cases: cases.length, failures: failures.length });
  console.log(`golden[${slice}] ran ${cases.length} cases, ${failures.length} failing`);

  if (failures.length > 0) {
    const report = renderReport(slice, cases.length, failures);
    console.error(`\n${report}\n`);
    expect(failures.map((failure) => failure.caseId), report).toEqual([]);
  }
}

/** Print the composition once, at the end, and refuse to pass on a shrunken dataset. */
export function printSummary(): void {
  const total = registry.reduce((sum, run) => sum + run.cases, 0);
  const lines = [
    '',
    `golden dataset v1 — ${total} cases, ${registry.reduce((sum, run) => sum + run.failures, 0)} failing`,
    ...registry.map(
      (run) => `  ${run.slice.padEnd(14)} ${String(run.cases).padStart(4)} cases`,
    ),
    '',
  ];
  console.log(lines.join('\n'));

  expect(
    total,
    `the golden dataset must hold exactly ${EXPECTED_V1_CASES} cases (docs/09 §4 task 2.1.2); ` +
      'a smaller number means a fixture file stopped being collected',
  ).toBe(EXPECTED_V1_CASES);
}

function runCase(goldenCase: GoldenCase, failures: Failure[]): void {
  const options: ExtractOptions = {
    currency: goldenCase.ledgerCurrency,
    today: goldenCase.today,
  };
  const fragments = extractFragments(goldenCase.input, options);
  const expectedList = expectationList(goldenCase.expected);

  const context: FailureContext = {
    caseId: goldenCase.id,
    slice: goldenCase.slice,
    input: goldenCase.input,
    where: 'fragments',
  };

  if (expectedList.length !== fragments.length) {
    pushFailure(failures, context, 'fragmentCount', expectedList.length, fragments.length);
  }

  const shared = Math.min(expectedList.length, fragments.length);
  for (let index = 0; index < shared; index += 1) {
    compareFragment(goldenCase, index, expectedList[index]!, fragments[index]!, failures);
  }
}

function compareFragment(
  goldenCase: GoldenCase,
  index: number,
  expected: GoldenExpectation,
  fragment: ReturnType<typeof extractFragments>[number],
  failures: Failure[],
): void {
  const context: FailureContext = {
    caseId: goldenCase.id,
    slice: goldenCase.slice,
    input: goldenCase.input,
    where: `fragment ${index}`,
  };

  if (has(expected, 'amountMinor')) {
    const actual = fragment.amountMinor === null ? null : fragment.amountMinor.toString();
    if (actual !== expected.amountMinor) {
      pushFailure(failures, context, 'amountMinor', expected.amountMinor, actual);
    }
  }
  if (has(expected, 'currency') && fragment.currency !== expected.currency) {
    pushFailure(failures, context, 'currency', expected.currency, fragment.currency);
  }
  if (has(expected, 'kind') && fragment.kind !== expected.kind) {
    pushFailure(failures, context, 'kind', expected.kind, fragment.kind);
  }
  if (has(expected, 'occurredOn') && fragment.occurredOn !== expected.occurredOn) {
    pushFailure(failures, context, 'occurredOn', expected.occurredOn, fragment.occurredOn);
  }
  if (has(expected, 'description') && fragment.description !== expected.description) {
    pushFailure(failures, context, 'description', expected.description, fragment.description);
  }
  if (has(expected, 'tokens') && !sameTokens(expected.tokens, fragment.tokens)) {
    pushFailure(failures, context, 'tokens', expected.tokens, fragment.tokens);
  }
  if (has(expected, 'candidates') && fragment.candidates.length !== expected.candidates) {
    pushFailure(failures, context, 'candidates', expected.candidates, fragment.candidates.length);
  }
  if (
    has(expected, 'needsDirectionConfirmation') &&
    fragment.needsDirectionConfirmation !== expected.needsDirectionConfirmation
  ) {
    pushFailure(
      failures,
      context,
      'needsDirectionConfirmation',
      expected.needsDirectionConfirmation,
      fragment.needsDirectionConfirmation,
    );
  }
}

/**
 * Fixture linter (docs/10 §5.2). Runs before any case, so a malformed fixture reports once instead
 * of as hundreds of confusing parse failures.
 */
function lintFixtures(slice: GoldenSlice, cases: readonly GoldenCase[]): void {
  const problems: string[] = [];
  const prefix = ID_PREFIX[slice];

  if (cases.length === 0) problems.push(`${slice}: fixture is empty`);

  for (const goldenCase of cases) {
    const label = goldenCase.id || '(missing id)';
    if (!goldenCase.id.startsWith(prefix)) {
      problems.push(`${label}: id must start with '${prefix}'`);
    }
    if (seenIds.has(goldenCase.id)) problems.push(`${label}: duplicate id`);
    seenIds.add(goldenCase.id);
    if (goldenCase.slice !== slice) {
      problems.push(`${label}: slice is '${goldenCase.slice}', file is '${slice}'`);
    }
    if (goldenCase.input.trim().length === 0) problems.push(`${label}: empty input`);
    if (!ISO_DATE.test(goldenCase.today)) {
      problems.push(`${label}: today must be a pinned ISO date, got '${goldenCase.today}'`);
    }
    if (!/^[A-Z]{3}$/.test(goldenCase.ledgerCurrency)) {
      problems.push(`${label}: ledgerCurrency must be an ISO-4217 code`);
    }
    if (!ISO_DATE.test(goldenCase.addedIn)) {
      problems.push(`${label}: addedIn must be an ISO date`);
    }
    if (goldenCase.provenance !== 'hand-labelled' && goldenCase.provenance !== 'synthetic') {
      problems.push(`${label}: provenance must be 'hand-labelled' or 'synthetic'`);
    }
    if (UUID.test(goldenCase.input) || UUID.test(goldenCase.id)) {
      problems.push(`${label}: fixture contains a UUID (docs/10 §5.2 forbids real ids)`);
    }

    const expectedList = expectationList(goldenCase.expected);
    const isBulk = slice === 'BULK';
    if (isBulk && !Array.isArray(goldenCase.expected)) {
      problems.push(`${label}: BULK cases must list one expectation per fragment`);
    }
    if (!isBulk && Array.isArray(goldenCase.expected)) {
      problems.push(`${label}: only BULK cases may list several fragments`);
    }
    if (expectedList.length === 0) problems.push(`${label}: no expectations`);
    expectedList.forEach((expectation, index) => {
      if (Object.keys(expectation).length === 0) {
        problems.push(`${label}: expectation ${index} pins no field at all`);
      }
    });
  }

  if (problems.length > 0) {
    throw new Error(`golden fixture linter failed:\n  - ${problems.join('\n  - ')}`);
  }
}

function expectationList(
  expected: GoldenCase['expected'],
): readonly GoldenExpectation[] {
  return Array.isArray(expected)
    ? (expected as readonly GoldenExpectation[])
    : [expected as GoldenExpectation];
}

function has(expectation: GoldenExpectation, key: keyof GoldenExpectation): boolean {
  return Object.prototype.hasOwnProperty.call(expectation, key);
}

function sameTokens(expected: readonly string[] | undefined, actual: readonly string[]): boolean {
  if (expected === undefined || expected.length !== actual.length) return false;
  return expected.every((token, index) => token === actual[index]);
}

function pushFailure(
  failures: Failure[],
  context: FailureContext,
  field: string,
  expected: unknown,
  actual: unknown,
): void {
  failures.push({ ...context, field, expected: show(expected), actual: show(actual) });
}

function show(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function renderReport(slice: GoldenSlice, total: number, failures: readonly Failure[]): string {
  const byCase = new Map<string, Failure[]>();
  for (const failure of failures) {
    const list = byCase.get(failure.caseId);
    if (list === undefined) byCase.set(failure.caseId, [failure]);
    else list.push(failure);
  }

  const blocks = [...byCase.entries()].map(([caseId, list]) => {
    const first = list[0]!;
    const lines = [
      `  [${caseId}] ${list.length} difference(s)`,
      `    input: ${JSON.stringify(first.input)}`,
      ...list.map(
        (failure) =>
          `    ${failure.where} · ${failure.field}: expected ${failure.expected}, actual ${failure.actual}`,
      ),
    ];
    return lines.join('\n');
  });

  return [
    `GOLDEN DATASET — ${failures.length} difference(s) across ${byCase.size} case(s) of ${total} (${slice})`,
    '',
    ...blocks,
  ].join('\n');
}
