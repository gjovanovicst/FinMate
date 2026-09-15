import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEYWORD_WEIGHT,
  KEYWORD_DECISION_THRESHOLD,
  STARTER_CATEGORIES,
  STRONG_KEYWORD_WEIGHT,
  type StarterCategory,
} from './categories';
import { SHIPPED_MERCHANTS } from './merchants';
import {
  SEED_VERSION,
  flattenStarterCategories,
  starterCategoryKeys,
  type FlatStarterCategory,
} from './index';

/**
 * The shipped content, asserted like code.
 *
 * This is the file that stops a bad seed from being a bad *release*. The list is hand-authored
 * content, which is exactly the kind of thing that rots quietly: a duplicate key makes
 * `default_category_id` resolve to whichever node the writer saw first; a merchant pointing at a
 * category the tree no longer has silently loses its suggestion; an alias shared by two merchants
 * makes entity resolution depend on row order. None of those fail loudly at runtime — they produce a
 * slightly worse categorisation that nobody can attribute to a commit.
 *
 * **Fold-sensitive checks live in the API's integration spec, not here.** `packages/domain` imports
 * nothing (so it cannot fold), and the fold is what the classifier actually compares against. This
 * file checks the document; `onboarding.integration.spec.ts` checks what lands in the database.
 */

function walk(nodes: readonly StarterCategory[], depth = 1): readonly { node: StarterCategory; depth: number }[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...walk(node.children ?? [], depth + 1),
  ]);
}

const ALL_NODES = walk(STARTER_CATEGORIES);
const FLAT = flattenStarterCategories();

describe('STARTER_CATEGORIES', () => {
  it('ships roughly the ~40 nodes docs/01 F-13 promises', () => {
    // A range rather than an equality: the spec says "~40", and pinning the exact count here would
    // make adding a legitimate category a test failure instead of a review.
    expect(FLAT.length).toBeGreaterThanOrEqual(35);
    expect(FLAT.length).toBeLessThanOrEqual(45);
  });

  it('has exactly one node per key', () => {
    const keys = FLAT.map((node) => node.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never repeats a name under the same parent', () => {
    // Two siblings with one name is ambiguous to a human and unaddressable for onboarding, which
    // matches existing nodes by (parentPath, name).
    const seen = new Set<string>();
    for (const { key, name, parentPath } of FLAT) {
      const address = [...parentPath, name].join(' / ');
      expect(seen.has(address), `duplicate category path: ${address} (${key})`).toBe(false);
      seen.add(address);
    }
  });

  it('keeps every node within the depth cap of I-11', () => {
    // docs/03 I-11 caps the tree at 5. A seed that violates it would make the first onboarding step
    // fail validation on a fresh Household, which is the worst place to discover it.
    for (const { node, depth } of ALL_NODES) {
      expect(depth, `${node.name} is at depth ${depth}`).toBeLessThanOrEqual(5);
    }
  });

  it('gives every node a kind and a non-empty name', () => {
    for (const node of FLAT) {
      expect(['EXPENSE', 'INCOME']).toContain(node.kind);
      expect(node.name.trim()).not.toBe('');
    }
  });

  it('lists parents before children, so a writer can insert in one pass', () => {
    const written = new Set<string>();
    for (const node of FLAT) {
      for (const parentName of node.parentPath) {
        expect(written.has(parentName), `${node.name} precedes its parent ${parentName}`).toBe(true);
      }
      written.add(node.name);
    }
  });

  it('carries keywords for the categories that actually decide the cold start', () => {
    // docs/04 §5.4: keywords are the priority-1000 tier, and they are why `Lidl 2000` categorises
    // after onboarding step 1 alone. A tree with no keywords would still "work" and would leave the
    // headline promise to the AI, which is exactly the cold start F-13 exists to prevent.
    const withKeywords = FLAT.filter((node) => node.keywords.length > 0);
    expect(withKeywords.length).toBeGreaterThanOrEqual(20);

    // Income is where a wrong direction is most damaging, so those keywords are not optional.
    for (const key of ['prihod-plata', 'prihod-penzija', 'prihod-uplata']) {
      const node = FLAT.find((candidate) => candidate.key === key);
      expect(node?.kind).toBe('INCOME');
      expect(node?.keywords.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('gives every category a DECISIVE keyword, because a corroborating one can never decide', () => {
    // This is the assertion that would have caught the bug that made the whole feature inert. The
    // threshold is 2.0, the schema default weight is 1.0, and the shipped tree seeded 137 keywords
    // all at the default — so the tree could not categorise a single input, and the demo Household
    // hid it because a merchant *default* is a different stage that always decides.
    expect(STRONG_KEYWORD_WEIGHT).toBeGreaterThanOrEqual(KEYWORD_DECISION_THRESHOLD);
    expect(DEFAULT_KEYWORD_WEIGHT).toBeLessThan(KEYWORD_DECISION_THRESHOLD);

    // A node that HAS keywords must have at least one decisive one; a node with none is either a
    // grouping root (its children carry the words) or the fallback bucket, which must never attract a
    // match — `Ostalo` having no keywords is the point of it.
    const withoutStrong = FLAT.filter((node) => node.keywords.length > 0 && node.strong.length === 0).map(
      (node) => node.key,
    );
    expect(withoutStrong).toEqual([]);

    // A keywordless node must be a grouping root (its children carry the words) or the fallback
    // bucket. Stated structurally rather than as a list of names, so adding a category does not
    // require editing this test.
    const groupingRoots = new Set(
      ALL_NODES.filter((entry) => (entry.node.children ?? []).length > 0).map((entry) => entry.node.name),
    );
    for (const node of FLAT) {
      if (node.keywords.length > 0) continue;
      const excused = groupingRoots.has(node.name) || node.key === 'ostalo';
      expect(excused, `${node.key} has no keywords and is neither a grouping root nor Ostalo`).toBe(true);
    }
  });

  it('marks the exit-criterion inputs decisive', () => {
    // docs/09 §4: `Lidl 2000, gorivo 3500, plata 150000` must parse to three correctly categorised
    // transactions with no AI. Each of those three words therefore has to be decisive on its own.
    const decisive = new Set(FLAT.flatMap((node) => node.strong.map((word) => `${node.key}:${word}`)));
    for (const pair of ['hrana-supermarket:lidl', 'auto-gorivo:gorivo', 'prihod-plata:plata']) {
      expect(decisive.has(pair), `${pair} is not a decisive keyword`).toBe(true);
    }
  });

  it('keeps ambiguous words corroborating rather than decisive', () => {
    // `kafa` is the clearest case in the tree: buying coffee is `Kafa i kolači`, but "kafa i mleko"
    // is groceries. Words like this belong in `include`, where they need a second hit.
    const weak = new Map(FLAT.flatMap((node) => node.include.map((word) => [word, node.key])));
    for (const word of ['kafa', 'market', 'voda', 'rata']) {
      expect(weak.has(word), `${word} should be corroborating`).toBe(true);
    }
    // …and none of them also appears as decisive.
    const strong = new Set(FLAT.flatMap((node) => node.strong));
    for (const word of ['kafa', 'market', 'voda', 'rata']) {
      expect(strong.has(word), `${word} is both decisive and corroborating`).toBe(false);
    }
  });

  it('attaches a weight to every keyword, so a writer cannot fall back to the default', () => {
    for (const node of FLAT) {
      for (const keyword of node.keywords) {
        expect(
          [DEFAULT_KEYWORD_WEIGHT, STRONG_KEYWORD_WEIGHT],
          `${node.key}:${keyword.word}`,
        ).toContain(keyword.weight);
      }
    }
    // The convenience views must agree with the full list, or a reader picking the wrong one gets a
    // different tree than the writer does.
    for (const node of FLAT) {
      expect(node.keywords.filter((keyword) => keyword.weight === STRONG_KEYWORD_WEIGHT).map((k) => k.word))
        .toEqual([...node.strong]);
      expect(node.keywords.filter((keyword) => keyword.polarity === 'EXCLUDE').map((k) => k.word))
        .toEqual([...node.exclude]);
    }
  });

  it('never lists one word as both decisive and corroborating on the same node', () => {
    for (const node of FLAT) {
      const strong = new Set(node.strong);
      for (const word of node.include) {
        expect(strong.has(word), `${node.key} lists ${word} twice`).toBe(false);
      }
    }
  });

  it('keeps the exclude list that stops oil routing into fuel', () => {
    // Named rather than general: this one was reasoned about and would be easy to drop in a tidy-up.
    const fuel = FLAT.find((node) => node.key === 'auto-gorivo');
    expect(fuel?.exclude).toContain('ulje');
  });

  it('has both directions represented', () => {
    expect(FLAT.some((node) => node.kind === 'EXPENSE')).toBe(true);
    expect(FLAT.some((node) => node.kind === 'INCOME')).toBe(true);
  });

  it('is self-contained: every key resolves, and the helpers agree with the document', () => {
    const keys = starterCategoryKeys();
    expect(keys.size).toBe(FLAT.length);
    for (const node of FLAT) expect(keys.has(node.key)).toBe(true);
  });
});

describe('SHIPPED_MERCHANTS', () => {
  it('ships the ~60 merchants docs/11 §2.3 specifies', () => {
    // The shortfall this guards against is real: it was 38, which is what "the seed is short"
    // meant. A floor keeps that from recurring without freezing the exact list.
    expect(SHIPPED_MERCHANTS.length).toBeGreaterThanOrEqual(60);
  });

  it('never repeats a merchant name', () => {
    const names = SHIPPED_MERCHANTS.map((merchant) => merchant.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('points every suggestion at a category that exists', () => {
    const keys = starterCategoryKeys();
    for (const merchant of SHIPPED_MERCHANTS) {
      expect(keys.has(merchant.categoryKey), `${merchant.name} -> ${merchant.categoryKey}`).toBe(true);
    }
  });

  it('suggests only expense categories', () => {
    // A shop that suggests an income category would file spending as money coming in.
    const byKey = new Map(FLAT.map((node) => [node.key, node]));
    for (const merchant of SHIPPED_MERCHANTS) {
      expect(byKey.get(merchant.categoryKey)?.kind, merchant.name).toBe('EXPENSE');
    }
  });

  it('gives every merchant at least one alias', () => {
    // An alias that merely repeats the name is *redundant but harmless* — the resolver already adds
    // the entity's own name as a key and picks a single best key per entity (`matchKeysFor` /
    // `bestKey`), so it cannot inflate a score or create a tie. That is why this asserts presence
    // rather than demanding a variant spelling: `Wolt` has no other way of being written, and
    // inventing one to satisfy a test would be content designed for the test.
    for (const merchant of SHIPPED_MERCHANTS) {
      expect(merchant.aliases.length, `${merchant.name} has no aliases`).toBeGreaterThan(0);
    }
  });

  it('spells out the variants people actually type, in both scripts', () => {
    // The catalogue's value is here, not in its length: `septicka` for a Latin keyboard without
    // diacritics, `лидл` for a Cyrillic one. A list of names with no variants would pass every other
    // check in this file and still leave the classifier failing on how people really type.
    const aliases = SHIPPED_MERCHANTS.flatMap((merchant) => merchant.aliases);
    const cyrillic = aliases.filter((alias) => /[\u0400-\u04FF]/.test(alias));
    expect(cyrillic.length).toBeGreaterThanOrEqual(3);
    expect(aliases.length).toBeGreaterThanOrEqual(40);
  });

  it('keeps aliases unique across merchants, ignoring case', () => {
    // The fold-sensitive version of this check needs `@finmate/nlp` and lives in the API spec. This
    // catches the obvious collision earlier and without a dependency.
    const owners = new Map<string, string>();
    for (const merchant of SHIPPED_MERCHANTS) {
      for (const alias of merchant.aliases) {
        const key = alias.toLowerCase();
        const owner = owners.get(key);
        expect(owner === undefined, `alias "${alias}" is on both ${owner} and ${merchant.name}`).toBe(true);
        owners.set(key, merchant.name);
      }
    }
  });

  it('has no blank or padded alias', () => {
    for (const merchant of SHIPPED_MERCHANTS) {
      for (const alias of merchant.aliases) {
        expect(alias, merchant.name).toBe(alias.trim());
        expect(alias.length, merchant.name).toBeGreaterThan(0);
      }
    }
  });

  it('covers more than groceries, so the list is not a supermarket list', () => {
    const groups = new Set(SHIPPED_MERCHANTS.map((merchant) => merchant.categoryKey.split('-')[0]));
    expect(groups.size).toBeGreaterThanOrEqual(6);
  });
});

describe('SEED_VERSION', () => {
  it('is a positive integer a Household can store', () => {
    // Onboarding records the version it applied; a float or a zero would make "already onboarded"
    // undecidable.
    expect(Number.isInteger(SEED_VERSION)).toBe(true);
    expect(SEED_VERSION).toBeGreaterThan(0);
  });
});

describe('flattenStarterCategories', () => {
  it('reports the depth and the parent path of a nested node', () => {
    const supermarket: FlatStarterCategory | undefined = FLAT.find((node) => node.key === 'hrana-supermarket');
    expect(supermarket?.depth).toBe(2);
    expect(supermarket?.parentPath).toEqual(['Hrana']);

    const root = FLAT.find((node) => node.key === 'hrana');
    expect(root?.depth).toBe(1);
    expect(root?.parentPath).toEqual([]);
  });

  it('defaults include/exclude to empty rather than undefined', () => {
    // A writer that has to guard for `undefined` on every keyword list is a writer that will forget.
    for (const node of FLAT) {
      expect(Array.isArray(node.include)).toBe(true);
      expect(Array.isArray(node.exclude)).toBe(true);
    }
  });
});
