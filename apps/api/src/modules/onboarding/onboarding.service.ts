import { Injectable } from '@nestjs/common';

import {
  SEED_VERSION,
  SHIPPED_MERCHANTS,
  flattenStarterCategories,
  uuidv7,
  type FlatStarterCategory,
} from '@finmate/domain';

import { normaliseForMatching } from '../../common/text/normalise';
import { EntityEmbeddingsService } from '../classification/entity-embeddings.service';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MerchantsService } from '../taxonomy/merchants.service';

/**
 * F-13 onboarding: the writes that turn shipped knowledge into a Household's own rows.
 *
 * ## Why this is a module of its own
 *
 * Onboarding is the one flow that spans the whole taxonomy — categories, their keywords, and
 * merchants with default categories — on behalf of a Household that has nothing yet. It owns no
 * tables (it reads and writes `households.settings` and the taxonomy's rows), so it composes
 * `TaxonomyModule` rather than duplicating its validation, and it exists so that neither the category
 * editor nor the merchant editor has to grow a "bulk seed" mode that only one caller ever uses.
 *
 * ## Progress lives in `households.settings`, not on the Member
 *
 * docs/02 §4.1 says the step is *"stored on the Member so a killed app resumes at the same step"*.
 * `household_members` has no settings column, and in v1 a Household has exactly one Member (F-29
 * household sharing is a `Won't`), so the two are the same unit — the step is recorded in
 * `households.settings.onboarding` next to the confidence-threshold override that already lives
 * there, and no migration was needed. When sharing lands, per-member progress becomes meaningful and
 * that is the moment to add the column; recorded in docs/06 §5.6.1.
 *
 * ## Both writes are idempotent, because onboarding is re-enterable
 *
 * docs/01 F-13: onboarding is *"re-enterable later from settings"*. So neither write may double up:
 * the tree is matched by (parent, name) and reused, and a merchant already owned by the Household is
 * left alone. That is also why `applyMerchantSelection` does **not** simply copy every global row —
 * the global rows stay global, and a second run must not mint a second `Lidl`.
 *
 * @module apps/api/src/modules/onboarding
 */

/** What the wizard needs to resume: the step, and enough counts to know what is already there. */
export interface OnboardingStateView {
  readonly step: number;
  readonly completedAt: Date | null;
  /** The seed version this Household accepted, `null` when it skipped the tree. */
  readonly seedVersion: number | null;
  readonly categories: number;
  readonly keywords: number;
  readonly merchants: number;
  readonly accounts: number;
}

/** The outcome of seeding the starter tree. */
export interface StarterSeedResultView {
  /** Nodes created by this call. */
  readonly categories: number;
  readonly keywords: number;
  /** Nodes that already existed and were reused — the idempotency evidence. */
  readonly reused: number;
}

/** The outcome of applying a merchant selection. */
export interface MerchantSelectionResultView {
  /** Merchants that became Household-owned (or had a default Category filled in) in this call. */
  readonly applied: number;
  /** Selected names the Household already owned, left untouched. */
  readonly alreadyOwned: number;
  /** Names that are not in the shipped catalogue. Reported, never silently dropped. */
  readonly unresolved: readonly string[];
  /**
   * Copied, but with no default Category: the Household's tree has no node at the seed's path,
   * which happens when the user renamed `Supermarket` during step 1. Not an error — the keywords
   * still categorise — but the wizard says so rather than claiming a suggestion it did not make.
   */
  readonly withoutCategory: readonly string[];
  /**
   * Entity vectors written for rung 5 (docs/04 §4), or 0 when no embedding model is configured.
   * Reported because "0" is the difference between "nothing needed indexing" and "there is no model",
   * and a caller should not have to guess which.
   */
  readonly embedded: number;
}

/** The `settings.onboarding` document. Versioned by `seedVersion` so a release can offer more. */
interface OnboardingDocument {
  readonly step: number;
  readonly completedAt: string | null;
  readonly seedVersion: number | null;
}

const FIRST_STEP = 1;
/** docs/02 §4.1 has six steps; seven is "past the end", which is how completion is expressed. */
const LAST_STEP = 6;

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly merchants: MerchantsService,
    private readonly embeddings: EntityEmbeddingsService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Progress
  // -------------------------------------------------------------------------------------------

  async state(householdId: string): Promise<OnboardingStateView> {
    const [household, categories, keywords, merchants, accounts] = await Promise.all([
      this.prisma.client.households.findFirst({
        where: { id: householdId },
        select: { settings: true },
      }),
      this.prisma.client.categories.count({ where: { household_id: householdId, deleted_at: null } }),
      this.prisma.client.category_keywords.count({ where: { household_id: householdId } }),
      this.prisma.client.merchants.count({ where: { household_id: householdId, deleted_at: null } }),
      this.prisma.client.accounts.count({ where: { household_id: householdId, deleted_at: null } }),
    ]);

    const document = readOnboarding(household?.settings);
    return {
      step: document.step,
      completedAt: document.completedAt === null ? null : new Date(document.completedAt),
      seedVersion: document.seedVersion,
      categories,
      keywords,
      merchants,
      accounts,
    };
  }

  /**
   * Record the step the app should resume at.
   *
   * Clamped rather than refused: this is progress bookkeeping written by a screen the user is
   * stepping through, and a 500 on "you told me step 8" would be a worse failure than resuming at the
   * last real step. A step past the end means the wizard finished.
   */
  async setStep(householdId: string, step: number): Promise<OnboardingStateView> {
    const clamped = Math.min(Math.max(Math.trunc(step) || FIRST_STEP, FIRST_STEP), LAST_STEP + 1);
    await this.writeDocument(householdId, (current) => ({ ...current, step: clamped }));
    return this.state(householdId);
  }

  /** Mark onboarding done. Separate from `setStep` so the completion time is a fact of its own. */
  async complete(householdId: string): Promise<OnboardingStateView> {
    await this.writeDocument(householdId, (current) => ({
      ...current,
      step: LAST_STEP + 1,
      completedAt: new Date().toISOString(),
      // Recorded even when the tree was skipped, so a later release can tell "declined v1" from
      // "never asked" — which row counts cannot, because a user may delete the whole tree.
      // The version the Household completed under, defaulted to this build's if the tree step was
      // skipped — "declined the tree, completed onboarding" is still an answer to "which seed did
      // they see", which row counts cannot give.
      seedVersion: current.seedVersion ?? CURRENT_SEED_VERSION,
    }));
    return this.state(householdId);
  }

  // -------------------------------------------------------------------------------------------
  // The starter tree
  // -------------------------------------------------------------------------------------------

  /**
   * Write the shipped category tree and its keywords into this Household.
   *
   * **One interactive transaction**, because a half-written tree is worse than none: step 1's whole
   * promise is that a usable structure exists before the first entry, and a partial tree would leave
   * the classifier mapping some inputs into categories that exist and others into nothing, with no
   * way for the user to tell which.
   *
   * Node identity is **(parent, name)**, not the seed key. The keys are a property of the document
   * and mean nothing in a Household, and matching on them would create a second `Hrana` the moment a
   * user renamed theirs.
   */
  async seedStarterCategories(householdId: string): Promise<StarterSeedResultView> {
    const tree = flattenStarterCategories();

    return this.prisma.client.$transaction(async (tx) => {
      const existing = await tx.categories.findMany({
        where: { household_id: householdId, deleted_at: null },
        select: { id: true, name: true, parent_id: true },
      });
      // Two indexes, for two different questions. `byId` answers "does this Household already have a
      // node at (parent, name)?" — the identity used for reuse. `idBySeedPath` answers "which id is
      // the node at this point in the SHIPPED document?", which is what a child needs to find its
      // parent, because `parentPath` is a list of names rather than ids.
      const byId = new Map<string, string>();
      for (const row of existing) byId.set(nodePath(row.parent_id, row.name), row.id);
      const idBySeedPath = new Map<string, string>();

      // Keyed on (category, polarity, keyword) only — NOT on weight. A row already present at the
      // wrong weight is a legacy artefact of the pre-2.3.3 seed, and treating it as "already there"
      // would leave the tree permanently unable to decide; `writeKeywords` corrects the weight
      // instead of skipping, which is what makes re-running onboarding repair an old Household.
      const existingKeywords = new Map(
        (
          await tx.category_keywords.findMany({
            where: { household_id: householdId },
            select: { id: true, category_id: true, keyword: true, polarity: true, weight: true },
          })
        ).map((row) => [`${row.category_id}:${row.polarity}:${row.keyword}`, row]),
      );

      let created = 0;
      let reused = 0;
      let keywords = 0;
      const siblingIndex = new Map<string, number>();

      for (const node of tree) {
        const parentId =
          node.parentPath.length === 0 ? null : (idBySeedPath.get(pathOf(node.parentPath)) ?? null);
        const address = nodePath(parentId, node.name);
        let categoryId = byId.get(address);

        if (categoryId === undefined) {
          const order = siblingIndex.get(parentId ?? '') ?? 0;
          siblingIndex.set(parentId ?? '', order + 1);
          const row = await tx.categories.create({
            data: {
              // UUIDv7, like every other id: the keyset pagination depends on ids being
              // time-ordered, and `crypto.randomUUID()` is v4.
              id: uuidv7(),
              household_id: householdId,
              parent_id: parentId,
              name: node.name,
              kind: node.kind,
              icon: node.icon ?? null,
              ai_description: node.aiDescription ?? null,
              is_system: true,
              sort_order: order,
            },
            select: { id: true },
          });
          categoryId = row.id;
          byId.set(address, categoryId);
          created += 1;
        } else {
          reused += 1;
        }

        idBySeedPath.set(pathOf([...node.parentPath, node.name]), categoryId);
        keywords += await this.writeKeywords(tx, householdId, categoryId, node, existingKeywords);
      }

      // Stamp the version this build applied, so `complete` can report it and a later release can
      // tell "accepted v1" from "never asked".
      await this.writeDocumentIn(tx, householdId, (current) => ({
        ...current,
        seedVersion: CURRENT_SEED_VERSION,
      }));

      return { categories: created, keywords, reused };
    });
  }

  /**
   * Insert the keywords a node does not already have. Returns how many were written.
   *
   * The **weight** comes from the document, not from the schema default. That is the whole reason a
   * seeded tree categorises: docs/04 §5.4 only decides a category at a score of 2.0, so a decisive
   * keyword must be written at 2.0 and a corroborating one at 1.0. Seeding everything at the default
   * is how the tree ended up unable to decide a single input.
   */
  private async writeKeywords(
    tx: Prisma.TransactionClient,
    householdId: string,
    categoryId: string,
    node: FlatStarterCategory,
    existing: Map<string, { id: string; weight: unknown }>,
  ): Promise<number> {
    let written = 0;
    for (const entry of node.keywords) {
      // The same fold `addKeyword` and `setMerchantAliases` use. A keyword stored unfolded would
      // still match (the engine folds both sides), but two storage conventions for one concept is
      // how the editor's chips and the seed's rows start disagreeing.
      const keyword = normaliseForMatching(entry.word);
      if (keyword === '') continue;
      const key = `${categoryId}:${entry.polarity}:${keyword}`;
      const present = existing.get(key);
      if (present !== undefined) {
        // Already correct: nothing to do. Wrong (a legacy default-weight row): raise it, so a
        // Household that ran the old seed gets a working tree on its next onboarding visit.
        if (Number(present.weight) !== entry.weight) {
          await tx.category_keywords.update({
            where: { id: present.id },
            data: { weight: entry.weight },
          });
        }
        continue;
      }
      existing.set(key, { id: '', weight: entry.weight });
      await tx.category_keywords.create({
        data: {
          id: uuidv7(),
          household_id: householdId,
          category_id: categoryId,
          keyword,
          polarity: entry.polarity,
          weight: entry.weight,
        },
      });
      written += 1;
    }
    return written;
  }

  // -------------------------------------------------------------------------------------------
  // Merchants
  // -------------------------------------------------------------------------------------------

  /**
   * Make the selected shipped merchants this Household's own, with a default Category.
   *
   * Step 4's job. Two things make it more than a copy:
   *
   *  - **The global rows stay global.** Copying happens through `MerchantsService.update`, which is
   *    the shipped copy-on-write path: it clones the row, moves this Household's references onto the
   *    clone and brings the aliases along. `MerchantsService.create` cannot be used here at all —
   *    its duplicate-name check sees global rows and refuses `Lidl` as "already exists".
   *  - **A default Category is resolved by path**, because `SHIPPED_MERCHANTS[].categoryKey` is a key
   *    in the shipped document and the Household's tree is its own rows. Step 1 may have been skipped
   *    or renamed, in which case the merchant is still created and reported in `withoutCategory`
   *    rather than being given a wrong category. Its keywords still categorise.
   */
  async applyMerchantSelection(
    householdId: string,
    names: readonly string[],
  ): Promise<MerchantSelectionResultView> {
    const wanted = dedupe(names);
    if (wanted.length === 0) {
      return { applied: 0, alreadyOwned: 0, unresolved: [], withoutCategory: [], embedded: 0 };
    }

    const shippedByName = new Map(SHIPPED_MERCHANTS.map((merchant) => [normaliseForMatching(merchant.name), merchant]));

    const [owned, globals, categories] = await Promise.all([
      this.prisma.client.merchants.findMany({
        where: { household_id: householdId, deleted_at: null },
        select: { id: true, name: true, default_category_id: true },
      }),
      this.prisma.client.merchants.findMany({
        where: { household_id: null, deleted_at: null },
        select: { id: true, name: true },
      }),
      this.prisma.client.categories.findMany({
        where: { household_id: householdId, deleted_at: null },
        select: { id: true, name: true, parent_id: true, kind: true },
      }),
    ]);

    const ownedByName = new Map(owned.map((row) => [normaliseForMatching(row.name), row]));
    const globalByName = new Map(globals.map((row) => [normaliseForMatching(row.name), row.id]));
    const categoryIndex = indexCategories(categories);

    const unresolved: string[] = [];
    const withoutCategory: string[] = [];
    let applied = 0;
    let alreadyOwned = 0;

    for (const name of wanted) {
      const shipped = shippedByName.get(normaliseForMatching(name));
      if (shipped === undefined) {
        unresolved.push(name);
        continue;
      }

      const categoryId = resolveCategoryByPath(categoryIndex, shipped.categoryKey);
      if (categoryId === null) withoutCategory.push(shipped.name);

      const mine = ownedByName.get(normaliseForMatching(shipped.name));
      if (mine !== undefined) {
        alreadyOwned += 1;
        // Never overwrite a default the user set themselves; only fill an empty one.
        if (mine.default_category_id === null && categoryId !== null) {
          await this.merchants.update(householdId, mine.id, { defaultCategoryId: categoryId });
          applied += 1;
        }
        continue;
      }

      const globalId = globalByName.get(normaliseForMatching(shipped.name));
      if (globalId !== undefined) {
        // Copy-on-write: clones the global row into this Household and brings its aliases.
        await this.merchants.update(householdId, globalId, {
          ...(categoryId === null ? {} : { defaultCategoryId: categoryId }),
        });
        applied += 1;
        continue;
      }

      // No global row: the catalogue moved on since the platform seed ran. Create the Household row
      // and store the shipped aliases so the merchant is still reachable by how people type.
      const created = await this.merchants.create(householdId, {
        name: shipped.name,
        ...(categoryId === null ? {} : { defaultCategoryId: categoryId }),
      });
      await this.merchants.setAliases(householdId, created.id, [
        ...new Set([shipped.name, ...shipped.aliases].map(normaliseForMatching).filter((alias) => alias !== '')),
      ]);
      applied += 1;
    }

    // Rung 5 needs vectors, and this is the moment the entity set changes for a new Household — so the
    // index is built here rather than from a read path (`parse` is on a keystroke debounce). It is a
    // no-op with no embedding model configured, which is why it can sit on the interactive path at all
    // (ADR-021); a deployment with a model pays one batch of calls for the merchants just adopted.
    const embedded = await this.embeddings.syncMissing(householdId);

    return { applied, alreadyOwned, unresolved, withoutCategory, embedded: embedded.embedded };
  }

  // -------------------------------------------------------------------------------------------
  // Settings plumbing
  // -------------------------------------------------------------------------------------------

  private async writeDocument(
    householdId: string,
    next: (current: OnboardingDocument) => OnboardingDocument,
  ): Promise<void> {
    await this.writeDocumentIn(this.prisma.client, householdId, next);
  }

  /**
   * The document write, against a client or a transaction.
   *
   * Read-merge-write, and only the `onboarding` key: `households.settings` already holds
   * `aiConfidenceThresholds`, so replacing the whole document would silently reset a Household's
   * ADR-009 thresholds — a bug that surfaces as odd review-queue behaviour weeks later.
   */
  private async writeDocumentIn(
    db: Prisma.TransactionClient,
    householdId: string,
    next: (current: OnboardingDocument) => OnboardingDocument,
  ): Promise<void> {
    const household = await db.households.findFirst({
      where: { id: householdId },
      select: { settings: true },
    });
    if (household === null) throw new Error(`Household ${householdId} not found.`);

    const settings = isRecord(household.settings) ? household.settings : {};
    const merged = { ...settings, onboarding: { ...next(readOnboarding(household.settings)) } };
    await db.households.update({ where: { id: householdId }, data: { settings: merged } });
  }
}

// ---------------------------------------------------------------------------------------------
// Pure helpers. Kept out of the methods so the mapping rules can be reasoned about on their own.
// ---------------------------------------------------------------------------------------------

/** Identity of a node inside a Household: its parent plus its name. Exported shape is a string key. */
function nodePath(parentId: string | null, name: string): string {
  return `${parentId ?? '~'}\u0000${name}`;
}

/** The address of a path of names, root first — how a nested document addresses a node. */
function pathOf(names: readonly string[]): string {
  return names.join('\u0000');
}

/** `septička, septicka` and `Septička` are one name selection, not three. */
function dedupe(names: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === '') continue;
    const key = normaliseForMatching(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

interface CategoryRow {
  readonly id: string;
  readonly name: string;
  readonly parent_id: string | null;
}

/** Index a Household's categories by (parent, name) so a path can be walked without queries. */
function indexCategories(rows: readonly CategoryRow[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const row of rows) index.set(nodePath(row.parent_id, row.name), row.id);
  return index;
}

/**
 * Resolve a shipped category key to this Household's category id, by walking the seed path.
 *
 * `null` is the honest answer when the path is not there — the user skipped step 1, or renamed a
 * node. Callers report it rather than substituting a different category, because a merchant pointing
 * at the wrong category is worse than one pointing at none: the wrong one is applied silently and
 * never reviewed.
 */
/** Resolved once: the document is static, and this is read per selected merchant. */
const SEED_TREE_BY_KEY = new Map(flattenStarterCategories().map((node) => [node.key, node]));

function resolveCategoryByPath(
  index: ReadonlyMap<string, string>,
  categoryKey: string,
): string | null {
  const node = SEED_TREE_BY_KEY.get(categoryKey);
  if (node === undefined) return null;

  let parentId: string | null = null;
  for (const name of [...node.parentPath, node.name]) {
    const id = index.get(nodePath(parentId, name));
    if (id === undefined) return null;
    parentId = id;
  }
  return parentId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read `settings.onboarding`, tolerating anything: settings is user-editable JSONB. */
export function readOnboarding(settings: unknown): OnboardingDocument {
  const fallback: OnboardingDocument = { step: FIRST_STEP, completedAt: null, seedVersion: null };
  if (!isRecord(settings)) return fallback;
  const raw = settings['onboarding'];
  if (!isRecord(raw)) return fallback;

  const step = raw['step'];
  const completedAt = raw['completedAt'];
  const seedVersion = raw['seedVersion'];
  return {
    step: typeof step === 'number' && Number.isFinite(step) ? Math.trunc(step) : FIRST_STEP,
    completedAt: typeof completedAt === 'string' ? completedAt : null,
    seedVersion: typeof seedVersion === 'number' ? seedVersion : null,
  };
}

/** The version this build ships, so the resolver records the server's value rather than the client's. */
export const CURRENT_SEED_VERSION = SEED_VERSION;
