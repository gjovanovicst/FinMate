import { describe, expect, it } from 'vitest';

import {
  buildDataset,
  findWorkspaceRoot,
  goldenDescriptions,
  loadCategoryExpectations,
  loadGoldenFixtures,
  type GoldenCase,
} from './dataset';

/**
 * The dataset is the part of an evaluation that can quietly stop measuring. These tests are about the
 * two ways it would: a case the label table does not cover, and a description labelled twice.
 */

const root = findWorkspaceRoot();
const golden = loadGoldenFixtures(root);
const expectations = loadCategoryExpectations(root);
const dataset = buildDataset(golden, expectations);

describe('the v1 golden dataset, joined with the category labels', () => {
  it('keeps every one of the 300 v1 cases', () => {
    expect(golden).toHaveLength(300);
    expect(dataset).toHaveLength(300);
    expect(dataset.map((testCase) => testCase.id)).toEqual(golden.map((testCase) => testCase.id));
  });

  it('labels every description the v1 dataset mentions — no case can be silently dropped', () => {
    const descriptions = goldenDescriptions(golden);
    expect(descriptions.length).toBeGreaterThan(60);
    for (const description of descriptions) {
      const labelled =
        expectations.paths[description] !== undefined ||
        expectations.shouldAsk[description] !== undefined;
      expect(labelled, `"${description}" is in neither map`).toBe(true);
    }
  });

  it('never labels a description as both a path and a should-ask', () => {
    const both = Object.keys(expectations.paths).filter(
      (description) => expectations.shouldAsk[description] !== undefined,
    );
    expect(both).toEqual([]);
  });

  it('gives every should-ask fragment the verify-floor ceiling and a reason', () => {
    const shouldAskCases = dataset.filter((testCase) => testCase.slice === 'SHOULD_ASK');
    expect(shouldAskCases.length).toBeGreaterThan(0);
    for (const testCase of shouldAskCases) {
      expect(testCase.note, `${testCase.id} has no reason`).toBeTruthy();
      const unlabelled = testCase.expected.filter((fragment) => fragment.categoryPath === null);
      expect(unlabelled.length).toBeGreaterThan(0);
      for (const fragment of unlabelled) {
        expect(fragment.maxConfidence).toBe(0.6);
      }
    }
  });

  it('carries the parsing expectations across, so extraction is graded from the same run', () => {
    const withAmount = dataset.filter((testCase) =>
      testCase.expected.some((fragment) => fragment.amountMinor !== undefined),
    );
    expect(withAmount.length).toBeGreaterThan(250);
    expect(withAmount[0]?.expected[0]?.amountMinor).toMatch(/^\d+$/);
  });

  it('keeps BULK cases multi-fragment, which is what the slice exists for', () => {
    const bulk = dataset.filter((testCase) => testCase.sourceSlice === 'BULK');
    expect(bulk).toHaveLength(40);
    // The slice asserts *how many* fragments segmentation produced, so the expectations are arrays
    // with several entries — the harness reads the count from the array's length, not a field.
    expect(bulk.filter((testCase) => testCase.expected.length > 1).length).toBeGreaterThanOrEqual(39);
    expect(Math.max(...bulk.map((testCase) => testCase.expected.length))).toBe(5);
  });

  it('reports the slice each case came from, even when the label moves it to SHOULD_ASK', () => {
    const moved = dataset.filter((testCase) => testCase.slice === 'SHOULD_ASK');
    expect(moved.every((testCase) => testCase.sourceSlice !== 'SHOULD_ASK')).toBe(true);
  });
});

describe('buildDataset', () => {
  const oneCase: GoldenCase = {
    id: 'merchant-9999',
    slice: 'MERCHANT',
    input: 'Nepoznato 100',
    today: '2026-09-14',
    ledgerCurrency: 'RSD',
    expected: { description: 'Nepoznato', amountMinor: '10000', kind: 'EXPENSE' },
    provenance: 'hand-labelled',
    addedIn: '2026-09-15',
  };

  it('refuses an unlabelled description rather than shrinking the dataset', () => {
    expect(() => buildDataset([oneCase], { paths: {}, shouldAsk: {} })).toThrow(/neither/);
  });

  it('refuses a description labelled twice', () => {
    expect(() =>
      buildDataset([oneCase], {
        paths: { Nepoznato: 'Ostalo' },
        shouldAsk: { Nepoznato: 'both' },
      }),
    ).toThrow(/both/);
  });

  it('refuses a fragment with no description to label', () => {
    expect(() =>
      buildDataset([{ ...oneCase, expected: { amountMinor: '100' } }], {
        paths: { Nepoznato: 'Ostalo' },
        shouldAsk: {},
      }),
    ).toThrow(/no description/);
  });

  it('keeps the v1 slice when every fragment is labelled, and moves the case when one is not', () => {
    const labelled = buildDataset([oneCase], {
      paths: { Nepoznato: 'Ostalo' },
      shouldAsk: {},
    });
    expect(labelled[0]?.slice).toBe('MERCHANT');
    expect(labelled[0]?.expected[0]?.categoryPath).toBe('Ostalo');
    expect(labelled[0]?.expected[0]?.maxConfidence).toBeUndefined();

    const partly = buildDataset(
      [{ ...oneCase, expected: [{ description: 'Nepoznato', amountMinor: '10000' }, { description: 'kupovina' }] }],
      { paths: { Nepoznato: 'Ostalo' }, shouldAsk: { kupovina: 'no category' } },
    );
    expect(partly[0]?.slice).toBe('SHOULD_ASK');
    expect(partly[0]?.expected[0]?.categoryPath).toBe('Ostalo');
    expect(partly[0]?.expected[1]?.categoryPath).toBeNull();
    expect(partly[0]?.note).toBe('no category');
  });
});
