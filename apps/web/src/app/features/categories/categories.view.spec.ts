import { describe, expect, it } from 'vitest';

import {
  buildTree,
  moveRefusal,
  nestParentFor,
  reorderChanges,
  siblingsOf,
  unnestParentFor,
  visibleRows,
  type CategoryNode,
} from './categories.view';

let sequence = 0;
function cat(overrides: Partial<CategoryNode> & { id: string }): CategoryNode {
  sequence += 1;
  return {
    name: `cat-${sequence}`,
    kind: 'EXPENSE',
    parentId: null,
    depth: 1,
    path: ['x'],
    sortOrder: 0,
    icon: null,
    color: null,
    aiDescription: null,
    isSystem: false,
    keywords: [],
    ...overrides,
  };
}

/** Hrana > (Meso, Hleb), Auto > Gorivo, all roots ordered as given. */
const tree: CategoryNode[] = [
  cat({ id: 'hrana', name: 'Hrana', sortOrder: 0 }),
  cat({ id: 'meso', name: 'Meso', parentId: 'hrana', depth: 2, sortOrder: 0 }),
  cat({ id: 'hleb', name: 'Hleb', parentId: 'hrana', depth: 2, sortOrder: 10 }),
  cat({ id: 'auto', name: 'Auto', sortOrder: 10 }),
  cat({ id: 'gorivo', name: 'Gorivo', parentId: 'auto', depth: 2, sortOrder: 0 }),
];

describe('buildTree', () => {
  it('nests children under their parents and preserves server order', () => {
    const roots = buildTree(tree);
    expect(roots.map((node) => node.node.id)).toEqual(['hrana', 'auto']);
    expect(roots[0]?.children.map((node) => node.node.id)).toEqual(['meso', 'hleb']);
    expect(roots[1]?.children.map((node) => node.node.id)).toEqual(['gorivo']);
  });

  it('promotes an orphan to a root instead of dropping it', () => {
    // A filtered or partially-loaded page must not make a Category silently disappear.
    const roots = buildTree([cat({ id: 'orphan', parentId: 'missing' })]);
    expect(roots.map((node) => node.node.id)).toEqual(['orphan']);
  });

  it('handles an empty tree and a single root', () => {
    expect(buildTree([])).toEqual([]);
    expect(buildTree([cat({ id: 'only' })]).map((n) => n.node.id)).toEqual(['only']);
  });
});

describe('visibleRows', () => {
  it('hides the children of a collapsed node and re-derives depth from position', () => {
    const rows = visibleRows(buildTree(tree), new Set(['hrana']));
    expect(rows.map((row) => row.node.id)).toEqual(['hrana', 'auto', 'gorivo']);
    expect(rows[0]?.expanded).toBe(false);
    expect(rows[0]?.hasChildren).toBe(true);
  });

  it('shows everything when nothing is collapsed', () => {
    const rows = visibleRows(buildTree(tree), new Set());
    expect(rows.map((row) => row.node.id)).toEqual(['hrana', 'meso', 'hleb', 'auto', 'gorivo']);
    expect(rows.find((row) => row.node.id === 'meso')?.depth).toBe(1);
  });

  it('marks a leaf as having no children so the UI renders no disclosure control', () => {
    const rows = visibleRows(buildTree(tree), new Set());
    expect(rows.find((row) => row.node.id === 'meso')?.hasChildren).toBe(false);
  });
});

describe('moveRefusal', () => {
  it('allows a legal move', () => {
    expect(moveRefusal(tree, 'gorivo', 'hrana')).toBeNull();
    expect(moveRefusal(tree, 'meso', null)).toBeNull();
  });

  it('refuses making a node its own parent', () => {
    expect(moveRefusal(tree, 'hrana', 'hrana')).toBe('SELF');
  });

  it('refuses moving a node under its own descendant (I-11)', () => {
    expect(moveRefusal(tree, 'hrana', 'meso')).toBe('CYCLE');
  });

  it('refuses a move that would push the subtree past the depth cap (I-11)', () => {
    // p1 > p2 > p3 > p4 is four deep, and y > y1 > y2 is an unrelated three-tall branch. Moving y
    // under p4 would put its deepest node at 4 + 3 - 1 = 6, one past the cap of 5.
    const deep: CategoryNode[] = [
      cat({ id: 'p1' }),
      cat({ id: 'p2', parentId: 'p1', depth: 2 }),
      cat({ id: 'p3', parentId: 'p2', depth: 3 }),
      cat({ id: 'p4', parentId: 'p3', depth: 4 }),
      cat({ id: 'y' }),
      cat({ id: 'y1', parentId: 'y', depth: 2 }),
      cat({ id: 'y2', parentId: 'y1', depth: 3 }),
      cat({ id: 'z' }),
    ];
    expect(moveRefusal(deep, 'y', 'p4')).toBe('TOO_DEEP');
    // A leaf under p4 lands at 5, exactly at the cap, so it is allowed.
    expect(moveRefusal(deep, 'z', 'p4')).toBeNull();
    // The same leaf under y1 (depth 2) is fine too.
    expect(moveRefusal(deep, 'z', 'y1')).toBeNull();
    // Moving the tall branch to the root is always legal.
    expect(moveRefusal(deep, 'y', null)).toBeNull();
  });
});

describe('siblingsOf', () => {
  it('returns only nodes sharing a parent, and roots for a root', () => {
    expect(siblingsOf(tree, 'meso').map((n) => n.id)).toEqual(['meso', 'hleb']);
    expect(siblingsOf(tree, 'hrana').map((n) => n.id)).toEqual(['hrana', 'auto']);
    expect(siblingsOf(tree, 'nope')).toEqual([]);
  });
});

describe('reorderChanges', () => {
  it('renumbers the whole sibling list so a swap of equal orders still takes effect', () => {
    // Every sibling at sortOrder 0 — the seeded case. Swapping two 0s would be a no-op.
    const flat: CategoryNode[] = [
      cat({ id: 'a', sortOrder: 0 }),
      cat({ id: 'b', sortOrder: 0 }),
      cat({ id: 'c', sortOrder: 0 }),
    ];
    // `b` moves to the front and keeps order 0, so it needs no write; the other two shift.
    expect(reorderChanges(flat, 'b', -1)).toEqual([
      { id: 'a', sortOrder: 10 },
      { id: 'c', sortOrder: 20 },
    ]);
  });

  it('moves down as well as up, and only within the same parent', () => {
    expect(reorderChanges(tree, 'meso', 1).map((change) => change.id)).toEqual(['hleb', 'meso']);
    expect(reorderChanges(tree, 'gorivo', 1)).toEqual([]);
  });

  it('does nothing at the ends of the list', () => {
    expect(reorderChanges(tree, 'hrana', -1)).toEqual([]);
    expect(reorderChanges(tree, 'auto', 1)).toEqual([]);
  });

  it('ignores an unknown id', () => {
    expect(reorderChanges(tree, 'nope', 1)).toEqual([]);
  });
});

describe('nesting targets', () => {
  it('nests under the sibling above, and not under the row below', () => {
    expect(nestParentFor(tree, 'hleb')).toBe('meso');
  });

  it('offers no nest target for the first sibling', () => {
    expect(nestParentFor(tree, 'meso')).toBeNull();
    expect(nestParentFor(tree, 'hrana')).toBeNull();
  });

  it('un-nests to the grandparent, and reports a root as having nowhere to go', () => {
    expect(unnestParentFor(tree, 'meso')).toBeNull();
    expect(unnestParentFor(tree, 'gorivo')).toBeNull();
    expect(unnestParentFor(tree, 'hrana')).toBeUndefined();
  });
});
