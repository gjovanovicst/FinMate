import {
  MAX_TREE_DEPTH,
  depthUnder,
  subtreeHeight,
  wouldCreateCycle,
  type TreeNode,
} from '@finmate/domain';

export type CategoryKind = 'EXPENSE' | 'INCOME';
export type KeywordPolarity = 'INCLUDE' | 'EXCLUDE';
export type KeywordMatchMode = 'WORD' | 'PREFIX' | 'SUBSTRING';

export interface KeywordNode {
  readonly id: string;
  readonly keyword: string;
  readonly matchMode: string;
  readonly polarity: KeywordPolarity;
  readonly weight: number;
}

/** A Category as the editor needs it. Mirrors `CategoryModel` (docs/06 §5). */
export interface CategoryNode {
  readonly id: string;
  readonly name: string;
  readonly kind: CategoryKind;
  readonly parentId: string | null;
  readonly depth: number;
  readonly path: readonly string[];
  readonly sortOrder: number;
  readonly icon: string | null;
  readonly color: string | null;
  readonly aiDescription: string | null;
  readonly isSystem: boolean;
  readonly keywords: readonly KeywordNode[];
}

export interface CategoryTreeNode {
  readonly node: CategoryNode;
  readonly children: readonly CategoryTreeNode[];
}

export interface VisibleRow {
  readonly node: CategoryNode;
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly expanded: boolean;
}

/**
 * Nest the flat list the API returns.
 *
 * The server already orders by `sortOrder` then `name`, and that order is **preserved** rather than
 * re-sorted here: two orderings of the same data is how a list ends up looking different before and
 * after a refresh. A node whose parent is missing from the input is treated as a root so it cannot
 * vanish silently.
 */
export function buildTree(nodes: readonly CategoryNode[]): readonly CategoryTreeNode[] {
  const byId = new Set(nodes.map((node) => node.id));
  const childrenOf = new Map<string | null, CategoryNode[]>();

  for (const node of nodes) {
    const parent = node.parentId !== null && byId.has(node.parentId) ? node.parentId : null;
    const bucket = childrenOf.get(parent);
    if (bucket) bucket.push(node);
    else childrenOf.set(parent, [node]);
  }

  const build = (parentId: string | null): CategoryTreeNode[] =>
    (childrenOf.get(parentId) ?? []).map((node) => ({ node, children: build(node.id) }));

  return build(null);
}

/** Flatten for display, hiding the children of collapsed nodes. */
export function visibleRows(
  tree: readonly CategoryTreeNode[],
  collapsed: ReadonlySet<string>,
): readonly VisibleRow[] {
  const rows: VisibleRow[] = [];
  const walk = (nodes: readonly CategoryTreeNode[], depth: number): void => {
    for (const { node, children } of nodes) {
      const expanded = children.length > 0 && !collapsed.has(node.id);
      rows.push({ node, depth, hasChildren: children.length > 0, expanded });
      if (expanded) walk(children, depth + 1);
    }
  };
  walk(tree, 0);
  return rows;
}

export type MoveRefusal = 'SELF' | 'CYCLE' | 'TOO_DEEP';

/** The shape the domain's tree helpers expect. Deliberately not a second tree implementation. */
function flatNodes(nodes: readonly CategoryNode[]): TreeNode[] {
  return nodes.map((node) => ({ id: node.id, parentId: node.parentId }));
}

/**
 * Why a move would be illegal, or `null` when it is fine.
 *
 * Checked here so the user gets an inline reason before a request, and re-checked by the server
 * because a client is not a security boundary (I-11). The depth test counts the moving subtree's own
 * height: moving a two-deep branch under a four-deep parent breaches the cap even though the parent
 * itself sits at a legal depth.
 */
export function moveRefusal(
  nodes: readonly CategoryNode[],
  id: string,
  newParentId: string | null,
): MoveRefusal | null {
  if (newParentId === id) return 'SELF';
  const flat = flatNodes(nodes);
  if (wouldCreateCycle(flat, id, newParentId)) return 'CYCLE';
  const deepest = depthUnder(flat, newParentId) + subtreeHeight(flat, id) - 1;
  return deepest > MAX_TREE_DEPTH ? 'TOO_DEEP' : null;
}

/** Siblings of `id` in display order, or the roots when `id` has no parent. */
export function siblingsOf(nodes: readonly CategoryNode[], id: string): readonly CategoryNode[] {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) return [];
  return nodes.filter((candidate) => candidate.parentId === node.parentId);
}

export interface SortOrderChange {
  readonly id: string;
  readonly sortOrder: number;
}

/**
 * The `sortOrder` writes needed to move `id` one place up (-1) or down (+1) among its siblings.
 *
 * Renumbers the whole sibling list to 0, 10, 20… rather than swapping two values: a freshly seeded
 * tree has every sibling at `0`, and swapping two equal numbers is a no-op that reads as a broken
 * button. Only rows whose order actually changes are returned.
 */
export function reorderChanges(
  nodes: readonly CategoryNode[],
  id: string,
  direction: -1 | 1,
): readonly SortOrderChange[] {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node) return [];

  const siblings = nodes.filter((candidate) => candidate.parentId === node.parentId);
  const from = siblings.findIndex((candidate) => candidate.id === id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= siblings.length) return [];

  const reordered = [...siblings];
  const moved = reordered[from] as CategoryNode;
  reordered[from] = reordered[to] as CategoryNode;
  reordered[to] = moved;

  const changes: SortOrderChange[] = [];
  reordered.forEach((sibling, index) => {
    const sortOrder = index * 10;
    if (sibling.sortOrder !== sortOrder) changes.push({ id: sibling.id, sortOrder });
  });
  return changes;
}

/**
 * The parent a "nest" should use: the sibling immediately before `id`.
 *
 * Nesting under the row *above* is the only target that keeps reading order stable — nesting under
 * the row below would move the node past it, which looks like the wrong command ran.
 */
export function nestParentFor(nodes: readonly CategoryNode[], id: string): string | null {
  const siblings = siblingsOf(nodes, id);
  const index = siblings.findIndex((candidate) => candidate.id === id);
  if (index <= 0) return null;
  return (siblings[index - 1] as CategoryNode).id;
}

/** The grandparent an "un-nest" should target, or `undefined` when the node is already a root. */
export function unnestParentFor(
  nodes: readonly CategoryNode[],
  id: string,
): string | null | undefined {
  const node = nodes.find((candidate) => candidate.id === id);
  if (!node || node.parentId === null) return undefined;
  const parent = nodes.find((candidate) => candidate.id === node.parentId);
  if (!parent) return undefined;
  return parent.parentId;
}
