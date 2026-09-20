import { foldForMatching } from '@finmate/nlp';
import {
  SHIPPED_MERCHANTS,
  flattenStarterCategories,
  type FlatStarterCategory,
} from '@finmate/domain';

/**
 * The onboarding wizard's decisions, as pure functions (docs/02 §4.1, FL-01).
 *
 * Everything here is the part of F-13 that can be **wrong without looking wrong**: which step to show
 * when the user comes back, whether "Continue" is allowed to be pressed, what each comma-separated
 * phrase in "who do you pay regularly?" turns into, and how the shipped catalogue is grouped for a
 * multi-select. The component owns rendering and the network; this owns the judgement.
 *
 * ## Why the step-3 proposals come from the server
 *
 * docs/02 §4.1 step 3 turns `Dejan rođa, septička jama` into Counterparties *with a suggested
 * category*. That suggestion is a classification, and the classification rules live in docs/04. Rather
 * than re-implement them here — a second copy of the fold and the keyword weights is exactly the drift
 * `docs/15` warns about — step 3 sends the whole input to `captureParse`, which already segments on
 * commas and returns one fragment per phrase. This module pairs those fragments with display names.
 *
 * ## Mirrors, not authorities
 *
 * The wizard previews the tree it is about to create, so the counts and the order here must match
 * `seedStarterCategories`. They are derived from the *same document* (`@finmate/domain`), which is why
 * the preview cannot promise something the server would not write.
 *
 * @module apps/web/src/app/features/onboarding
 */

/** The six steps of docs/02 §4.1, in order. */
export type OnboardingStepKey =
  | 'categories'
  | 'accounts'
  | 'people'
  | 'merchants'
  | 'plan'
  | 'firstEntry';

export interface OnboardingStep {
  readonly step: number;
  readonly key: OnboardingStepKey;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  { step: 1, key: 'categories' },
  { step: 2, key: 'accounts' },
  { step: 3, key: 'people' },
  { step: 4, key: 'merchants' },
  { step: 5, key: 'plan' },
  { step: 6, key: 'firstEntry' },
];

export const FIRST_STEP = 1;
export const LAST_STEP = 6;
/** Past the last step, which is how `OnboardingService` records completion. */
export const COMPLETE_STEP = 7;

/**
 * Clamp a recorded step into 1…7.
 *
 * The server already clamps, and this clamps again because the *client* is what decides whether to
 * render a wizard or the dashboard: a `step` of `0`, `NaN` or `99` from a hand-edited settings row must
 * not render an empty screen. A step past the end reads as "finished".
 */
export function clampStep(step: number): number {
  if (!Number.isFinite(step)) return FIRST_STEP;
  return Math.min(Math.max(Math.trunc(step), FIRST_STEP), COMPLETE_STEP);
}

/** The step definition for a position, or `null` when onboarding is done. */
export function stepAt(step: number): OnboardingStep | null {
  return ONBOARDING_STEPS.find((candidate) => candidate.step === clampStep(step)) ?? null;
}

/** Move one step, clamped at both ends — never wrapping, so Back at step 1 does nothing. */
export function move(step: number, delta: -1 | 1): number {
  return clampStep(clampStep(step) + delta);
}

/**
 * Whether this Household should be shown the wizard.
 *
 * **`completedAt` is the signal, not the step.** A user who finished onboarding and then deleted every
 * category is still finished — sending them back into a wizard because their tree is empty would be a
 * trap, and it is the reason the server records a timestamp rather than inferring completion from row
 * counts. A Household that has never onboarded has neither.
 */
export function needsOnboarding(state: {
  readonly step: number;
  readonly completedAt: Date | string | null;
}): boolean {
  if (state.completedAt !== null) return false;
  return clampStep(state.step) < COMPLETE_STEP;
}

// ---------------------------------------------------------------------------------------------
// Step 1 — the starter tree preview
// ---------------------------------------------------------------------------------------------

/** One row of the preview, flattened in the order the server creates nodes (parents first). */
export interface TreePreviewRow {
  readonly key: string;
  readonly name: string;
  readonly kind: 'EXPENSE' | 'INCOME';
  readonly icon: string | null;
  readonly depth: number;
  /** The parent's seed key, or `null` for a root. Rendering indents by `depth`. */
  readonly parentKey: string | null;
  readonly decisive: number;
  readonly corroborating: number;
  readonly blocked: number;
}

/** The nested document flattened for a list, with each node's keyword counts. */
export function previewRows(
  nodes: readonly FlatStarterCategory[] = flattenStarterCategories(),
): readonly TreePreviewRow[] {
  const parentOf = new Map<string, string | null>();
  for (const node of nodes) {
    // `parentPath` names the parent; the seed keys are what the UI tracks, so resolve by path.
    const parentPath = node.parentPath.join('\u0000');
    parentOf.set(
      node.key,
      nodes.find((candidate) => [...candidate.parentPath, candidate.name].join('\u0000') === parentPath)?.key ??
        null,
    );
  }

  return nodes.map((node) => ({
    key: node.key,
    name: node.name,
    kind: node.kind,
    icon: node.icon ?? null,
    depth: node.depth,
    parentKey: parentOf.get(node.key) ?? null,
    decisive: node.strong.length,
    corroborating: node.include.length,
    blocked: node.exclude.length,
  }));
}

/** What the preview says above the tree ("40 kategorija · menjaš ih kasnije"). */
export interface TreeSummary {
  readonly categories: number;
  readonly expense: number;
  readonly income: number;
  /** Keywords that decide a category on their own. */
  readonly decisive: number;
  readonly corroborating: number;
  readonly blocked: number;
}

export function treeSummary(
  nodes: readonly FlatStarterCategory[] = flattenStarterCategories(),
): TreeSummary {
  return {
    categories: nodes.length,
    expense: nodes.filter((node) => node.kind === 'EXPENSE').length,
    income: nodes.filter((node) => node.kind === 'INCOME').length,
    decisive: nodes.reduce((total, node) => total + node.strong.length, 0),
    corroborating: nodes.reduce((total, node) => total + node.include.length, 0),
    blocked: nodes.reduce((total, node) => total + node.exclude.length, 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Step 3 — "who do you pay regularly?"
// ---------------------------------------------------------------------------------------------

/**
 * Words that describe a *relationship* rather than a person.
 *
 * docs/01 F-13's own example is `Dejan rođa` — "Dejan my cousin" — and the Counterparty the user wants
 * is `Dejan`. Keeping the suffix would create an entity named "Dejan rođa" that never matches a plain
 * `Dejan 2000` later, which is the opposite of what step 3 is for.
 *
 * The entries are **folded**, because that is what `personNameFrom` compares against. Both `roda` and
 * `rodja` appear for one word because the fold is inconsistent for `đ`/`ђ` — a known gap in
 * `packages/nlp`, where Latin `rođa` folds to `roda` while Cyrillic `рођа` folds to `rodja`. Every other
 * pair agrees (`brat`/`брат`, `sestra`/`сестра`), so this is the only doubled entry and it should
 * collapse to one when the fold is fixed. See docs/15.
 */
export const RELATION_WORDS: readonly string[] = [
  'roda',
  // Cyrillic `рођа`, which the current fold does not reduce to `roda`.
  'rodja',
  'brat',
  'sestra',
  'majka',
  'otac',
  'keva',
  'stari',
  'stara',
  'sin',
  'cerka',
  'stric',
  'ujak',
  'tetka',
  'baba',
  'deda',
  'kum',
  'komsija',
  'komsinica',
  'drug',
  'drugarica',
  'zena',
  'suprug',
  'supruga',
  'muz',
];

/**
 * The Counterparty name inside a phrase the user typed.
 *
 * Returns the phrase unchanged when stripping would empty it — a one-word phrase is already a name, and
 * blanking it would create an entity with no name at all.
 */
export function personNameFrom(phrase: string): string {
  const words = phrase.trim().split(/\s+/).filter((word) => word !== '');
  if (words.length <= 1) return phrase.trim();

  const kept = words.filter((word) => !RELATION_WORDS.includes(foldForMatching(word)));
  return kept.length === 0 ? phrase.trim() : kept.join(' ');
}

/** One proposal card in step 3, as the wireframe draws it. */
export interface PersonProposal {
  /** Position in the input, so removing a card does not renumber the others. */
  readonly index: number;
  /** What the user typed for this phrase. */
  readonly phrase: string;
  /** The Counterparty to create. */
  readonly personName: string;
  /** The category the pipeline suggested, when it settled on one. */
  readonly categoryId: string | null;
  /**
   * The alias to store on the Counterparty — the full phrase, folded. `Dejan rođa 3600` must resolve
   * later, and `Dejan` alone would not match that input (docs/04 §4 rung 3 requires every token).
   */
  readonly alias: string;
  /** `true` when the pipeline is unsure, so the card can mark it rather than assert a category. */
  readonly needsReview: boolean;
}

/** The fragment fields this needs — a structural subset of the API's `fragments`. */
export interface ProposalFragment {
  readonly description: string;
  readonly categoryId: string | null;
  readonly needsReview: boolean;
}

/**
 * Pair one server fragment per phrase with the Counterparty it should create.
 *
 * The fragment is authoritative for the *category* (it came from the real pipeline); this decides only
 * what to call the person and what alias to store. A phrase that resolved to a Counterparty already
 * carries its own description, which is what the user should see.
 */
export function personProposals(fragments: readonly ProposalFragment[]): readonly PersonProposal[] {
  return fragments.map((fragment, index) => {
    const phrase = fragment.description.trim();
    return {
      index,
      phrase,
      personName: personNameFrom(phrase),
      categoryId: fragment.categoryId,
      alias: foldForMatching(phrase),
      needsReview: fragment.needsReview,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Step 4 — "where do you shop?"
// ---------------------------------------------------------------------------------------------

/** The shipped catalogue grouped by the category path each merchant suggests. */
export interface MerchantGroup {
  readonly categoryPath: string;
  readonly merchants: readonly string[];
}

/**
 * Group the shipped merchants by suggested category, in the tree's own order.
 *
 * Grouping rather than one flat list of 62 checkboxes: the user is recalling where they shop, and
 * "Hrana › Supermarket" is the cue that makes a 62-item list scannable. Ordering follows
 * `flattenStarterCategories`, so the groups appear in the same order as the tree the user just reviewed.
 */
export function merchantGroups(
  merchants: readonly { readonly name: string; readonly categoryKey: string }[] = SHIPPED_MERCHANTS,
  nodes: readonly FlatStarterCategory[] = flattenStarterCategories(),
): readonly MerchantGroup[] {
  const pathByKey = new Map(
    nodes.map((node) => [node.key, [...node.parentPath, node.name].join(' \u203a ')]),
  );

  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const path = pathByKey.get(node.key)!;
    const names = merchants
      .filter((merchant) => merchant.categoryKey === node.key)
      .map((merchant) => merchant.name);
    if (names.length > 0) groups.set(path, names);
  }

  // Anything pointing at a key the tree does not have would be invisible, which is a seed bug rather
  // than a UI state — but dropping it silently is how it stays one.
  const orphans = merchants.filter((merchant) => !pathByKey.has(merchant.categoryKey));
  if (orphans.length > 0) {
    groups.set('?', orphans.map((merchant) => merchant.name));
  }

  return [...groups.entries()].map(([categoryPath, names]) => ({ categoryPath, merchants: names }));
}

/** Case- and accent-insensitive merchant search, for the filter field above the list. */
export function filterMerchants(
  query: string,
  merchants: readonly { readonly name: string; readonly aliases: readonly string[] }[] = SHIPPED_MERCHANTS,
): readonly string[] {
  const needle = foldForMatching(query.trim());
  if (needle === '') return merchants.map((merchant) => merchant.name);
  return merchants
    .filter(
      (merchant) =>
        foldForMatching(merchant.name).includes(needle) ||
        merchant.aliases.some((alias) => foldForMatching(alias).includes(needle)),
    )
    .map((merchant) => merchant.name);
}

/** Add or remove one Merchant from the selection, preserving the order it was chosen in. */
export function toggleSelection(selected: readonly string[], name: string): readonly string[] {
  return selected.includes(name)
    ? selected.filter((candidate) => candidate !== name)
    : [...selected, name];
}

// ---------------------------------------------------------------------------------------------
// Per-step gating
// ---------------------------------------------------------------------------------------------

/** What the wizard knows about the Household while stepping through it. */
export interface OnboardingDraft {
  /** Categories that exist now — the server's count, not the preview's. */
  readonly categoryCount: number;
  /**
   * Categories the shipped starter tree holds — the *preview's* count, not the Household's.
   *
   * Step 1's Continue is what calls `seedStarterCategories` (docs/02 §4.1's *Seeds* column), so the
   * gate has to read what pressing it would **create**. It used to read only
   * {@link categoryCount}, which is zero precisely because the seed has not run yet: the one control
   * that writes the tree was disabled until the tree existed, so a fresh Household could only Skip
   * step 1 and every later verification — the demo Household, `db:seed`, the eval harness — bypassed
   * the wizard and never saw it.
   */
  readonly starterCount: number;
  readonly accountCount: number;
  /** Step-3 proposals the user has accepted. */
  readonly acceptedPeople: number;
  readonly selectedMerchants: number;
}

/**
 * Whether "Continue" may be pressed, per step.
 *
 * **Every step is skippable** (docs/01 F-13: "skippable at every step"), so this never returns `false`
 * to block a skip — it returns `false` only where pressing Continue would *write something invalid*:
 *
 *  - step 1 with no starter tree to write: Continue calls `seedStarterCategories`, so it is disabled
 *    only when that write would have nothing to write. It is enabled for a Household that has no
 *    categories yet — which is the normal fresh state, and the whole point of the step. *Skip* stays
 *    the control for "I want an empty tree" (docs/02 §4.1).
 *  - step 2 with no accounts: a Transaction needs one (I-4), so Continue is allowed only once at least
 *    one exists — the step's own "use cash" default satisfies this.
 *  - steps 3–5 accept anything, including nothing.
 *  - step 6 needs at least one account, because it commits a real Transaction.
 */
export function canContinue(step: number, draft: OnboardingDraft): boolean {
  const key = stepAt(step)?.key;

  // Past the last step there is no Continue at all. `false` rather than a default `true`, so a
  // mis-recorded step cannot be advanced through by a stray keypress.
  if (key === undefined) return false;

  switch (key) {
    case 'categories':
      // Continue is `seedStarterCategories`; it writes whenever there is a tree to seed, whether or
      // not this Household already has categories (the mutation is idempotent by parent+name). The
      // Household's own count cannot gate it — it is zero until this very write runs.
      return draft.categoryCount > 0 || draft.starterCount > 0;
    case 'accounts':
    case 'firstEntry':
      // Step 6 commits a real Transaction, which needs an Account (I-4).
      return draft.accountCount > 0;
    // Steps 3, 4 and 5 accept anything, including nothing: docs/01 F-13 makes every step skippable,
    // and only an invalid WRITE is blocked.
    default:
      return true;
  }
}

/** Steps whose Continue writes something, as opposed to merely advancing. */
export function writesOnContinue(step: number): boolean {
  const key = stepAt(step)?.key;
  return key === 'categories' || key === 'accounts' || key === 'merchants' || key === 'plan';
}
