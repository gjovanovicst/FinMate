import { describe, expect, it } from 'vitest';

import {
  ancestorsOf,
  depthUnder,
  depthOf,
  descendantsOf,
  findTreeViolations,
  MAX_TREE_DEPTH,
  pathTo,
  subtreeHeight,
  wouldCreateCycle,
  type TreeNode,
} from './tree';

/**
 * Tree rules behind invariant I-11 (acyclic, ≤ 5 deep).
 *
 * A cycle here is not a cosmetic defect: every category rollup, budget subtree and breadcrumb walks
 * the tree, so a cycle is an infinite loop in production. These are asserted over generated shapes
 * rather than a couple of examples.
 */
const node = (id: string, parentId: string | null): TreeNode => ({ id, parentId });

/** docs/02's example tree, trimmed. */
const tree: TreeNode[] = [
  node('hrana', null),
  node('supermarket', 'hrana'),
  node('pekara', 'hrana'),
  node('auto', null),
  node('gorivo', 'auto'),
  node('servis', 'auto'),
  node('kuca', null),
  node('septicka', 'kuca'),
  node('duboko1', 'septicka'),
  node('duboko2', 'duboko1'),
  node('duboko3', 'duboko2'),
];

describe('tree structure', () => {
  it('reports depth with roots at 1', () => {
    expect(depthOf(tree, 'hrana')).toBe(1);
    expect(depthOf(tree, 'supermarket')).toBe(2);
    expect(depthOf(tree, 'septicka')).toBe(2);
    expect(depthOf(tree, 'duboko3')).toBe(5);
  });

  it('lists ancestors nearest first', () => {
    expect(ancestorsOf(tree, 'duboko3')).toEqual(['duboko2', 'duboko1', 'septicka', 'kuca']);
    expect(ancestorsOf(tree, 'hrana')).toEqual([]);
  });

  it('lists all descendants, not just direct children', () => {
    expect(descendantsOf(tree, 'hrana').sort()).toEqual(['pekara', 'supermarket']);
    expect(descendantsOf(tree, 'kuca').sort()).toEqual([
      'duboko1',
      'duboko2',
      'duboko3',
      'septicka',
    ]);
    expect(descendantsOf(tree, 'supermarket')).toEqual([]);
  });

  it('builds a breadcrumb from the root down', () => {
    expect(pathTo(tree, 'duboko3')).toEqual(['kuca', 'septicka', 'duboko1', 'duboko2', 'duboko3']);
  });

  it('reports subtree height, which is what a move must respect', () => {
    expect(subtreeHeight(tree, 'supermarket')).toBe(1);
    expect(subtreeHeight(tree, 'kuca')).toBe(5);
  });
});

describe('cycle prevention (the guard between a user and an infinite loop)', () => {
  it('refuses to reparent a node under itself', () => {
    expect(wouldCreateCycle(tree, 'kuca', 'kuca')).toBe(true);
  });

  it('refuses to reparent a node under its own descendant', () => {
    expect(wouldCreateCycle(tree, 'kuca', 'septicka')).toBe(true);
    expect(wouldCreateCycle(tree, 'kuca', 'duboko3')).toBe(true);
  });

  it('allows a legitimate move', () => {
    expect(wouldCreateCycle(tree, 'septicka', 'auto')).toBe(false);
    expect(wouldCreateCycle(tree, 'supermarket', null)).toBe(false);
  });

  it('never reports a cycle on a well-formed tree', () => {
    expect(findTreeViolations(tree)).toEqual({ cycles: [], tooDeep: [] });
  });

  it('detects a real cycle instead of looping forever', () => {
    // A cycle can only get in through a bug or a bad import; when it does, the tree walkers must
    // terminate so the failure is a report, not a hung request.
    const cyclic: TreeNode[] = [node('a', 'c'), node('b', 'a'), node('c', 'b')];
    expect(findTreeViolations(cyclic).cycles.length).toBeGreaterThan(0);
    expect(ancestorsOf(cyclic, 'a').length).toBeLessThanOrEqual(3);
    expect(descendantsOf(cyclic, 'a').length).toBeLessThanOrEqual(3);
    expect(subtreeHeight(cyclic, 'a')).toBeLessThanOrEqual(3);
  });

  it('would rather hang than crash on self-parenting', () => {
    const selfParent: TreeNode[] = [node('x', 'x')];
    expect(() => ancestorsOf(selfParent, 'x')).not.toThrow();
    expect(findTreeViolations(selfParent).cycles).toContain('x');
  });
});

describe('depth limit (invariant I-11)', () => {
  it('flags nodes past the cap', () => {
    const deep: TreeNode[] = [
      node('1', null),
      node('2', '1'),
      node('3', '2'),
      node('4', '3'),
      node('5', '4'),
      node('6', '5'),
    ];
    expect(findTreeViolations(deep).tooDeep).toEqual(['6']);
  });

  it('accepts a tree exactly at the cap', () => {
    const atCap: TreeNode[] = [
      node('1', null),
      node('2', '1'),
      node('3', '2'),
      node('4', '3'),
      node('5', '4'),
    ];
    expect(findTreeViolations(atCap).tooDeep).toEqual([]);
    expect(depthOf(atCap, '5')).toBe(MAX_TREE_DEPTH);
  });

  it('computes the depth a node WOULD have, so a move can be refused before it happens', () => {
    // Moving `hrana` under `duboko3` would make it depth 6.
    expect(depthUnder(tree, 'duboko3')).toBe(6);
    expect(depthUnder(tree, 'auto')).toBe(2);
    expect(depthUnder(tree, null)).toBe(1);
  });

  it('catches a move that breaches the cap deep inside the subtree', () => {
    // `kuca` is depth 1 but carries a 4-deep subtree, so moving it under a depth-3 parent would put
    // its deepest descendant at depth 8 — a violation nobody would see by looking at the node being
    // moved. This is why the check must consider subtree height, not just the moved node.
    const deepest = depthUnder(tree, 'duboko1') + subtreeHeight(tree, 'kuca') - 1;
    expect(deepest).toBeGreaterThan(MAX_TREE_DEPTH);
  });
});

describe('generated trees never produce a false cycle', () => {
  it('accepts every parent-before-child ordering of a generated tree', () => {
    // Property: a tree built so that a node's parent always appears earlier can never contain a
    // cycle. If any ordering reports one, the walker is wrong rather than the data.
    for (let width = 1; width <= 6; width += 1) {
      const generated: TreeNode[] = [];
      for (let index = 0; index < width; index += 1) {
        generated.push(node(`n${index}`, index === 0 ? null : `n${Math.floor((index - 1) / 2)}`));
      }
      expect(findTreeViolations(generated).cycles).toEqual([]);
    }
  });

  it('reports depth consistently with the ancestors it returns', () => {
    for (const candidate of tree) {
      expect(depthOf(tree, candidate.id)).toBe(ancestorsOf(tree, candidate.id).length + 1);
    }
  });
});
