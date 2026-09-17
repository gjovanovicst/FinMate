/**
 * Building the evaluation dataset from the two documents that describe it.
 *
 * **Pure**, apart from {@link loadGoldenFixtures} which only reads files. Nothing here imports the
 * classifier: a dataset built by the thing it grades measures nothing.
 *
 * @module apps/api/src/evals
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { AssistantIntent } from '../modules/assistant/assistant-intents';
import type { PlannerContext } from '../modules/assistant/query-planner';
import type { EvalCase, EvalFragmentExpectation, GoldenSliceName, EvalSlice } from './types';

/**
 * docs/04 §7's verify floor: a should-ask fragment must stay under it, so the row is either
 * uncategorised or flagged for the user rather than applied silently.
 */
export const SHOULD_ASK_MAX_CONFIDENCE = 0.6;

/** Where the v1 golden dataset lives. Read as data — the parsing expectations stay its owner's. */
export const GOLDEN_FIXTURE_DIR = 'packages/nlp/test/golden/fixtures';

const GOLDEN_FILES: readonly { readonly slice: GoldenSliceName; readonly file: string }[] = [
  { slice: 'AMOUNT_FORMAT', file: 'amount-format.json' },
  { slice: 'MERCHANT', file: 'merchant.json' },
  { slice: 'BULK', file: 'bulk.json' },
];

/** The parsing expectations of one v1 case, narrowed to the fields this harness grades. */
export interface GoldenExpectation {
  readonly amountMinor?: string | null;
  readonly currency?: string | null;
  readonly kind?: 'EXPENSE' | 'INCOME' | 'UNKNOWN';
  readonly occurredOn?: string | null;
  readonly description?: string;
}

export interface GoldenCase {
  readonly id: string;
  readonly slice: GoldenSliceName;
  readonly input: string;
  readonly today: string;
  readonly ledgerCurrency: string;
  readonly expected: GoldenExpectation | readonly GoldenExpectation[];
  readonly note?: string;
  readonly provenance: string;
  readonly addedIn: string;
}

/** `apps/api/src/evals/fixtures/category-expectations.json`. */
export interface CategoryExpectations {
  /** Description → the category a human named from the text alone. */
  readonly paths: Readonly<Record<string, string>>;
  /** Description → why no category can be defended from the text alone. */
  readonly shouldAsk: Readonly<Record<string, string>>;
}

/**
 * The repository root, found rather than assumed.
 *
 * `process.cwd()` is the workspace root under `nx run api:test` and the project root under
 * `nx run api:evals`, so a relative path would resolve differently in the two places this module
 * runs. Walking up to the first `nx.json` is the same answer from both.
 */
export function findWorkspaceRoot(start: string = process.cwd()): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, 'nx.json'))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`no nx.json above ${start}: cannot locate the workspace root`);
    }
    current = parent;
  }
}

/** Read the three v1 fixture files. Throws rather than returning an empty dataset. */
export function loadGoldenFixtures(root: string = findWorkspaceRoot()): readonly GoldenCase[] {
  const cases: GoldenCase[] = [];
  for (const { file } of GOLDEN_FILES) {
    const path = join(root, GOLDEN_FIXTURE_DIR, file);
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) {
      throw new Error(`${path} is not an array of golden cases`);
    }
    cases.push(...(parsed as readonly GoldenCase[]));
  }
  return cases;
}

/** Read the hand-labelled category table. */
export function loadCategoryExpectations(
  root: string = findWorkspaceRoot(),
): CategoryExpectations {
  const path = join(root, 'apps/api/src/evals/fixtures/category-expectations.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CategoryExpectations>;
  if (typeof parsed.paths !== 'object' || parsed.paths === null) {
    throw new Error(`${path} has no \`paths\` map`);
  }
  if (typeof parsed.shouldAsk !== 'object' || parsed.shouldAsk === null) {
    throw new Error(`${path} has no \`shouldAsk\` map`);
  }
  return { paths: parsed.paths, shouldAsk: parsed.shouldAsk };
}

/** Every description the v1 dataset mentions, in the order it appears. */
export function goldenDescriptions(cases: readonly GoldenCase[]): readonly string[] {
  const seen = new Set<string>();
  for (const testCase of cases) {
    for (const expectation of asArray(testCase.expected)) {
      if (expectation.description !== undefined) seen.add(expectation.description);
    }
  }
  return [...seen];
}

/**
 * Join the two documents into the dataset the runner scores.
 *
 * **A description in neither map is an error, not a default.** The alternative — treating an unmapped
 * word as "no expectation" — would silently shrink the dataset every time somebody adds a case to the
 * v1 set, and the shrink would look like an improvement in every rate that is a fraction of cases.
 * `dataset.spec.ts` runs this over the real files, so the table cannot fall behind.
 */
export function buildDataset(
  goldenCases: readonly GoldenCase[],
  expectations: CategoryExpectations,
): readonly EvalCase[] {
  const { paths, shouldAsk } = expectations;
  return goldenCases.map((testCase) => {
    const golden = asArray(testCase.expected);
    const fragments: EvalFragmentExpectation[] = golden.map((expectation, index) => {
      const description = expectation.description;
      if (description === undefined) {
        throw new Error(`${testCase.id} fragment ${index} has no description to label`);
      }
      const path = paths[description];
      const reason = shouldAsk[description];
      if (path !== undefined && reason !== undefined) {
        throw new Error(
          `${testCase.id}: "${description}" is in both \`paths\` and \`shouldAsk\` — it must be one`,
        );
      }
      if (path === undefined && reason === undefined) {
        throw new Error(
          `${testCase.id}: "${description}" is in neither \`paths\` nor \`shouldAsk\` — ` +
            'label it in apps/api/src/evals/fixtures/category-expectations.json',
        );
      }

      return {
        description,
        categoryPath: path ?? null,
        ...(path === undefined ? { maxConfidence: SHOULD_ASK_MAX_CONFIDENCE } : {}),
        ...(expectation.amountMinor !== undefined ? { amountMinor: expectation.amountMinor } : {}),
        ...(expectation.kind !== undefined ? { kind: expectation.kind } : {}),
        ...(expectation.occurredOn !== undefined ? { occurredOn: expectation.occurredOn } : {}),
      };
    });

    // A case is a should-ask case when **any** of its fragments is: the pipeline cannot answer the
    // whole input, even if it can answer part of it. The fragments that do carry a path are still
    // scored on it, so this moves a case between slices without throwing its signal away.
    const slice: EvalSlice = fragments.some((fragment) => fragment.categoryPath === null)
      ? 'SHOULD_ASK'
      : testCase.slice;

    const reasons = golden
      .map((expectation) => expectation.description)
      .filter((description): description is string => description !== undefined)
      .map((description) => shouldAsk[description])
      .filter((reason): reason is string => reason !== undefined);

    return {
      id: testCase.id,
      slice,
      sourceSlice: testCase.slice,
      rawInput: testCase.input,
      today: testCase.today,
      ledgerCurrency: testCase.ledgerCurrency,
      expected: fragments,
      ...(reasons.length > 0
        ? { note: [...new Set(reasons)].join(' ') }
        : testCase.note !== undefined
          ? { note: testCase.note }
          : {}),
      provenance: 'hand-labelled',
      addedIn: testCase.addedIn,
    };
  });
}

function asArray(expectation: GoldenExpectation | readonly GoldenExpectation[]): readonly GoldenExpectation[] {
  return Array.isArray(expectation) ? expectation : [expectation as GoldenExpectation];
}

/**
 * The assistant battery — docs/06 §8.11, docs/10 §5.6.
 *
 * Each entry declares what the planner **must** do with a question: the intent it routes to, and
 * whether the plan is runnable (i.e. answerable). A question that refuses must also carry a `why`, and
 * this loader **throws** when one does not — a refusal is a product gap, and an unrecorded gap is the
 * thing this file exists to make impossible.
 *
 * The context is frozen in the fixture rather than read from a seeded Household, because the planner is
 * pure: a gate that depended on the demo tree would fail for reasons that have nothing to do with the
 * planner. It is deliberately small — ten Categories and five Merchants — so a failure names a
 * vocabulary the reader can hold in their head.
 */
export interface AssistantQuestion {
  readonly question: string;
  readonly intent: AssistantIntent;
  /** Default `true`. `false` declares a question the registry **cannot** answer yet. */
  readonly runnable?: boolean;
  /** Required whenever the entry declares a refusal. */
  readonly why?: string;
}

export interface AssistantBattery {
  readonly context: PlannerContext;
  readonly questions: readonly AssistantQuestion[];
}

export function loadAssistantBattery(
  root: string = findWorkspaceRoot(),
): AssistantBattery {
  const path = join(root, 'apps/api/src/evals/fixtures/assistant-questions.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AssistantBattery>;
  if (typeof parsed.context !== 'object' || parsed.context === null) {
    throw new Error(`${path} has no \`context\``);
  }
  if (!Array.isArray(parsed.questions)) {
    throw new Error(`${path} has no \`questions\` array`);
  }
  for (const entry of parsed.questions) {
    if (typeof entry.question !== 'string' || typeof entry.intent !== 'string') {
      throw new Error(`${path} has an entry without a question or an intent`);
    }
    const refuses = entry.intent === 'NO_TEMPLATE_MATCH' || entry.runnable === false;
    if (refuses && (entry.why === undefined || entry.why.length === 0)) {
      throw new Error(
        `${path}: "${entry.question}" declares a refusal with no \`why\`. Every gap the battery ` +
          `records has to say what it is — that is the point of the file.`,
      );
    }
  }
  return { context: parsed.context as PlannerContext, questions: parsed.questions };
}
