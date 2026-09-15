/**
 * The shipped starter knowledge, as data (docs/11 §2.3: "content, not fixture").
 *
 * Two documents live here — the starter category tree and the merchant catalogue — plus the helpers
 * that walk them. Everything is plain data with no imports, so the constraints `packages/domain`
 * lives by hold: it stays pure, and both the API (which writes the rows) and the web (which previews
 * them during onboarding) read the *same* copy instead of two lists that drift.
 *
 * **Why the content is here rather than in `packages/domain/seed/`.** docs/11 §2.3 names that path;
 * this package's TypeScript project is rooted at its `src` directory (the compiler option `rootDir`
 * is `src`, and `include` covers the source tree) and the package is consumed as source, so a sibling
 * directory would fall outside the program — not typechecked, and not reachable through the
 * `@finmate/domain` specifier that both apps import. docs/11 was corrected to match, and the intent
 * it states ("versioned in git so a bad change is a reviewable PR") is served exactly the same way.
 *
 * @module @finmate/domain/seed
 */

export {
  DEFAULT_KEYWORD_WEIGHT,
  KEYWORD_DECISION_THRESHOLD,
  STARTER_CATEGORIES,
  STRONG_KEYWORD_WEIGHT,
  type StarterCategory,
} from './categories';
export { SHIPPED_MERCHANTS, type ShippedMerchant } from './merchants';

import {
  DEFAULT_KEYWORD_WEIGHT,
  STARTER_CATEGORIES,
  STRONG_KEYWORD_WEIGHT,
  type StarterCategory,
} from './categories';

/**
 * Bumped when the shipped content changes in a way a Household should be offered again.
 *
 * Onboarding records the version it applied, so a later release can tell "this Household accepted
 * v1" from "this Household has never onboarded" without guessing from row counts — which would break
 * the moment somebody deleted a category.
 */
export const SEED_VERSION = 1;

/** One `CategoryKeyword` a node asks for, already carrying the weight it must be written at. */
export interface FlatStarterKeyword {
  readonly word: string;
  readonly polarity: 'INCLUDE' | 'EXCLUDE';
  /**
   * `STRONG_KEYWORD_WEIGHT` for a decisive word, `DEFAULT_KEYWORD_WEIGHT` for a corroborating one.
   * A writer must not invent its own: the whole point is that one decisive hit clears docs/04 §5.4's
   * 2.0 threshold and one corroborating hit does not.
   */
  readonly weight: number;
}

/** One node of the flat form, with the path that identifies it inside a Household. */
export interface FlatStarterCategory {
  readonly key: string;
  readonly name: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly icon?: string;
  readonly aiDescription?: string;
  /** Every keyword the node asks for, in the order a writer should create them. */
  readonly keywords: readonly FlatStarterKeyword[];
  /** Convenience views of {@link keywords}, so a reader does not re-filter. */
  readonly strong: readonly string[];
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  /** Root first, excluding this node — the names onboarding matches an existing tree against. */
  readonly parentPath: readonly string[];
  /** 1 for a root. docs/03 I-11 caps the tree at 5. */
  readonly depth: number;
}

/**
 * The tree flattened **parents before children**, so a writer can insert in order without recursion
 * and without a second lookup for the parent it just created.
 *
 * Authors the same nesting twice would be a way for the two orders to disagree, so the nested
 * document stays the single source and this is derived from it.
 */
export function flattenStarterCategories(
  nodes: readonly StarterCategory[] = STARTER_CATEGORIES,
): readonly FlatStarterCategory[] {
  const out: FlatStarterCategory[] = [];

  const walk = (node: StarterCategory, parentPath: readonly string[], depth: number): void => {
    out.push({
      key: node.key,
      name: node.name,
      kind: node.kind,
      ...(node.icon === undefined ? {} : { icon: node.icon }),
      ...(node.aiDescription === undefined ? {} : { aiDescription: node.aiDescription }),
      keywords: keywordsOf(node),
      strong: node.strong ?? [],
      include: node.include ?? [],
      exclude: node.exclude ?? [],
      parentPath,
      depth,
    });
    const path = [...parentPath, node.name];
    for (const child of node.children ?? []) walk(child, path, depth + 1);
  };

  for (const root of nodes) walk(root, [], 1);
  return out;
}

/**
 * The keywords a node asks for, with weights attached.
 *
 * Every keyword in the document is one of three things, and the weight is the whole difference
 * between a tree that categorises and one that collects dust: a decisive word (`strong`, 2.0), a
 * corroborating one (`include`, 1.0), or a blocker (`exclude`, 1.0 — docs/04 §5.4 hard-blocks on
 * polarity rather than on score).
 */
function keywordsOf(node: StarterCategory): readonly FlatStarterKeyword[] {
  return [
    ...(node.strong ?? []).map(
      (word): FlatStarterKeyword => ({ word, polarity: 'INCLUDE', weight: STRONG_KEYWORD_WEIGHT }),
    ),
    ...(node.include ?? []).map(
      (word): FlatStarterKeyword => ({ word, polarity: 'INCLUDE', weight: DEFAULT_KEYWORD_WEIGHT }),
    ),
    ...(node.exclude ?? []).map(
      (word): FlatStarterKeyword => ({ word, polarity: 'EXCLUDE', weight: DEFAULT_KEYWORD_WEIGHT }),
    ),
  ];
}

/** Every seed key, for validating that a merchant's suggestion exists. */
export function starterCategoryKeys(
  nodes: readonly StarterCategory[] = STARTER_CATEGORIES,
): ReadonlySet<string> {
  return new Set(flattenStarterCategories(nodes).map((node) => node.key));
}

/** The category a shipped merchant suggests, as the tree node itself. */
export function starterCategoryFor(key: string): FlatStarterCategory | undefined {
  return flattenStarterCategories().find((node) => node.key === key);
}
